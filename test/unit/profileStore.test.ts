import { describe, it, expect } from 'vitest';
import { ProfileStore, type ConnectionProfile } from '../../src/profiles/profileStore';
import { FakeMemento, FakeSecrets } from './fakes';

const p: ConnectionProfile = { id: 'a1', name: 'Dev', server: 's.sql.azuresynapse.net', database: 'db', auth: 'sql', user: 'u' };

function mk() {
  const state = new FakeMemento(); const secrets = new FakeSecrets();
  return { state, secrets, store: new ProfileStore(state as never, secrets as never) };
}

describe('ProfileStore', () => {
  it('saves, lists, gets', async () => {
    const { store } = mk();
    await store.save(p, 'pw');
    expect(store.list()).toEqual([p]);
    expect(store.get('a1')).toEqual(p);
    expect(store.get('zz')).toBeUndefined();
  });
  it('stores password only in SecretStorage', async () => {
    const { store, state, secrets } = mk();
    await store.save(p, 'test-pass-123');
    expect(JSON.stringify(state.get('tableDiff.profiles'))).not.toContain('test-pass-123');
    expect(secrets.data.get('tableDiff.pwd.a1')).toBe('test-pass-123');
    expect(await store.password('a1')).toBe('test-pass-123');
  });
  it('save without password keeps existing; update replaces profile', async () => {
    const { store } = mk();
    await store.save(p, 'pw');
    await store.save({ ...p, name: 'Dev2' });
    expect(store.list()).toHaveLength(1);
    expect(store.get('a1')?.name).toBe('Dev2');
    expect(await store.password('a1')).toBe('pw');
  });
  it('remove deletes profile and secret', async () => {
    const { store, secrets } = mk();
    await store.save(p, 'pw');
    await store.remove('a1');
    expect(store.list()).toEqual([]);
    expect(secrets.data.has('tableDiff.pwd.a1')).toBe(false);
  });
});
