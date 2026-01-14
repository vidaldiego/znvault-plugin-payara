// Path: src/payara-manager.ts
// Payara application server process management

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile, access, constants } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { PayaraManagerOptions, PayaraStatus } from './types.js';

const execAsync = promisify(exec);

/**
 * Manages Payara application server lifecycle
 */
export class PayaraManager {
  private readonly payaraHome: string;
  private readonly asadmin: string;
  readonly domain: string;
  private readonly user: string;
  private readonly healthEndpoint?: string;
  private readonly healthCheckTimeout: number;
  private readonly operationTimeout: number;
  private readonly logger: Logger;
  private environment: Record<string, string>;
  private readonly passwordFile?: string;

  constructor(options: PayaraManagerOptions) {
    this.payaraHome = options.payaraHome;
    this.domain = options.domain;
    this.user = options.user;
    this.healthEndpoint = options.healthEndpoint;
    this.healthCheckTimeout = options.healthCheckTimeout ?? 30000;
    this.operationTimeout = options.operationTimeout ?? 120000;
    this.logger = options.logger;
    this.environment = options.environment ?? {};
    this.passwordFile = options.passwordFile;

    // Path to asadmin command
    this.asadmin = join(this.payaraHome, 'bin', 'asadmin');
  }

  /**
   * Validate that asadmin binary exists and is accessible.
   * Call this during plugin initialization for early failure detection.
   */
  async validateAsadmin(): Promise<void> {
    try {
      await access(this.asadmin, constants.X_OK);
    } catch {
      throw new Error(
        `asadmin not found or not executable at ${this.asadmin}. ` +
        `Check payaraHome configuration (current: ${this.payaraHome})`
      );
    }
  }

  /**
   * Update environment variables (e.g., after secret refresh)
   */
  setEnvironment(env: Record<string, string>): void {
    this.environment = env;
    this.logger.debug({ count: Object.keys(env).length }, 'Environment updated');
  }

  /**
   * Update environment and write to setenv.conf
   * Use this when secrets have been refreshed and need to be persisted
   * even if Payara isn't being restarted
   */
  async updateEnvironment(env: Record<string, string>): Promise<void> {
    this.environment = env;
    this.logger.debug({ count: Object.keys(env).length }, 'Environment updated');
    await this.writeSetenvConf();
  }

  /**
   * Build environment string for command execution.
   *
   * SECURITY: This method ONLY includes non-sensitive env vars (JAVA_HOME).
   * Secrets are written to setenv.conf file which Payara reads on JVM startup.
   * This prevents secrets from appearing in `ps aux`, logs, and error messages.
   */
  private buildEnvPrefix(): string {
    const javaHome = process.env.JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk-amd64';
    return `JAVA_HOME="${javaHome}" `;
  }

  /**
   * Sanitize a string for logging by redacting potential secret values.
   * Redacts any quoted string longer than 8 characters.
   */
  private sanitizeForLogging(str: string): string {
    return str.replace(/('|")[^'"]{8,}('|")/g, '"[REDACTED]"');
  }

  /**
   * Execute a command, optionally as a different user
   */
  private async execCommand(command: string, timeout?: number): Promise<{ stdout: string; stderr: string }> {
    const effectiveTimeout = timeout ?? this.operationTimeout;

    // Build environment prefix for sudo
    const envPrefix = this.buildEnvPrefix();

    // If running as root and user is specified, use sudo with env vars
    // The env vars are passed explicitly because sudo doesn't preserve them by default
    const fullCommand = process.getuid?.() === 0 && this.user
      ? `sudo -u ${this.user} env ${envPrefix}${command}`
      : `${envPrefix}${command}`;

    this.logger.debug({ command: command, hasEnv: Object.keys(this.environment).length > 0 }, 'Executing command');

    try {
      const result = await execAsync(fullCommand, {
        timeout: effectiveTimeout,
        shell: '/bin/bash',
      });
      return result;
    } catch (err) {
      const error = err as Error & { stdout?: string; stderr?: string; code?: number };
      // SECURITY: Don't log stdout/stderr as they may contain secrets
      // Use sanitizeForLogging to redact potential secrets in command
      this.logger.error({
        command: this.sanitizeForLogging(command),
        code: error.code,
      }, 'Command failed');
      throw err;
    }
  }

