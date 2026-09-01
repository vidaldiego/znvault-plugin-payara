# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Payara application server plugin for zn-vault-agent and znvault CLI. Provides:
- **WAR Diff Deployment**: Only transfer changed files (via hash comparison)
- **Payara Lifecycle Management**: Start, stop, restart Payara domains
- **Secret Injection**: Write secrets to `setenv.conf` for JVM startup
- **Certificate Event Safety**: Certificate events never restart Payara
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
├── cli.ts                # CLI commands (znvault payara)
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
- Awaits the complete 105-second monotonic startup transaction; routes and
  health remain 503 until it commits

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
- `GET /hashes`: Returns one coherent raw/canonical WAR identity plus entry hashes
- `POST /deploy`: Apply file changes (base64-encoded)
- `POST /deploy/full`: Full WAR deployment (no diff)
- `POST /deploy/upload`: Upload entire WAR file (binary)
- `POST /boot-deployment/stage-artifact`: Store only a missing recovery WAR
- `POST /boot-deployment/recover`: Hash/epoch/runtime-bound one-shot recovery
- `GET /status`, `POST /restart`, `POST /start`, `POST /stop`

Every deployment mutation requires one caller-generated lowercase UUIDv4
`deploymentId` (`x-znvault-deployment-id` for the binary upload; JSON field for
diff, full, and every chunk). There is no server-generated fallback.
`/deploy/status` publishes the active `deploymentId` and the
`lastDeploymentId` bound to `lastResult`. Timeout recovery compares those IDs
exactly; timestamps and application health are never deployment receipts, and
a 409 for a different ID is a hard conflict rather than a reason to poll.

Every deploy rail also carries an artifact CAS fence. The CLI snapshots the
local WAR once, sends the exact raw remote `sha256` observed from `/hashes` (or
`null` for an absent WAR) as `expectedBaseSha256`, and sends the immutable
snapshot's canonical entry-content digest as `targetContentSha256`. The agent
revalidates the base under the shared mutation lock before any WAR/lifecycle
change, verifies the proposed target before replacement, and returns an exact
post-deploy artifact receipt. Base drift, target mismatch, or a missing/mismatched
receipt fails closed.

Local, uploaded, and recovery-staged WARs share one strict ZIP parser. Duplicate
logical names, file/directory collisions, unsafe paths, and control characters
are rejected before a lock or lifecycle operation; their entry maps cannot be
silently collapsed into a misleading content identity.

**CLI Plugin** (`cli.ts`):
- Multi-host deployment configs (`znvault payara config create`)
- WAR deployment with visual progress (`znvault payara deploy to <config>`)
- Chunked file transfer for large deployments

### Plugin Integration Points

The plugin implements `@zincapp/zn-vault-agent/plugins` interface:
- `AgentPlugin` with lifecycle methods
- `PluginContext` provides vault client, logger, config
- Events: `CertificateDeployedEvent`, `KeyRotatedEvent`, `SecretChangedEvent`

### Deploy node classes (`payara deploy run`)

A deploy config is **flat** (top-level `hosts`) or **multi-class** (an ordered
`classes` array) — never both. `classes` absent ⇒ flat path runs byte-identically
to v1.21.1. Two layers:

1. **Within one host list (v1.21.1):** the strategy (`1+R`, …) applies to
   **serving** nodes (in `haproxy.serverMap`); **worker** nodes (not in
   `serverMap`) deploy in a separate final batch — parallel, no drain,
   **non-blocking**. `partitionHostsByClass` (`listr-deploy.ts`) is the split.
2. **Multi-class (v1.22.0):** an explicit `classes[]` so `payara deploy run <env>`
   deploys every node class (api, worker, future) as **ordered phases**, each
   self-describing (own `strategy`, `blocking`, `haproxy` drain, `quiesce`, and
   overridable shared defaults incl. a per-class WAR). Classes deploy in array
   order behind a **blocking gate**. (Relative `warPath`s — top-level or per-class —
   are anchored by config-level `rootDir`; see "Config templates & rootDir" below.)

**Key files** — `deploy-class.ts` (`resolveClass`, `partitionSelectedClasses`,
`hasActiveServerMap`), `deploy-config-validate.ts` (`validateDeployConfig`),
`multi-class-deploy.ts` (`executeMultiClassDeployment` + `classGateFailed` +
dry-run/summary printers), wired in `commands/deploy-run.ts`.

