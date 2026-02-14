// Path: src/cli/haproxy.ts
// HAProxy drain/ready operations via SSH for zero-downtime rolling deployments

import { execFile } from 'node:child_process';
import type { HAProxyConfig } from './types.js';

const DEFAULT_USER = 'sysadmin';
const DEFAULT_SSH_PORT = 22;
const DEFAULT_SOCKET_PATH = '/run/haproxy/admin.sock';
const DEFAULT_SSH_TIMEOUT = 10000;

/**
 * Result from a single SSH command execution
 */
export interface SSHExecResult {
  host: string;
  success: boolean;
  stdout?: string;
  error?: string;
}

/**
 * Aggregate result from running a command across all HAProxy hosts
 */
export interface HAProxyOperationResult {
  success: boolean;
  results: SSHExecResult[];
}

/**
 * Execute a command on a remote host via SSH
 *
 * Uses BatchMode=yes to fail immediately instead of prompting for password.
 * Uses ConnectTimeout to avoid hanging on unreachable hosts.
 */
export function sshExec(
  host: string,
  user: string,
  port: number,
  command: string,
  timeout: number
): Promise<SSHExecResult> {
  const connectTimeout = Math.max(1, Math.ceil(timeout / 1000));

  return new Promise((resolve) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-p', String(port),
      `${user}@${host}`,
      command,
    ];

    const child = execFile('ssh', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || error.message;
        resolve({ host, success: false, error: msg });
      } else {
        resolve({ host, success: true, stdout: stdout.trim() });
      }
    });

    // Safety: kill on timeout (execFile handles this, but just in case)
    child.on('error', (err) => {
      resolve({ host, success: false, error: err.message });
    });
  });
}

/**
 * Build the socat command to set HAProxy server state
 */
function buildSocatCommand(socketPath: string, backend: string, serverName: string, state: 'drain' | 'ready'): string {
  return `echo "set server ${backend}/${serverName} state ${state}" | socat stdio ${socketPath}`;
}

/**
 * Set server state (drain/ready) across all HAProxy hosts in parallel
 *
 * Runs the command on every HAProxy host simultaneously. Returns success
 * only if ALL hosts succeed — partial drain could cause inconsistent routing.
 */
export async function setServerState(
  config: HAProxyConfig,
  appHost: string,
  state: 'drain' | 'ready'
): Promise<HAProxyOperationResult> {
  const serverName = config.serverMap[appHost];
  if (!serverName) {
    return {
      success: false,
      results: [{
        host: appHost,
        success: false,
        error: `No HAProxy server mapping for host "${appHost}"`,
      }],
    };
  }

  const user = config.user ?? DEFAULT_USER;
  const port = config.sshPort ?? DEFAULT_SSH_PORT;
  const socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
  const timeout = config.sshTimeout ?? DEFAULT_SSH_TIMEOUT;
  const command = buildSocatCommand(socketPath, config.backend, serverName, state);

  const results = await Promise.all(
    config.hosts.map(haHost => sshExec(haHost, user, port, command, timeout))
  );

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results };
}

/**
 * Drain a server from all HAProxy load balancers
 */
export async function drainServer(config: HAProxyConfig, appHost: string): Promise<HAProxyOperationResult> {
  return setServerState(config, appHost, 'drain');
}

/**
 * Set a server ready on all HAProxy load balancers
 */
export async function readyServer(config: HAProxyConfig, appHost: string): Promise<HAProxyOperationResult> {
  return setServerState(config, appHost, 'ready');
}

/**
 * Pre-flight connectivity check: SSH to each HAProxy host and run a no-op
 */
export async function testHAProxyConnectivity(config: HAProxyConfig): Promise<HAProxyOperationResult> {
  const user = config.user ?? DEFAULT_USER;
  const port = config.sshPort ?? DEFAULT_SSH_PORT;
  const timeout = config.sshTimeout ?? DEFAULT_SSH_TIMEOUT;

  const results = await Promise.all(
    config.hosts.map(host => sshExec(host, user, port, 'echo ok', timeout))
  );

  const allSuccess = results.every(r => r.success);
  return { success: allSuccess, results };
}

/**
 * Find app hosts that don't have a serverMap entry
 */
export function getUnmappedHosts(config: HAProxyConfig, appHosts: string[]): string[] {
  return appHosts.filter(host => !config.serverMap[host]);
}
