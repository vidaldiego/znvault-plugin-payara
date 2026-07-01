// Faithful port of utilities/.../SqlStatementSplitter.kt. Same single-pass cursor + flags.

/**
 * Split a SQL string into individual statements, respecting:
 * - DELIMITER directives (case-insensitive, only at line start, only when no code seen yet)
 * - Line comments (-- and #): copied verbatim, do NOT set sawCode
 * - Block comments (/* ... * /): copied verbatim; executable comments (/*! ... * /) set sawCode
 * - Quoted strings/identifiers: backslash-escape inside ' and "; doubled quote is close+reopen
 * - Delimiter match → flush buffer
 * - Non-whitespace outside comments → sawCode = true
 * - flush() emits only when trimmed non-empty AND sawCode (suppresses comment-only buffers)
 *
 * NOTE: operates on the RAW file string — does NOT normalize CRLF→LF.
 * A bare \r is NOT treated as a newline (so \rDELIMITER $$ is NOT recognized as a directive).
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let delimiter = ';';
  let i = 0;
  const n = sql.length;
  let sawCode = false;

  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  /**
   * Returns true if position idx is at a line start.
   * Scans backwards over space/tab/\r — a bare \r is NOT a line boundary.
   * Only \n (or beginning-of-file) counts as a line start.
   */
  const atLineStart = (idx: number): boolean => {
    let j = idx - 1;
    while (j >= 0 && (sql[j] === ' ' || sql[j] === '\t' || sql[j] === '\r')) j--;
    return j < 0 || sql[j] === '\n';
  };

  const flush = () => {
    const s = current.trim();
    if (s.length > 0 && sawCode) statements.push(s);
    current = '';
    sawCode = false;
  };

  const regionMatches = (idx: number, word: string, ci: boolean): boolean => {
    if (idx + word.length > n) return false;
    const seg = sql.substring(idx, idx + word.length);
    return ci ? seg.toUpperCase() === word.toUpperCase() : seg === word;
  };

  while (i < n) {
    const c = sql[i] as string;

    // DELIMITER directive — only at line start, only when no code seen yet
    if (
      (c === 'D' || c === 'd') &&
      atLineStart(i) &&
      !sawCode &&
      regionMatches(i, 'DELIMITER', true) &&
      (i + 9 >= n || isWs(sql[i + 9] ?? '\n'))
    ) {
      // Skip past "DELIMITER" keyword
      let j = i + 9;
      // Skip horizontal whitespace before the token
      while (j < n && (sql[j] === ' ' || sql[j] === '\t')) j++;
      const start = j;
      // Collect the new delimiter token — stop at whitespace or trailing comment
      while (j < n) {
        const ch = sql[j];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
        if (ch === '-' && j + 1 < n && sql[j + 1] === '-') break;
        if (ch === '#') break;
        if (ch === '/' && j + 1 < n && sql[j + 1] === '*') break;
        j++;
      }
      const newDelim = sql.substring(start, j);
      if (newDelim.length > 0) delimiter = newDelim;
      // Consume the rest of the line (up to but not including the \n)
      while (j < n && sql[j] !== '\n') j++;
      i = j + 1;
      continue;
    }

    // Line comment: -- (copied verbatim, does NOT set sawCode)
    if (c === '-' && i + 1 < n && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      continue;
    }

    // Line comment: # (copied verbatim, does NOT set sawCode)
    if (c === '#') {
      while (i < n && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: /* ... */ (executable /*! ... */ sets sawCode)
    if (c === '/' && i + 1 < n && sql[i + 1] === '*') {
      const isExec = i + 2 < n && sql[i + 2] === '!';
      current += c;
      current += sql[i + 1];
      i += 2;
      while (i < n && !(sql[i] === '*' && i + 1 < n && sql[i + 1] === '/')) {
        current += sql[i];
        i++;
      }
      if (i + 1 < n) {
        current += '*/';
        i += 2;
      }
      if (isExec) sawCode = true;
      continue;
    }

    // Quoted strings and identifiers: ', ", `
    if (c === "'" || c === '"' || c === '`') {
      sawCode = true;
      const quote = c;
      current += c;
      i++;
      while (i < n) {
        const q = sql[i];
        current += q;
        // Backslash escape inside ' and " (not backtick)
        if (q === '\\' && (quote === "'" || quote === '"') && i + 1 < n) {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        // Doubled quote = close-then-reopen (same quote-toggle path)
        if (q === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            current += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Delimiter match → flush the buffer
    if (regionMatches(i, delimiter, false)) {
      flush();
      i += delimiter.length;
      continue;
    }

    // Any non-whitespace char outside a comment → sawCode = true
    if (!/\s/.test(c)) sawCode = true;
    current += c;
    i++;
  }

  flush();
  return statements;
}
