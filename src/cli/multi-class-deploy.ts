// Path: src/cli/multi-class-deploy.ts
// Orchestrates a multi-class deploy: run each class in config order via the
// injected runClass callback, applying the blocking gate between classes.
// Pure of I/O — the CLI injects runClass (preflight + tunnels + executeListrDeployment).

import type { DeployContext } from './listr-deploy.js';
import type { ResolvedClass } from './deploy-class.js';
import { ANSI } from './constants.js';

export interface ClassOutcome {
  name: string;
  blocking: boolean;
  ran: boolean;
  ctx?: DeployContext;
  skippedReason?: 'no-hosts' | 'upstream-abort' | 'interrupted';
}

export interface MultiClassResult {
  classes: ClassOutcome[];
  abortedAt?: string;
}

/** The blocking gate: a class "failed" iff failed>0 || aborted || healthCheckFailed>0. NOT workerFailed. */
export function classGateFailed(ctx: DeployContext): boolean {
  return ctx.failed > 0 || ctx.aborted || ctx.healthCheckFailed > 0;
}

/**
 * Print the dry-run plan for a multi-class deploy.
 * Shows each resolved class in config order: name, blocking, strategy, drain, hosts.
 */
export function printMultiClassDryRun(resolved: ResolvedClass[], isPlain: boolean): void {
  if (isPlain) {
    console.log('Dry run - multi-class deploy plan:');
  } else {
    console.log(`\n${ANSI.bold}Dry run — multi-class deploy plan:${ANSI.reset}`);
  }
  resolved.forEach((rc, i) => {
    const blockLabel = rc.blocking ? 'blocking' : 'non-blocking';
    const strategyLabel = rc.strategy ?? 'sequential';
    const drainLabel = rc.haproxy && rc.haproxy.serverMap && Object.keys(rc.haproxy.serverMap).length > 0
      ? 'drain'
      : 'no-drain';
    const hostsLabel = rc.hosts.length > 0 ? rc.hosts.join(', ') : '(no hosts)';
    if (isPlain) {
      console.log(`  ${i + 1}. ${rc.name} [${blockLabel}] strategy=${strategyLabel} ${drainLabel} hosts=${hostsLabel}`);
    } else {
      console.log(`  ${ANSI.bold}${i + 1}. ${rc.name}${ANSI.reset} [${blockLabel}] strategy=${strategyLabel} ${drainLabel} hosts=${hostsLabel}`);
    }
  });
}

/**
 * Print a summary of a completed multi-class deploy.
 */
export function printMultiClassSummary(result: MultiClassResult, isPlain: boolean): void {
  console.log('');
  if (result.abortedAt) {
    if (isPlain) {
      console.log(`Multi-class deploy ABORTED at class '${result.abortedAt}'.`);
    } else {
      console.log(`${ANSI.red}${ANSI.bold}Multi-class deploy ABORTED${ANSI.reset} at class '${result.abortedAt}'.`);
    }
  }
  for (const outcome of result.classes) {
    let statusLabel: string;
    if (!outcome.ran) {
      statusLabel = outcome.skippedReason === 'upstream-abort'
        ? 'not run (upstream-abort)'
        : outcome.skippedReason === 'no-hosts'
          ? 'skipped (no hosts)'
          : `skipped (${outcome.skippedReason ?? 'unknown'})`;
    } else if (outcome.ctx) {
      const c = outcome.ctx;
      const parts: string[] = [`${c.successful} succeeded`];
      if (c.failed > 0) parts.push(`${c.failed} failed`);
      if (c.healthCheckFailed > 0) parts.push(`${c.healthCheckFailed} unhealthy`);
      if (c.workerFailed > 0) parts.push(`${c.workerFailed} worker(s) failed`);
      if (c.skipped > 0) parts.push(`${c.skipped} skipped`);
      statusLabel = parts.join(', ');
    } else {
      statusLabel = 'ran';
    }
    const blockLabel = outcome.blocking ? '[blocking]' : '[non-blocking]';
    if (isPlain) {
      console.log(`  ${outcome.name} ${blockLabel}: ${statusLabel}`);
    } else {
      const color = (!outcome.ran && outcome.skippedReason === 'upstream-abort') || (outcome.ctx && (outcome.ctx.failed > 0 || outcome.ctx.healthCheckFailed > 0))
        ? ANSI.red
        : outcome.ran ? ANSI.green : ANSI.yellow;
      console.log(`  ${color}${outcome.name}${ANSI.reset} ${blockLabel}: ${statusLabel}`);
    }
  }
}

export async function executeMultiClassDeployment(
  resolvedClasses: ResolvedClass[],
  runClass: (rc: ResolvedClass) => Promise<DeployContext>,
  log: { warn(m: string): void; info(m: string): void },
): Promise<MultiClassResult> {
  const result: MultiClassResult = { classes: [] };
  let aborted = false;

  for (const rc of resolvedClasses) {
    if (aborted) {
      result.classes.push({ name: rc.name, blocking: rc.blocking, ran: false, skippedReason: 'upstream-abort' });
      continue;
    }

    if (rc.hosts.length === 0) {
      log.warn(`class '${rc.name}' has no hosts — skipping`);
      result.classes.push({ name: rc.name, blocking: rc.blocking, ran: false, skippedReason: 'no-hosts' });
      continue; // a skipped class never gates
    }

    const ctx = await runClass(rc);
    result.classes.push({ name: rc.name, blocking: rc.blocking, ran: true, ctx });

    const failed = classGateFailed(ctx);
    if (failed && rc.blocking) {
      result.abortedAt = rc.name;
      aborted = true;
    } else if (failed) {
      log.warn(`class '${rc.name}' FAILED (non-blocking) — continuing`);
    }
  }

  return result;
}
