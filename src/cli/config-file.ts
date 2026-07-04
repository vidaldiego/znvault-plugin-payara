// Path: src/cli/config-file.ts
// Read a DeployConfig from a JSON file, optionally anchoring it to a --with-root
// base (sets/overrides rootDir). Shared by `import` and deploy-from-file.
// Does NOT validate or resolve paths — callers use validateDeployConfig /
// resolveConfigPaths so import and deploy share identical semantics.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeployConfig } from './types.js';
import { expandTilde } from './deploy-config-paths.js';

export function loadConfigFromFile(filePath: string, withRoot?: string): DeployConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`config file not found: ${filePath}`);
    throw new Error(`could not read config file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config file is not valid JSON: ${filePath} (${e instanceof Error ? e.message : String(e)})`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file must contain a single DeployConfig object: ${filePath}`);
  }

  const config = parsed as DeployConfig;

  if (withRoot !== undefined && withRoot !== '') {
    // resolve() anchors a relative --with-root (e.g. '.') against process.cwd();
    // expandTilde handles a leading ~. This OVERRIDES any rootDir in the file.
    config.rootDir = resolve(expandTilde(withRoot));
  }

  return config;
}
