import { describe, it, expect } from 'vitest';
import { assertAllowedSql, ALLOWED_FUNCTIONS, ALLOWED_KEYWORDS } from '../../src/sql/allowList';

describe('assertAllowedSql accepts known-safe SQL', () => {
  it('accepts a hashing select over a bracketed table', () => {
    expect(() => assertAllowedSql("SELECT HASHBYTES('SHA2_256', N'a') AS kh FROM [s].[t]")).not.toThrow();
  });

  it('ignores words inside string literals and bracketed identifiers', () => {
    expect(() => assertAllowedSql("SELECT N'MERGE' AS x FROM [s].[t]")).not.toThrow();
    expect(() => assertAllowedSql("SELECT 'EXEC sp_executesql' AS x FROM [s].[t]")).not.toThrow();
    expect(() => assertAllowedSql('SELECT [EXEC] AS x FROM [s].[t]')).not.toThrow();
  });

  it('handles doubled quotes and doubled closing brackets', () => {
    expect(() => assertAllowedSql("SELECT 'it''s MERGE' AS x FROM [s].[odd]]MERGE]")).not.toThrow();
  });

  it('accepts two-part dotted names and sys catalog names', () => {
    expect(() =>
      assertAllowedSql(
        'SELECT c.name, t.type_name FROM sys.columns AS c JOIN sys.types AS t ON c.user_type_id = t.user_type_id',
      ),
    ).not.toThrow();
  });

  it('accepts CAST with type names and max', () => {
    expect(() => assertAllowedSql('SELECT CAST(x AS nvarchar(max)) AS b24 FROM [s].[t]')).not.toThrow();
  });

  it('accepts numeric literals, operators, COUNT_BIG(*) and a trailing semicolon', () => {
    expect(() =>
      assertAllowedSql('SELECT COUNT_BIG(*) AS cnt, SUM(1.5) AS s1 FROM [s].[t] WHERE k_1 <> -1 AND n_2 >= 0;'),
    ).not.toThrow();
  });

  it('accepts IN lists and keywords followed by a parenthesis', () => {
    expect(() => assertAllowedSql('SELECT x FROM [s].[t] WHERE x IN (1, 2)')).not.toThrow();
    expect(() => assertAllowedSql('SELECT x FROM [s].[t] WHERE (x = 1) AND (x = 2)')).not.toThrow();
  });
});

describe('assertAllowedSql rejects disallowed SQL', () => {
  it('rejects a bare word that is not in any allow-list', () => {
    expect(() => assertAllowedSql('SELECT foo FROM [s].[t]')).toThrow('Disallowed SQL: foo');
  });

  it('rejects a function outside ALLOWED_FUNCTIONS, in any case', () => {
    expect(() => assertAllowedSql('SELECT CONCAT(1,2)')).toThrow('Disallowed SQL: CONCAT');
    expect(() => assertAllowedSql('SELECT concat(1,2)')).toThrow('Disallowed SQL: concat');
  });

  it('rejects MERGE in any case', () => {
    expect(() => assertAllowedSql('MERGE [s].[t] AS x USING [s].[u] AS y ON 1 = 1')).toThrow('Disallowed SQL: MERGE');
    expect(() => assertAllowedSql('merge [s].[t]')).toThrow('Disallowed SQL: merge');
  });

  it('rejects EXEC in any case', () => {
    expect(() => assertAllowedSql('EXEC x')).toThrow('Disallowed SQL: EXEC');
    expect(() => assertAllowedSql('exec x')).toThrow('Disallowed SQL: exec');
  });

  it('rejects sp_executesql in any case', () => {
    expect(() => assertAllowedSql("sp_executesql N'SELECT 1'")).toThrow('Disallowed SQL: sp_executesql');
    expect(() => assertAllowedSql("SP_EXECUTESQL N'SELECT 1'")).toThrow('Disallowed SQL: SP_EXECUTESQL');
  });

  it('rejects three-part names, bracketed or not', () => {
    expect(() => assertAllowedSql('SELECT * FROM db.s.t')).toThrow('Disallowed SQL: db.s.t');
    expect(() => assertAllowedSql('SELECT * FROM [db].[s].[t]')).toThrow('Disallowed SQL: [db].[s].[t]');
  });

  it('rejects #temp names in any case', () => {
    expect(() => assertAllowedSql('SELECT 1 FROM #t')).toThrow('Disallowed SQL: #t');
    expect(() => assertAllowedSql('SELECT 1 FROM #temp')).toThrow('Disallowed SQL: #temp');
    expect(() => assertAllowedSql('select 1 from ##global')).toThrow('Disallowed SQL: ##global');
  });

  it('rejects a dotted part that is not an allowed word', () => {
    expect(() => assertAllowedSql('SELECT t.foo FROM [s].[t] AS t')).toThrow('Disallowed SQL: foo');
  });

  it('rejects sys names outside the catalog allow-list', () => {
    expect(() => assertAllowedSql('SELECT 1 FROM sys.dm_exec_requests')).toThrow(
      'Disallowed SQL: sys.dm_exec_requests',
    );
  });

  it('rejects an unterminated string literal', () => {
    expect(() => assertAllowedSql("SELECT 'abc")).toThrow(/^Disallowed SQL: /);
  });
});

describe('allow-list exports', () => {
  it('exports upper-cased function and keyword sets', () => {
    expect(ALLOWED_FUNCTIONS.has('HASHBYTES')).toBe(true);
    expect(ALLOWED_FUNCTIONS.has('DATE')).toBe(true);
    expect(ALLOWED_FUNCTIONS.has('CONCAT')).toBe(false);
    expect(ALLOWED_KEYWORDS.has('SELECT')).toBe(true);
    expect(ALLOWED_KEYWORDS.has('JOIN')).toBe(true);
    expect(ALLOWED_KEYWORDS.has('MERGE')).toBe(false);
  });
});

describe('catalog column additions', () => {
  it('accepts is_unique_constraint as a catalog column', () => {
    expect(() => assertAllowedSql('SELECT i.name FROM sys.indexes AS i WHERE i.is_unique_constraint = 1')).not.toThrow();
  });
});
