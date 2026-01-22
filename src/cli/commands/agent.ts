// Path: src/cli/commands/agent.ts
// Agent management commands - check status and trigger updates

import type { Command } from 'commander';
import type { CLIPluginContext, PluginVersionCheckResult, TriggerUpdateResult } from '../types.js';
import { loadDeployConfigs } from '../config-store.js';
import { ANSI, parsePort } from '../constants.js';
import {
  checkHostReachable,
  checkPluginVersions,
  triggerPluginUpdate,
} from '../host-checks.js';
import { buildPluginUrl, agentGet } from '../http-client.js';
import { getErrorMessage } from '../../utils/error.js';
import { formatDuration } from '../formatters.js';

/**
 * Agent health response from /health endpoint
 */
interface AgentHealthResponse {
  status: string;
  version: string;
  uptime: number;
  plugins: Array<{
    name: string;
    version: string;
    healthy: boolean;
  }>;
}

/**
 * Result of checking a single agent
 */
interface AgentCheckResult {
  host: string;
  port: number;
  reachable: boolean;
  health?: AgentHealthResponse;
  versions?: PluginVersionCheckResult;
  error?: string;
}

/**
 * Check a single agent's health and plugin versions
 */
async function checkAgent(host: string, port: number): Promise<AgentCheckResult> {
  const result: AgentCheckResult = { host, port, reachable: false };

  try {
    // Check reachability
    const reachable = await checkHostReachable(host, port);
    if (!reachable.reachable) {
      result.error = reachable.error ?? 'Unreachable';
      return result;
    }
    result.reachable = true;

    // Get health info
    const pluginUrl = buildPluginUrl(host, port);
    try {
      // Agent health endpoint (not plugin)
      const baseUrl = `http://${host}:${port}`;
      const health = await agentGet<AgentHealthResponse>(`${baseUrl}/health`);
      result.health = health;
    } catch {
      // Health endpoint might not exist in older agents
    }

    // Get plugin versions
    const versions = await checkPluginVersions(host, port);
    result.versions = versions;

    return result;
  } catch (err) {
    result.error = getErrorMessage(err);
    return result;
  }
}

/**
 * Display agent check result
 */
function displayAgentResult(result: AgentCheckResult, plain: boolean): void {
  const hostStr = `${result.host}:${result.port}`;

  if (!result.reachable) {
    if (plain) {
      console.log(`[ERR] ${hostStr}: ${result.error ?? 'Unreachable'}`);
    } else {
      console.log(`  ${ANSI.red}✗${ANSI.reset} ${hostStr} ${ANSI.red}${result.error ?? 'Unreachable'}${ANSI.reset}`);
    }
    return;
  }

  // Host is reachable
  if (plain) {
    console.log(`[OK] ${hostStr}`);
  } else {
    console.log(`  ${ANSI.green}✓${ANSI.reset} ${hostStr}`);
  }

  // Show agent health if available
  if (result.health) {
    const uptime = formatDuration(result.health.uptime);
    if (plain) {
      console.log(`      Agent: v${result.health.version} (up ${uptime})`);
    } else {
      console.log(`      ${ANSI.dim}Agent:${ANSI.reset} v${result.health.version} ${ANSI.dim}(up ${uptime})${ANSI.reset}`);
    }
  }

  // Show plugin versions
  if (result.versions?.success && result.versions.response) {
    const { versions, hasUpdates } = result.versions.response;

    for (const plugin of versions) {
      const updateIcon = plugin.updateAvailable
        ? (plain ? ' [UPDATE]' : ` ${ANSI.yellow}↑${ANSI.reset}`)
        : '';

      if (plain) {
        console.log(`      ${plugin.package}: ${plugin.current}${plugin.updateAvailable ? ` → ${plugin.latest}` : ''}${updateIcon}`);
      } else {
        const versionStr = plugin.updateAvailable
          ? `${plugin.current} ${ANSI.dim}→${ANSI.reset} ${ANSI.green}${plugin.latest}${ANSI.reset}`
          : plugin.current;
        console.log(`      ${ANSI.dim}${plugin.package}:${ANSI.reset} ${versionStr}${updateIcon}`);
      }
    }
  }
}

/**
 * Display update result
 */
