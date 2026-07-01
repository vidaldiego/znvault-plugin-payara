import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CHECKSUM_ALGO = 'sha256-lf-v1';

/**
 * Compute the canonical sha256-lf-v1 checksum of a migration file buffer.
 *
 * Algorithm (byte-level — never decode to string):
 *   1. Strip UTF-8 BOM (EF BB BF) at offset 0, if present.
 *   2. Remove ALL 0x0D bytes (bare CR and CR in CRLF pairs).
 *   3. SHA-256 the resulting bytes.
 *   4. Return lowercase hex.
 *
 * This matches the Kotlin MigrationChecksummer implementation exactly.
 */
export function canonicalChecksum(buf: Buffer): string {
  let b = buf;
  // Strip UTF-8 BOM at offset 0
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    b = b.subarray(3);
  }
  // Drop every 0x0D byte (CR), producing a pure-LF buffer
  const lf = Buffer.from(b.filter((byte) => byte !== 0x0d));
  return createHash('sha256').update(lf).digest('hex');
}

/**
 * Read a migration file from disk and return its canonical sha256-lf-v1 checksum.
 */
export function canonicalChecksumFile(path: string): string {
  return canonicalChecksum(readFileSync(path));
}
