import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { ProfileStore } from './profiles/profileStore';
import { RecentStore } from './profiles/recentStore';
import { registerConnectionCommands } from './profiles/connectionCommands';
import { entraTokenProvider, makeConnector } from './db/auth';
import { runComparison } from './core/pipeline';
import type { CompareRequest, CompareResult, TableRef } from './core/types';
import { readLimits, recentLabel, runFromRequest, type CompareEnv } from './commands/compare';
import { SetupPanel, type SetupDeps } from './ui/setupPanel';
import { ResultsPanel } from './ui/resultsPanel';
import { DiffDocumentProvider, diffTitle } from './ui/diffDocument';
import { exportMessage, writeCsv } from './export/csv';

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new ProfileStore(ctx.globalState, ctx.secrets);
  const recent = new RecentStore(ctx.globalState);
  const provider = new DiffDocumentProvider();
  const tokens = entraTokenProvider(vscode.authentication);
  const limits = () => readLimits(vscode.workspace.getConfiguration('tableDiff'));
  registerConnectionCommands(ctx, store);
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('tablediff', provider));

  const openDiff = async (runId: string, result: CompareResult) => {
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(`tablediff:/${runId}/left.txt`),
      vscode.Uri.parse(`tablediff:/${runId}/right.txt`),
      diffTitle(result),
    );
  };

  const exportCsv = async (result: CompareResult) => {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('table-diff.csv'),
      filters: { CSV: ['csv'] },
    });
    if (!target) return;
    try {
      await writeCsv(result, fs.createWriteStream(target.fsPath));
      void vscode.window.showInformationMessage(exportMessage(result));
    } catch (err) {
      void vscode.window.showErrorMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const connect = async (ref: Pick<TableRef, 'profileId' | 'database'>, timeoutSeconds: number) => {
    const profile = store.get(ref.profileId);
    if (!profile) throw new Error('Connection profile not found. It may have been removed.');
    return makeConnector(profile, ref.database, store, tokens, timeoutSeconds);
  };

  const env: CompareEnv = {
    withProgress: async (o, task) => vscode.window.withProgress(o, (p, t) => task(p, t)),
    showWarningMessage: (m, o, ...items) => vscode.window.showWarningMessage(m, o, ...items),
    showInformationMessage: (m) => vscode.window.showInformationMessage(m),
    showErrorMessage: (m) => vscode.window.showErrorMessage(m),
    getLimits: limits,
    connect,
    runComparison,
    addRecent: (r) => recent.add(r),
    showResults: (result) => {
      // One diff-document run per result, released when its results panel closes.
      const runId = provider.add(result);
      ResultsPanel.show(ctx, result, {
        openDiff: () => void openDiff(runId, result),
        exportCsv: () => void exportCsv(result),
        onDispose: () => provider.delete(runId),
      });
    },
  };

  const setupDeps: SetupDeps = {
    store,
    connect: (profileId, database) => connect({ profileId, database }, limits().queryTimeoutSeconds),
    onRun: (req: CompareRequest) => void runFromRequest(req, env),
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('tableDiff.compare', () => SetupPanel.show(ctx, setupDeps)),
    vscode.commands.registerCommand('tableDiff.rerunRecent', async () => {
      const items = recent.list();
      if (items.length === 0) {
        void vscode.window.showInformationMessage('No recent comparisons.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        items.map((r) => ({ label: recentLabel(r), req: r })),
        { placeHolder: 'Recent comparison' },
      );
      if (pick) SetupPanel.show(ctx, setupDeps, pick.req);
    }),
  );
}

export function deactivate(): void {}
