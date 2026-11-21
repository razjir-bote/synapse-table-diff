import * as vscode from 'vscode';
import type { SideConnector } from '../db/runner';
import type { PipelineDeps } from '../core/pipeline';
import { CompareCancelledError, ComparePlanError, PausedPoolError, PoolUnavailableError } from '../core/errors';
import type { CompareRequest, CompareResult, Limits, Side, Stage, TableRef } from '../core/types';
import { DEFAULT_LIMITS } from '../core/types';

export const STAGE_MESSAGES: Record<Stage, string> = {
  schema: 'Reading schemas…',
  checksums: 'Computing checksums…',
  rebucket: 'Narrowing differences…',
  compare: 'Comparing keys…',
  details: 'Fetching changed rows…',
};

export const SERVERLESS_PROMPT =
  'Many differences found. Narrowing further needs one more scan of the serverless side(s) (billed per data processed). Continue?';

export interface ProgressLike { report(v: { message?: string }): void }
export interface TokenLike {
  isCancellationRequested: boolean;
  onCancellationRequested(cb: () => void): unknown;
}

export interface CompareEnv {
  withProgress<T>(
    options: { location: vscode.ProgressLocation; cancellable: boolean; title: string },
    task: (progress: ProgressLike, token: TokenLike) => Promise<T>,
  ): Promise<T>;
  showWarningMessage(message: string, options: { modal: boolean }, ...items: string[]): Thenable<string | undefined>;
  showInformationMessage(message: string): unknown;
  showErrorMessage(message: string): unknown;
  /** Read at the start of every run so settings changes apply to the next run. */
  getLimits(): Limits;
  connect(ref: TableRef, timeoutSeconds: number): Promise<SideConnector>;
  runComparison(req: CompareRequest, deps: PipelineDeps): Promise<CompareResult>;
  addRecent(req: CompareRequest): Promise<void>;
  showResults(result: CompareResult): void;
}

export function readLimits(cfg: { get<T>(key: string, def: T): T }): Limits {
  return {
    pairLimit: cfg.get('pairLimit', DEFAULT_LIMITS.pairLimit),
    detailLimit: cfg.get('detailLimit', DEFAULT_LIMITS.detailLimit),
    inListCap: cfg.get('inListCap', DEFAULT_LIMITS.inListCap),
    queryTimeoutSeconds: cfg.get('queryTimeoutSeconds', DEFAULT_LIMITS.queryTimeoutSeconds),
  };
}

export function recentLabel(r: CompareRequest): string {
  return `${r.left.schema}.${r.left.name} ↔ ${r.right.schema}.${r.right.name}`;
}

export async function runFromRequest(req: CompareRequest, env: CompareEnv): Promise<void> {
  const limits = env.getLimits();
  try {
    const result = await env.withProgress(
      { location: vscode.ProgressLocation.Notification, cancellable: true, title: 'Table Diff' },
      async (progress, token) => {
        const abort = new AbortController();
        if (token.isCancellationRequested) abort.abort();
        token.onCancellationRequested(() => abort.abort());
        const [left, right] = await Promise.all([
          env.connect(req.left, limits.queryTimeoutSeconds),
          env.connect(req.right, limits.queryTimeoutSeconds),
        ]);
        return env.runComparison(req, {
          left,
          right,
          limits,
          signal: abort.signal,
          onProgress: (stage, detail) => {
            const base = STAGE_MESSAGES[stage];
            progress.report({ message: detail ? `${base} ${detail}` : base });
          },
          confirmExtraScan: async (_sides: Side[]) =>
            (await env.showWarningMessage(SERVERLESS_PROMPT, { modal: true }, 'Continue')) === 'Continue',
        });
      },
    );
    await env.addRecent(req);
    env.showResults(result);
  } catch (err) {
    if (err instanceof CompareCancelledError) {
      void env.showInformationMessage('Comparison cancelled.');
    } else if (err instanceof PausedPoolError || err instanceof PoolUnavailableError || err instanceof ComparePlanError) {
      void env.showErrorMessage(err.message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      void env.showErrorMessage(`Comparison failed: ${msg}`);
    }
  }
}
