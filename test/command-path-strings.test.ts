import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Files whose user-facing strings must not reference the removed `deploy …` paths.
const FILES = [
  'src/cli/commands/deploy-run.ts',
  'src/cli/commands/deploy-config.ts',
  'src/cli/commands/tls.ts',
  'src/cli/commands/helpers.ts',
  'src/cli/listr-deploy.ts',
];

// Patterns that indicate a stale CLI command path in a user-facing string.
// These match the OLD paths; none should remain after this task.
const STALE = [
  /znvault deploy config/,
  /znvault deploy tls/,
  /'deploy run /,
  /'deploy config /,
  /'deploy war /,
  /"znvault deploy /,
];

describe('no stale deploy command-path strings', () => {
  it.each(FILES)('%s has no old deploy-command hints', (rel) => {
    const src = readFileSync(join(process.cwd(), rel), 'utf-8');
    for (const re of STALE) {
      expect(src, `${rel} contains stale path matching ${re}`).not.toMatch(re);
    }
  });
});
