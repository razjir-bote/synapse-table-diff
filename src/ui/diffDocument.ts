import type * as vscode from 'vscode';
import type { CompareResult, DiffRow, Side } from '../core/types';

const NULL_TEXT = 'NULL';

function cell(v: string | null | undefined): string {
  return v === null || v === undefined ? NULL_TEXT : v;
}

/**
 * Renders one side of a comparison as text: a header line, then one line per
 * row present on that side (removed and changed rows on the left, added and
 * changed rows on the right), in result.rows order.
 */
export function renderSideText(result: CompareResult, side: Side): string {
  const ref = side === 'left' ? result.request.left : result.request.right;
  const total = result.added + result.removed + result.changed;
  const lines: string[] = [
    `-- ${ref.database}.${ref.schema}.${ref.name} (showing ${result.rows.length} of ${total} differences)`,
  ];
  for (const row of result.rows) {
    if (side === 'left' && row.kind === 'added') continue;
    if (side === 'right' && row.kind === 'removed') continue;
    lines.push(renderRowLine(result, row, side));
  }
  return lines.map((l) => l + '\n').join('');
}

function renderRowLine(result: CompareResult, row: DiffRow, side: Side): string {
  const keyPart = result.plan.keys.map((k, i) => `${k.name}=${cell(row.key[i])}`).join(', ');
  const values = (side === 'left' ? row.left : row.right) ?? [];
  const colParts = result.plan.compared.map((c, i) => `${c.name}=${cell(values[i])}`);
  return [keyPart, ...colParts].join(' | ');
}

/** Title for the diff editor: `Table Diff: <left schema.name> ↔ <right schema.name>`. */
export function diffTitle(result: CompareResult): string {
  const l = result.request.left;
  const r = result.request.right;
  return `Table Diff: ${l.schema}.${l.name} ↔ ${r.schema}.${r.name}`;
}

/** Serves the two side documents for a run. URIs: `tablediff:/<runId>/left.txt` and `right.txt`. */
export class DiffDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly runs = new Map<string, CompareResult>();

  set(runId: string, result: CompareResult): void {
    this.runs.set(runId, result);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const m = /^\/([^/]+)\/(left|right)\.txt$/.exec(uri.path);
    if (!m) return '';
    const result = this.runs.get(m[1]);
    if (!result) return '';
    return renderSideText(result, m[2] as Side);
  }
}
