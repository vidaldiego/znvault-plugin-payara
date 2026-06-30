import { readFileSync } from 'node:fs';
const RE = /^--\s*BASELINE_MARKER:\s*(\S+)\s*$/m;
export function readBaselineMarker(path: string): string | null {
  try { return RE.exec(readFileSync(path, 'utf8'))?.[1] ?? null; } catch { return null; }
}
