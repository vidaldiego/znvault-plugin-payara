// Path: src/utils/polling.ts
// Generic polling utility for waiting on conditions

/**
 * Options for polling operations
 */
export interface PollOptions {
  /** Polling interval in ms (default: 1000) */
  intervalMs?: number;
  /** Error message when timeout is reached */
  timeoutMessage?: string;
}

/**
 * Wait for a condition to become true, polling at regular intervals.
 *
 * @param condition - Async function that returns true when the condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param options - Polling options
 * @throws Error if timeout is reached before condition becomes true
 *
 * @example
 * // Wait for server to become healthy
 * await waitFor(() => isHealthy(), 60000, {
 *   intervalMs: 2000,
 *   timeoutMessage: 'Server did not become healthy'
 * });
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  options: PollOptions = {}
): Promise<void> {
  const {
    intervalMs = 1000,
    timeoutMessage = `Condition not met within ${timeoutMs}ms`,
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await sleep(intervalMs);
  }

  throw new Error(timeoutMessage);
}

/**
 * Wait for a condition to become true, returning a result instead of throwing.
 *
 * @param condition - Async function that returns true when the condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param options - Polling options
 * @returns true if condition was met, false if timeout was reached
 *
 * @example
 * // Wait for server with soft timeout
 * const ready = await waitForWithResult(() => isHealthy(), 60000);
 * if (!ready) {
 *   console.warn('Server not ready, continuing anyway');
 * }
 */
export async function waitForWithResult(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  options: Omit<PollOptions, 'timeoutMessage'> = {}
): Promise<boolean> {
  const { intervalMs = 1000 } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await sleep(intervalMs);
  }

  return false;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
