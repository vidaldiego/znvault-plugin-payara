// Path: src/payara-manager.ts
// Payara application server process management

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

  constructor(options: PayaraManagerOptions) {
    this.payaraHome = options.payaraHome;
    this.domain = options.domain;
    this.user = options.user;
    this.healthEndpoint = options.healthEndpoint;
    this.healthCheckTimeout = options.healthCheckTimeout ?? 30000;
    this.operationTimeout = options.operationTimeout ?? 120000;
    this.logger = options.logger;
    this.environment = options.environment ?? {};

    // Path to asadmin command
    this.asadmin = join(this.payaraHome, 'bin', 'asadmin');
  }

  /**
   * Update environment variables (e.g., after secret refresh)
   */
  setEnvironment(env: Record<string, string>): void {
    this.environment = env;
    this.logger.debug({ count: Object.keys(env).length }, 'Environment updated');
  }

  /**
   * Build environment string for command execution
   * Returns "VAR1=value1 VAR2=value2 " prefix for the command
   */
  private buildEnvPrefix(): string {
    const envVars: string[] = [];

    // Add JAVA_HOME
    const javaHome = process.env.JAVA_HOME ?? '/usr/lib/jvm/java-21-openjdk-amd64';
    envVars.push(`JAVA_HOME="${javaHome}"`);

    // Add custom environment variables (secrets)
    for (const [key, value] of Object.entries(this.environment)) {
      // Escape single quotes in value
      const escapedValue = value.replace(/'/g, "'\\''");
      envVars.push(`${key}='${escapedValue}'`);
    }

    return envVars.length > 0 ? envVars.join(' ') + ' ' : '';
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
      this.logger.error({
        command: command,
        stdout: error.stdout,
        stderr: error.stderr,
        code: error.code,
      }, 'Command failed');
      throw err;
    }
  }

  /**
   * Run asadmin command
   */
  private async asadminCommand(args: string[], timeout?: number): Promise<string> {
    const command = `${this.asadmin} ${args.join(' ')}`;
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
      return domainLine?.includes('running') && !domainLine?.includes('not running') || false;
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
   * Deploy a WAR file to Payara
   */
  async deploy(warPath: string, appName: string, contextRoot?: string): Promise<void> {
    this.logger.info({ warPath, appName, contextRoot }, 'Deploying application');

    const args = ['deploy', '--force=true', `--name=${appName}`];
    if (contextRoot) {
      args.push(`--contextroot=${contextRoot}`);
    }
    args.push(warPath);

    await this.asadminCommand(args);

    this.logger.info({ appName }, 'Application deployed');
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

    return {
      healthy,
      running,
      domain: this.domain,
    };
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
}
