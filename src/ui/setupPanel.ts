import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ColumnInfo, CompareRequest, Side, TableRef } from '../core/types';
import type { ProfileStore } from '../profiles/profileStore';
import type { QueryRunner, SideConnector } from '../db/runner';
import { columnsQuery, declaredKeyQuery, listDatabasesQuery, listObjectsQuery } from '../sql/queries';
import type { HostToSetup, SetupToHost } from './protocol';

export interface SetupDeps {
  store: ProfileStore;
  connect: (profileId: string, database: string) => Promise<SideConnector>;
  onRun: (req: CompareRequest) => void;
}

interface ColumnRow {
  name: string;
  type_name: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean | number;
  column_id: number;
}
interface KeyRow { index_id: number; is_primary_key: boolean | number; name: string; key_ordinal: number }

export function mapColumns(rows: ColumnRow[]): ColumnInfo[] {
  return rows.map((r) => ({
    name: r.name,
    type: String(r.type_name).toLowerCase(),
    maxLength: Number(r.max_length),
    precision: Number(r.precision),
    scale: Number(r.scale),
    nullable: Boolean(r.is_nullable),
    ordinal: Number(r.column_id),
  }));
}

/** Primary key if present, otherwise the lowest-numbered unique constraint. */
export function pickDeclaredKey(rows: KeyRow[]): string[] {
  if (rows.length === 0) return [];
  const pk = rows.find((r) => Boolean(r.is_primary_key));
  const idx = pk ? pk.index_id : Math.min(...rows.map((r) => Number(r.index_id)));
  return rows
    .filter((r) => Number(r.index_id) === Number(idx))
    .sort((a, b) => Number(a.key_ordinal) - Number(b.key_ordinal))
    .map((r) => r.name);
}

export class SetupPanel {
  private static current: SetupPanel | undefined;

  static show(ctx: vscode.ExtensionContext, deps: SetupDeps, initial?: CompareRequest): void {
    if (SetupPanel.current) {
      SetupPanel.current.deps = deps;
      SetupPanel.current.panel.reveal();
      if (initial) SetupPanel.current.sendInit(initial);
      return;
    }
    SetupPanel.current = new SetupPanel(ctx, deps, initial);
  }

  private readonly panel: vscode.WebviewPanel;
  private deps: SetupDeps;
  private pendingInitial: CompareRequest | undefined;

  private constructor(ctx: vscode.ExtensionContext, deps: SetupDeps, initial?: CompareRequest) {
    this.deps = deps;
    this.pendingInitial = initial;
    const root = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel('tableDiff.setup', 'Compare Tables', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [root],
      retainContextWhenHidden: true,
    });
    this.panel.webview.html = this.html(root);
    this.panel.onDidDispose(() => { SetupPanel.current = undefined; }, null, ctx.subscriptions);
    this.panel.webview.onDidReceiveMessage((m: SetupToHost) => void this.handle(m), null, ctx.subscriptions);
  }

  private html(root: vscode.Uri): string {
    const w = this.panel.webview;
    const nonce = makeNonce();
    const script = w.asWebviewUri(vscode.Uri.joinPath(root, 'setup.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css'));
    const csp = `default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Compare Tables</title></head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private post(m: HostToSetup): void {
    void this.panel.webview.postMessage(m);
  }

  private sendInit(initial?: CompareRequest): void {
    this.post({
      type: 'init',
      profiles: this.deps.store.list().map((p) => ({ id: p.id, name: p.name })),
      initial,
    });
  }

  private async handle(m: SetupToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.sendInit(this.pendingInitial);
          this.pendingInitial = undefined;
          break;
        case 'listDatabases': {
          const db = this.deps.store.get(m.profileId)?.database || 'master';
          const rows = await this.withRunner(m.profileId, db, (r) => r.query<{ name: string }>(listDatabasesQuery()));
          this.post({ type: 'databases', side: m.side, names: rows.map((r) => r.name) });
          break;
        }
        case 'listObjects': {
          const rows = await this.withRunner(m.profileId, m.database, (r) =>
            r.query<{ schema_name: string; object_name: string; object_type: string }>(listObjectsQuery()));
          this.post({
            type: 'objects',
            side: m.side,
            objects: rows.map((r) => ({
              schema: r.schema_name,
              name: r.object_name,
              kind: String(r.object_type).trim() === 'V' ? ('view' as const) : ('table' as const),
            })),
          });
          break;
        }
        case 'describe':
          await this.describe(m.side, m.ref);
          break;
        case 'run':
          this.deps.onRun(m.request);
          break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async describe(side: Side, ref: TableRef): Promise<void> {
    const connector = await this.deps.connect(ref.profileId, ref.database);
    const runner = await connector.open();
    try {
      const cols = await runner.query<ColumnRow>(columnsQuery(ref));
      let declaredKey: string[] = [];
      try {
        declaredKey = pickDeclaredKey(await runner.query<KeyRow>(declaredKeyQuery(ref)));
      } catch {
        declaredKey = [];
      }
      this.post({ type: 'described', side, columns: mapColumns(cols), declaredKey, poolType: connector.poolType });
    } finally {
      await runner.close();
    }
  }

  private async withRunner<T>(profileId: string, database: string, fn: (r: QueryRunner) => Promise<T>): Promise<T> {
    const connector = await this.deps.connect(profileId, database);
    const runner = await connector.open();
    try {
      return await fn(runner);
    } finally {
      await runner.close();
    }
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('hex');
}
