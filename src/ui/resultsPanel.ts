import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AggregateResult, ChangeKind, CompareResult } from '../core/types';
import type { HostToResults, ResultsToHost } from './protocol';
import { pageRows, totalsByKind } from './resultsPaging';

export interface ResultsActions {
  openDiff(): void;
  exportCsv(): void;
  /** Called once when the panel closes, to release what belongs to this result. */
  onDispose?(): void;
}

export class ResultsPanel {
  /** One panel per result. */
  static show(ctx: vscode.ExtensionContext, result: CompareResult | AggregateResult, actions: ResultsActions): ResultsPanel {
    return new ResultsPanel(ctx, result, actions);
  }

  private readonly panel: vscode.WebviewPanel;
  private rows: CompareResult['rows'] | AggregateResult['rows'];
  private readonly aggregate: boolean;
  private readonly summary: Omit<CompareResult, 'rows'> | Omit<AggregateResult, 'rows'>;

  private constructor(ctx: vscode.ExtensionContext, result: CompareResult | AggregateResult, private readonly actions: ResultsActions) {
    this.aggregate = result.mode === 'aggregate';
    const { rows, ...summary } = result;
    this.rows = rows;
    this.summary = summary;
    const root = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview');
    const l = result.request.left;
    const r = result.request.right;
    this.panel = vscode.window.createWebviewPanel(
      'tableDiff.results',
      `Table Diff: ${this.aggregate ? 'Σ ' : ''}${l.schema}.${l.name} ↔ ${r.schema}.${r.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html(root);
    const sub = this.panel.webview.onDidReceiveMessage((m: ResultsToHost) => this.handle(m));
    this.panel.onDidDispose(() => {
      sub.dispose();
      this.rows = [];
      try {
        this.actions.onDispose?.();
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private html(root: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const script = w.asWebviewUri(vscode.Uri.joinPath(root, 'results.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css'));
    const csp = `default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Table Diff</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private post(m: HostToResults): void {
    void this.panel.webview.postMessage(m);
  }

  private handle(m: ResultsToHost): void {
    switch (m.type) {
      case 'ready':
        if (this.aggregate) {
          this.post({ type: 'aggregateSummary', summary: this.summary as Omit<AggregateResult, 'rows'>, totalByKind: totalsByKind<{ kind: ChangeKind }>(this.rows) });
        } else {
          this.post({ type: 'summary', summary: this.summary as Omit<CompareResult, 'rows'>, totalByKind: totalsByKind<{ kind: ChangeKind }>(this.rows) });
        }
        break;
      case 'page':
        if (this.aggregate) {
          this.post({ type: 'aggregateRows', kind: m.kind, offset: Math.max(0, Math.floor(Number(m.offset)) || 0), rows: pageRows(this.rows as AggregateResult['rows'], m.kind, m.offset, m.limit) });
          break;
        }
        this.post({ type: 'rows', kind: m.kind, offset: Math.max(0, Math.floor(Number(m.offset)) || 0), rows: pageRows(this.rows as CompareResult['rows'], m.kind, m.offset, m.limit) });
        break;
      case 'openDiff':
        this.run(() => this.actions.openDiff());
        break;
      case 'exportCsv':
        this.run(() => this.actions.exportCsv());
        break;
    }
  }

  private run(fn: () => unknown): void {
    try {
      Promise.resolve(fn()).catch((e) => this.fail(e));
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    void vscode.window.showErrorMessage(`Table Diff: ${e instanceof Error ? e.message : String(e)}`);
  }
}
