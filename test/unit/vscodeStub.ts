// Placeholder vscode API stub for unit tests. Extended as needed.
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export type ProgressLocation = (typeof ProgressLocation)[keyof typeof ProgressLocation];
