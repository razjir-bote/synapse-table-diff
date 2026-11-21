export function quoteIdent(s: string): string {
  return '[' + s.replace(/]/g, ']]') + ']';
}

export function sqlString(s: string): string {
  return "N'" + s.replace(/'/g, "''") + "'";
}

export function qualifiedName(t: { schema: string; name: string }): string {
  return quoteIdent(t.schema) + '.' + quoteIdent(t.name);
}
