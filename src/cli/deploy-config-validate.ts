// Path: src/cli/deploy-config-validate.ts
// Pure static validation of a DeployConfig — flat or multi-class.
// errors.length > 0 ⇒ a hard violation (deploy must abort before touching hosts).

import { isAbsolute } from 'node:path';
import type { DeployConfig, MigrationConfig } from './types.js';
import { resolveClass, hasActiveServerMap } from './deploy-class.js';
import { expandTilde } from './deploy-config-paths.js';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  info: string[];
}

/** Validate one migration block (pre or post). Pushes into the caller's arrays. */
function validateMigrationBlock(
  configName: string,
  block: MigrationConfig,
  label: 'migration' | 'postMigration',
  errors: string[],
  info: string[],
  hasRoot: boolean,
): void {
  const isPre = label === 'migration';
  if (!block.roleId || block.roleId.trim() === '') {
    errors.push(`config '${configName}' ${label} is missing roleId (the dynamic-secrets write role).`);
  }
  if (!block.migrationsDir || block.migrationsDir.trim() === '') {
    errors.push(`config '${configName}' ${label} is missing migrationsDir.`);
  }
  if (block.roleId && block.roleId.trim() !== '' && block.migrationsDir && block.migrationsDir.trim() !== '') {
    const when = isPre ? 'before rollout' : 'after a successful rollout';
    const suffix = isPre ? `; host/port/database come from the Vault dynamic-secrets connection.` : `.`;
    info.push(`config '${configName}' will run schema migrations ${when} (role '${block.roleId}', dir '${block.migrationsDir}')${suffix}`);
  }
  if (block.scaffoldingFile !== undefined) {
    if (typeof block.scaffoldingFile !== 'string' || block.scaffoldingFile.length === 0) {
      errors.push(`config '${configName}' ${label}.scaffoldingFile must be a non-empty filename or absolute path.`);
    } else if (!hasRoot && !isAbsolute(block.scaffoldingFile) && (block.scaffoldingFile.includes('/') || block.scaffoldingFile.includes('\\'))) {
      // When rootDir is set, a relative scaffoldingFile (with separators) is
      // valid — it resolves against rootDir. Only enforce the bare-filename rule
      // on the no-root path.
      errors.push(`config '${configName}' ${label}.scaffoldingFile must be a bare filename (relative to migrationsDir) or an absolute path — a relative path with separators is not allowed.`);
    }
  }
}

/** True if a value (after tilde-expansion) is a relative path. */
function isRelativeAfterTilde(value: string): boolean {
  return !isAbsolute(expandTilde(value));
}

