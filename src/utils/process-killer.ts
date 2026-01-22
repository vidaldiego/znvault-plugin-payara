// Path: src/utils/process-killer.ts
// Utility for killing processes with graceful SIGTERM followed by SIGKILL

import type { Logger } from 'pino';

/**
 * Options for process killing operations
 */
export interface ProcessKillOptions {
  /** Delay in ms after sending SIGTERM before checking (default: 2000) */
  termDelayMs?: number;
  /** Delay in ms after sending SIGKILL before verifying (default: 2000) */
  killDelayMs?: number;
  /** Timeout for kill commands in ms (default: 5000) */
  commandTimeoutMs?: number;
}

/**
 * Command executor interface matching PayaraManager.execCommand
 */
export interface CommandExecutor {
  (command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kill processes by their PIDs with graceful SIGTERM followed by SIGKILL.
 *
 * @param pids - Array of process IDs to kill
 * @param processName - Name for logging purposes (e.g., "Payara", "Java")
 * @param exec - Command executor function
 * @param logger - Logger instance
 * @param getRemainingPids - Function to check which PIDs are still running
 * @param options - Kill options
 * @throws Error if processes cannot be killed
 */
export async function killProcessesByPid(
  pids: number[],
  processName: string,
  exec: CommandExecutor,
  logger: Logger,
  getRemainingPids: () => Promise<number[]>,
  options: ProcessKillOptions = {}
): Promise<void> {
  const {
    termDelayMs = 2000,
    killDelayMs = 2000,
    commandTimeoutMs = 5000,
  } = options;

  if (pids.length === 0) {
    logger.debug(`No ${processName} processes found`);
    return;
  }

  logger.info({ pids }, `Found ${processName} processes to kill`);

  // First try graceful SIGTERM
  await exec(`kill -TERM ${pids.join(' ')} || true`, commandTimeoutMs);
  await sleep(termDelayMs);

  // Check if any processes remain
  const remaining = await getRemainingPids();
  if (remaining.length > 0) {
    // Force kill with SIGKILL
    logger.warn({ pids: remaining }, `${processName} processes still running, using SIGKILL`);
    await exec(`kill -9 ${remaining.join(' ')} || true`, commandTimeoutMs);
    await sleep(killDelayMs);
  }

  // Verify all processes are dead
  const finalCheck = await getRemainingPids();
  if (finalCheck.length > 0) {
    logger.error({ pids: finalCheck }, `Failed to kill ${processName} processes`);
    throw new Error(`Failed to kill ${processName} processes: PIDs ${finalCheck.join(', ')} still running`);
  }

  logger.info(`${processName} processes killed`);
}

/**
 * Kill processes using pkill command with graceful SIGTERM followed by SIGKILL.
 *
 * @param pkillArgs - Arguments for pkill (e.g., "-u user java")
 * @param processName - Name for logging purposes (e.g., "Java")
 * @param exec - Command executor function
 * @param logger - Logger instance
 * @param hasProcesses - Function to check if processes are still running
 * @param getRemainingPids - Function to get remaining PIDs (for error message)
 * @param options - Kill options
 * @throws Error if processes cannot be killed
 */
export async function killProcessesByPkill(
  pkillArgs: string,
  processName: string,
  exec: CommandExecutor,
  logger: Logger,
  hasProcesses: () => Promise<boolean>,
  getRemainingPids: () => Promise<number[]>,
  options: ProcessKillOptions = {}
): Promise<void> {
  const {
    termDelayMs = 2000,
    killDelayMs = 2000,
    commandTimeoutMs = 5000,
  } = options;

  logger.warn(`Killing ALL ${processName} processes`);

  // First try graceful SIGTERM
  // Note: `|| true` ensures command succeeds even if no processes found
  await exec(`pkill ${pkillArgs} || true`, commandTimeoutMs);
  await sleep(termDelayMs);

  // Check if any processes remain
  const stillRunning = await hasProcesses();

  if (stillRunning) {
    // Force kill with SIGKILL
    logger.warn(`${processName} processes still running, using SIGKILL`);
    await exec(`pkill -9 ${pkillArgs} || true`, commandTimeoutMs);
    await sleep(killDelayMs);
  }

  // Verify all processes are dead
  const remaining = await getRemainingPids();
  if (remaining.length > 0) {
    logger.error({ pids: remaining }, `Failed to kill all ${processName} processes`);
    throw new Error(`Failed to kill all ${processName} processes: PIDs ${remaining.join(', ')} still running`);
  }

  logger.info(`All ${processName} processes killed`);
}
