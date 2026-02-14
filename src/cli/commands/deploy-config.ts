// Path: src/cli/commands/deploy-config.ts
// Deploy config management commands

import type { Command } from 'commander';
import type { CLIPluginContext, DeployConfig, HealthCheckConfig, HAProxyConfig } from '../types.js';
import { loadDeployConfigs, saveDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import { getConfigOrExit, confirmPrompt, withErrorHandling } from './helpers.js';

/**
 * Register deploy config commands
 */
export function registerConfigCommands(
  configCmd: Command,
  ctx: CLIPluginContext
): void {
  // deploy config create <name>
  configCmd
    .command('create <name>')
    .description('Create a new deployment configuration')
    .option('-w, --war <path>', 'Path to WAR file')
    .option('-h, --hosts <hosts>', 'Comma-separated list of hosts')
    .option('-p, --port <port>', 'Agent port (default: 9100)', '9100')
    .option('--parallel', 'Deploy to hosts in parallel')
    .option('-d, --description <desc>', 'Configuration description')
    .action(async (name: string, options: {
      war?: string;
      hosts?: string;
      port: string;
      parallel?: boolean;
      description?: string;
    }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();

        if (store.configs[name]) {
          ctx.output.error(`Config '${name}' already exists`);
          process.exit(1);
        }

        const config: DeployConfig = {
          name,
          hosts: options.hosts ? options.hosts.split(',').map(h => h.trim()) : [],
          warPath: options.war ?? '',
          port: parsePort(options.port),
          parallel: options.parallel ?? false,
          description: options.description,
        };

        store.configs[name] = config;
        await saveDeployConfigs(store);

        ctx.output.success(`Created deployment config: ${name}`);
        if (config.hosts.length > 0) {
          ctx.output.info(`  Hosts: ${config.hosts.join(', ')}`);
        }
        if (config.warPath) {
          ctx.output.info(`  WAR: ${config.warPath}`);
        }
      }, 'Failed to create config');
    });

  // deploy config list
  configCmd
    .command('list')
    .alias('ls')
    .description('List all deployment configurations')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();
        const configs = Object.values(store.configs);

        if (configs.length === 0) {
          if (options.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            ctx.output.info('No deployment configurations found.');
            ctx.output.info('Create one with: znvault deploy config create <name>');
          }
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(configs, null, 2));
          return;
        }

        console.log('\nDeployment Configurations:\n');
        for (const config of configs) {
          console.log(`  ${ANSI.bold}${config.name}${ANSI.reset}`);
          if (config.description) {
            console.log(`    ${ANSI.dim}${config.description}${ANSI.reset}`);
          }
          console.log(`    Hosts: ${config.hosts.length > 0 ? config.hosts.join(', ') : ANSI.dim + '(none)' + ANSI.reset}`);
          console.log(`    WAR:   ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
          const displayStrategy = config.strategy ?? (config.parallel ? 'parallel' : 'sequential');
          console.log(`    Strategy: ${displayStrategy}`);
          console.log();
        }
      }, 'Failed to list configs');
    });

  // deploy config show <name>
  configCmd
    .command('show <name>')
    .description('Show deployment configuration details')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const { config } = await getConfigOrExit(ctx, name);

        if (options.json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }

        console.log(`\n${ANSI.bold}Deployment Config: ${config.name}${ANSI.reset}\n`);
        if (config.description) {
          console.log(`  Description: ${config.description}`);
        }
        console.log(`  WAR Path:    ${config.warPath || ANSI.dim + '(not set)' + ANSI.reset}`);
        console.log(`  Port:        ${config.port}`);
        // Display strategy (prefer explicit strategy over legacy parallel flag)
        const displayStrategy = config.strategy ?? (config.parallel ? 'parallel' : 'sequential');
        console.log(`  Strategy:    ${displayStrategy}`);
        console.log(`\n  Hosts (${config.hosts.length}):`);
        if (config.hosts.length === 0) {
          console.log(`    ${ANSI.dim}(none)${ANSI.reset}`);
        } else {
          for (const host of config.hosts) {
            console.log(`    - ${host}`);
          }
        }
        if (config.healthCheck) {
          const hc = config.healthCheck;
          console.log(`\n  Health Check:`);
          console.log(`    Path:     ${hc.path}`);
          console.log(`    Port:     ${hc.port ?? 8080}`);
          console.log(`    Expected: HTTP ${hc.expectedStatus ?? 200}`);
          console.log(`    Timeout:  ${hc.timeout ?? 5000}ms`);
          console.log(`    Retries:  ${hc.retries ?? 5} (delay: ${hc.retryDelay ?? 3000}ms)`);
        } else {
          console.log(`\n  Health Check: ${ANSI.dim}(not configured)${ANSI.reset}`);
        }
        // TLS configuration
        if (config.tls && (config.tls.verify !== false || config.tls.httpsPort)) {
          console.log(`\n  TLS:`);
          console.log(`    Enabled:  ${config.tls.verify !== false ? ANSI.green + 'yes' + ANSI.reset : ANSI.yellow + 'no (insecure)' + ANSI.reset}`);
          console.log(`    Port:     ${config.tls.httpsPort ?? 9443}`);
          if (config.tls.useVaultCA) {
            console.log(`    CA:       vault (auto-fetched)`);
          } else if (config.tls.caCertPath) {
            console.log(`    CA:       ${config.tls.caCertPath}`);
          }
        } else {
          console.log(`\n  TLS: ${ANSI.dim}(not configured - using HTTP)${ANSI.reset}`);
        }
        // HAProxy configuration
        if (config.haproxy) {
          const ha = config.haproxy;
          console.log(`\n  HAProxy:`);
          console.log(`    Hosts:    ${ha.hosts.join(', ')}`);
          console.log(`    Backend:  ${ha.backend}`);
          console.log(`    Socket:   ${ha.socketPath ?? '/run/haproxy/admin.sock'}`);
          console.log(`    User:     ${ha.user ?? 'sysadmin'}`);
          console.log(`    Drain wait: ${ha.drainWaitSeconds ?? 5}s`);
          const mappings = Object.entries(ha.serverMap);
          if (mappings.length > 0) {
            console.log(`    Server map (${mappings.length}):`);
            for (const [appHost, serverName] of mappings) {
              console.log(`      ${appHost} → ${serverName}`);
            }
          } else {
            console.log(`    Server map: ${ANSI.dim}(empty)${ANSI.reset}`);
          }
        } else {
          console.log(`\n  HAProxy: ${ANSI.dim}(not configured)${ANSI.reset}`);
        }
        console.log();
      }, 'Failed to show config');
    });

  // deploy config delete <name>
  configCmd
    .command('delete <name>')
    .alias('rm')
    .description('Delete a deployment configuration')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name: string, options: { yes?: boolean }) => {
      await withErrorHandling(ctx, async () => {
        const store = await loadDeployConfigs();

        if (!store.configs[name]) {
          ctx.output.error(`Config '${name}' not found`);
          process.exit(1);
        }

        if (!options.yes) {
          const confirmed = await confirmPrompt(`Delete deployment config '${name}'?`, false);
          if (!confirmed) {
            ctx.output.info('Cancelled');
            return;
          }
        }

        delete store.configs[name];
        await saveDeployConfigs(store);

        ctx.output.success(`Deleted config: ${name}`);
      }, 'Failed to delete config');
    });

  // deploy config add-host <name> <host>
  configCmd
    .command('add-host <name> <host>')
    .description('Add a host to deployment configuration')
    .action(async (name: string, host: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        if (config.hosts.includes(host)) {
          ctx.output.warn(`Host '${host}' already in config`);
          return;
        }

        config.hosts.push(host);
        await saveDeployConfigs(store);

        ctx.output.success(`Added host: ${host}`);
        ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
      }, 'Failed to add host');
    });

  // deploy config remove-host <name> <host>
  configCmd
    .command('remove-host <name> <host>')
    .description('Remove a host from deployment configuration')
    .action(async (name: string, host: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        const index = config.hosts.indexOf(host);
        if (index === -1) {
          ctx.output.error(`Host '${host}' not found in config`);
          process.exit(1);
        }

        config.hosts.splice(index, 1);
        await saveDeployConfigs(store);

        ctx.output.success(`Removed host: ${host}`);
        ctx.output.info(`Config '${name}' now has ${config.hosts.length} host(s)`);
      }, 'Failed to remove host');
    });

  // deploy config set <name> <key> <value>
  configCmd
    .command('set <name> <key> <value>')
    .description('Set a configuration value (war, port, strategy, parallel, description, tls, tls-port)')
    .action(async (name: string, key: string, value: string) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        switch (key.toLowerCase()) {
          case 'war':
          case 'warpath':
            config.warPath = value;
            break;
          case 'port':
            config.port = parsePort(value);
            break;
          case 'strategy':
            // Validate strategy format
            if (!['sequential', 'parallel'].includes(value.toLowerCase()) && !value.includes('+')) {
              ctx.output.error(`Invalid strategy: ${value}`);
              ctx.output.info('Use: sequential, parallel, or canary format (1+R, 1+2, 2+3+R)');
              process.exit(1);
            }
            config.strategy = value;
            break;
          case 'parallel':
            config.parallel = value.toLowerCase() === 'true' || value === '1';
            break;
          case 'description':
          case 'desc':
            config.description = value;
            break;
          case 'tls':
            // Enable/disable TLS for this config
            if (!config.tls) {
              config.tls = {};
            }
            if (value.toLowerCase() === 'true' || value === '1') {
              config.tls.verify = true;
              config.tls.useVaultCA = true;
              ctx.output.info('TLS enabled with vault CA. Run "znvault deploy tls setup" to fetch CA certificate.');
            } else if (value.toLowerCase() === 'false' || value === '0') {
              config.tls.verify = false;
              config.tls.useVaultCA = false;
            } else {
              ctx.output.error('Invalid TLS value. Use "true" or "false"');
              process.exit(1);
            }
            break;
          case 'tls-port':
          case 'tlsport':
          case 'https-port':
          case 'httpsport':
            if (!config.tls) {
              config.tls = { verify: true, useVaultCA: true };
            }
            config.tls.httpsPort = parsePort(value);
            break;
          case 'tls-ca':
          case 'tlsca':
          case 'ca-path':
          case 'capath':
            if (!config.tls) {
              config.tls = { verify: true };
            }
            config.tls.caCertPath = value;
            config.tls.useVaultCA = false;
            break;
          default:
            ctx.output.error(`Unknown config key: ${key}`);
            ctx.output.info('Valid keys: war, port, strategy, parallel, description, tls, tls-port, tls-ca');
            process.exit(1);
        }

        await saveDeployConfigs(store);
        ctx.output.success(`Set ${key} = ${value}`);
      }, 'Failed to set config');
    });

  // deploy config health-check <name>
  configCmd
    .command('health-check <name>')
    .description('Configure post-deployment health check')
    .option('--path <path>', 'Health check URL path (e.g., /api/health)')
    .option('--port <port>', 'Application port (default: 8080)', '8080')
    .option('--status <code>', 'Expected HTTP status code (default: 200)', '200')
    .option('--timeout <ms>', 'Request timeout in milliseconds (default: 5000)', '5000')
    .option('--retries <n>', 'Number of retry attempts (default: 5)', '5')
    .option('--retry-delay <ms>', 'Delay between retries in milliseconds (default: 3000)', '3000')
    .option('--disable', 'Disable health check for this config')
    .action(async (name: string, options: {
      path?: string;
      port: string;
      status: string;
      timeout: string;
      retries: string;
      retryDelay: string;
      disable?: boolean;
    }) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        if (options.disable) {
          delete config.healthCheck;
          await saveDeployConfigs(store);
          ctx.output.success(`Disabled health check for '${name}'`);
          return;
        }

        if (!options.path && !config.healthCheck?.path) {
          ctx.output.error('Health check path is required');
          ctx.output.info('Usage: znvault deploy config health-check <name> --path /api/health');
          process.exit(1);
        }

        const healthCheck: HealthCheckConfig = {
          path: options.path ?? config.healthCheck?.path ?? '/health',
          port: parseInt(options.port, 10),
          expectedStatus: parseInt(options.status, 10),
          timeout: parseInt(options.timeout, 10),
          retries: parseInt(options.retries, 10),
          retryDelay: parseInt(options.retryDelay, 10),
        };

        // Validate
        if (isNaN(healthCheck.port!) || healthCheck.port! < 1 || healthCheck.port! > 65535) {
          ctx.output.error(`Invalid port: ${options.port}`);
          process.exit(1);
        }
        if (isNaN(healthCheck.expectedStatus!)) {
          ctx.output.error(`Invalid status code: ${options.status}`);
          process.exit(1);
        }

        config.healthCheck = healthCheck;
        await saveDeployConfigs(store);

        ctx.output.success(`Configured health check for '${name}'`);
        ctx.output.info(`  Path:     ${healthCheck.path}`);
        ctx.output.info(`  Port:     ${healthCheck.port}`);
        ctx.output.info(`  Expected: HTTP ${healthCheck.expectedStatus}`);
        ctx.output.info(`  Timeout:  ${healthCheck.timeout}ms`);
        ctx.output.info(`  Retries:  ${healthCheck.retries} (delay: ${healthCheck.retryDelay}ms)`);
      }, 'Failed to configure health check');
    });

  // deploy config haproxy <name>
  configCmd
    .command('haproxy <name>')
    .description('Configure HAProxy drain/ready for zero-downtime deployments')
    .option('--hosts <hosts>', 'Comma-separated HAProxy host addresses')
    .option('--user <user>', 'SSH user (default: sysadmin)')
    .option('--ssh-port <port>', 'SSH port (default: 22)')
    .option('--socket <path>', 'HAProxy admin socket path (default: /run/haproxy/admin.sock)')
    .option('--backend <name>', 'HAProxy backend name')
    .option('--drain-wait <seconds>', 'Seconds to wait after drain (default: 5)')
    .option('--disable', 'Disable HAProxy integration for this config')
    .action(async (name: string, options: {
      hosts?: string;
      user?: string;
      sshPort?: string;
      socket?: string;
      backend?: string;
      drainWait?: string;
      disable?: boolean;
    }) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        if (options.disable) {
          delete config.haproxy;
          await saveDeployConfigs(store);
          ctx.output.success(`Disabled HAProxy for '${name}'`);
          return;
        }

        // Build or update HAProxy config
        const existing = config.haproxy;

        if (!options.hosts && !existing?.hosts?.length && !options.backend && !existing?.backend) {
          ctx.output.error('HAProxy hosts and backend are required');
          ctx.output.info('Usage: znvault deploy config haproxy <name> --hosts 1.2.3.4,1.2.3.5 --backend api_servers');
          process.exit(1);
        }

        const haproxy: HAProxyConfig = {
          hosts: options.hosts
            ? options.hosts.split(',').map(h => h.trim())
            : existing?.hosts ?? [],
          backend: options.backend ?? existing?.backend ?? '',
          serverMap: existing?.serverMap ?? {},
        };

        if (!haproxy.backend) {
          ctx.output.error('HAProxy backend name is required (--backend)');
          process.exit(1);
        }

        if (haproxy.hosts.length === 0) {
          ctx.output.error('At least one HAProxy host is required (--hosts)');
          process.exit(1);
        }

        // Optional fields
        if (options.user) haproxy.user = options.user;
        else if (existing?.user) haproxy.user = existing.user;

        if (options.sshPort) {
          haproxy.sshPort = parsePort(options.sshPort, 'ssh-port');
        } else if (existing?.sshPort) {
          haproxy.sshPort = existing.sshPort;
        }

        if (options.socket) haproxy.socketPath = options.socket;
        else if (existing?.socketPath) haproxy.socketPath = existing.socketPath;

        if (options.drainWait) {
          const wait = parseInt(options.drainWait, 10);
          if (isNaN(wait) || wait < 0) {
            ctx.output.error(`Invalid drain-wait: ${options.drainWait}`);
            process.exit(1);
          }
          haproxy.drainWaitSeconds = wait;
        } else if (existing?.drainWaitSeconds !== undefined) {
          haproxy.drainWaitSeconds = existing.drainWaitSeconds;
        }

        if (existing?.sshTimeout !== undefined) {
          haproxy.sshTimeout = existing.sshTimeout;
        }

        config.haproxy = haproxy;
        await saveDeployConfigs(store);

        ctx.output.success(`Configured HAProxy for '${name}'`);
        ctx.output.info(`  Hosts:      ${haproxy.hosts.join(', ')}`);
        ctx.output.info(`  Backend:    ${haproxy.backend}`);
        ctx.output.info(`  Socket:     ${haproxy.socketPath ?? '/run/haproxy/admin.sock'}`);
        ctx.output.info(`  Drain wait: ${haproxy.drainWaitSeconds ?? 5}s`);
        const mapCount = Object.keys(haproxy.serverMap).length;
        if (mapCount > 0) {
          ctx.output.info(`  Server map: ${mapCount} mapping(s)`);
        } else {
          ctx.output.warn('  Server map: empty — use "znvault deploy config haproxy-map" to add mappings');
        }
      }, 'Failed to configure HAProxy');
    });

  // deploy config haproxy-map <name>
  configCmd
    .command('haproxy-map <name>')
    .description('Manage HAProxy server name mappings (app host → HAProxy server)')
    .option('--set <mapping>', 'Set mapping (host=server), can be repeated', collectMappings, [])
    .option('--remove <host>', 'Remove mapping for host')
    .option('--clear', 'Remove all mappings')
    .action(async (name: string, options: {
      set: string[];
      remove?: string;
      clear?: boolean;
    }) => {
      await withErrorHandling(ctx, async () => {
        const { store, config } = await getConfigOrExit(ctx, name);

        if (!config.haproxy) {
          ctx.output.error('HAProxy not configured for this deployment');
          ctx.output.info(`Use "znvault deploy config haproxy ${name} --hosts ... --backend ..." first`);
          process.exit(1);
        }

        if (options.clear) {
          config.haproxy.serverMap = {};
          await saveDeployConfigs(store);
          ctx.output.success('Cleared all HAProxy server mappings');
          return;
        }

        if (options.remove) {
          if (!config.haproxy.serverMap[options.remove]) {
            ctx.output.warn(`No mapping found for host '${options.remove}'`);
            return;
          }
          delete config.haproxy.serverMap[options.remove];
          await saveDeployConfigs(store);
          ctx.output.success(`Removed mapping for ${options.remove}`);
          return;
        }

        if (options.set.length === 0) {
          // Show current mappings
          const mappings = Object.entries(config.haproxy.serverMap);
          if (mappings.length === 0) {
            ctx.output.info('No HAProxy server mappings configured');
            ctx.output.info('Usage: znvault deploy config haproxy-map <name> --set host=server');
            return;
          }
          console.log(`\nHAProxy server mappings for '${name}':\n`);
          for (const [appHost, serverName] of mappings) {
            console.log(`  ${appHost} → ${serverName}`);
          }
          console.log();
          return;
        }

        // Apply set mappings
        for (const mapping of options.set) {
          const eqIndex = mapping.indexOf('=');
          if (eqIndex === -1) {
            ctx.output.error(`Invalid mapping format: "${mapping}" (expected host=server)`);
            process.exit(1);
          }
          const appHost = mapping.substring(0, eqIndex).trim();
          const serverName = mapping.substring(eqIndex + 1).trim();
          if (!appHost || !serverName) {
            ctx.output.error(`Invalid mapping: "${mapping}" (host and server name required)`);
            process.exit(1);
          }
          config.haproxy.serverMap[appHost] = serverName;
        }

        await saveDeployConfigs(store);

        ctx.output.success(`Updated ${options.set.length} HAProxy server mapping(s)`);
        for (const mapping of options.set) {
          const eqIndex = mapping.indexOf('=');
          ctx.output.info(`  ${mapping.substring(0, eqIndex)} → ${mapping.substring(eqIndex + 1)}`);
        }
      }, 'Failed to update HAProxy mappings');
    });
}

/**
 * Collector function for repeatable --set option
 */
function collectMappings(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
