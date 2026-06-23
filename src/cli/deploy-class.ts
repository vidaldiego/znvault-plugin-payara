// Path: src/cli/deploy-class.ts
// Pure helpers for the multi-class deploy model: resolve a class against the
// config-level shared defaults, and partition the --class selection.

import type { DeployConfig, DeployClass, HAProxyConfig } from './types.js';

/** A class with all shared defaults resolved and `blocking` made concrete. */
export type ResolvedClass = DeployClass & { blocking: boolean };

/** True iff the haproxy config exists AND has a non-empty serverMap (i.e. actually drains). */
export function hasActiveServerMap(haproxy?: HAProxyConfig): boolean {
  return !!haproxy && !!haproxy.serverMap && Object.keys(haproxy.serverMap).length > 0;
}

/**
 * Resolve one class against the config-level shared defaults.
 * Rule: class value wins if present, else inherit the base; objects replace
 * wholesale (no deep-merge). quiesce/hostConfigs do NOT inherit (per-class only).
 */
export function resolveClass(base: DeployConfig, cls: DeployClass): ResolvedClass {
  const pick = <T>(c: T | undefined, b: T | undefined): T | undefined => (c !== undefined ? c : b);

  const resolved: ResolvedClass = {
    name: cls.name,
    hosts: cls.hosts,
    // SharedDeployDefaults — class wins, else base; objects replace wholesale:
    warPath: pick(cls.warPath, base.warPath),
    port: pick(cls.port, base.port),
    tunnel: pick(cls.tunnel, base.tunnel),
    ssh: pick(cls.ssh, base.ssh),
    tls: pick(cls.tls, base.tls),
    healthCheck: pick(cls.healthCheck, base.healthCheck),
    haproxy: pick(cls.haproxy, base.haproxy),
    strategy: pick(cls.strategy, base.strategy),
    // Per-class only — never inherit:
    quiesce: cls.quiesce,
    hostConfigs: cls.hostConfigs,
    // blocking resolved below:
    blocking: false,
  };

  resolved.blocking = cls.blocking !== undefined
    ? cls.blocking
    : hasActiveServerMap(resolved.haproxy);

  return resolved;
}
