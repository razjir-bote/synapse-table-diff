import { describe, it, expect, vi } from 'vitest';
import { runFromRequest, recentLabel, readLimits, STAGE_MESSAGES, SERVERLESS_PROMPT, type CompareEnv } from '../../src/commands/compare';
import { CompareCancelledError, ComparePlanError, PausedPoolError, PoolUnavailableError } from '../../src/core/errors';
import { DEFAULT_LIMITS, type CompareRequest, type CompareResult } from '../../src/core/types';
import type { PipelineDeps } from '../../src/core/pipeline';

const ref = (name: string) => ({ profileId: 'p', database: 'db', schema: 'dbo', name });
const req: CompareRequest = {
  left: ref('orders'), right: ref('orders2'), keyColumns: ['id'], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false,
};
const result = { request: req } as CompareResult;

function makeEnv(run: CompareEnv['runComparison'], over: Record<string, unknown> = {}) {
  let cancel: (() => void) | undefined;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => { cancel = cb; },
  };
  const reports: string[] = [];
  const env = {
    withProgress: vi.fn(async (_o: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
      task({ report: (v: { message?: string }) => void reports.push(v.message ?? '') }, token)),
    showWarningMessage: vi.fn(async () => 'Continue'),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    getLimits: vi.fn(() => DEFAULT_LIMITS),
    connect: vi.fn(async () => ({ label: 'x', poolType: 'other' as const, open: async () => { throw new Error('unused'); } })),
    runComparison: vi.fn(run),
    addRecent: vi.fn(async () => {}),
    showResults: vi.fn(),
    ...over,
  } as any;
  return { env: env as CompareEnv & Record<string, any>, reports, cancel: () => cancel?.() };
}

describe('runFromRequest', () => {
  it('success: progress options, recent add, results shown', async () => {
    const { env } = makeEnv(async () => result);
    await runFromRequest(req, env);
    expect((env.withProgress as any).mock.calls[0][0]).toMatchObject({ location: 15, cancellable: true, title: 'Table Diff' });
    expect(env.addRecent).toHaveBeenCalledWith(req);
    expect(env.showResults).toHaveBeenCalledWith(result);
  });

  it('cancel aborts pipeline, informs, no panel', async () => {
    let signal: AbortSignal | undefined;
    const t = makeEnv((_r, deps) => {
      signal = deps.signal;
      return new Promise((_res, rej) => deps.signal!.addEventListener('abort', () => rej(new CompareCancelledError('c'))));
    });
    const p = runFromRequest(req, t.env);
    await vi.waitFor(() => expect(signal).toBeDefined());
    t.cancel();
    await p;
    expect(signal!.aborted).toBe(true);
    expect(t.env.showInformationMessage).toHaveBeenCalledWith('Comparison cancelled.');
    expect(t.env.showResults).not.toHaveBeenCalled();
    expect(t.env.addRecent).not.toHaveBeenCalled();
  });

  it.each([
    ['paused', new PausedPoolError('srv', 'db')],
    ['unavailable', new PoolUnavailableError('pool down')],
    ['plan', new ComparePlanError('key missing')],
  ])('%s error shows its message', async (_n, err) => {
    const { env } = makeEnv(async () => { throw err; });
    await runFromRequest(req, env);
    expect(env.showErrorMessage).toHaveBeenCalledWith(err.message);
    expect(env.showResults).not.toHaveBeenCalled();
  });

  it('other errors are prefixed', async () => {
    const { env } = makeEnv(async () => { throw new Error('boom'); });
    await runFromRequest(req, env);
    expect(env.showErrorMessage).toHaveBeenCalledWith('Comparison failed: boom');
  });

  it('connect failures map through the same handler', async () => {
    const { env } = makeEnv(async () => result, { connect: async () => { throw new PausedPoolError('s', 'd'); } });
    await runFromRequest(req, env);
    expect(env.showErrorMessage).toHaveBeenCalledWith(new PausedPoolError('s', 'd').message);
  });

  it('maps stages to messages with optional detail', async () => {
    const t = makeEnv(async (_r, deps: PipelineDeps) => {
      for (const s of Object.keys(STAGE_MESSAGES) as (keyof typeof STAGE_MESSAGES)[]) deps.onProgress!(s);
      deps.onProgress!('details', '5 of 10');
      return result;
    });
    await runFromRequest(req, t.env);
    expect(t.reports).toEqual([
      'Reading schemas…', 'Computing checksums…', 'Narrowing differences…', 'Comparing keys…', 'Fetching changed rows…',
      'Fetching changed rows… 5 of 10',
    ]);
  });

  it('confirmExtraScan uses a modal warning', async () => {
    let ok: boolean | undefined;
    const t = makeEnv(async (_r, deps) => { ok = await deps.confirmExtraScan!(['left']); return result; });
    await runFromRequest(req, t.env);
    expect(ok).toBe(true);
    expect(t.env.showWarningMessage).toHaveBeenCalledWith(SERVERLESS_PROMPT, { modal: true }, 'Continue');
    const t2 = makeEnv(async (_r, deps) => { ok = await deps.confirmExtraScan!(['left']); return result; },
      { showWarningMessage: vi.fn(async () => undefined) });
    await runFromRequest(req, t2.env);
    expect(ok).toBe(false);
  });

  it('reads limits on every run', async () => {
    const limits = [{ ...DEFAULT_LIMITS, detailLimit: 1 }, { ...DEFAULT_LIMITS, detailLimit: 2 }];
    const seen: number[] = [];
    const { env } = makeEnv(async (_r, deps) => { seen.push(deps.limits.detailLimit); return result; },
      { getLimits: vi.fn(() => limits.shift()!) });
    await runFromRequest(req, env);
    await runFromRequest(req, env);
    expect(seen).toEqual([1, 2]);
  });
});

describe('helpers', () => {
  it('recentLabel format', () => {
    expect(recentLabel(req)).toBe('dbo.orders ↔ dbo.orders2');
  });
  it('readLimits falls back to defaults', () => {
    expect(readLimits({ get: (_k: string, d: any) => d })).toEqual(DEFAULT_LIMITS);
    expect(readLimits({ get: (k: string, d: any) => (k === 'pairLimit' ? 7 : d) }).pairLimit).toBe(7);
  });
});
