# @zincapp/znvault-plugin-payara

Payara application server management plugin for ZnVault Agent and CLI. Enables incremental WAR deployment with diff-based file transfer.

## Features

- **WAR Diff Deployment**: Only transfer changed files, not entire WAR
- **Payara Lifecycle Management**: Start, stop, restart Payara domains
- **Certificate Integration**: Auto-restart on certificate deployment
- **Health Monitoring**: Plugin health status in agent health endpoint
- **CLI Commands**: Deploy WAR files from development machine

## Installation

```bash
npm install @zincapp/znvault-plugin-payara
```

## Agent Configuration

Add the plugin to your agent's `config.json`:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": { "apiKey": "znv_..." },
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "config": {
        "payaraHome": "/opt/payara",
        "domain": "domain1",
        "user": "payara",
        "warPath": "/opt/app/MyApp.war",
        "appName": "MyApp",
        "healthEndpoint": "http://localhost:8080/health",
        "restartOnCertChange": true
      }
    }
  ]
}
```

### Configuration Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `payaraHome` | string | Yes | Path to Payara installation |
| `domain` | string | Yes | Payara domain name |
| `user` | string | Yes | System user to run asadmin commands as |
| `warPath` | string | Yes | Path to the WAR file |
| `appName` | string | Yes | Application name in Payara |
| `contextRoot` | string | No | Context root for deployment (default: `/${appName}`) |
| `healthEndpoint` | string | No | HTTP endpoint to check application health |
| `restartOnCertChange` | boolean | No | Restart Payara when certificates are deployed |
| `restartOnKeyRotation` | boolean | No | Restart Payara when API key is rotated (default: false) |
| `aggressiveMode` | boolean | No | Full restart cycle on deploy (undeploy→stop→kill→start→deploy) |
| `apiKeyFilePath` | string | No | Path to write API key file (enables zero-downtime key rotation) |
| `secrets` | object | No | Environment variables to write to `setenv.conf` |
| `watchSecrets` | string[] | No | Secret aliases to watch for changes |

### Secrets Configuration

Secrets are written to Payara's `setenv.conf` file, NOT passed via command line (security improvement in v1.7.0):

```json
{
  "secrets": {
    "ZINC_CONFIG_USE_VAULT": "literal:true",
    "ZINC_CONFIG_APPLICATION_FILE": "literal:api/staging/config",
    "ZINC_CONFIG_VAULT_API_KEY": "api-key:my-managed-key",
    "AWS_ACCESS_KEY_ID": "alias:api/staging/s3.accessKeyId",
    "AWS_SECRET_ACCESS_KEY": "alias:api/staging/s3.secretAccessKey"
  },
  "watchSecrets": ["api/staging/config", "api/staging/s3"]
}
```

Secret value prefixes:
- `literal:` - Static value
- `alias:` - Vault secret alias (with optional path)
- `api-key:` - Managed API key value

## HTTP API

The plugin registers routes under `/plugins/payara/`:

### GET /plugins/payara/hashes

Returns SHA-256 hashes of all files in the current WAR.

```bash
curl http://localhost:9100/plugins/payara/hashes
```

Response:
```json
{
  "hashes": {
    "WEB-INF/web.xml": "abc123...",
    "index.html": "def456..."
  }
}
```

### POST /plugins/payara/deploy

Apply file changes and deploy. Files are base64-encoded.

```bash
curl -X POST http://localhost:9100/plugins/payara/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {"path": "index.html", "content": "PGh0bWw+Li4uPC9odG1sPg=="}
    ],
    "deletions": ["old-file.css"]
  }'
```

Response:
```json
{
  "status": "deployed",
  "filesChanged": 1,
  "filesDeleted": 1,
  "message": "Deployment successful"
}
```

### POST /plugins/payara/deploy/full

Trigger a full WAR deployment (no diff).

### POST /plugins/payara/restart

Restart the Payara domain.

### POST /plugins/payara/start

Start the Payara domain.

### POST /plugins/payara/stop

Stop the Payara domain.

### GET /plugins/payara/status

Get current Payara status.

```json
{
  "running": true,
  "healthy": true,
  "domain": "domain1"
}
```

### GET /plugins/payara/applications

List deployed applications.

```json
{
  "applications": ["MyApp", "OtherApp"]
}
```

### GET /plugins/payara/file/*

Get a specific file from the WAR.

```bash
curl http://localhost:9100/plugins/payara/file/WEB-INF/web.xml
```

## CLI Commands

The plugin adds commands to `znvault`:

### Multi-Host Deployment Configs

Create and manage deployment configurations for multiple hosts:

```bash
# Create a new deployment config
znvault deploy config create staging \
  --war /path/to/app.war \
  --host 172.16.220.55 \
  --host 172.16.220.56 \
  --host 172.16.220.57 \
  --parallel

