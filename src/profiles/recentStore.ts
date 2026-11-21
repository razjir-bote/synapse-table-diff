import type * as vscode from 'vscode';
import type { CompareRequest } from '../core/types';

const KEY = 'tableDiff.recent';
const MAX = 10;

export class RecentStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): CompareRequest[] {
    return this.state.get<CompareRequest[]>(KEY, []) ?? [];
  }

  async add(r: CompareRequest): Promise<void> {
    const json = JSON.stringify(r);
    const rest = this.list().filter((x) => JSON.stringify(x) !== json);
    await this.state.update(KEY, [r, ...rest].slice(0, MAX));
  }
}
