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