function displayUpdateResult(host: string, port: number, result: TriggerUpdateResult, plain: boolean): void {
  const hostStr = `${host}:${port}`;

  if (!result.success) {
    if (plain) {
      console.log(`[ERR] ${hostStr}: ${result.error}`);
    } else {
      console.log(`  ${ANSI.red}✗${ANSI.reset} ${hostStr} ${ANSI.red}${result.error}${ANSI.reset}`);
    }
    return;
  }

  const response = result.response!;

  if (response.updated === 0) {
    if (plain) {
      console.log(`[OK] ${hostStr}: No updates needed`);
    } else {
      console.log(`  ${ANSI.green}✓${ANSI.reset} ${hostStr} ${ANSI.dim}No updates needed${ANSI.reset}`);
    }
    return;
  }

  if (plain) {
    console.log(`[OK] ${hostStr}: Updated ${response.updated} plugin(s)${response.willRestart ? ' (restarting)' : ''}`);
  } else {
    const restartNote = response.willRestart ? ` ${ANSI.yellow}(restarting)${ANSI.reset}` : '';
    console.log(`  ${ANSI.green}✓${ANSI.reset} ${hostStr} Updated ${response.updated} plugin(s)${restartNote}`);
  }

  for (const plugin of response.results) {
    if (plugin.success) {
      if (plain) {
        console.log(`      ${plugin.package}: ${plugin.previousVersion} → ${plugin.newVersion}`);
      } else {
        console.log(`      ${ANSI.dim}${plugin.package}:${ANSI.reset} ${plugin.previousVersion} ${ANSI.dim}→${ANSI.reset} ${ANSI.green}${plugin.newVersion}${ANSI.reset}`);
      }
    } else {
      if (plain) {
        console.log(`      ${plugin.package}: FAILED - ${plugin.error}`);
      } else {
        console.log(`      ${ANSI.red}${plugin.package}: ${plugin.error}${ANSI.reset}`);
      }
    }
  }
}

/**
 * Register agent management commands
 */