**The class-sequencing gate (load-bearing):** `classGateFailed = failed>0 ||
aborted || healthCheckFailed>0` — includes `healthCheckFailed` (a
parallel-strategy serving health-fail must gate downstream), **excludes**
`workerFailed`. A blocking class must pass before the next runs; a non-blocking
class or worker failure is allowed to finish the remaining phases. The final
command gate is stricter: any selected host without an exact verified deployment
receipt, including a worker, exits non-zero and blocks post-deploy migration.

**Resolution:** class field wins over the config-level shared default; **objects
replace wholesale** (no deep-merge). `quiesce`/`hostConfigs` are **per-class
only** (never inherit; top-level on a multi-class config is a validation error).
`blocking` defaults true iff resolved `haproxy` has a non-empty `serverMap`.

**CLI:** `--class <name>` (repeatable, unique, config order), `--dry-run` (per-class
plan), class-scoped `--strategy`/`--host` (need exactly one `--class`),
`payara config validate <cfg>`. v1 authors `classes` by hand-editing
`~/.znvault/payara/configs.json` (no CLI authoring command yet).

Guide: README → "Multi-class configs". Design:
`../docs/superpowers/specs/2026-06-23-multi-class-deploy-design.md`.

### Migration phases (`payara deploy run`, v1.28.0)

