// Test-time guard: generated T-SQL may only use constructs known to run on
// both Azure Synapse dedicated and serverless pools.

const FUNCTION_NAMES = [
  'HASHBYTES', 'CAST', 'CONVERT', 'SUBSTRING', 'COUNT_BIG', 'SUM', 'DATALENGTH',
  'RTRIM', 'UPPER', 'LEFT', 'SWITCHOFFSET', 'OBJECT_ID', 'SERVERPROPERTY', 'IN',
  'nvarchar', 'varchar', 'decimal', 'datetime2', 'time', 'float', 'bigint', 'int', 'date',
];

const KEYWORD_NAMES = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'AS', 'AND', 'OR', 'NOT', 'IN',
  'IS', 'NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'TOP', 'HAVING',
  'ASC', 'JOIN', 'ON', 'INNER', 'LEFT',
];

const TYPE_NAMES = [
  'nvarchar', 'varchar', 'decimal', 'datetime2', 'time', 'float', 'bigint', 'int', 'date',
];

const SYS_CATALOG_NAMES = [
  'columns', 'types', 'objects', 'schemas', 'indexes', 'index_columns', 'databases',
];

export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(
  FUNCTION_NAMES.map((n) => n.toUpperCase()),
);

export const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set(
  KEYWORD_NAMES.map((n) => n.toUpperCase()),
);

const TYPE_SET: ReadonlySet<string> = new Set(TYPE_NAMES.map((n) => n.toUpperCase()));
const SYS_CATALOG_SET: ReadonlySet<string> = new Set(SYS_CATALOG_NAMES);

const ALIAS_RE =
  /^(kh|rh|knull|b24|b1|b2|cnt|dk|s1|s2|k_\d+|v_\d+|n_\d+|h|x|name|type_name|max_length|precision|scale|is_nullable|column_id|schema_name|object_name|object_type|is_primary_key|is_unique_constraint|engine_edition|key_ordinal|c|t|s|o|i|ic|object_id|user_type_id|schema_id|type|index_id|is_unique)$/;

type TokKind = 'word' | 'bracket' | 'literal' | 'number' | 'op' | 'hash' | 'other';

interface Tok {
  kind: TokKind;
  text: string;
}

function fail(token: string): never {
  throw new Error(`Disallowed SQL: ${token}`);
}

// Returns the index just past the closing delimiter. A doubled closer is an escape.
function scanQuoted(sql: string, start: number, close: string): number {
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return fail(sql.slice(start));
}

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      const end = scanQuoted(sql, i, "'");
      out.push({ kind: 'literal', text: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (c === '[') {
      const end = scanQuoted(sql, i, ']');
      out.push({ kind: 'bracket', text: sql.slice(i, end) });
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      // T-SQL N'...' prefix: drop it so the literal is handled as one token.
      if (word.toUpperCase() === 'N' && sql[j] === "'") {
        i = j;
        continue;
      }
      out.push({ kind: 'word', text: word });
      i = j;
      continue;
    }
    if (c === '#') {
      let j = i;
      while (j < n && sql[j] === '#') j++;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) j++;
      out.push({ kind: 'hash', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      if (sql[j] === '.' && j + 1 < n && /[0-9]/.test(sql[j + 1])) {
        j++;
        while (j < n && /[0-9]/.test(sql[j])) j++;
      }
      out.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      out.push({ kind: 'op', text: two });
      i += 2;
      continue;
    }
    if ('=<>+-*/%,().;'.includes(c)) {
      out.push({ kind: 'op', text: c });
      i++;
      continue;
    }
    out.push({ kind: 'other', text: c });
    i++;
  }
  return out;
}

function isName(t: Tok | undefined): boolean {
  return t !== undefined && (t.kind === 'word' || t.kind === 'bracket');
}

function checkBareWord(text: string): void {
  const upper = text.toUpperCase();
  if (ALLOWED_KEYWORDS.has(upper) || TYPE_SET.has(upper) || upper === 'MAX' || ALIAS_RE.test(text)) {
    return;
  }
  fail(text);
}

export function assertAllowedSql(sql: string): void {
  const toks = tokenize(sql);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === 'literal' || t.kind === 'number' || t.kind === 'op') {
      i++;
      continue;
    }
    if (t.kind === 'hash' || t.kind === 'other') fail(t.text);

    // Collect a name chain such as a, [a], a.b or [a].[b].
    const parts: Tok[] = [t];
    let j = i + 1;
    while (
      j + 1 < toks.length &&
      toks[j].kind === 'op' &&
      toks[j].text === '.' &&
      isName(toks[j + 1])
    ) {
      parts.push(toks[j + 1]);
      j += 2;
    }
    const next = toks[j];
    const followedByParen = next !== undefined && next.kind === 'op' && next.text === '(';
    const joined = parts.map((p) => p.text).join('.');

    if (parts.length === 1) {
      if (t.kind === 'word') {
        if (followedByParen) {
          const upper = t.text.toUpperCase();
          if (!ALLOWED_FUNCTIONS.has(upper) && !ALLOWED_KEYWORDS.has(upper)) fail(t.text);
        } else {
          checkBareWord(t.text);
        }
      } else if (followedByParen) {
        // A bracketed name used as a function call is never allowed.
        fail(joined);
      }
      i = j;
      continue;
    }

    // Dotted name (two or more parts).
    if (parts.length > 2 || followedByParen) fail(joined);

    if (parts[0].kind === 'word' && parts[0].text.toUpperCase() === 'SYS') {
      if (parts[1].kind !== 'word' || !SYS_CATALOG_SET.has(parts[1].text.toLowerCase())) {
        fail(joined);
      }
    } else {
      for (const p of parts) {
        if (p.kind === 'word') checkBareWord(p.text);
      }
    }
    i = j;
  }
}
