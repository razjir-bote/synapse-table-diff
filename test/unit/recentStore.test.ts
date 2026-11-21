import { describe, it, expect } from 'vitest';
import { RecentStore } from '../../src/profiles/recentStore';
import type { CompareRequest } from '../../src/core/types';
import { FakeMemento } from './fakes';

const req = (n: number): CompareRequest => ({
  left: { profileId: 'p', database: 'd', schema: 's', name: `t${n}` },
  right: { profileId: 'p', database: 'd', schema: 's', name: `u${n}` },
  keyColumns: ['id'], excludedColumns: [], ignoreCase: false, ignoreTrailingSpaces: false,
});

describe('RecentStore', () => {
  it('newest first, deduped, max 10', async () => {
    const s = new RecentStore(new FakeMemento() as never);
    for (let i = 0; i < 12; i++) await s.add(req(i));
    expect(s.list()).toHaveLength(10);
    expect(s.list()[0]).toEqual(req(11));
    await s.add(req(5));
    expect(s.list()[0]).toEqual(req(5));
    expect(s.list()).toHaveLength(10);
    expect(s.list().filter((r) => JSON.stringify(r) === JSON.stringify(req(5)))).toHaveLength(1);
  });
});