A deploy config may carry **two** schema-migration blocks: `migration` (pre-deploy,
runs BEFORE any host) and `postMigration` (post-deploy, runs ONLY after a fully
successful rollout). Post-deploy exists for **destructive** changes (drop
column/table, remove routines) that are unsafe while old-WAR instances are still
live. Both are the same `MigrationConfig` shape (role, dir, optional database; a relative
`migrationsDir`/`scaffoldingFile` is anchored by config-level `rootDir` — see "Config
templates & rootDir" below). **Pre and post MUST use different `migrationsDir` folders** —
the engine applies all-pending-per-dir, so a shared dir makes the post phase a
silent no-op; `validateDeployConfig` warns on equal dirs.

Ordered plan: pre migrations → deploy all classes → post migrations.

For rollout commands, the mutable boundary is fleet-wide: load every credential
and tunnel, authenticate Agent-owned updater metadata on every selected host,
analyze compatible Plugin 3 hosts, then test every selected class HAProxy exactly
once before plugin updates, pre migrations, or WAR dispatch. A Plugin 2 host is
accepted only as a transient bootstrap state when root health and the unique
Payara updater record prove the same current version plus exact `dr-m4`,
`updaterReady=true`, and `targetVersion=latest` Plugin 3 target. The CLI never
calls Plugin 2 status/analyze routes. After explicit update consent, all class
updates complete and every class is re-preflighted as Plugin 3; per-class TLS/CA
state is rebound immediately before each update and re-preflight. Explicit
migration-only/pre-only/post-only maintenance does not bootstrap or require an
HAProxy: it still requires Plugin 3 and performs no rollout/drain.

**The post-deploy gate (load-bearing, safety-critical):** post runs iff
`noFailures && fullCoverage && !isScoped` — every configured host reached the new
WAR with no failures, none dropped pre-rollout, and the deploy wasn't scoped.
Unlike the class-sequencing gate (which **excludes** `workerFailed`), the post
gate's `noFailures` **includes** `workerFailed` and per-class `aborted` —
a failed worker is a live old-WAR instance, so destructive SQL must not run.
Skip-reason precedence (each logged): `flag > scoped-subset > partial-coverage >
rollout-failed`. Coverage is captured BEFORE any `--host` filter (flat:
`configuredHostCount`; multi-class: `preOverrideClassHostCount` before the per-class
`--host` rewrite — closes the B1c "name all classes but narrow via `--host`"
footgun) and rides on `ClassOutcome.coverageOk`.

**Six flags** → resolved once by `resolveDeployPlan` to `{runPre,runPost,runRollout}`:
`--skip-migrations` (skip both), `--skip-pre`, `--skip-post`, `--migrations-only`
(run BOTH phases, no rollout), `--pre-only`, `--post-only` (recovery: post only, no
rollout). Contradictory combos error before any host is touched. `-only` flags take
an early no-rollout branch (need no WAR/preflight).

**Key files** — `deploy-plan.ts` (`resolveDeployPlan`, pure six-flag resolver),
`post-gate.ts` (`computeNoFailures`, `computeFullCoverage`, `isScopedDeploy`,
`resolvePostSkipReason`, pure), `runMigrationPhase` + the flat/multi-class gate
wiring in `commands/deploy-run.ts`, `ClassOutcome.coverageOk` in
`multi-class-deploy.ts`.

**CLI:** `payara config set-migration <cfg> --phase pre|post --role <r> --dir <d>`
(`--clear` is phase-scoped); the six `payara deploy run` flags above; `payara config show`
renders both phases + the execution plan. Guide: README → migration flags. Design:
`../docs/superpowers/specs/2026-07-02-post-deploy-migration-phase-design.md`; runbook:
`../docs/superpowers/runbooks/2026-07-02-post-deploy-migration-phase-rollout.md`.

### Config templates & rootDir (v2.5.0 / v2.6.0)

`DeployConfig.rootDir?: string` (`types.ts`) **anchors RELATIVE local paths** in a
config so a template is portable across checkouts/machines. Anchored: `warPath` +
each class's `warPath`, and the `migration`/`postMigration` `migrationsDir` +
`scaffoldingFile`. **NEVER anchored:** `healthCheck.path` (remote, on the Payara
host) and `haproxy.socketPath` (remote). Per-path rule (`resolveConfigPath`): a
leading `~/` tilde-expands to `$HOME`; an **absolute path WINS** (used as-is,
ignores `rootDir`); a **relative path joins `rootDir`**. Resolution happens
**exactly once** in `commands/deploy-run.ts` — validate the config **as-stored**,
then `resolveConfigPaths` → run with everything absolute. So the downstream
`@zincapp/znvault-migrate` runner only ever sees absolute paths and is untouched by
this feature.

**Validation** (`deploy-config-validate.ts`): a relative local path with **no
`rootDir`** set → **WARNING** only (backward-compat — existing cwd-relative configs
keep working). A **relative `rootDir`** itself → **ERROR** (an anchor must be
absolute/`~`).

**Commands** — `payara config export <name> [file]` **strips `rootDir`** → a
portable template (relative paths, no machine-specific anchor). `payara config
import <file> --with-root <dir> [--name] [--force]` stamps a `rootDir` in on import
(TTY-gated upgrade-confirm before overwriting an existing config; `--force` skips).
`payara deploy run <file> --with-root <dir>` runs an **ephemeral** file-config
(never saved). File-vs-saved-name is a **lexical** decision via
`config-arg.ts`→`isConfigFilePath` (treated as a **file** iff the arg contains `/`,
`\`, or ends `.json`; otherwise a saved config name). `--with-root` on a **saved
name** overrides that config's `rootDir` **for the run only** (operates on a
non-mutating copy — the stored config is unchanged).

**Key files** — `deploy-config-paths.ts` (`expandTilde`, `resolveConfigPath`,
`resolveConfigPaths`), `config-file.ts` (`loadConfigFromFile(filePath, withRoot?)`),
`config-arg.ts` (`isConfigFilePath`); commands in `commands/deploy-config.ts` +
`commands/deploy-run.ts`.

Design: `../docs/superpowers/specs/2026-07-04-payara-deploy-config-rootdir-design.md`
+ `../docs/superpowers/specs/2026-07-04-payara-config-templates-import-export-design.md`.

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
  "ENV_VAR": "file:node-role"           // read node-local file under fileSourceRoot, omit on failure
}
```

Secrets are written to `setenv.conf` (not command line) for security.

### Aggressive Mode

When `aggressiveMode: true`, deployments follow strict sequence:
1. Acquire the shared lifecycle/deployment lease
2. Strictly undeploy the application and confirm both its runtime row and persistent ref are absent
3. Stop Payara domain
4. Kill Payara processes (clean slate)
5. Mark a new boot epoch before `start-domain`
6. Prove the agent owns an empty target for a continuous window
7. Fresh-deploy and verify the application

At plugin startup, a persistent `list-application-refs server` entry means Payara
owns boot restoration. Startup only observes ownership and performs no
undeploy/deploy, even for an agent-owned empty target; first deploy and stuck
recovery are explicit post-start operator actions. Runtime visibility is not readiness. Lifecycle and deployment
mutations stay fenced until the configured application health endpoint returns 2xx
or an operator submits a reasoned attestation for the exact current boot epoch
through the agent's loopback endpoint over the SSH trust boundary. The complete
Payara namespace requires the shared file-backed control-plane Bearer, while
operator routes also retain their direct-loopback check. Inventory errors, contradictory ref/runtime
state, stale attestations, and timeouts fail closed. `asadmin uptime` gates
liveness, while Linux `boot_id + PID + /proc start ticks` is the exact epoch
identity; agent child-process events rotate it immediately. Every readiness
commit rechecks the epoch as a CAS token, so even a sub-second external restart
cannot inherit an earlier readiness decision. Unknown mutation outcomes remain
blocked for the epoch. WAR deploy routes use a create-exclusive cross-process
lock; a live lock never ages out and stale cleanup is deliberately manual.

Every Payara/admin/process command is spawned directly with an argv vector and
an explicit environment; config values are never rebuilt as shell command text.
The two operations that require shell semantics (sourcing generated `setenv.conf`
and its atomic sudo-user replacement) use fixed scripts with validated positional
arguments. Every spawned command runs in its own process group. Its advertised
timeout includes the TERM-to-KILL window, and the promise is not returned while
a resistant descendant can continue executing. Polling uses `performance.now()`,
caps each probe and sleep to remaining time, and rejects late success.

The deployment lock pathname is a host-wide protocol, not merely a plugin
mutex. Every certificate and secret writer/reload caller in zn-vault-agent must
acquire the same lock. Snapshot validation in `onInit` is defense in depth only;
an agent build without the coordinated shared-lock fix is a release **NO_GO**.

This prevents port conflicts, orphan processes, and concurrent boot/redeploy writers.

### API Key File Mode

When `apiKeyFilePath` is set, API keys are written atomically to a file instead
of `setenv.conf`. Standalone `managedKey` and mapped `api-key:` modes validate
the event key and serialize generations. `restartOnKeyRotation=true`,
`restartOnCertChange=true`, and non-empty `watchSecrets` are rejected.

### Recovery artifact protocol

If a persistent ref exists, the runtime app is absent, and `warPath` is ENOENT,
ordinary upload correctly remains fenced. The direct-loopback staging route can
only create the absent WAR under the file lock; it cannot overwrite or deploy.
Recovery authorization must then include the returned lowercase SHA-256. The
manager synchronously rehashes the regular non-symlink WAR immediately before
one-shot consumption, WAL arm and `asadmin` dispatch.

The complete `/plugins/payara/*` namespace requires the Agent control-plane
Bearer loaded from the same private token file as the plugin; operator routes
also retain their direct-loopback and forwarding-header checks. The Bearer is
machine authorization, not independent cryptographic human authorization, so
keep the named GO and result in the incident record. For production, systemd `TimeoutStopSec` must cover the
maximum fenced operation (900 seconds with default deploy/operation timeouts);
30 seconds is an explicit **NO_GO**.

## Release Process

Push a version tag triggers GitHub Actions publish to npm:

```bash
npm version patch --no-git-tag-version    # or minor/major
git add -A
git diff --cached --check
git status --short
RELEASE_VERSION=$(node -p "require('./package.json').version")
git commit -m "chore(release): v$RELEASE_VERSION"
git push origin HEAD:main
git tag -a "v$RELEASE_VERSION" -m "v$RELEASE_VERSION"
git push origin "refs/tags/v$RELEASE_VERSION"
```

Stable plugin 3 versions publish under the isolated `dr-m4` npm dist-tag and
create a non-latest GitHub Release. The workflow must not promote npm `latest`;
that requires a separate fleet/auto-update operational gate for the exact
Agent 2 / plugin 3 pair. The publish job packs once, verifies the content,
installation, imports, and version of that exact tarball, then digest-checks and
publishes the same file with provenance.

The supported runtime is Node.js 22.13 or newer; release gates must run on a supported Node 22 runtime. Release requires trusted publishing configured on npm (see PUBLISHING.md).

## Peer Dependencies

- `@zincapp/zn-vault-agent` >= 2.0.0 < 3 for the coordinated shared
  mutation-lock protocol and plugin API
- `@zincapp/znvault-cli` >= 4.5.0 (CLI plugin host with `znvault ssh forward`)

Both are optional - plugin works standalone for direct HTTP API usage.
