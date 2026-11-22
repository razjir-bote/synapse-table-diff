/**
 * Defence-in-depth check for the user's free-text row filter, which is inserted
 * verbatim as `WHERE (\n<filter>\n)` on both sides. It blocks text that could end
 * the WHERE clause early or run a second statement. It is not a SQL parser:
 * a read-only database login is still the real safeguard.
 */

const FORBIDDEN_WORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY', 'GO', 'INTO', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE',
  'SHUTDOWN', 'BACKUP', 'RESTORE', 'DBCC', 'RECONFIGURE', 'WAITFOR',
];
const FORBIDDEN = new Set(FORBIDDEN_WORDS);

/** Returns a reason the filter is rejected, or undefined when it is acceptable. */
export function filterProblem(filter: string | undefined): string | undefined {
  if (filter === undefined || filter.trim() === '') return undefined;
  let code = '';
  let i = 0;
  const s = filter;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      // String literal with '' escapes (an N prefix is just a word before it).
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return 'The filter has an unterminated string literal.';
      code += ' ';
      continue;
    }
    if (c === '[') {
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === ']') {
          if (s[i + 1] === ']') { i += 2; continue; }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) return 'The filter has an unterminated [bracketed] name.';
      code += ' x ';
      continue;
    }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return 'The filter has an unterminated "quoted" name.';
      i = end + 1;
      code += ' x ';
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      // Line comment: skip to end of line (the generated SQL puts ")" on the next line).
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') return 'Block comments (/* */) are not allowed in the filter.';
    if (c === '*' && s[i + 1] === '/') return 'Block comments (/* */) are not allowed in the filter.';
    code += c;
    i++;
  }

  if (code.includes(';')) return 'The filter cannot contain ";".';
  let depth = 0;
  for (const ch of code) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return 'The filter has a ")" without a matching "(".';
    }
  }
  if (depth !== 0) return 'The filter has unbalanced parentheses.';

  for (const m of code.matchAll(/[A-Za-z_@#][A-Za-z0-9_@#$]*/g)) {
    const w = m[0].toUpperCase();
    if (FORBIDDEN.has(w)) return `The filter cannot use "${m[0]}". It must be a plain condition, such as region = 'EU'.`;
  }
  return undefined;
}
