# @zincapp/znvault-plugin-payara

Payara application server management plugin for ZN-Vault Agent and CLI. Enables incremental WAR deployment with diff-based file transfer.

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
| `healthEndpoint` | string | No | HTTP endpoint to check application health |
| `restartOnCertChange` | boolean | No | Restart Payara when certificates are deployed |

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

### Deploy WAR with diff

```bash
# Deploy changed files only
znvault deploy war ./target/MyApp.war --target server.example.com

# Force full deployment
znvault deploy war ./target/MyApp.war --target server.example.com --force

# Dry run - show what would be deployed
znvault deploy war ./target/MyApp.war --target server.example.com --dry-run
```

### Restart Payara

```bash
znvault deploy restart --target server.example.com
```

### Check Status

```bash
znvault deploy status --target server.example.com
```

### List Applications

```bash
znvault deploy applications --target server.example.com
# or
znvault deploy apps --target server.example.com
```

## CLI Configuration

Add the plugin to your CLI config (`~/.znvault/config.json`):

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

## License

MIT
