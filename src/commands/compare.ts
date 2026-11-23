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

/** Bounds of each setting, as declared in package.json (VS Code does not enforce them on settings.json). */
export const LIMIT_BOUNDS: Record<keyof Limits, { min: number; max: number }> = {
  pairLimit: { min: 1000, max: Number.MAX_SAFE_INTEGER },
  detailLimit: { min: 1, max: 1_000_000 },
  inListCap: { min: 1, max: 20_000 },
  queryTimeoutSeconds: { min: 30, max: Number.MAX_SAFE_INTEGER },
};

export function readLimits(cfg: { get<T>(key: string, def: T): T }): Limits {
  const read = (k: keyof Limits): number => {
    const v = Number(cfg.get(k, DEFAULT_LIMITS[k]));
    if (!Number.isFinite(v)) return DEFAULT_LIMITS[k];
    return Math.min(LIMIT_BOUNDS[k].max, Math.max(LIMIT_BOUNDS[k].min, Math.floor(v)));
  };
  return {
    pairLimit: read('pairLimit'),
    detailLimit: read('detailLimit'),
    inListCap: read('inListCap'),
    queryTimeoutSeconds: read('queryTimeoutSeconds'),
  };
}

export function recentLabel(r: CompareRequest): string {
  return `${r.left.schema}.${r.left.name} ↔ ${r.right.schema}.${r.right.name}`;
}

/** m:ss elapsed. */
export function elapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** One-line summary shown when a comparison finishes. */
export function doneMessage(r: CompareResult): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const time = `in ${elapsed(r.durationMs)}`;
  const rows = `${n(r.leftRows)} vs ${n(r.rightRows)} rows`;
  const schema = r.schema.differenceCount > 0 ? `, ${n(r.schema.differenceCount)} column differences` : '';
  const warn = r.warnings.length > 0 ? ' See the warnings in the results.' : '';
  if (r.added + r.removed + r.changed === 0) {
    return `Table Diff finished ${time}: no row differences (${rows})${schema}.${warn}`;
  }
  return `Table Diff finished ${time}: ${n(r.changed)} changed, ${n(r.added)} added, ${n(r.removed)} removed ` +
    `(${rows})${schema}.${warn}`;
}

/** How often the progress notification refreshes its elapsed time during long queries. */
export const HEARTBEAT_MS = 5000;

export async function runFromRequest(req: CompareRequest, env: CompareEnv): Promise<void> {
  const limits = env.getLimits();
  try {
    const result = await env.withProgress(
      { location: vscode.ProgressLocation.Notification, cancellable: true, title: `Table Diff: ${recentLabel(req)}` },
      async (progress, token) => {
        const abort = new AbortController();
        if (token.isCancellationRequested) abort.abort();
        token.onCancellationRequested(() => abort.abort());
        const started = Date.now();
        let current = 'Connecting to both sides…';
        const show = () => progress.report({ message: `${current} (${elapsed(Date.now() - started)})` });
        show();
        // Long scans emit no events, so keep the elapsed time ticking to show the comparison is alive.
        const timer = setInterval(show, HEARTBEAT_MS);
        try {
          const [left, right] = await Promise.all([
            env.connect(req.left, limits.queryTimeoutSeconds),
            env.connect(req.right, limits.queryTimeoutSeconds),
          ]);
          current = `Connected to ${left.label} (${left.poolType}) and ${right.label} (${right.poolType}).`;
          show();
          return await env.runComparison(req, {
            left,
            right,
            limits,
            signal: abort.signal,
            onProgress: (stage, detail) => {
              current = detail ?? STAGE_MESSAGES[stage];
              show();
            },
            confirmExtraScan: async (_sides: Side[]) =>
              (await env.showWarningMessage(SERVERLESS_PROMPT, { modal: true }, 'Continue')) === 'Continue',
          });
        } finally {
          clearInterval(timer);
        }
      },
    );
    void env.showInformationMessage(doneMessage(result));
    env.showResults(result);
    // Best effort: a storage failure must never hide a finished result.
    try {
      await env.addRecent(req);
    } catch (err) {
      console.warn('Table Diff: could not save the recent comparison', err);
    }
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
