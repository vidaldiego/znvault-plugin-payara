import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createPayaraCLIPlugin } from '../src/cli.js';

function buildTree() {
  const program = new Command();
  const ctx: any = {
    output: { info() {}, warn() {}, success() {}, error() {}, table() {}, keyValue() {} },
    client: { get: async () => ({}), post: async () => ({}) },
    getConfig: () => ({ url: 'x' }),
    isPlainMode: () => true,
  };
  createPayaraCLIPlugin().registerCommands(program, ctx);
  return program;
}
const sub = (cmd: Command, name: string) => cmd.commands.find((c) => c.name() === name);

describe('payara command namespace', () => {
  it('registers a top-level "payara" group and NOT "deploy"', () => {
    const program = buildTree();
    expect(sub(program, 'payara')).toBeDefined();
    expect(sub(program, 'deploy')).toBeUndefined(); // hard move — no top-level deploy
  });

  it('nests deploy run/to/war under payara deploy', () => {
    const payara = sub(buildTree(), 'payara')!;
    const deploy = sub(payara, 'deploy')!;
    expect(deploy).toBeDefined();
    expect(sub(deploy, 'run')).toBeDefined();
    expect(deploy.commands.find((c) => c.aliases().includes('to'))).toBeDefined();
    expect(sub(deploy, 'war')).toBeDefined();
  });

  it('registers config, lifecycle, and tls as peers under payara', () => {
    const payara = sub(buildTree(), 'payara')!;
    expect(sub(payara, 'config')).toBeDefined();
    expect(sub(payara, 'restart')).toBeDefined();
    expect(sub(payara, 'status')).toBeDefined();
    expect(sub(payara, 'applications')).toBeDefined();
    expect(sub(payara, 'tls')).toBeDefined();
  });
});
