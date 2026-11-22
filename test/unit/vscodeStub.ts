// Placeholder vscode API stub for unit tests. Extended as needed.
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export type ProgressLocation = (typeof ProgressLocation)[keyof typeof ProgressLocation];

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(public label: string, public collapsibleState: number = 0) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l); } };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}
