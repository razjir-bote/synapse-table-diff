import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ProfileStore, ConnectionProfile } from './profileStore';
import { buildMssqlConfig, entraTokenProvider } from '../db/auth';
import { openRunner } from '../db/runner';
import { engineEditionQuery } from '../sql/queries';

function timeoutSeconds(): number {
  return vscode.workspace.getConfiguration('tableDiff').get<number>('queryTimeoutSeconds', 120);
}

async function required(prompt: string, placeHolder?: string): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true, validateInput: (s) => (s.trim() ? undefined : 'Required') });
  return v?.trim();
}

export async function addConnection(store: ProfileStore): Promise<void> {
  const name = await required('Connection name');
  if (!name) return;
  const server = await required('Server', 'myworkspace.sql.azuresynapse.net');
  if (!server) return;
  const database = await required('Database');
  if (!database) return;
  const pick = await vscode.window.showQuickPick(
    [{ label: 'Entra ID', value: 'entra' as const }, { label: 'SQL login', value: 'sql' as const }],
    { placeHolder: 'Authentication', ignoreFocusOut: true },
  );
  if (!pick) return;

  const profile: ConnectionProfile = { id: randomUUID(), name, server, database, auth: pick.value };
  let password: string | undefined;
  if (pick.value === 'entra') {
    const tenant = await vscode.window.showInputBox({ prompt: 'Tenant ID (optional)', ignoreFocusOut: true });
    if (tenant === undefined) return;
    if (tenant.trim()) profile.tenantId = tenant.trim();
  } else {
    const user = await required('User name');
    if (!user) return;
    profile.user = user;
    password = await vscode.window.showInputBox({ prompt: 'Password', password: true, ignoreFocusOut: true });
    if (password === undefined) return;
  }

  try {
    const secret = profile.auth === 'entra'
      ? { token: await entraTokenProvider(vscode.authentication)(profile.tenantId) }
      : { password };
    const runner = await openRunner(buildMssqlConfig(profile, database, secret), timeoutSeconds());
    try {
      const rows = await runner.query<{ engine_edition: number }>(engineEditionQuery());
      const ed = Number(rows[0]?.engine_edition);
      const kind = ed === 6 ? 'dedicated SQL pool' : ed === 11 ? 'serverless SQL pool' : 'SQL Server / other';
      void vscode.window.showInformationMessage(`Connected: ${kind}.`);
    } finally {
      await runner.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(`Test connection failed: ${msg}`, 'Save anyway', 'Cancel');
    if (choice !== 'Save anyway') return;
  }

  await store.save(profile, password);
}

export async function removeConnection(store: ProfileStore): Promise<void> {
  const profiles = store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('No saved connections.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: `${p.server} / ${p.database}`, id: p.id })),
    { placeHolder: 'Connection to remove' },
  );
  if (!pick) return;
  const ok = await vscode.window.showWarningMessage(`Remove connection "${pick.label}"?`, { modal: true }, 'Remove');
  if (ok === 'Remove') await store.remove(pick.id);
}

export function registerConnectionCommands(ctx: vscode.ExtensionContext, store: ProfileStore): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tableDiff.addConnection', () => addConnection(store)),
    vscode.commands.registerCommand('tableDiff.removeConnection', () => removeConnection(store)),
  );
}
