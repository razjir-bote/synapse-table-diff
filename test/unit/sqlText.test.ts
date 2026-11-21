import { describe, it, expect } from 'vitest';
import { quoteIdent, sqlString, qualifiedName } from '../../src/sql/sqlText';

describe('sqlText', () => {
  it('quoteIdent escapes closing brackets', () => {
    expect(quoteIdent('odd]x')).toBe('[odd]]x]');
  });
  it('sqlString makes an escaped N literal', () => {
    expect(sqlString("it's")).toBe("N'it''s'");
  });
  it('qualifiedName quotes schema and name', () => {
    expect(qualifiedName({ schema: 'dbo', name: 'a b' })).toBe('[dbo].[a b]');
  });
});
