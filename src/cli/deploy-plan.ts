// Path: src/cli/deploy-plan.ts
// Pure resolution of the six deploy-run migration/rollout flags to a plan.
// Zero I/O — the CLI action consumes { plan | error }.

export interface DeployPlan {
  /** Run the pre-deploy migration phase. */
  runPre: boolean;
  /** Run the post-deploy migration phase (intent; still gated on rollout success at the call site). */
  runPost: boolean;
  /** Run the WAR rollout. False for the three `-only` flags. */
  runRollout: boolean;
}

export interface DeployFlags {
  skipMigrations?: boolean;
  skipPre?: boolean;
  skipPost?: boolean;
  migrationsOnly?: boolean;
  preOnly?: boolean;
  postOnly?: boolean;
}

const ONLY_FLAGS: Array<keyof DeployFlags> = ['migrationsOnly', 'preOnly', 'postOnly'];
const SKIP_FLAGS: Array<keyof DeployFlags> = ['skipMigrations', 'skipPre', 'skipPost'];

const FLAG_LABEL: Record<keyof DeployFlags, string> = {
  skipMigrations: '--skip-migrations',
  skipPre: '--skip-pre',
  skipPost: '--skip-post',
  migrationsOnly: '--migrations-only',
  preOnly: '--pre-only',
  postOnly: '--post-only',
};

/**
 * Resolve the six flags to a { runPre, runPost, runRollout } plan, or an error
 * string for any contradictory combination (spec §3a rules 1–4).
 */
export function resolveDeployPlan(flags: DeployFlags): { plan?: DeployPlan; error?: string } {
  const onlySet = ONLY_FLAGS.filter((f): f is keyof DeployFlags => !!flags[f]);
  const skipSet = SKIP_FLAGS.filter((f): f is keyof DeployFlags => !!flags[f]);

  // Rule 1: two -only flags together.
  if (onlySet.length > 1) {
    return { error: `${FLAG_LABEL[onlySet[0]!]} and ${FLAG_LABEL[onlySet[1]!]} are mutually exclusive.` };
  }
  // Rule 2: any -only + any -skip.
  if (onlySet.length === 1 && skipSet.length >= 1) {
    return { error: `${FLAG_LABEL[onlySet[0]!]} cannot be combined with ${FLAG_LABEL[skipSet[0]!]} (the -only flag already scopes the phases).` };
  }
  // Rules 3 & 4: skip-pre/skip-post pairings.
  if (flags.skipMigrations && flags.skipPre) {
    return { error: `--skip-migrations already skips pre-deploy migrations; drop --skip-pre.` };
  }
  if (flags.skipMigrations && flags.skipPost) {
    return { error: `--skip-migrations already skips post-deploy migrations; drop --skip-post.` };
  }
  if (flags.skipPre && flags.skipPost) {
    return { error: `--skip-pre and --skip-post together — use --skip-migrations to skip both.` };
  }

  // Valid states.
  if (flags.migrationsOnly) return { plan: { runPre: true, runPost: true, runRollout: false } };
  if (flags.preOnly) return { plan: { runPre: true, runPost: false, runRollout: false } };
  if (flags.postOnly) return { plan: { runPre: false, runPost: true, runRollout: false } };

  return {
    plan: {
      runPre: !(flags.skipMigrations || flags.skipPre),
      runPost: !(flags.skipMigrations || flags.skipPost),
      runRollout: true,
    },
  };
}
