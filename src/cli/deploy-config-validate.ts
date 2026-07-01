// Path: src/cli/deploy-config-validate.ts
// Pure static validation of a DeployConfig — flat or multi-class.
// errors.length > 0 ⇒ a hard violation (deploy must abort before touching hosts).

import type { DeployConfig } from './types.js';
import { resolveClass, hasActiveServerMap } from './deploy-class.js';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  info: string[];
}

export function validateDeployConfig(config: DeployConfig): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

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
    if (!config.migration.roleId || config.migration.roleId.trim() === '') {
      errors.push(`config '${config.name}' migration is missing roleId (the dynamic-secrets write role).`);
    }
    if (!config.migration.migrationsDir || config.migration.migrationsDir.trim() === '') {
      errors.push(`config '${config.name}' migration is missing migrationsDir.`);
    }
    if (config.migration.roleId && config.migration.roleId.trim() !== '' &&
        config.migration.migrationsDir && config.migration.migrationsDir.trim() !== '') {
      info.push(`config '${config.name}' will run schema migrations before rollout (role '${config.migration.roleId}', dir '${config.migration.migrationsDir}'); host/port/database come from the Vault dynamic-secrets connection.`);
    }
  }

  return { errors, warnings, info };
}
