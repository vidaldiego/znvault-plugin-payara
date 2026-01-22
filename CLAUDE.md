# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Payara application server plugin for zn-vault-agent and znvault CLI. Provides:
- **WAR Diff Deployment**: Only transfer changed files (via hash comparison)
- **Payara Lifecycle Management**: Start, stop, restart Payara domains
- **Secret Injection**: Write secrets to `setenv.conf` for JVM startup
- **Certificate Integration**: Auto-restart on TLS certificate deployment
- **Managed API Key Rotation**: Zero-downtime key file updates

## Development Commands

```bash
npm install         # Install dependencies
npm run build       # Build TypeScript to dist/
npm run dev         # Watch mode (build on change)
npm test            # Run all tests
npm test test/integration/war-deployer.test.ts  # Run specific test
npm run lint        # ESLint check
npm run lint:fix    # Auto-fix lint issues
npm run typecheck   # TypeScript type check
```

## Architecture

```
src/
├── index.ts              # Plugin factory, lifecycle hooks, secret handling
├── payara-manager.ts     # Payara process management (asadmin wrapper)
├── war-deployer.ts       # WAR diff deployment, hash calculation
├── routes.ts             # HTTP API endpoints (/plugins/payara/*)
├── cli.ts                # CLI commands (znvault deploy)
├── deployment-lock.ts    # File-based lock for SIGTERM deferral
├── deployment-journal.ts # Crash recovery checkpointing
└── types.ts              # TypeScript interfaces
```

### Core Components

**Plugin Factory** (`index.ts`):
- `createPayaraPlugin(config)`: Creates agent plugin instance
- Handles lifecycle: `onInit`, `onStart`, `onStop`
- Event handlers: `onCertificateDeployed`, `onKeyRotated`, `onSecretChanged`
- Implements `healthCheck()` for agent health endpoint

**PayaraManager** (`payara-manager.ts`):
- Wraps `asadmin` commands (start-domain, stop-domain, deploy, undeploy)
- Process detection for duplicate Payara instance prevention
- Health checks via configurable HTTP endpoint
- `setenv.conf` generation for environment variable injection

**WarDeployer** (`war-deployer.ts`):
- Hash calculation using `adm-zip` and SHA-256
- Diff-based deployment: extract → apply changes → repackage → deploy
- Aggressive mode: undeploy → stop → kill Java → start → deploy
- Deployment journaling for crash recovery

**HTTP Routes** (`routes.ts`):
- `GET /hashes`: Returns WAR file hashes for diff calculation
- `POST /deploy`: Apply file changes (base64-encoded)
- `POST /deploy/full`: Full WAR deployment (no diff)
- `POST /deploy/upload`: Upload entire WAR file (binary)
- `GET /status`, `POST /restart`, `POST /start`, `POST /stop`

**CLI Plugin** (`cli.ts`):
- Multi-host deployment configs (`znvault deploy config create`)
- WAR deployment with visual progress (`znvault deploy to <config>`)
- Chunked file transfer for large deployments

### Plugin Integration Points

The plugin implements `@zincapp/zn-vault-agent/plugins` interface:
- `AgentPlugin` with lifecycle methods
- `PluginContext` provides vault client, logger, config
- Events: `CertificateDeployedEvent`, `KeyRotatedEvent`, `SecretChangedEvent`

## Testing

Tests use **Vitest** with mocked Payara/agent dependencies.

```bash
npm test                           # All tests
npm test test/plugin.test.ts       # Unit tests for plugin factory
npm test test/integration/         # Integration tests
npm test test/e2e/                 # End-to-end deployment flow
npm run test:coverage              # With coverage report
```

### Test Structure

| Directory | Description |
|-----------|-------------|
| `test/*.test.ts` | Unit tests (plugin, CLI, war-deployer) |
| `test/integration/` | PayaraManager, WarDeployer, routes tests |
| `test/e2e/` | Full deployment flow with mock server |
| `test/helpers/` | Mock utilities (mock-payara, war-utils) |

## Key Patterns

### Secret Handling

Secrets configured in plugin config are resolved at startup:
```typescript
// Config format
secrets: {
  "ENV_VAR": "literal:value",           // Static value
  "ENV_VAR": "alias:path/to/secret",    // Vault secret
  "ENV_VAR": "alias:path.fieldName",    // JSON field extraction
  "ENV_VAR": "api-key:managed-key-name" // Managed API key
}
```

Secrets are written to `setenv.conf` (not command line) for security.

### Aggressive Mode

When `aggressiveMode: true`, deployments follow strict sequence:
1. Undeploy application
2. Stop Payara domain
3. Kill ALL Java processes (clean slate)
4. Start Payara domain
5. Deploy application

This prevents port conflicts and orphan processes.

### API Key File Mode

When `apiKeyFilePath` is set, API keys are written to a file instead of `setenv.conf`. The application reads from file on each request, enabling zero-downtime rotation.

## Release Process

Push a version tag triggers GitHub Actions publish to npm:

```bash
npm version patch    # or minor/major
git push origin main --tags
```

CI runs tests on Node 18/20/22. Release requires trusted publishing configured on npm (see PUBLISHING.md).

## Peer Dependencies

- `@zincapp/zn-vault-agent` >= 1.14.0 (agent plugin host)
- `@zincapp/znvault-cli` >= 2.11.0 (CLI plugin host)

Both are optional - plugin works standalone for direct HTTP API usage.