export function validateDeployConfig(config: DeployConfig): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // ── rootDir + relative-local-path validation ──
  const rootDir = config.rootDir;
  // A relative rootDir has nothing to anchor to → hard error.
  if (rootDir !== undefined && rootDir !== '' && isRelativeAfterTilde(rootDir)) {
    errors.push(`config '${config.name}' rootDir must be an absolute path (or start with ~/): '${rootDir}'.`);
  }
  const hasRoot = rootDir !== undefined && rootDir !== '';

  // The 5 local fields, each with a label for the message.
  const localFields: Array<{ label: string; value: string | undefined }> = [
    { label: 'warPath', value: config.warPath },
    { label: 'migration.migrationsDir', value: config.migration?.migrationsDir },
    { label: 'migration.scaffoldingFile', value: config.migration?.scaffoldingFile },
    { label: 'postMigration.migrationsDir', value: config.postMigration?.migrationsDir },
    { label: 'postMigration.scaffoldingFile', value: config.postMigration?.scaffoldingFile },
  ];
  if (Array.isArray(config.classes)) {
    for (const c of config.classes) {
      if (c.warPath !== undefined) localFields.push({ label: `classes[${c.name}].warPath`, value: c.warPath });
    }
  }
  // Relative local path + no rootDir → WARNING (not error). Today these resolve
  // against cwd and are accepted (58+ existing fixtures rely on this); a hard
  // error would be a breaking change. Guide the user without failing validation.
  for (const f of localFields) {
    if (f.value !== undefined && f.value !== '' && !hasRoot && isRelativeAfterTilde(f.value)) {
      warnings.push(`config '${config.name}' ${f.label} is a relative path ('${f.value}') and no rootDir is configured — it will resolve against the current working directory; set rootDir for a stable base.`);
    }
  }

  const hasClasses = Array.isArray(config.classes);

  // ── Multi-class invariants ──
  if (hasClasses) {
    if (config.hosts && config.hosts.length > 0) {
      errors.push(`config '${config.name}' has both top-level hosts and classes — use one.`);
    }
    if (config.quiesce !== undefined || config.hostConfigs !== undefined) {
      errors.push(`config '${config.name}' has a top-level quiesce/hostConfigs — these are per-class only on a multi-class config.`);
    }
    const classes = config.classes!;
    if (classes.length === 0) {
      errors.push(`config '${config.name}' has an empty classes array.`);
    } else {
      // Unique names
      const seenNames = new Set<string>();
      for (const c of classes) {
        if (seenNames.has(c.name)) errors.push(`duplicate class name '${c.name}'.`);
        seenNames.add(c.name);
      }

      // No host in two classes
      const hostToClass = new Map<string, string>();
      for (const c of classes) {
        for (const h of c.hosts) {
          const prev = hostToClass.get(h);
          if (prev && prev !== c.name) {
            errors.push(`host ${h} appears in two classes ('${prev}' and '${c.name}').`);
          }
          hostToClass.set(h, c.name);
        }
      }

      const warPaths: string[] = [];
      for (const c of classes) {
        const r = resolveClass(config, c);

        // Resolved warPath/port
        if (!r.warPath) errors.push(`class '${c.name}' resolves no warPath (set it on the class or the config).`);
        if (r.port === undefined) errors.push(`class '${c.name}' resolves no port.`);
        if (r.warPath) warPaths.push(r.warPath);

        // Empty hosts → warn + skip (not error)
        if (c.hosts.length === 0) {
          warnings.push(`class '${c.name}' has no hosts — it will be skipped.`);
        }

        // serverMap ⊆ hosts (extra key → error), host ∉ serverMap (→ warn)
        const sm = r.haproxy?.serverMap;
        if (sm) {
          const hostSet = new Set(c.hosts);
          for (const key of Object.keys(sm)) {
            if (!hostSet.has(key)) {
              errors.push(`class '${c.name}' serverMap key ${key} is not in the class hosts.`);
            }
          }
          for (const h of c.hosts) {
            if (!(h in sm)) {
              warnings.push(`class '${c.name}' host ${h} is absent from its serverMap (would deploy without drain).`);
            }
          }
        }

        // Explicit blocking:true but no actual drain → warn
        if (c.blocking === true && !hasActiveServerMap(r.haproxy)) {
          warnings.push(`class '${c.name}' is blocking:true but has no draining serverMap — it can gate on deploy/health only.`);
        }
      }

      // Differing per-class WARs → neutral info (per-class WAR is a designed feature)
      const uniqueWars = Array.from(new Set(warPaths));
      if (uniqueWars.length > 1) {
        info.push(`classes use ${uniqueWars.length} different WARs: ${uniqueWars.join(', ')}.`);
      }
    }
  }

  // ── Migration config validation (applies to BOTH flat and multi-class) ──
  if (config.migration) {
    validateMigrationBlock(config.name, config.migration, 'migration', errors, info, hasRoot);
  }
  if (config.postMigration) {
    validateMigrationBlock(config.name, config.postMigration, 'postMigration', errors, info, hasRoot);
  }
  if (
    config.migration?.migrationsDir &&
    config.postMigration?.migrationsDir &&
    config.migration.migrationsDir.trim() === config.postMigration.migrationsDir.trim()
  ) {
    warnings.push(
      `config '${config.name}' uses the same migrationsDir for pre- and post-deploy migrations — ` +
        `the post-deploy phase will find nothing to run (the engine applies all-pending per dir). ` +
        `Use separate directories.`,
    );
  }

  return { errors, warnings, info };
}
