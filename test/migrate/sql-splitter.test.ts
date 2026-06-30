import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitStatements } from '../../src/migrate/sql-splitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('splitStatements', () => {
  it('splits on ; outside strings', () =>
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]));
  it('DELIMITER directive switches + is not emitted', () =>
    expect(splitStatements("DELIMITER $$\nCREATE PROC$$\nDELIMITER ;\n")).toEqual(["CREATE PROC"]));
  it('DELIMITER token stops at trailing comment (mysqldump shape)', () =>
    expect(splitStatements("DELIMITER ;;  -- x\nA;;B;;")).toEqual(["A", "B"]));
  it('bare \\r is NOT a line start — DELIMITER not recognized', () =>
    // \rDELIMITER must be treated as content (not a directive), so the default ; still splits.
    // trim() strips the leading \r, matching Kotlin String.trim() behaviour.
    expect(splitStatements("SELECT 1;\rDELIMITER $$\nSELECT 2;")).toEqual(["SELECT 1", "DELIMITER $$\nSELECT 2"]));
  it('doubled single-quote is an escape, not a boundary', () =>
    expect(splitStatements("SELECT 'a;;b'; SELECT 1;")).toEqual(["SELECT 'a;;b'", "SELECT 1"]));
  it('executable /*! */ comment is code (emitted)', () =>
    expect(splitStatements("/*!40101 SET X=1 */;")).toEqual(["/*!40101 SET X=1 */"]));
  it('ordinary comment-only buffer is suppressed', () =>
    expect(splitStatements("SELECT 1;\n-- trailing\n")).toEqual(["SELECT 1"]));
  it('line comment with # is suppressed', () =>
    expect(splitStatements("SELECT 1;\n# note\n")).toEqual(["SELECT 1"]));
});

// assert splitStatements(file) == Kotlin golden split for every corpus file (incl. baseline /*!...*/)
const corpus = JSON.parse(readFileSync(join(__dirname, 'golden/corpus-golden.json'), 'utf8')).splits as Record<string, string[]>;
const MIG = process.env['ZINCAPI_MIGRATIONS_DIR'];

describe('corpus split conformance', () => {
  if (MIG) {
    for (const [rel, stmts] of Object.entries(corpus)) {
      it(`split ${rel}`, () => expect(splitStatements(readFileSync(join(MIG, rel), 'utf8'))).toEqual(stmts));
    }
  } else {
    it('ZINCAPI_MIGRATIONS_DIR not set — skipping corpus tests', () => {
      // intentional skip: set ZINCAPI_MIGRATIONS_DIR=/path/to/zincapi-parent/docs/migrations to run
    });
  }
});
