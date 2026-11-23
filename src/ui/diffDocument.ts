import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { CompareResult, DiffRow, Side } from '../core/types';

const NULL_TEXT = 'NULL';

/** One value as text; CR and LF are escaped so a row stays on one line in the diff editor. */
function cell(v: string | null | undefined): string {
  if (v === null || v === undefined) return NULL_TEXT;
  if (v === '') return "''"; // make an empty string visibly different from NULL
  return v.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

const KIND_LABEL: Record<DiffRow['kind'], string> = { changed: 'CHANGED', added: 'ADDED  ', removed: 'REMOVED' };

/**
 * Renders one side of a comparison as text for VS Code's diff editor.
 *
 * Every differing row becomes a block with the SAME number of lines on both sides,
 * so line N on the left always belongs to the same key as line N on the right:
 *
 *     == CHANGED  order_id=200
 *        amount : 1.23          <- one line per field that differs, so the diff
 *        status : open             editor highlights exactly those fields
 *
 * Added rows show every column on the right and a placeholder on the left (removed
 * rows the other way round), padded with blank lines to keep the two sides aligned.
 */
export function renderSideText(result: CompareResult, side: Side): string {
  const ref = side === 'left' ? result.request.left : result.request.right;
  const total = result.added + result.removed + result.changed;
  const lines: string[] = [
    `-- ${ref.database}.${ref.schema}.${ref.name} (showing ${result.rows.length} of ${total} differences)`,
    '-- Each block is one key; for changed rows only the fields that differ are listed.',
  ];
  const names = result.plan.compared.map((c) => c.name);
  const width = names.reduce((w, n) => Math.max(w, n.length), 0);
  const field = (name: string, v: string | null | undefined) => `   ${name.padEnd(width)} : ${cell(v)}`;
  const otherRef = side === 'left' ? result.request.right : result.request.left;

  for (const row of result.rows) {
    const keyPart = result.plan.keys.map((k, i) => `${k.name}=${cell(row.key[i])}`).join(', ');
    lines.push('', `== ${KIND_LABEL[row.kind]}  ${keyPart}`);
    const values = (side === 'left' ? row.left : row.right) ?? [];
    if (row.kind === 'changed') {
      const changed = new Set(row.changedColumns);
      names.forEach((n, i) => {
        if (changed.has(n)) lines.push(field(n, values[i]));
      });
      continue;
    }
    // Added: present on the right only. Removed: present on the left only.
    const present = (row.kind === 'added') === (side === 'right');
    if (present) {
      names.forEach((n, i) => lines.push(field(n, values[i])));
    } else {
      lines.push(`   (no row with this key in ${side === 'left' ? 'the left' : 'the right'} table; it is only in ${otherRef.schema}.${otherRef.name})`);
      for (let i = 1; i < names.length; i++) lines.push('');
    }
  }
  return lines.map((l) => l + '\n').join('');
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

  constructor(private readonly newId: () => string = randomUUID) {}

  set(runId: string, result: CompareResult): void {
    this.runs.set(runId, result);
  }

  /** Registers a result under a new run id (one per result); `delete` it when the result's panel closes. */
  add(result: CompareResult): string {
    const runId = this.newId();
    this.runs.set(runId, result);
    return runId;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  get size(): number {
    return this.runs.size;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const m = /^\/([^/]+)\/(left|right)\.txt$/.exec(uri.path);
    if (!m) return '';
    const result = this.runs.get(m[1]);
    if (!result) return '';
    return renderSideText(result, m[2] as Side);
  }
}
