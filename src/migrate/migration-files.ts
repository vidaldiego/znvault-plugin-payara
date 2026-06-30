import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELPER_RE = /^(0000_)[^/]*\.sql$/;
const PREFIX_RE = /^(\d{4}-\d{2}-\d{2}_\d{3})_[^/]*\.sql$/;

export interface MigrationFile { version: string; prefix: string; path: string; }
export class DuplicatePrefixError extends Error {
  constructor(prefix: string, files: string[]) {
    super(`Duplicate migration prefix '${prefix}': ${files.join(', ')}. Rename to unique monotonic prefixes.`);
    this.name = 'DuplicatePrefixError';
  }
}
export function parsePrefix(filename: string): string {
  const h = HELPER_RE.exec(filename); if (h) return h[1]!;
  const p = PREFIX_RE.exec(filename); if (p) return p[1]!;
  throw new Error(`Migration filename must match 0000_*.sql or YYYY-MM-DD_NNN_*.sql: ${filename}`);
}
export function discover(dir: string): MigrationFile[] {
  const files = readdirSync(dir)                                  // shallow — subdirs (baseline/, archive/) not descended
    .filter((name) => name.endsWith('.sql') && statSync(join(dir, name)).isFile())
    .map((name) => ({ version: name, prefix: parsePrefix(name), path: join(dir, name) }))
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  const byPrefix = new Map<string, string[]>();
  for (const f of files) (byPrefix.get(f.prefix) ?? byPrefix.set(f.prefix, []).get(f.prefix)!).push(f.version);
  for (const [prefix, dups] of byPrefix) if (dups.length > 1) throw new DuplicatePrefixError(prefix, dups);
  return files;
}
