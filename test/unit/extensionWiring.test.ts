import { describe, it, expect, vi } from 'vitest';
import { runFromRequest, recentLabel, readLimits, doneMessage, elapsed, STAGE_MESSAGES, SERVERLESS_PROMPT, type CompareEnv } from '../../src/commands/compare';
import { CompareCancelledError, ComparePlanError, PausedPoolError, PoolUnavailableError } from '../../src/core/errors';
import { DEFAULT_LIMITS, type CompareRequest, type CompareResult } from '../../src/core/types';
import type { PipelineDeps } from '../../src/core/pipeline';

const ref = (name: string) => ({ profileId: 'p', database: 'db', schema: 'dbo', name });
const req: CompareRequest = {
  left: ref('orders'), right: ref('orders2'), keyColumns: ['id'], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false,
};
const result = {
  request: req, leftRows: 50_000, rightRows: 50_005, added: 5, removed: 10, changed: 54, durationMs: 41_500,
  schema: { columns: [], differenceCount: 2 }, warnings: [], rows: [],
} as unknown as CompareResult;
const stripTime = (m: string) => m.replace(/ \(\d+:\d\d\)$/, '');

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
    expect((env.withProgress as any).mock.calls[0][0]).toMatchObject({
      location: 15, cancellable: true, title: 'Table Diff: dbo.orders ↔ dbo.orders2',
    });
    expect(env.showInformationMessage).toHaveBeenCalledWith(doneMessage(result));
    expect(env.addRecent).toHaveBeenCalledWith(req);
    expect(env.showResults).toHaveBeenCalledWith(result);
  });

  it('shows results before saving the recent entry, and a save failure is ignored', async () => {
    const order: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = makeEnv(async () => result, {
      showResults: vi.fn(() => { order.push('show'); }),
      addRecent: vi.fn(async () => { order.push('recent'); throw new Error('storage full'); }),
    });
    await runFromRequest(req, env);
    expect(order).toEqual(['show', 'recent']);
    expect(env.showErrorMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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

  it('reports connecting, then each stage (detail text when given), with elapsed time', async () => {
    const t = makeEnv(async (_r, deps: PipelineDeps) => {
      for (const s of Object.keys(STAGE_MESSAGES) as (keyof typeof STAGE_MESSAGES)[]) deps.onProgress!(s);
      deps.onProgress!('details', 'Fetching 5 of 10 rows…');
      return result;
    });
    await runFromRequest(req, t.env);
    expect(t.reports.every((m) => / \(\d+:\d\d\)$/.test(m))).toBe(true);
    expect(t.reports.map(stripTime)).toEqual([
      'Connecting to both sides…', 'Connected to x (other) and x (other).',
      'Reading schemas…', 'Computing checksums…', 'Narrowing differences…', 'Comparing keys…', 'Fetching changed rows…',
      'Computing aggregates…', 'Fetching 5 of 10 rows…',
    ]);
  });

  it('formats elapsed time and the finished summary', () => {
    expect(elapsed(0)).toBe('0:00');
    expect(elapsed(125_900)).toBe('2:05');
    expect(doneMessage(result)).toBe(
      'Table Diff finished in 0:41: 54 changed, 5 added, 10 removed (50,000 vs 50,005 rows), 2 column differences.',
    );
    const same = { ...result, added: 0, removed: 0, changed: 0, warnings: ['x'], schema: { columns: [], differenceCount: 0 } };
    expect(doneMessage(same as CompareResult)).toBe(
      'Table Diff finished in 0:41: no row differences (50,000 vs 50,005 rows). See the warnings in the results.',
    );
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

describe('readLimits bounds', () => {
  it('clamps out-of-range settings to the declared bounds', () => {
    const vals: Record<string, unknown> = { pairLimit: 5, detailLimit: 5_000_000, inListCap: 0, queryTimeoutSeconds: 'x' };
    const cfg = { get: <T,>(k: string, def: T) => (vals[k] ?? def) as T };
    expect(readLimits(cfg)).toEqual({ pairLimit: 1000, detailLimit: 1_000_000, inListCap: 1, queryTimeoutSeconds: 3600 });
  });
});

describe('helpers', () => {
  it('recentLabel format', () => {
    expect(recentLabel(req)).toBe('dbo.orders ↔ dbo.orders2');
  });
  it('readLimits falls back to defaults', () => {
    expect(readLimits({ get: (_k: string, d: any) => d })).toEqual(DEFAULT_LIMITS);
    expect(readLimits({ get: (k: string, d: any) => (k === 'pairLimit' ? 7000 : d) }).pairLimit).toBe(7000);
  });
});
