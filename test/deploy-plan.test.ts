import { describe, it, expect } from 'vitest';
import { resolveDeployPlan } from '../src/cli/deploy-plan.js';

describe('resolveDeployPlan — valid states', () => {
  const cases: Array<[string, Record<string, boolean>, { runPre: boolean; runPost: boolean; runRollout: boolean }]> = [
    ['none', {}, { runPre: true, runPost: true, runRollout: true }],
    ['skipMigrations', { skipMigrations: true }, { runPre: false, runPost: false, runRollout: true }],
    ['skipPre', { skipPre: true }, { runPre: false, runPost: true, runRollout: true }],
    ['skipPost', { skipPost: true }, { runPre: true, runPost: false, runRollout: true }],
    ['migrationsOnly', { migrationsOnly: true }, { runPre: true, runPost: true, runRollout: false }],
    ['preOnly', { preOnly: true }, { runPre: true, runPost: false, runRollout: false }],
    ['postOnly', { postOnly: true }, { runPre: false, runPost: true, runRollout: false }],
  ];
  it.each(cases)('%s', (_label, flags, expected) => {
    const { plan, error } = resolveDeployPlan(flags);
    expect(error).toBeUndefined();
    expect(plan).toEqual(expected);
  });
});

describe('resolveDeployPlan — contradictions', () => {
  const bad: Array<[string, Record<string, boolean>]> = [
    ['two only flags', { migrationsOnly: true, preOnly: true }],
    ['post-only + pre-only', { postOnly: true, preOnly: true }],
    ['only + skip', { preOnly: true, skipPost: true }],
    ['migrations-only + skip-migrations', { migrationsOnly: true, skipMigrations: true }],
    ['skip-migrations + skip-pre', { skipMigrations: true, skipPre: true }],
    ['skip-migrations + skip-post', { skipMigrations: true, skipPost: true }],
    ['skip-pre + skip-post', { skipPre: true, skipPost: true }],
  ];
  it.each(bad)('%s → error, no plan', (_label, flags) => {
    const { plan, error } = resolveDeployPlan(flags);
    expect(plan).toBeUndefined();
    expect(error).toBeTruthy();
    // Error names both offending flags.
    expect(error!.length).toBeGreaterThan(0);
  });
});
