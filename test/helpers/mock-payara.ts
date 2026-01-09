// Path: test/helpers/mock-payara.ts
// Mock Payara environment for testing

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';

export interface MockPayaraOptions {
  /** Base directory for mock Payara */
  baseDir: string;
  /** Domain name */
  domain?: string;
  /** Port for health endpoint */
  healthPort?: number;
}

export interface MockPayaraState {
  running: boolean;
  applications: string[];
  failStart: boolean;
  failStop: boolean;
  failDeploy: boolean;
  failUndeploy: boolean;
}

/**
 * Mock Payara environment that simulates asadmin commands
 */
export class MockPayara {
  private options: Required<MockPayaraOptions>;
  private healthServer: Server | null = null;
  private stateFile: string;

  constructor(options: MockPayaraOptions) {
    this.options = {
      domain: 'domain1',
      healthPort: 0,
      ...options,
    };
    this.stateFile = join(this.options.baseDir, '.mock-state.json');
  }

  /**
   * Set up mock Payara directory structure
   */
  async setup(): Promise<void> {
    const { baseDir, domain } = this.options;

    // Create directory structure
    mkdirSync(join(baseDir, 'bin'), { recursive: true });
    mkdirSync(join(baseDir, 'glassfish', 'domains', domain, 'applications'), { recursive: true });

    // Initialize state
    this.saveState({
      running: false,
      applications: [],
      failStart: false,
      failStop: false,
      failDeploy: false,
      failUndeploy: false,
    });

    // Create mock asadmin script
    this.createAsadminScript();
  }

  private createAsadminScript(): void {
    const asadminPath = join(this.options.baseDir, 'bin', 'asadmin');
    const script = `#!/bin/bash
# Mock asadmin script for testing
STATE_FILE="${this.stateFile}"

# Parse JSON state file
get_state_value() {
  local key="$1"
  grep -o "\\"$key\\":[^,}]*" "$STATE_FILE" | head -1 | sed 's/.*://' | tr -d ' "\\n'
}

set_state_value() {
  local key="$1"
  local value="$2"
  local tmp_file="\${STATE_FILE}.tmp"
  sed "s/\\"$key\\":[^,}]*/\\"$key\\":$value/" "$STATE_FILE" > "$tmp_file"
  mv "$tmp_file" "$STATE_FILE"
}

RUNNING=$(get_state_value "running")
FAIL_START=$(get_state_value "failStart")
FAIL_STOP=$(get_state_value "failStop")
FAIL_DEPLOY=$(get_state_value "failDeploy")
FAIL_UNDEPLOY=$(get_state_value "failUndeploy")

case "$1" in
  start-domain)
    if [ "$FAIL_START" = "true" ]; then
      echo "Command start-domain failed." >&2
      exit 1
    fi
    set_state_value "running" "true"
    echo "Command start-domain executed successfully."
    exit 0
    ;;

  stop-domain)
    if [ "$FAIL_STOP" = "true" ]; then
      echo "Command stop-domain failed." >&2
      exit 1
    fi
    set_state_value "running" "false"
    echo "Command stop-domain executed successfully."
    exit 0
    ;;

  restart-domain)
    if [ "$FAIL_START" = "true" ]; then
      echo "Command restart-domain failed." >&2
      exit 1
    fi
    set_state_value "running" "true"
    echo "Command restart-domain executed successfully."
    exit 0
    ;;

  deploy)
    if [ "$FAIL_DEPLOY" = "true" ]; then
      echo "Command deploy failed." >&2
      exit 1
    fi
    echo "Application deployed successfully."
    exit 0
    ;;

  undeploy)
    if [ "$FAIL_UNDEPLOY" = "true" ]; then
      echo "Command undeploy failed." >&2
      exit 1
    fi
    echo "Command undeploy executed successfully."
    exit 0
    ;;

  list-applications)
    echo "Command list-applications executed successfully."
    exit 0
    ;;

  list-domains)
    if [ "$RUNNING" = "true" ]; then
      echo "${this.options.domain} running"
    else
      echo "${this.options.domain} not running"
    fi
    exit 0
    ;;

  *)
    echo "Unknown command: $1" >&2
    exit 1
    ;;
esac
`;

    writeFileSync(asadminPath, script);
    chmodSync(asadminPath, 0o755);
  }

  /**
   * Clean up mock Payara
   */
  async cleanup(): Promise<void> {
    await this.stopHealthServer();
    if (existsSync(this.options.baseDir)) {
      rmSync(this.options.baseDir, { recursive: true, force: true });
    }
  }

  /**
   * Start mock health server
   */
  async startHealthServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.healthServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const state = this.loadState();
        if (req.url === '/health' || req.url === '/service-status') {
          if (state.running) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'healthy', applications: state.applications }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'unavailable' }));
          }
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.healthServer.listen(this.options.healthPort, () => {
        const addr = this.healthServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        this.options.healthPort = port;
        resolve(port);
      });

      this.healthServer.on('error', reject);
    });
  }

  /**
   * Stop mock health server
   */
  async stopHealthServer(): Promise<void> {
    return new Promise((resolve) => {
      if (this.healthServer) {
        this.healthServer.close(() => resolve());
        this.healthServer = null;
      } else {
        resolve();
      }
    });
  }

  /**
   * Get mock Payara home path
   */
  get payaraHome(): string {
    return this.options.baseDir;
  }

  /**
   * Get domain name
   */
  get domain(): string {
    return this.options.domain;
  }

  /**
   * Get health endpoint URL
   */
  get healthEndpoint(): string {
    return `http://localhost:${this.options.healthPort}/health`;
  }

  /**
   * Simulate domain start (for manual testing)
   */
  simulateStart(): void {
    const state = this.loadState();
    state.running = true;
    this.saveState(state);
  }

  /**
   * Simulate domain stop (for manual testing)
   */
  simulateStop(): void {
    const state = this.loadState();
    state.running = false;
    this.saveState(state);
  }

  /**
   * Set failure mode
   */
  setFailure(type: 'start' | 'stop' | 'deploy' | 'undeploy', fail: boolean): void {
    const state = this.loadState();
    switch (type) {
      case 'start': state.failStart = fail; break;
      case 'stop': state.failStop = fail; break;
      case 'deploy': state.failDeploy = fail; break;
      case 'undeploy': state.failUndeploy = fail; break;
    }
    this.saveState(state);
  }

  /**
   * Get current state
   */
  getState(): MockPayaraState {
    return this.loadState();
  }

  /**
   * Reset state
   */
  reset(): void {
    this.saveState({
      running: false,
      applications: [],
      failStart: false,
      failStop: false,
      failDeploy: false,
      failUndeploy: false,
    });
  }

  private saveState(state: MockPayaraState): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  private loadState(): MockPayaraState {
    if (existsSync(this.stateFile)) {
      try {
        return JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      } catch {
        // Return default state on parse error
      }
    }
    return {
      running: false,
      applications: [],
      failStart: false,
      failStop: false,
      failDeploy: false,
      failUndeploy: false,
    };
  }
}

/**
 * Create a temporary mock Payara instance
 */
export async function createMockPayara(options?: Partial<MockPayaraOptions>): Promise<MockPayara> {
  const baseDir = options?.baseDir || `/tmp/mock-payara-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mock = new MockPayara({ baseDir, ...options });
  await mock.setup();
  return mock;
}
