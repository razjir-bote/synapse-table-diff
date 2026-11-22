import { describe, expect, it } from 'vitest';
import { filterProblem } from '../../src/sql/filterGuard';

describe('filterProblem', () => {
  it.each([
    [undefined],
    [''],
    ['   '],
    ["region = 'EU'"],
    ["region = 'EU' -- eu only"],
    ["created >= '2024-01-01' AND (status IN ('open','closed') OR qty > 5)"],
    ["note = 'it''s; DROP TABLE x' AND [weird ; name] = 1"],
    ['[delete] = 1'],
    ["name LIKE N'%update%'"],
    ['amount BETWEEN 1 AND 10'],
  ])('accepts %j', (f) => {
    expect(filterProblem(f)).toBeUndefined();
  });

  it.each([
    ["1=1; DELETE FROM dbo.orders", /";"/],
    ["1=1) AS h) AS x; SELECT 1 --", /";"|without a matching/],
    ["a = 1) OR (1 = 1", /without a matching/],
    ['(a = 1', /unbalanced/],
    ["x = 'open", /unterminated string/],
    ['[x = 1', /unterminated \[bracketed\]/],
    ['a = 1 /* hide', /Block comments/],
    ['a = 1 */', /Block comments/],
    ['1=1\nGO\nDROP TABLE t', /"GO"|"DROP"/],
    ['exists (select 1 from t) and 1=1 exec sp_who', /"exec"/],
    ['1 = 1 UNION SELECT * INTO dbo.copy FROM t', /"INTO"/],
    ["1=1 waitfor delay '0:0:5'", /"waitfor"/],
    ['x IN (SELECT a FROM OPENROWSET(BULK 1))', /"OPENROWSET"/],
  ])('rejects %j', (f, re) => {
    expect(filterProblem(f)).toMatch(re);
  });
});