export function registerAgentCommands(
  program: Command,
  ctx: CLIPluginContext
): void {
  const agent = program
    .command('agent')
    .description('Manage zn-vault-agent instances');

  // agent status <config>
  agent
    .command('status <config>')
    .description('Check agent health and plugin versions for all hosts in a config')
    .option('--json', 'Output as JSON')
    .action(async (configName: string, options: { json?: boolean }) => {
      try {
        const store = await loadDeployConfigs();
        const config = store.configs[configName];

        if (!config) {
          ctx.output.error(`Deployment config '${configName}' not found`);
          ctx.output.info('Use "znvault deploy config list" to see available configs');
          process.exit(1);
        }

        if (config.hosts.length === 0) {
          ctx.output.error('No hosts configured');
          process.exit(1);
        }

        const plain = ctx.isPlainMode();

        if (!options.json) {
          if (plain) {
            console.log(`\nChecking ${config.hosts.length} agent(s) in '${configName}'...\n`);
          } else {
            console.log(`\n${ANSI.bold}Agent Status: ${configName}${ANSI.reset}\n`);
          }
        }

        // Check all agents in parallel
        const results = await Promise.all(
          config.hosts.map(host => checkAgent(host, config.port))
        );

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        // Display results
        for (const result of results) {
          displayAgentResult(result, plain);
          console.log('');
        }

        // Summary
        const reachable = results.filter(r => r.reachable).length;
        const withUpdates = results.filter(r =>
          r.versions?.success && r.versions.response?.hasUpdates
        ).length;

        if (plain) {
          console.log(`Summary: ${reachable}/${results.length} agents reachable, ${withUpdates} with updates available`);
        } else {
          const statusIcon = reachable === results.length
            ? `${ANSI.green}✓${ANSI.reset}`
            : `${ANSI.yellow}⚠${ANSI.reset}`;
          const updateNote = withUpdates > 0
            ? ` ${ANSI.yellow}(${withUpdates} with updates)${ANSI.reset}`
            : '';
          console.log(`${statusIcon} ${reachable}/${results.length} agents reachable${updateNote}`);
        }

        if (withUpdates > 0 && !plain) {
          console.log(`${ANSI.dim}Run "znvault agent update ${configName}" to update plugins${ANSI.reset}`);
        }
      } catch (err) {
        ctx.output.error(`Failed to check agents: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // agent update <config>
  agent
    .command('update <config>')
    .description('Update plugins on all agents in a config')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--json', 'Output as JSON')
    .action(async (configName: string, options: { yes?: boolean; json?: boolean }) => {
      try {
        const store = await loadDeployConfigs();
        const config = store.configs[configName];

        if (!config) {
          ctx.output.error(`Deployment config '${configName}' not found`);
          ctx.output.info('Use "znvault deploy config list" to see available configs');
          process.exit(1);
        }

        if (config.hosts.length === 0) {
          ctx.output.error('No hosts configured');
          process.exit(1);
        }

        const plain = ctx.isPlainMode();

        // First check what needs updating
        if (!options.json) {
          if (plain) {
            console.log(`\nChecking plugin versions on ${config.hosts.length} agent(s)...\n`);
          } else {
            console.log(`\n${ANSI.bold}Checking Plugin Versions${ANSI.reset}\n`);
          }
        }

        const versionChecks = await Promise.all(
          config.hosts.map(async host => ({
            host,
            result: await checkPluginVersions(host, config.port),
          }))
        );

        const hostsWithUpdates = versionChecks.filter(
          v => v.result.success && v.result.response?.hasUpdates
        );

        if (hostsWithUpdates.length === 0) {
          if (options.json) {
            console.log(JSON.stringify({ updated: 0, message: 'All plugins up to date' }));
          } else if (plain) {
            console.log('All plugins are up to date.');
          } else {
            console.log(`${ANSI.green}✓${ANSI.reset} All plugins are up to date`);
          }
          return;
        }

        // Show what will be updated
        if (!options.json) {
          for (const { host, result } of hostsWithUpdates) {
            if (plain) {
              console.log(`${host}:${config.port}:`);
            } else {
              console.log(`  ${host}:${config.port}`);
            }
            for (const plugin of result.response!.versions) {
              if (plugin.updateAvailable) {
                if (plain) {
                  console.log(`    ${plugin.package}: ${plugin.current} → ${plugin.latest}`);
                } else {
                  console.log(`    ${ANSI.dim}${plugin.package}:${ANSI.reset} ${plugin.current} ${ANSI.dim}→${ANSI.reset} ${ANSI.green}${plugin.latest}${ANSI.reset}`);
                }
              }
            }
          }
          console.log('');
        }

        // Confirm
        if (!options.yes && !options.json) {
          const inquirerModule = await import('inquirer');
          const inquirer = inquirerModule.default;
          const answers = await inquirer.prompt([{
            type: 'confirm',
            name: 'proceed',
            message: `Update plugins on ${hostsWithUpdates.length} host(s)?`,
            default: true,
          }]) as { proceed: boolean };

          if (!answers.proceed) {
            ctx.output.info('Cancelled');
            return;
          }
        }

        // Perform updates
        if (!options.json) {
          if (plain) {
            console.log('\nUpdating plugins...\n');
          } else {
            console.log(`\n${ANSI.bold}Updating Plugins${ANSI.reset}\n`);
          }
        }

        const updateResults: Array<{ host: string; result: TriggerUpdateResult }> = [];
        let hostsRestarting = 0;

        for (const { host } of hostsWithUpdates) {
          const result = await triggerPluginUpdate(host, config.port);
          updateResults.push({ host, result });

          if (!options.json) {
            displayUpdateResult(host, config.port, result, plain);
          }

          if (result.success && result.response?.willRestart) {
            hostsRestarting++;
          }
        }

        if (options.json) {
          console.log(JSON.stringify({
            updated: updateResults.filter(r => r.result.success).length,
            results: updateResults,
            restarting: hostsRestarting,
          }, null, 2));
          return;
        }

        // Wait for restarts if needed
        if (hostsRestarting > 0) {
          console.log('');
          const RESTART_WAIT_TIME = 25;

          if (plain) {
            console.log(`Waiting ${RESTART_WAIT_TIME}s for ${hostsRestarting} agent(s) to restart...`);
          } else {
            console.log(`${ANSI.dim}Waiting for ${hostsRestarting} agent(s) to restart...${ANSI.reset}`);
          }

          for (let i = RESTART_WAIT_TIME; i > 0; i--) {
            if (!plain) {
              process.stdout.write(`\r${ANSI.dim}Restarting... ${i}s${ANSI.reset}  `);
            }
            await new Promise(r => setTimeout(r, 1000));
          }

          if (!plain) {
            process.stdout.write(`\r${ANSI.clearLine}`);
          }

          // Verify agents are back
          console.log('');
          if (plain) {
            console.log('Verifying agents...');
          } else {
            console.log(`${ANSI.dim}Verifying agents are back online...${ANSI.reset}`);
          }

          const verifyResults = await Promise.all(
            hostsWithUpdates.map(({ host }) => checkAgent(host, config.port))
          );

          const backOnline = verifyResults.filter(r => r.reachable).length;

          console.log('');
          if (plain) {
            console.log(`Done: ${backOnline}/${hostsWithUpdates.length} agents online`);
          } else {
            const icon = backOnline === hostsWithUpdates.length
              ? `${ANSI.green}✓${ANSI.reset}`
              : `${ANSI.yellow}⚠${ANSI.reset}`;
            console.log(`${icon} ${backOnline}/${hostsWithUpdates.length} agents back online`);
          }
        }
      } catch (err) {
        ctx.output.error(`Failed to update agents: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  // agent check <host:port>
  agent
    .command('check <hostPort>')
    .description('Check a single agent (format: host:port or host)')
    .option('--json', 'Output as JSON')
    .action(async (hostPort: string, options: { json?: boolean }) => {
      try {
        // Parse host:port
        let host: string;
        let port = 9100;

        if (hostPort.includes(':')) {
          const [hostPart, portPart] = hostPort.split(':');
          host = hostPart!;
          port = parsePort(portPart!);
        } else {
          host = hostPort;
        }

        const plain = ctx.isPlainMode();

        if (!options.json && !plain) {
          console.log(`\n${ANSI.bold}Checking Agent${ANSI.reset}\n`);
        }

        const result = await checkAgent(host, port);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        displayAgentResult(result, plain);

        if (!result.reachable) {
          process.exit(1);
        }
      } catch (err) {
        ctx.output.error(`Failed to check agent: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });
}