# Deploy to all hosts in config (diff transfer)
znvault deploy to staging

# Or use 'run' alias
znvault deploy run staging

# Force full deployment
znvault deploy to staging --force

# Dry run
znvault deploy to staging --dry-run

# Sequential deployment (one host at a time)
znvault deploy to staging --sequential

# Manage configs
znvault deploy config list
znvault deploy config show staging
znvault deploy config add-host staging 172.16.220.58
znvault deploy config set staging war /new/path.war
znvault deploy config delete staging
```

### Tunneled Deployment (`tunnel: true`)

Deploy agents bind their `:9100` deploy/health server to loopback only, so it
is never exposed on the network. Set `tunnel: true` on a deploy config to route
the deploy through an **SSH-CA-authenticated local port-forward** to each host
instead — the deploy opens one `znvault ssh forward` per host, rewrites only the
fetched agent URL to `127.0.0.1:<ephemeral>`, runs the existing preflight + WAR
transfer through the tunnel, and tears it down afterward.

```jsonc
{
  "name": "staging",
  "war": "/path/to/app.war",
  "hosts": ["172.16.220.55", "172.16.220.56", "172.16.220.57"],
  "tunnel": true,
  "ssh": {
    "user": "sysadmin",            // optional; SSH user for the forward
    "readinessTimeoutMs": 30000    // optional; wait for /health through the tunnel
  }
}
```

| Config field | Type | Required | Description |
|--------------|------|----------|-------------|
| `tunnel` | boolean | No | Route the deploy through a per-host SSH-CA port-forward (default: `false`) |
| `ssh.user` | string | No | SSH user for the forward (default: `sysadmin`, honoring `~/.ssh/config`) |
| `ssh.readinessTimeoutMs` | number | No | How long to wait for the agent's `/health` through the tunnel before failing |

Requires `@zincapp/znvault-cli` >= 4.5.0 (ships `znvault ssh forward`) and this
plugin >= 1.18.0. See the
[Deployment Guide → Tunneled Deploys](../docs/DEPLOYMENT_GUIDE.md#tunneled-deploys)
for the full how-it-works, version matrix, loopback cutover procedure, and the
important caution about `deploy --force` with `aggressiveMode`.

### Scheduler-aware deploy (quiesce)

Scheduler-aware deploy is **opt-in and off by default**. A deploy config without a `quiesce` block (or with `quiesce.enabled: false`) is byte-identical to the current behaviour — no scheduler calls are made, no new secrets are required.

When enabled, the deploy drains the HAProxy backend for the target node, then asks znapi's in-process scheduler to stop accepting new units and waits until all in-flight units finish before transferring the WAR. This prevents a mid-deploy unit run from using a partially-updated WAR. The scheduler is always resumed in `finally`, even if the deploy itself fails.

#### Config block

Add a `quiesce` block to a deploy config and, optionally, per-host timeout overrides in `hostConfigs`:

```jsonc
{
  "name": "znapi-staging",
  "war": "/path/to/znapi.war",
  "hosts": ["172.16.220.55", "172.16.220.56", "172.16.220.57"],
  "tunnel": true,
  "ssh": { "user": "sysadmin" },
  "haproxy": {
    "hosts": ["172.16.220.20"],
    "backend": "znapi",
    "serverMap": {
      "172.16.220.55": "znapi-01",
      "172.16.220.56": "znapi-02"
      // 172.16.220.57 is a worker — absent from serverMap, skips HAProxy drain
    }
  },
  "quiesce": {
    "enabled": true,            // required to activate; everything else is optional
    "pollMs": 2000,             // how often to poll inFlightUnits (default: 2000)
    "drainTimeoutMs": 120000    // max wait for in-flight units to reach 0 (default: 120000)
    // The agent always sends X-Internal-Origin: deploy; this is not operator-configurable.
  },
  "hostConfigs": {
    "172.16.220.57": {
      "quiesceTimeoutMs": 60000  // per-host override of drainTimeoutMs
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `quiesce.enabled` | boolean | `false` | Activate scheduler quiesce on this deploy config |
| `quiesce.pollMs` | number | `2000` | Polling interval (ms) while waiting for in-flight units to drain |
| `quiesce.drainTimeoutMs` | number | `120000` | Max time (ms) to wait for in-flight count to reach zero |
| `hostConfigs.<host>.quiesceTimeoutMs` | number | _(inherits `drainTimeoutMs`)_ | Per-host override for the drain timeout |

There is no `role` field. A "worker node" is simply a host that is absent from `haproxy.serverMap` — it skips the HAProxy drain/ready cycle but still receives the quiesce call before the WAR transfer.

#### How it works

For each host, the deploy runs the following sequence:

1. **HAProxy drain** — if the host is in `haproxy.serverMap`, set it to DRAIN and wait for active connections to clear (existing behaviour, unchanged).
2. **Quiesce** — POST to the agent's `/scheduler/quiesce` passthrough endpoint, which calls znapi's loopback `/internal/scheduler/quiesce`. The scheduler stops accepting new units and returns the current in-flight count.
3. **Poll until drained** — poll `/scheduler/status` every `pollMs` ms until `inFlightUnits === 0` or `drainTimeoutMs` elapses.
4. **Deploy** — transfer the WAR diff and restart Payara (existing behaviour, unchanged).
5. **Resume** (in `finally`) — POST to `/scheduler/resume` via the agent passthrough. This runs even if the deploy fails. A failed resume is logged but never throws — znapi's internal `quiesceTtlSeconds` auto-resume is the backstop.

**Degradation guarantees** — every failure degrades to today's safe deploy and the deploy proceeds:

- Agent cannot reach znapi loopback (connection refused) → log + skip quiesce → deploy.
- znapi version does not have the endpoint (HTTP 404) → agent returns `{ available: false }` → log + skip quiesce → deploy.
- `X-Internal-Secret` mismatch (401) → log + skip quiesce → deploy.
- Drain timeout elapsed with in-flight units still > 0 → log warning + proceed to deploy (safe because the Q5 daily-unit same-day recovery fix is in place — a mid-deploy run will recover on the next poll).
- Resume call fails → swallow + log; auto-resume TTL is the backstop.

No failure path can abort a deploy that was otherwise ready to proceed.

#### Provisioning: dedicated deploy secret

The loopback call uses a **dedicated deploy secret** stored on each node — it is never part of the deploy config and never travels from the operator machine.

On each znapi node, provision the secret file:

```bash
# On each znapi host (e.g. /etc/zincapi/scheduler-deploy-secret)
openssl rand -hex 32 | sudo tee /etc/zincapi/scheduler-deploy-secret > /dev/null
sudo chmod 640 /etc/zincapi/scheduler-deploy-secret
sudo chown root:zn-vault-agent /etc/zincapi/scheduler-deploy-secret
```

The secret file path is configured in znapi's `ZincConfiguration` via `schedulerDeploySecretFile` (default: `/etc/zincapi/scheduler-deploy-secret`). The agent reads the same file via its `internalSecretFile` config field (default: `/etc/zincapi/scheduler-deploy-secret`).

#### Agent configuration

The agent requires two new optional fields in its `config.json` plugin config (both have defaults that match a standard deployment):

```json
{
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "config": {
        "znapiBaseUrl": "http://127.0.0.1:8080",
        "internalSecretFile": "/etc/zincapi/scheduler-deploy-secret"
      }
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `znapiBaseUrl` | `http://127.0.0.1:8080` | Base URL of the znapi instance on the same node |
| `internalSecretFile` | `/etc/zincapi/scheduler-deploy-secret` | Path to the shared deploy secret file |

If `internalSecretFile` does not exist at agent start, the agent logs a warning but does **not** crash. The missing secret causes quiesce calls to return `{ available: false }`, which degrades safely to a quiesce-less deploy.

#### Loopback auth model

znapi's `/internal/scheduler/*` endpoint is protected by `SchedulerInternalFilter`, which mirrors the house `TrackingInternalFilter` / `FaceInternalFilter` pattern:

1. **Proxy-header absence** — any request carrying `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, or `Via` is rejected (403). This is the loopback signal: HAProxy strips or blocks these headers on the internal path, so their presence means the call did not originate on-node.
2. **`X-Internal-Origin: deploy`** — must be present and equal `"deploy"` exactly (403 otherwise).
3. **`X-Internal-Secret: <secret>`** — must match the contents of `schedulerDeploySecretFile` on the znapi node (401 otherwise).

The agent sends these three conditions and no proxy headers, satisfying all three gates.

#### Rollout order

Follow this sequence to activate quiesce deploys safely:

1. **Provision the secret** on every znapi node (`/etc/zincapi/scheduler-deploy-secret` with the same value on all nodes in a cluster).
2. **Ship the dormant znapi endpoints** (`InternalSchedulerEndpoint` + `SchedulerInternalFilter`) — these endpoints are unreachable until called and do not affect normal traffic.
3. **Ship agent + plugin** with `quiesce.enabled` absent or `false` on all deploy configs — byte-identical to the current behaviour; no quiesce calls are made.
4. **Enable on one deploy config** — set `quiesce.enabled: true` on a single non-critical config and run a real deploy.
5. **Smoke the loopback seam** — confirm in the deploy output that the quiesce call succeeded (look for "Quiescing scheduler..." and "Scheduler drained" in the task log). This is the single integration point that cannot be covered by automated tests (see Known coverage gap below).
6. **Roll out** to remaining deploy configs once the smoke deploy is clean.

**Prerequisite satisfied:** The Q5 daily-unit same-day recovery fix (units that miss their scheduled window due to a quiesce recover on the next poll cycle) is implemented and soak-validated. It is safe to proceed even if `drainTimeoutMs` elapses with units still in flight.

#### Known coverage gap

The single untested integration seam is the **agent → znapi call over real loopback in production** and the znapi endpoint's HTTP response paths (including the 503-on-null-scheduler branch). The znapi endpoint class cannot be invoked through a real HTTP request in unit tests because `ZincApi` is a `final` singleton with no mockable seam for the Kotlin test runner. Coverage of these paths is provided by:

- **Unit tests**: `SchedulerEngine` state-machine tests (quiesce/resume/inFlightUnits logic), `SchedulerInternalFilter` auth rejection tests.
- **Smoke deploy** (step 5 above): the first real scheduler-aware deploy exercises the full agent↔znapi loopback path end-to-end. Watch for `X-Internal-Secret` mismatches (401 in znapi logs), connection-refused errors (agent cannot reach `znapiBaseUrl`), and unexpected 503s (scheduler not initialised on this node).

---

### Single-Host Deployment

```bash
# Deploy changed files only
znvault deploy war ./target/MyApp.war --target server.example.com

# Force full deployment
znvault deploy war ./target/MyApp.war --target server.example.com --force

# Dry run - show what would be deployed
znvault deploy war ./target/MyApp.war --target server.example.com --dry-run
```

### Server Management

```bash
# Restart Payara
znvault deploy restart --target server.example.com
znvault deploy restart staging  # All hosts in config

# Check status
znvault deploy status --target server.example.com
znvault deploy status staging  # All hosts in config

# List applications
znvault deploy applications --target server.example.com
znvault deploy apps --target server.example.com
```

## CLI Installation

Install the plugin in the CLI plugins directory:

```bash
znvault plugin install @zincapp/znvault-plugin-payara
```

Or add to your CLI config (`~/.znvault/config.json`):

```json
{
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "enabled": true
    }
  ]
}
```

## How Diff Deployment Works

1. CLI calculates SHA-256 hash for every file in local WAR
2. CLI requests current hashes from agent (`GET /plugins/payara/hashes`)
3. CLI compares hashes to determine:
   - **Changed files**: Hash differs or file is new
   - **Deleted files**: Exists remotely but not locally
4. CLI sends only changed files (base64-encoded) and deletion list
5. Agent extracts current WAR to temp directory
6. Agent applies changes (updates, creates, deletes files)
7. Agent repackages WAR
8. Agent stops Payara, deploys WAR, starts Payara

This reduces deployment time from minutes (full WAR transfer) to seconds (incremental changes).

## Architecture

```
┌─────────────────┐                          ┌─────────────────┐
│   Development   │                          │   Production    │
│     Machine     │                          │     Server      │
│                 │                          │                 │
│  ┌───────────┐  │    Diff Transfer         │  ┌───────────┐  │
│  │ Local WAR │  │  (changed files only)    │  │ Agent     │  │
│  └─────┬─────┘  │ ────────────────────────>│  │ + Plugin  │  │
│        │        │                          │  └─────┬─────┘  │
│  ┌─────▼─────┐  │                          │        │        │
│  │ znvault   │  │   GET /hashes            │  ┌─────▼─────┐  │
│  │ deploy    │◄─┼──────────────────────────┼──│ WAR File  │  │
│  │ war       │  │                          │  └─────┬─────┘  │
│  └───────────┘  │   POST /deploy           │        │        │
│                 │ ────────────────────────>│  ┌─────▼─────┐  │
│                 │                          │  │ Payara    │  │
│                 │                          │  │ Server    │  │
│                 │                          │  └───────────┘  │
└─────────────────┘                          └─────────────────┘
```

## Plugin Events

The plugin responds to zn-vault-agent lifecycle events:

### onCertificateDeployed

When `restartOnCertChange: true`, automatically restarts Payara after certificate deployment:

```javascript
// Plugin automatically handles this when certificates change
// No action needed from user
```

### healthCheck

Reports Payara status to the agent's `/health` endpoint:

```json
{
  "plugins": {
    "payara": {
      "status": "healthy",
      "details": {
        "domain": "domain1",
        "warPath": "/opt/app/MyApp.war"
      }
    }
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run specific test suite
npm test test/integration/war-deployer.test.ts

# Type check
npm run typecheck

# Lint
npm run lint
```

### Test Coverage

| Suite | Tests | Description |
|-------|-------|-------------|
| Unit | 31 | Core plugin, CLI, WAR deployer logic |
| Integration | 49 | PayaraManager, WarDeployer, HTTP routes |
| E2E | 17 | Full deployment flow, plugin factory |
| **Total** | **97** | All tests passing |

## Requirements

- Node.js 18+
- Payara Server 5.x or 6.x
- `asadmin` in PATH or at `$PAYARA_HOME/bin/asadmin`
- Write access to WAR file location
- sudo access for running as different user (if configured)

## Migration from Python zinc_updater

See [MIGRATION.md](./MIGRATION.md) for step-by-step migration guide from the Python-based zinc_updater.

## Changelog

### v1.18.0
- Added opt-in `tunnel: true` deploy-config flag (+ optional `ssh: {user?, readinessTimeoutMs?}`): route deploys through a per-host SSH-CA local port-forward so agents stay loopback-only and `:9100` is never on the wire. Requires `@zincapp/znvault-cli` >= 4.5.0. See the [Deployment Guide → Tunneled Deploys](../docs/DEPLOYMENT_GUIDE.md#tunneled-deploys).

### v1.7.3
- Fix: Always write setenv.conf on agent start (even when skipping Payara restart in aggressive mode)

### v1.7.2
- Fix: Add 60s timeout for agent HTTP requests (fixes diff deployment with large WARs)

### v1.7.1
- Fix: Use direct fetch for agent communication instead of vault client

### v1.7.0
- **SECURITY**: Secrets no longer passed via command line (visible in `ps aux`/logs)
- Secrets now written only to `setenv.conf` file
- Added undeploy-before-deploy to prevent "virtual server already has web module" errors
- Added upload progress indicator for full WAR uploads
- Added retry logic for hash endpoint
- Improved `/hashes` endpoint response with status field

### v1.6.1
- Skip Payara restart on agent restart if already healthy (zero-downtime updates)

### v1.6.0
- Added `aggressiveMode` for full restart cycle on deploy
- Added `apiKeyFilePath` for file-based API key rotation
- Zero-downtime key rotation support

## License

MIT
