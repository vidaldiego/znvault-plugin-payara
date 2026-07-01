import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalChecksum, canonicalChecksumFile, CHECKSUM_ALGO } from '../../src/migrate/checksum.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYN = join(__dirname, 'golden/synthetic');
const synGold = JSON.parse(readFileSync(join(__dirname, 'golden/synthetic-golden.json'), 'utf8')).checksums as Record<string, string>;

describe('canonicalChecksum (sha256-lf-v1)', () => {
  it('algo constant matches', () => expect(CHECKSUM_ALGO).toBe('sha256-lf-v1'));

  for (const name of ['bom.sql', 'crlf.sql', 'bare-cr.sql', 'non-ascii.sql']) {
    it(`matches Kotlin golden for ${name}`, () => {
      const buf = readFileSync(join(SYN, name));
      expect(canonicalChecksum(buf)).toBe(synGold[name]);
    });
  }

  it('CRLF and LF of the same content hash identically', () => {
    expect(canonicalChecksum(Buffer.from('A;\r\nB;\r\n'))).toBe(canonicalChecksum(Buffer.from('A;\nB;\n')));
  });
});

// Corpus conformance: TS hex must match Kotlin hex for every real corpus migration file
const corpus = JSON.parse(readFileSync(join(__dirname, 'golden/corpus-golden.json'), 'utf8')).checksums as Record<string, string>;
const MIG = process.env['ZINCAPI_MIGRATIONS_DIR'];

describe('corpus checksum conformance', () => {
  if (MIG) {
    for (const [rel, hex] of Object.entries(corpus)) {
      it(`checksum ${rel}`, () => expect(canonicalChecksumFile(join(MIG, rel))).toBe(hex));
    }
  } else {
    it('ZINCAPI_MIGRATIONS_DIR not set — skipping corpus tests', () => {
      // intentional skip: set ZINCAPI_MIGRATIONS_DIR=/path/to/zincapi-parent/docs/migrations to run
    });
  }
});
