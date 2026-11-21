import { describe, it, expect, vi, beforeEach } from 'vitest';
import { entraTokenProvider, buildMssqlConfig, makeConnector } from '../../src/db/auth';
import { ProfileStore, type ConnectionProfile } from '../../src/profiles/profileStore';
import { openRunner } from '../../src/db/runner';
import { FakeMemento, FakeSecrets } from './fakes';

vi.mock('../../src/db/runner');

const entra: ConnectionProfile = { id: 'e', name: 'E', server: 'srv', database: 'd0', auth: 'entra' };
const sqlp: ConnectionProfile = { id: 's', name: 'S', server: 'srv', database: 'd0', auth: 'sql', user: 'u' };

describe('entraTokenProvider', () => {
  it('requests exact scopes', async () => {
    const getSession = vi.fn().mockResolvedValue({ accessToken: 'tok' });
    const tp = entraTokenProvider({ getSession } as never);
    expect(await tp()).toBe('tok');
    expect(getSession).toHaveBeenCalledWith('microsoft', ['https://database.windows.net//.default'], { createIfNone: true });
    await tp('ten-1');
    expect(getSession).toHaveBeenLastCalledWith('microsoft', ['https://database.windows.net//.default', 'VSCODE_TENANT:ten-1'], { createIfNone: true });
  });
});

describe('buildMssqlConfig', () => {
  it('entra', () => {
    const c = buildMssqlConfig(entra, 'db1', { token: 'T' });
    expect(c.server).toBe('srv'); expect(c.database).toBe('db1');
    expect(c.options?.encrypt).toBe(true);
    expect(c.authentication).toEqual({ type: 'azure-active-directory-access-token', options: { token: 'T' } });
  });
  it('sql', () => {
    const c = buildMssqlConfig(sqlp, 'db1', { password: 'P' });
    expect(c.user).toBe('u'); expect(c.password).toBe('P');
    expect(c.options?.encrypt).toBe(true);
    expect(c.authentication).toBeUndefined();
  });
});

describe('makeConnector', () => {
  const runner = (edition: number) => ({ query: vi.fn().mockResolvedValue([{ engine_edition: edition }]), stream: vi.fn(), close: vi.fn().mockResolvedValue(undefined) });
  beforeEach(() => { vi.mocked(openRunner).mockReset(); });

  it('fetches token on every open, detects pool once', async () => {
    const r = runner(6);
    vi.mocked(openRunner).mockResolvedValue(r as never);
    const store = new ProfileStore(new FakeMemento() as never, new FakeSecrets() as never);
    const tokens = vi.fn().mockResolvedValue('tok');
    const c = await makeConnector(entra, 'db1', store, tokens, 30);
    expect(c.label).toBe('E (db1)');
    expect(c.poolType).toBe('dedicated');
    const before = tokens.mock.calls.length;
    await c.open(); await c.open();
    expect(tokens.mock.calls.length - before).toBe(2);
    expect(r.query).toHaveBeenCalledTimes(1);
    expect(r.close).toHaveBeenCalledTimes(1);
  });
  it('maps 11 to serverless, other to other; sql uses stored password', async () => {
    vi.mocked(openRunner).mockResolvedValue(runner(11) as never);
    const store = new ProfileStore(new FakeMemento() as never, new FakeSecrets() as never);
    await store.save(sqlp, 'pw');
    const c = await makeConnector(sqlp, 'db1', store, vi.fn(), 30);
    expect(c.poolType).toBe('serverless');
    expect(vi.mocked(openRunner).mock.calls[0][0].password).toBe('pw');
    vi.mocked(openRunner).mockResolvedValue(runner(3) as never);
    expect((await makeConnector(sqlp, 'db1', store, vi.fn(), 30)).poolType).toBe('other');
  });
});
