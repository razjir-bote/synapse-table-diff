import type * as vscode from 'vscode';
import type { CompareRequest } from '../core/types';

const KEY = 'tableDiff.recent';
const MAX = 10;

export class RecentStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly state: vscode.Memento) {}

  /** Registers a callback fired after a comparison is added; returns an unsubscribe function. */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): CompareRequest[] {
    return this.state.get<CompareRequest[]>(KEY, []) ?? [];
  }

  async add(r: CompareRequest): Promise<void> {
    const json = JSON.stringify(r);
    const rest = this.list().filter((x) => JSON.stringify(x) !== json);
    await this.state.update(KEY, [r, ...rest].slice(0, MAX));
    for (const l of this.listeners) l();
  }
}
