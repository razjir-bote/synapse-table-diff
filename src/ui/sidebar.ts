import * as vscode from 'vscode';
import type { CompareRequest } from '../core/types';
import type { ConnectionProfile, ProfileStore } from '../profiles/profileStore';
import type { RecentStore } from '../profiles/recentStore';

/** Plain description of a tree row, kept free of vscode types so it can be unit tested. */
export interface RowSpec {
  label: string;
  description: string;
  tooltip: string;
  contextValue: 'connection' | 'recent';
  icon: string;
}

export function connectionRow(p: ConnectionProfile): RowSpec {
  const auth = p.auth === 'entra' ? 'Entra ID' : `SQL login${p.user ? ` ${p.user}` : ''}`;
  return {
    label: p.name,
    description: `${p.auth === 'entra' ? 'Entra' : 'SQL'} · ${p.database}`,
    tooltip: `${p.server}\nDatabase: ${p.database}\nSign-in: ${auth}${p.trustServerCertificate ? '\nTrusts the server certificate' : ''}`,
    contextValue: 'connection',
    icon: 'database',
  };
}

export function recentRow(r: CompareRequest, profileName: (id: string) => string | undefined): RowSpec {
  const name = (id: string) => profileName(id) ?? '(missing connection)';
  const left = `${r.left.database}.${r.left.schema}.${r.left.name}`;
  const right = `${r.right.database}.${r.right.schema}.${r.right.name}`;
  const keys = r.keyColumns.join(', ');
  return {
    label: `${r.left.schema}.${r.left.name} ↔ ${r.right.schema}.${r.right.name}`,
    description: `${name(r.left.profileId)} → ${name(r.right.profileId)}`,
    tooltip: `Left: ${name(r.left.profileId)} · ${left}\nRight: ${name(r.right.profileId)} · ${right}\nKey: ${keys}` +
      (r.filter && r.filter.trim() !== '' ? `\nFilter: ${r.filter.trim()}` : '') +
      '\n\nClick to open in the setup form; ▶ to run again.',
    contextValue: 'recent',
    icon: 'diff',
  };
}

function toItem(spec: RowSpec): vscode.TreeItem {
  const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
  item.description = spec.description;
  item.tooltip = spec.tooltip;
  item.contextValue = spec.contextValue;
  item.iconPath = new vscode.ThemeIcon(spec.icon);
  return item;
}

abstract class ListProvider<T> implements vscode.TreeDataProvider<T> {
  private readonly emitter = new vscode.EventEmitter<T | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void {
    this.emitter.fire(undefined);
  }
  dispose(): void {
    this.emitter.dispose();
  }
  abstract getChildren(element?: T): T[];
  abstract getTreeItem(element: T): vscode.TreeItem;
}

export class ConnectionsProvider extends ListProvider<ConnectionProfile> {
  constructor(private readonly store: ProfileStore) {
    super();
  }
  getChildren(element?: ConnectionProfile): ConnectionProfile[] {
    if (element) return [];
    return [...this.store.list()].sort((a, b) => a.name.localeCompare(b.name));
  }
  getTreeItem(p: ConnectionProfile): vscode.TreeItem {
    return toItem(connectionRow(p));
  }
}

export class RecentProvider extends ListProvider<CompareRequest> {
  constructor(private readonly recent: RecentStore, private readonly store: ProfileStore) {
    super();
  }
  getChildren(element?: CompareRequest): CompareRequest[] {
    return element ? [] : this.recent.list();
  }
  getTreeItem(r: CompareRequest): vscode.TreeItem {
    const item = toItem(recentRow(r, (id) => this.store.get(id)?.name));
    item.command = { command: 'tableDiff.openRecent', title: 'Open in setup form', arguments: [r] };
    return item;
  }
}

export interface SidebarActions {
  removeConnection(profileId: string): Promise<void>;
  openRecent(r: CompareRequest): void;
  runRecent(r: CompareRequest): void;
}

/** Registers the two sidebar views and their item commands, and keeps them in sync with the stores. */
export function registerSidebar(
  ctx: vscode.ExtensionContext,
  store: ProfileStore,
  recent: RecentStore,
  actions: SidebarActions,
): void {
  const connections = new ConnectionsProvider(store);
  const recents = new RecentProvider(recent, store);
  const offStore = store.onDidChange(() => {
    connections.refresh();
    recents.refresh(); // profile names shown on recent rows may have changed
  });
  const offRecent = recent.onDidChange(() => recents.refresh());

  ctx.subscriptions.push(
    connections,
    recents,
    { dispose: offStore },
    { dispose: offRecent },
    vscode.window.registerTreeDataProvider('tableDiff.connections', connections),
    vscode.window.registerTreeDataProvider('tableDiff.recent', recents),
    vscode.commands.registerCommand('tableDiff.removeConnectionItem', (p?: ConnectionProfile) =>
      p ? actions.removeConnection(p.id) : vscode.commands.executeCommand('tableDiff.removeConnection'),
    ),
    vscode.commands.registerCommand('tableDiff.openRecent', (r?: CompareRequest) => r && actions.openRecent(r)),
    vscode.commands.registerCommand('tableDiff.runRecent', (r?: CompareRequest) => r && actions.runRecent(r)),
  );
}
