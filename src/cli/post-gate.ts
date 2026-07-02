// Path: src/cli/post-gate.ts
// Pure gating helpers for the post-deploy migration phase.
// Post-deploy migrations must run only when EVERY configured host reached the
// new WAR with no failures. These helpers compute that, fail-safe.

/** Reason a migration phase was skipped, for reason-tagged log lines. */
export type MigrationSkipReason =
  | { kind: 'flag'; flag: string }
  | { kind: 'scoped-subset' }
  | { kind: 'partial-coverage'; dropped: string[] }
  | { kind: 'rollout-failed' };

/** True iff the rollout had no failures — INCLUDING worker failures (S3). */
export function computeNoFailures(r: {
  failed: number;
  aborted: boolean;
  healthCheckFailed: number;
  workerFailed: number;
}): boolean {
  return !(r.failed > 0 || r.aborted || r.healthCheckFailed > 0 || r.workerFailed > 0);
}

/** True iff every configured host was deployed (none dropped pre-rollout — B1b). */
export function computeFullCoverage(deployedCount: number, configuredCount: number): boolean {
  return deployedCount === configuredCount;
}

/** True iff the deployed host set is a PROPER subset of the configured hosts (B1). */
export function isScopedDeploy(configuredHosts: string[], deployedHostSet: string[]): boolean {
  const configured = new Set(configuredHosts);
  const deployed = new Set(deployedHostSet);
  if (deployed.size >= configured.size) return false; // enumerates all → not scoped
  for (const h of deployed) {
    if (!configured.has(h)) return false; // unrelated host; not a config subset
  }
  return deployed.size < configured.size;
}

/**
 * Resolve WHY (if at all) the post-deploy phase should be skipped, top-down
 * precedence: flag > scoped-subset > partial-coverage > rollout-failed.
 * Returns undefined when post should run.
 */
export function resolvePostSkipReason(input: {
  runPost: boolean;
  runPostFlag?: string;
  isScoped: boolean;
  fullCoverage: boolean;
  noFailures: boolean;
  dropped: string[];
}): MigrationSkipReason | undefined {
  if (!input.runPost) return { kind: 'flag', flag: input.runPostFlag ?? '--skip-post' };
  if (input.isScoped) return { kind: 'scoped-subset' };
  if (!input.fullCoverage) return { kind: 'partial-coverage', dropped: input.dropped };
  if (!input.noFailures) return { kind: 'rollout-failed' };
  return undefined;
}
