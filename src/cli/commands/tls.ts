// Path: src/cli/commands/tls.ts
// TLS setup and verification commands

import type { Command } from 'commander';
import type { CLIPluginContext } from '../types.js';
import { loadDeployConfigs, saveDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import { agentGet, buildPluginUrl, configureTLS } from '../http-client.js';
import { getErrorMessage } from '../../utils/error.js';
import { withErrorHandling, getConfigOrExit } from './helpers.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Default directory for storing CA certificates */
const DEFAULT_CA_DIR = join(homedir(), '.znvault', 'ca');

/** Default CA certificate filename */
const DEFAULT_CA_FILENAME = 'agent-tls-ca.pem';

/**
 * Get the default CA certificate path
 */
function getDefaultCACertPath(): string {
  return join(DEFAULT_CA_DIR, DEFAULT_CA_FILENAME);
}

/**
 * Fetch and save CA certificate from vault
 */
async function fetchAndSaveCA(ctx: CLIPluginContext): Promise<string> {
  ctx.output.info('Fetching agent TLS CA certificate from vault...');

  // Use the vault client to get the CA certificate
  const response = await ctx.client.get<{
    caId: string;
    certificate: string;
    fingerprintSha256: string;
    subjectCn: string;
    notBefore: string;
    notAfter: string;
  }>('/v1/agents/tls/ca');

  // Ensure directory exists
  if (!existsSync(DEFAULT_CA_DIR)) {
    mkdirSync(DEFAULT_CA_DIR, { recursive: true, mode: 0o700 });
  }

  // Save CA certificate
  const caPath = getDefaultCACertPath();
  writeFileSync(caPath, response.certificate, { mode: 0o644 });

  return caPath;
}

/**
 * Register TLS commands
 */
export function registerTLSCommands(
  deploy: Command,
  ctx: CLIPluginContext
): void {
  const tlsCmd = deploy
    .command('tls')
    .description('TLS certificate management for secure agent connections');

  // deploy tls setup
  tlsCmd
    .command('setup')
    .description('Setup TLS for secure agent connections (fetches CA from vault)')
    .option('--ca-path <path>', 'Custom path to save CA certificate')
    .action(async (options: { caPath?: string }) => {
      await withErrorHandling(ctx, async () => {
        // Fetch CA from vault
        const caPath = await fetchAndSaveCA(ctx);

        // Show certificate info
        const cert = readFileSync(caPath, 'utf-8');
        const subjectMatch = cert.match(/Subject:.*?CN\s*=\s*([^,\n]+)/);
        const cn = subjectMatch?.[1]?.trim() ?? 'Unknown';

        console.log(`\n${ANSI.bold}CA Certificate Saved:${ANSI.reset}`);
        console.log(`  Path: ${caPath}`);
        console.log(`  Subject CN: ${cn}`);
        console.log('');

        ctx.output.success('TLS setup complete. CA certificate cached locally.');
        ctx.output.info('To enable TLS for a deploy config, run:');
        console.log(`  ${ANSI.cyan}znvault deploy config set <name> tls true${ANSI.reset}`);
      }, 'TLS setup failed');
    });

  // deploy tls status
  tlsCmd
    .command('status')
    .description('Show TLS configuration status')
    .action(async () => {
      await withErrorHandling(ctx, async () => {
        const caPath = getDefaultCACertPath();
        const store = await loadDeployConfigs();

        console.log(`\n${ANSI.bold}TLS Status:${ANSI.reset}\n`);

        // Check if CA is cached
        if (existsSync(caPath)) {
          console.log(`  CA Certificate: ${ANSI.green}cached${ANSI.reset}`);
          console.log(`  CA Path: ${caPath}`);

          // Show expiry info
          try {
            const response = await ctx.client.get<{
              notAfter: string;
              subjectCn: string;
            }>('/v1/agents/tls/ca');

            const expiry = new Date(response.notAfter);
            const daysUntilExpiry = Math.round((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

            console.log(`  CA Subject: ${response.subjectCn}`);
            console.log(`  CA Expires: ${expiry.toISOString()} (${daysUntilExpiry} days)`);
          } catch {
            // Couldn't fetch from vault
          }
        } else {
          console.log(`  CA Certificate: ${ANSI.red}not cached${ANSI.reset}`);
          console.log(`  Run '${ANSI.cyan}znvault deploy tls setup${ANSI.reset}' to fetch CA`);
        }

        console.log('');

        // Show configs with TLS enabled
        const tlsConfigs = Object.entries(store.configs).filter(([_, config]) => config.tls?.verify !== false);
        const noTlsConfigs = Object.entries(store.configs).filter(([_, config]) => config.tls?.verify === false);

        if (tlsConfigs.length > 0) {
          console.log(`  ${ANSI.bold}Configs with TLS verification:${ANSI.reset}`);
          for (const [name, config] of tlsConfigs) {
            const port = config.tls?.httpsPort ?? 9443;
            console.log(`    ${ANSI.green}✓${ANSI.reset} ${name} (HTTPS port: ${port})`);
          }
        }

        if (noTlsConfigs.length > 0) {
          console.log(`  ${ANSI.bold}Configs without TLS:${ANSI.reset}`);
          for (const [name] of noTlsConfigs) {
            console.log(`    ${ANSI.yellow}○${ANSI.reset} ${name} (HTTP)`);
          }
        }

        if (Object.keys(store.configs).length === 0) {
          console.log('  No deploy configs found.');
        }

        console.log('');
      }, 'Failed to get TLS status');
    });

  // deploy tls verify <hostname>
  tlsCmd
    .command('verify <hostname>')
    .description('Verify TLS connectivity to an agent')
    .option('-p, --port <port>', 'HTTPS port (default: 9443)', '9443')
    .option('--ca-path <path>', 'Path to CA certificate')
    .option('-k, --insecure', 'Skip TLS verification')
    .action(async (hostname: string, options: { port: string; caPath?: string; insecure?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const port = parsePort(options.port);
        const caPath = options.caPath ?? getDefaultCACertPath();

        // Configure TLS options
        if (options.insecure) {
          configureTLS({ verify: false });
          console.log(`${ANSI.yellow}Warning: TLS verification disabled${ANSI.reset}\n`);
        } else if (existsSync(caPath)) {
          configureTLS({ verify: true, caCertPath: caPath });
        } else {
          ctx.output.error(`CA certificate not found at ${caPath}`);
          ctx.output.info(`Run '${ANSI.cyan}znvault deploy tls setup${ANSI.reset}' to fetch CA from vault`);
          process.exit(1);
        }

        ctx.output.info(`Verifying TLS connection to ${hostname}:${port}...`);

        const url = `https://${hostname}:${port}/health`;

        try {
          const health = await agentGet<{ status: string; version: string }>(url, 10000);

          console.log('');
          console.log(`  ${ANSI.green}✓${ANSI.reset} TLS connection successful`);
          console.log(`  Agent Status: ${health.status}`);
          console.log(`  Agent Version: ${health.version}`);
          console.log('');

          ctx.output.success('TLS verification passed');
        } catch (err) {
          const message = getErrorMessage(err);

          if (message.includes('certificate') || message.includes('SSL') || message.includes('TLS')) {
            ctx.output.error('TLS verification failed - certificate issue');
            ctx.output.info('The CA certificate may be incorrect or expired.');
            ctx.output.info(`Run '${ANSI.cyan}znvault deploy tls setup${ANSI.reset}' to refresh CA`);
          } else if (message.includes('ECONNREFUSED')) {
            ctx.output.error(`Connection refused. Is the agent running HTTPS on port ${port}?`);
          } else if (message.includes('timeout')) {
            ctx.output.error('Connection timed out');
          } else {
            ctx.output.error(`TLS verification failed: ${message}`);
          }

          process.exit(1);
        }
      }, 'TLS verification failed');
    });

  // deploy tls refresh
  tlsCmd
    .command('refresh')
    .description('Refresh cached CA certificate from vault')
    .action(async () => {
      await withErrorHandling(ctx, async () => {
        const caPath = await fetchAndSaveCA(ctx);
        ctx.output.success(`CA certificate refreshed: ${caPath}`);
      }, 'Failed to refresh CA certificate');
    });
}
