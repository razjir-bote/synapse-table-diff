import type * as vscode from 'vscode';
import { ProfileStore } from './profiles/profileStore';
import { registerConnectionCommands } from './profiles/connectionCommands';

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new ProfileStore(ctx.globalState, ctx.secrets);
  registerConnectionCommands(ctx, store);
}

export function deactivate(): void {}