  /**
   * Run asadmin command with optional authentication for Payara 7+
   */
  private async asadminCommand(args: string[], timeout?: number): Promise<string> {
    // Build auth arguments if password file is configured
    const authArgs = this.passwordFile
      ? ['--user', 'admin', '--passwordfile', this.passwordFile]
      : [];

    const command = `${this.asadmin} ${[...authArgs, ...args].join(' ')}`;
    const result = await this.execCommand(command, timeout);
    return result.stdout;
  }

  /**
   * Check if Payara domain is running
   */
  async isRunning(): Promise<boolean> {
    try {
      const output = await this.asadminCommand(['list-domains'], 10000);
      // Output format: "domain1 running" or "domain1 not running"
      const domainLine = output.split('\n').find(line => line.startsWith(this.domain));
      if (!domainLine) {
        return false;
      }
      // Must contain "running" but NOT "not running"
      return domainLine.includes('running') && !domainLine.includes('not running');
    } catch {
      return false;
    }
  }

  /**
   * Check if Payara is healthy via health endpoint
   */
  async isHealthy(): Promise<boolean> {
    if (!this.healthEndpoint) {
      // No health endpoint configured, just check if running
      return this.isRunning();
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.healthCheckTimeout);

      const response = await fetch(this.healthEndpoint, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn({ status: response.status }, 'Health check returned non-OK status');
        return false;
      }

      return true;
    } catch (err) {
      this.logger.debug({ err, endpoint: this.healthEndpoint }, 'Health check failed');
      return false;
    }
  }

  /**
   * Write environment variables to domain's setenv.conf
   * This ensures the Payara JVM receives the env vars on startup
   */
  private async writeSetenvConf(): Promise<void> {
    if (Object.keys(this.environment).length === 0) {
      this.logger.debug('No environment variables to write');
      return;
    }

    const configDir = join(this.payaraHome, 'glassfish', 'domains', this.domain, 'config');
    const setenvPath = join(configDir, 'setenv.conf');

    // Build setenv.conf content
    // Format: export VAR="value"
    const lines: string[] = [
      '# Auto-generated by znvault-plugin-payara',
      '# DO NOT EDIT - this file is overwritten on agent restart',
      '',
    ];

    for (const [key, value] of Object.entries(this.environment)) {
      // Escape double quotes in value
      const escapedValue = value.replace(/"/g, '\\"');
      lines.push(`export ${key}="${escapedValue}"`);
    }

    const content = lines.join('\n') + '\n';

    this.logger.info({ path: setenvPath, count: Object.keys(this.environment).length }, 'Writing setenv.conf');

    // Write file (needs to be readable by payara user)
    await writeFile(setenvPath, content, { mode: 0o640 });

    // Change ownership to payara user
    if (process.getuid?.() === 0 && this.user) {
      try {
        await execAsync(`chown ${this.user}:${this.user} "${setenvPath}"`);
      } catch (err) {
        this.logger.warn({ err }, 'Failed to chown setenv.conf');
      }
    }
  }

  /**
   * Start Payara domain
   */
  async start(): Promise<void> {
    if (await this.isRunning()) {
      this.logger.info({ domain: this.domain }, 'Domain already running');
      return;
    }

    // Write environment to setenv.conf before starting
    await this.writeSetenvConf();

    this.logger.info({ domain: this.domain }, 'Starting Payara domain');

    await this.asadminCommand(['start-domain', this.domain]);

    // Wait for domain to be ready
    await this.waitForHealthy(60000);

    this.logger.info({ domain: this.domain }, 'Payara domain started');
  }

  /**
   * Stop Payara domain
   */
  async stop(): Promise<void> {
    if (!(await this.isRunning())) {
      this.logger.info({ domain: this.domain }, 'Domain not running');
      return;
    }

    this.logger.info({ domain: this.domain }, 'Stopping Payara domain');

    try {
      await this.asadminCommand(['stop-domain', this.domain]);
    } catch (err) {
      // Domain might already be stopped
      this.logger.warn({ err }, 'Error stopping domain (may already be stopped)');
    }

    // Wait for domain to stop
    await this.waitForStopped(30000);

    this.logger.info({ domain: this.domain }, 'Payara domain stopped');
  }

  /**
   * Restart Payara domain
   */
  async restart(): Promise<void> {
    this.logger.info({ domain: this.domain }, 'Restarting Payara domain');

    await this.stop();
    await this.start();

    this.logger.info({ domain: this.domain }, 'Payara domain restarted');
  }

  /**
   * Deploy a WAR file to Payara.
   *
   * Handles "virtual server already has web module" errors by undeploying first.
   */
  async deploy(warPath: string, appName: string, contextRoot?: string): Promise<void> {
    this.logger.info({ warPath, appName, contextRoot }, 'Deploying application');

    // Validate contextRoot if provided
    if (contextRoot) {
      if (!contextRoot.startsWith('/')) {
        throw new Error(`contextRoot must start with '/': ${contextRoot}`);
      }
      if (contextRoot.includes(' ')) {
        throw new Error(`contextRoot cannot contain spaces: ${contextRoot}`);
      }
    }

    // Check if app is already deployed - undeploy first for clean state
    // This prevents "virtual server already has web module" errors
    const apps = await this.listApplications();
    if (apps.includes(appName)) {
      this.logger.info({ appName }, 'App already deployed, undeploying first');
      try {
        await this.undeploy(appName);
      } catch (err) {
        this.logger.warn({ err, appName }, 'Undeploy failed, continuing with force deploy');
      }
    }

    const args = ['deploy', '--force=true', `--name=${appName}`];
    if (contextRoot) {
      args.push(`--contextroot=${contextRoot}`);
    }
    args.push(warPath);

    try {
      await this.asadminCommand(args);
      this.logger.info({ appName }, 'Application deployed');
    } catch (err) {
      const error = err as Error & { stderr?: string };
      // Check for "already has web module" error
      if (error.stderr?.includes('already has a web module') ||
          error.message?.includes('already has a web module')) {
        // Last resort: aggressive undeploy with cascade
        this.logger.warn({ appName }, 'Deploy conflict detected, trying aggressive undeploy');
        try {
          await this.asadminCommand(['undeploy', '--cascade=true', appName], 30000);
        } catch {
          // Ignore undeploy errors
        }
        // Retry deploy
        await this.asadminCommand(args);
        this.logger.info({ appName }, 'Application deployed after aggressive cleanup');
      } else {
        throw err;
      }
    }
  }

  /**
   * Undeploy an application from Payara
   */
  async undeploy(appName: string): Promise<void> {
    this.logger.info({ appName }, 'Undeploying application');

    try {
      await this.asadminCommand(['undeploy', appName]);
      this.logger.info({ appName }, 'Application undeployed');
    } catch (err) {
      // Application might not be deployed
      this.logger.warn({ err, appName }, 'Error undeploying (may not be deployed)');
    }
  }

  /**
   * List deployed applications
   */
  async listApplications(): Promise<string[]> {
    try {
      const output = await this.asadminCommand(['list-applications'], 10000);
      const lines = output.split('\n').filter(line => line.trim() && !line.includes('Command'));
      return lines.map(line => line.split(/\s+/)[0] ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get Payara status
   */
  async getStatus(): Promise<PayaraStatus> {
    const running = await this.isRunning();
    const healthy = running ? await this.isHealthy() : false;
    const processPids = await this.getPayaraProcessPids();

    return {
      healthy,
      running,
      domain: this.domain,
      processCount: processPids.length,
      processPids,
    };
  }

  /**
   * Ensure exactly ONE Payara process is running.
   * If multiple processes detected, kills all and restarts fresh.
   * Returns true if safe (0 or 1 process), false if had to fix duplicates.
   */
  async ensureSingleProcess(): Promise<{ ok: boolean; fixed: boolean; previousCount: number }> {
    const pids = await this.getPayaraProcessPids();

    if (pids.length <= 1) {
      return { ok: true, fixed: false, previousCount: pids.length };
    }

    // CRITICAL: Multiple Payara processes detected - this causes Hazelcast cluster issues
    this.logger.error({
      pids,
      count: pids.length,
      domain: this.domain,
    }, 'CRITICAL: Multiple Payara processes detected - will cause cluster issues');

    // Kill all and restart fresh
    this.logger.warn({ pids }, 'Killing all Payara processes to ensure clean state');
    await this.aggressiveStop();

    // Verify cleanup
    const remaining = await this.getPayaraProcessPids();
    if (remaining.length > 0) {
      this.logger.error({ remaining }, 'Failed to kill all Payara processes');
      return { ok: false, fixed: false, previousCount: pids.length };
    }

    // Restart fresh
    this.logger.info('Starting Payara fresh after cleanup');
    await this.safeStart();

    return { ok: true, fixed: true, previousCount: pids.length };
  }

  /**
   * Wait for Payara to become healthy
   */
  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < timeoutMs) {
      if (await this.isHealthy()) {
        return;
      }
      await this.sleep(pollInterval);
    }

    throw new Error(`Payara did not become healthy within ${timeoutMs}ms`);
  }

  /**
   * Wait for Payara to stop
   */
  private async waitForStopped(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      if (!(await this.isRunning())) {
        return;
      }
      await this.sleep(pollInterval);
    }

    throw new Error(`Payara did not stop within ${timeoutMs}ms`);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // AGGRESSIVE MODE: Ensures only ONE Java process runs at a time
  // ============================================================================

  /**
   * Kill Payara-related Java processes only.
   * Filters by cmdline containing 'payara', 'glassfish', or the domain name.
   *
   * This is safer than killAllJavaProcesses() as it won't kill unrelated Java apps.
   */
  async killPayaraProcesses(): Promise<void> {
    this.logger.warn({ user: this.user, domain: this.domain }, 'Killing Payara Java processes');

    // Get PIDs matching Payara cmdline patterns
    const pids = await this.getPayaraProcessPids();

    if (pids.length === 0) {
      this.logger.debug('No Payara Java processes found');
      return;
    }

    this.logger.info({ pids }, 'Found Payara processes to kill');

    // First try graceful SIGTERM
    await this.execCommand(`kill -TERM ${pids.join(' ')} || true`, 5000);
    await this.sleep(2000);

    // Check if any Payara processes remain
    const remaining = await this.getPayaraProcessPids();
    if (remaining.length > 0) {
      // Force kill with SIGKILL
      this.logger.warn({ pids: remaining }, 'Payara processes still running, using SIGKILL');
      await this.execCommand(`kill -9 ${remaining.join(' ')} || true`, 5000);
      await this.sleep(2000);
    }

    // Verify all Payara processes are dead
    const finalCheck = await this.getPayaraProcessPids();
    if (finalCheck.length > 0) {
      this.logger.error({ pids: finalCheck }, 'Failed to kill Payara processes');
      throw new Error(`Failed to kill Payara processes: PIDs ${finalCheck.join(', ')} still running`);
    }

    this.logger.info('Payara processes killed');
  }

  /**
   * Get PIDs of Payara-related Java processes.
   * Matches processes with cmdline containing payara, glassfish, or the domain name.
   */
  async getPayaraProcessPids(): Promise<number[]> {
    // Patterns to match in Java process cmdline
    const patterns = ['payara', 'glassfish', this.domain];
    const patternRegex = patterns.join('|');

    // Find Java PIDs for user that match our patterns
    // This uses pgrep -f to match against full cmdline
    const cmd = `pgrep -u ${this.user} -f "(${patternRegex})" 2>/dev/null | ` +
                `xargs -r ps -p --no-headers -o pid,cmd 2>/dev/null | ` +
                `grep -i java | awk '{print $1}'`;

    try {
      const { stdout } = await this.execCommand(cmd, 5000);
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(pid => parseInt(pid, 10))
        .filter(pid => !isNaN(pid));
    } catch {
      // Command may fail if no processes found
      return [];
    }
  }

  /**
   * Check if any Payara-related Java processes are running
   */
  async hasPayaraProcesses(): Promise<boolean> {
    const pids = await this.getPayaraProcessPids();
    return pids.length > 0;
  }

  /**
   * Kill ALL Java processes for the configured user.
   * This is the legacy "aggressive mode" that ensures a clean slate.
   *
   * WARNING: This kills ALL Java processes for the user, not just Payara.
   * Prefer killPayaraProcesses() unless you specifically need to kill all Java.
   *
   * @deprecated Use killPayaraProcesses() instead for targeted cleanup
   */
  async killAllJavaProcesses(): Promise<void> {
    this.logger.warn({ user: this.user }, 'Killing ALL Java processes (legacy mode)');

    // First try graceful SIGTERM
    // Note: `|| true` ensures command succeeds even if no processes found
    await this.execCommand(`pkill -u ${this.user} java || true`, 5000);
    await this.sleep(2000);

    // Check if any Java processes remain
    const stillRunning = await this.hasJavaProcesses();

    if (stillRunning) {
      // Force kill with SIGKILL
      this.logger.warn('Java processes still running, using SIGKILL');
      await this.execCommand(`pkill -9 -u ${this.user} java || true`, 5000);
      await this.sleep(2000);
    }

    // Verify all processes are dead
    const remaining = await this.getJavaProcessPids();
    if (remaining.length > 0) {
      this.logger.error({ pids: remaining }, 'Failed to kill all Java processes');
      throw new Error(`Failed to kill all Java processes for user ${this.user}: PIDs ${remaining.join(', ')} still running`);
    }

    this.logger.info({ user: this.user }, 'All Java processes killed');
  }

  /**
   * Check if any Java processes are running for the configured user
   */
  async hasJavaProcesses(): Promise<boolean> {
    try {
      const result = await this.execCommand(`pgrep -u ${this.user} java`, 3000);
      return result.stdout.trim().length > 0;
    } catch {
      // pgrep returns exit code 1 when no processes found
      return false;
    }
  }

  /**
   * Get list of Java process PIDs for the configured user
   */
  async getJavaProcessPids(): Promise<number[]> {
    try {
      const result = await this.execCommand(`pgrep -u ${this.user} java`, 3000);
      return result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(pid => parseInt(pid, 10));
    } catch {
      return [];
    }
  }

  /**
   * Ensure NO Payara Java processes are running before starting.
   * Returns true if safe to start, throws if processes couldn't be killed.
   */
  async ensureNoJavaRunning(killIfRunning = true): Promise<boolean> {
    const pids = await this.getPayaraProcessPids();

    if (pids.length === 0) {
      this.logger.debug('No Payara Java processes running - safe to start');
      return true;
    }

    if (!killIfRunning) {
      throw new Error(`Payara Java processes already running: ${pids.join(', ')}. Cannot start safely.`);
    }

    this.logger.warn({ pids }, 'Found existing Payara processes, killing them');
    await this.killPayaraProcesses();

    return true;
  }

  /**
   * Aggressive stop: stop domain + kill Payara Java processes + verify
   *
   * Use this instead of stop() when you need to guarantee no Payara processes remain.
   */
  async aggressiveStop(): Promise<void> {
    this.logger.info({ domain: this.domain }, 'Aggressive stop: stopping domain and killing Payara Java');

    // Step 1: Try graceful stop
    if (await this.isRunning()) {
      try {
        await this.asadminCommand(['stop-domain', this.domain], 30000);
        await this.sleep(2000);
      } catch (err) {
        this.logger.warn({ err }, 'Error during graceful stop (continuing with kill)');
      }
    }

    // Step 2: Kill all remaining Payara Java processes (filtered by cmdline)
    await this.killPayaraProcesses();

    // Step 3: Verify
    const hasProcesses = await this.hasPayaraProcesses();
    if (hasProcesses) {
      throw new Error('Failed to stop all Payara processes');
    }

    this.logger.info({ domain: this.domain }, 'Aggressive stop completed - no Payara processes running');
  }

  /**
   * Safe start: ensures no Java processes are running before starting Payara.
   *
   * This is the recommended way to start Payara in aggressive mode.
   */
  async safeStart(): Promise<void> {
    this.logger.info({ domain: this.domain }, 'Safe start: verifying clean state before starting');

    // Ensure no Java processes running
    await this.ensureNoJavaRunning(true);

    // Write environment to setenv.conf
    await this.writeSetenvConf();

    // Start domain
    this.logger.info({ domain: this.domain }, 'Starting Payara domain (aggressive mode)');
    await this.asadminCommand(['start-domain', this.domain]);

    // Wait for domain to be ready
    await this.waitForHealthy(60000);

    this.logger.info({ domain: this.domain }, 'Payara domain started successfully');
  }

  /**
   * Full restart with aggressive cleanup:
   * 1. Stop domain gracefully
   * 2. Kill ALL Java processes
   * 3. Verify no Java running
   * 4. Start fresh
   */
  async aggressiveRestart(): Promise<void> {
    this.logger.info({ domain: this.domain }, 'Aggressive restart: full stop → kill → start cycle');

    await this.aggressiveStop();
    await this.safeStart();

    this.logger.info({ domain: this.domain }, 'Aggressive restart completed');
  }
}
