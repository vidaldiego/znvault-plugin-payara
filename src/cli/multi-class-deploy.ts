// Path: src/cli/multi-class-deploy.ts
// Orchestrates a multi-class deploy: run each class in config order via the
// injected runClass callback, applying the blocking gate between classes.
// Pure of I/O — the CLI injects runClass (preflight + tunnels + executeListrDeployment).

import type { DeployContext } from './listr-deploy.js';
import type { ResolvedClass } from './deploy-class.js';

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
