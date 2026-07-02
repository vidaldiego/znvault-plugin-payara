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
| `fileSourceRoot` | string | No | Allowlist root for `file:` secret sources (default `/etc/zn-agent/node/`). A `file:` path is resolved under this root; outside-root paths are rejected and the env var omitted. |
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
- `alias:` - Vault secret alias (with optional `.field` extraction)
- `api-key:` - Managed API key value
- `file:<path>` - Read a local file on the node and inject its trimmed contents. Path must be under `fileSourceRoot` (default `/etc/zn-agent/node/`). A missing, unreadable, empty, or outside-root file **omits** the env var so the application can fall back to its own default. Use this for per-node markers (scheduler role, zone) under a shared host-template.

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

The plugin adds a `payara` command group to `znvault`, organized by concern:

- `znvault payara deploy run/to/war` — deploy WAR files (multi-host config or single-host)
- `znvault payara config …` — manage deployment configurations (peer of `deploy`)
- `znvault payara restart/status/applications` — lifecycle & status (peers of `deploy`)
- `znvault payara tls …` — TLS management (peer of `deploy`)

### Multi-Host Deployment Configs

Create and manage deployment configurations for multiple hosts:

```bash
# Create a new deployment config
znvault payara config create staging \
  --war /path/to/app.war \
  --host 172.16.220.55 \
  --host 172.16.220.56 \
  --host 172.16.220.57 \
  --parallel

# Deploy to all hosts in config (diff transfer)
znvault payara deploy run staging

# Or use the 'to' alias
znvault payara deploy to staging

# Force full deployment
znvault payara deploy to staging --force

# Dry run
znvault payara deploy to staging --dry-run

# Sequential deployment (one host at a time)
znvault payara deploy to staging --sequential

# Skip ALL schema migrations (deploy the WAR without running any migrations).
# No-op unless the config has a migration/postMigration block.
znvault payara deploy to staging --skip-migrations

# Post-deploy migrations: run destructive schema changes AFTER a successful
# rollout (see the "Migration phases" section below for the full rules).
znvault payara config set-migration staging --phase post --role zincdb-rw --dir docs/migrations/post
znvault payara deploy to staging --skip-post

# Manage configs
znvault payara config list
znvault payara config show staging
znvault payara config add-host staging 172.16.220.58
znvault payara config set staging war /new/path.war
znvault payara config delete staging
```

### Migration phases (`payara deploy run`)

A deploy config may carry **two** schema-migration blocks:

- **`migration`** (pre-deploy) — runs **before** any host is deployed. A failure
  aborts the deploy before any host is touched. Set with `--phase pre` (default).
- **`postMigration`** (post-deploy) — runs **only after a fully successful
  rollout**. Use it for **destructive** changes (drop column/table, remove
  routines) that are unsafe while old-WAR instances are still serving. Set with
  `--phase post`.

The full execution order is: apply pre routines → **pre migrations** → deploy all
hosts/classes → **post migrations**.

> ⚠️ **Pre and post MUST use different `migrationsDir` folders.** The migration
> engine applies *all pending files* in a directory and records what it applied,
> so pointing both phases at the same folder makes the post phase a **silent
> no-op** (the pre phase already applied everything). `znvault payara config
> validate <cfg>` warns when the two dirs match.

**Post-deploy migrations are skipped (with a logged reason) when it is unsafe to
run destructive SQL** — i.e. when any host might still be on the old WAR:

| Skip reason | When |
|-------------|------|
| `scoped-subset` | The deploy was scoped with `--host`/`--only`/`--class` to a proper subset. |
| `partial-coverage` | A configured host was dropped pre-rollout (unreachable / failed analysis), even with `-y` and no flag. |
| `rollout-failed` | Any host failed — **including a non-blocking worker node**. |

> Note: the post-deploy gate is *stricter* than the deploy's own exit code. A
> failed **worker** node does not abort the rollout or change the exit code, but it
> **does** skip post-deploy migrations, because that worker is still running the old
> WAR. `--post-only` is the sanctioned way to run the post phase later, once every
> host is current.

**Migration flags on `payara deploy run`** (resolved together; contradictory combos error
out before any host is touched):

| Flag | Pre | Post | Rollout |
|------|:---:|:---:|:---:|
| *(none)* | ✅ | ✅ (if rollout OK) | ✅ |
| `--skip-migrations` | ❌ | ❌ | ✅ |
| `--skip-pre` | ❌ | ✅ | ✅ |
| `--skip-post` | ✅ | ❌ | ✅ |
| `--migrations-only` | ✅ | ✅ | ❌ (stop) |
| `--pre-only` | ✅ | ❌ | ❌ (stop) |
| `--post-only` | ❌ | ✅ | ❌ (recovery) |

`payara config show <cfg>` renders both phases and the ordered execution plan.
When both phases use the same role + database, the shared settings are shown once
under a common `Migration:` header, with each phase nested beneath it:

```
  Migration:
    Role:     zincdb-rw
    Database: (from Vault dynamic-secrets connection)
    Pre-deploy:
      Dir:    docs/migrations/pre
      Bundle: znapi-helpers v1 (applied before migrations)
    Post-deploy:
      Dir:    docs/migrations/post
      Bundle: znapi-helpers v1 (applied before migrations)

  Execution plan (what 'payara deploy run staging' does, in order):
    1. Apply routine bundle znapi-helpers v1 (pre-deploy, before any host is touched; …)
    2. Run pre-deploy schema migrations (role zincdb-rw; aborts the deploy on failure)
    3. Roll out hosts (…)
    4. Apply routine bundle znapi-helpers v1 (re-applied post-deploy before post-deploy migrations)
    5. Run post-deploy schema migrations (role zincdb-rw; only if the rollout succeeded)
       ⚠ point of no return: post-deploy migrations may apply destructive changes;
         rollback to the previous application version may no longer be possible.
```

(If the two phases use different roles or databases, each renders under its own
`Migration (pre-deploy):` / `Migration (post-deploy):` section instead.)

> In a **multi-class** config, scoping also counts when a per-class `--host`
> override narrows the one named class — even if `--class` names every class — so
> post-deploy is still skipped as `scoped-subset` in that case.

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
      // 172.16.220.57 is absent from serverMap → treated as a WORKER:
      //   - deploys in the final, parallel, non-blocking batch (after .55/.56)
      //   - skips HAProxy drain
      //   - never the canary; its failure does not abort the serving roll
      // Mixing it in here triggers a one-line "serving + worker" warning on deploy.
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

There is no `role` field. A "worker node" is simply a host that is absent from `haproxy.serverMap`. Worker nodes are deployed differently from serving nodes — see [Node classes & deploy ordering](#node-classes--deploy-ordering) below — and they skip the HAProxy drain/ready cycle (they still receive the quiesce call when quiesce is enabled).

#### Node classes & deploy ordering

The deployer recognises **two node classes**, distinguished solely by `haproxy.serverMap` membership — there is no config flag:

| Class | Signal | Routed? | Drain? | Canary-meaningful? |
|-------|--------|---------|--------|--------------------|
| **Serving** | host **is** in `haproxy.serverMap` | yes (user traffic) | yes | yes |
| **Worker** | host is **not** in `serverMap` | no (e.g. a scheduler worker) | no | no |

**The deploy strategy (`1+R`, `sequential`, `1+2`, …) applies to serving nodes only.** Worker nodes deploy in a separate, **final** batch that is:

- **parallel** — all workers at once (they are unrouted, so no rolling constraint);
- **no drain** — they are not in HAProxy;
- **non-blocking** — a worker deploy/health failure is reported as a warning but does **not** abort or fail the serving roll, and does not change the process exit code.

This guarantees the canary "1" in a `1+R` (or any first batch) is **always a serving node**, never a worker — a worker canary is meaningless because a worker serves no user traffic. A serving-canary failure aborts as usual and workers are then **never deployed** (don't touch workers if serving is broken).

> **Why this exists:** before this rule, the deployer filled strategy batches in plain config order with no notion of node class. A scheduler worker placed first in a `1+R` config became the canary; its "green" was worthless (it serves no traffic), and the serving nodes then rolled unsafely — a production outage (2026-06-23). Partitioning by `serverMap` membership makes that configuration impossible.

When a config **mixes** serving and worker hosts, the deploy prints a one-line warning that the strategy applies to serving nodes only and workers deploy last. To see the resolved plan without deploying, run `znvault payara deploy run <config> --dry-run` — it lists the serving batch (under the strategy) and the final worker batch separately.

If you would rather deploy a worker on its own schedule, give it a **separate deploy config** (or use `payara deploy war --target`) instead of mixing it into a serving config.

> **Guard — single class:** with no `haproxy` block (or an empty `serverMap`) there is no serving/worker distinction; **all** hosts are treated as one class and the strategy runs over them unchanged. A worker-only config (a `serverMap` that matches none of the listed hosts) simply deploys every host as a non-blocking worker batch — it does not error, because there is no serving node to protect.

#### Multi-class configs

The implicit two-class model above (serving nodes in `serverMap`, worker nodes absent) handles most environments. When you need a **third class**, **per-class strategies**, **per-class quiesce**, or **per-class WARs**, use an explicit `classes` array instead of a flat `hosts` list.

A config is either **flat** (top-level `hosts`, no `classes`) or **multi-class** (`classes`, no top-level `hosts`) — never both. Flat configs are **fully unchanged** — adding the `classes` field is always opt-in.

##### The `classes` block

```jsonc
{
  "name": "staging",
  "description": "ZincAPI staging — api + scheduler worker",
  // Shared defaults — inherited by every class unless a class overrides them:
  "warPath": "/path/to/zincapi-staging.war",
  "port": 9100,
  "tunnel": true,
  "ssh": { "user": "sysadmin" },
  "healthCheck": {
    "path": "/service-status", "port": 8080, "expectedStatus": 200,
    "timeout": 5000, "retries": 5, "retryDelay": 3000
  },
  "classes": [
    {
      "name": "api",
      "hosts": ["172.16.220.55", "172.16.220.56", "172.16.220.57"],
      "strategy": "1+R",
      "haproxy": {
        "hosts": ["172.16.220.20", "172.16.220.21", "172.16.220.22"],
        "backend": "packleader_api_backend",
        "serverMap": {
          "172.16.220.55": "server1",
          "172.16.220.56": "server2",
          "172.16.220.57": "server3"
        },
        "socketPath": "/run/haproxy/admin.sock",
        "drainWaitSeconds": 10
      }
      // `blocking` defaults true (resolved haproxy has a non-empty serverMap).
      // Inherits warPath / port / tunnel / ssh / healthCheck from the top level.
    },
    {
      "name": "worker",
      "hosts": ["172.16.220.58"],
      "strategy": "parallel",
      "blocking": false,
      "quiesce": { "enabled": true, "pollMs": 2000, "drainTimeoutMs": 120000 }
      // No haproxy → no drain. quiesce lives ONLY on the scheduler class.
      // Inherits warPath / port / tunnel / ssh / healthCheck from the top level.
    }
  ]
}
```

`payara deploy run staging` deploys the `api` class first (`1+R`, drain) and, only if it succeeds, deploys the `worker` class (parallel, no drain, quiesce, non-blocking).

##### Per-class fields and shared defaults

Each class inherits the following fields from the config level unless the class declares its own value: `warPath`, `port`, `tunnel`, `ssh`, `tls`, `healthCheck`, `haproxy`, `strategy`. **Objects replace wholesale** — a class's `haproxy` fully replaces the base `haproxy`; there is no deep-merge.

`quiesce` and `hostConfigs` are **per-class only** — they do not inherit from the config level and must not appear at the top level of a multi-class config (that is a hard validation error). This is intentional: a shared top-level `quiesce` would cause api nodes to quiesce pointlessly.

| Field | Per-class only? | Inherits from config? | Notes |
|-------|-----------------|-----------------------|-------|
| `name` | yes | — | Unique within the config |
| `hosts` | yes | — | No host may appear in two classes |
| `blocking` | yes | — | Defaults from drain presence (see below) |
| `quiesce` | yes | no | Set only on the class(es) that run the scheduler |
| `hostConfigs` | yes | no | Per-host `quiesceTimeoutMs` override; same class as `quiesce` |
| `warPath` | — | yes | Class value wins if present |
| `port` | — | yes | Class value wins if present |
| `tunnel` | — | yes | Class value wins if present |
| `ssh` | — | yes | Class value wins if present |
| `tls` | — | yes | Class value wins if present |
| `healthCheck` | — | yes | Class value wins if present |
| `haproxy` | — | yes | Class value wins if present (replaces wholesale) |
| `strategy` | — | yes | Class value wins if present |

##### Blocking gate and deploy ordering

Classes deploy in **array order** — the order you list them in `classes` is the deploy order. A `blocking` class must fully succeed (all nodes healthy) before the next class starts. A **non-blocking** class's failure is recorded as a warning but never aborts the run.

`blocking` defaults:
- **`true`** — if the resolved `haproxy` is present and has a non-empty `serverMap` (the class drains, so failures matter).
- **`false`** — if there is no `haproxy` or the `serverMap` is empty (e.g. a worker class).
- An explicit `blocking: true` or `blocking: false` on the class overrides either default.

When a blocking class fails, all downstream classes are skipped and recorded as `upstream-abort` in the summary. The process exits non-zero.

##### CLI: `payara deploy run` with multi-class configs

```bash
# Deploy all classes in config order
znvault payara deploy run staging

# Deploy a single class (replaces the separate-config workaround)
znvault payara deploy run staging --class worker

# Deploy a subset (config order preserved, gating applies)
znvault payara deploy run staging --class api --class worker

# Override the roll strategy for one class
znvault payara deploy run staging --class api --strategy 1+2

# Scope to a specific host within one class
znvault payara deploy run staging --class api --host 172.16.220.55

# Dry run — print the ordered plan without deploying
znvault payara deploy run staging --dry-run
znvault payara deploy run staging --class worker --dry-run
```

`--dry-run` output example:

```
Dry run — staging (2 classes, ordered):
 1. api     [blocking]      1+R       drain     172.16.220.55, .56, .57
 2. worker  [non-blocking]  parallel  no-drain  172.16.220.58
```

`--strategy` and `--host` are **per-class** on multi-class configs. Using them without `--class` (or with more than one `--class`) is an error.

Deploying a subset that omits an upstream blocking class (e.g. `--class worker` alone) prints a notice — "deploying 'worker' without its upstream 'api' gate (api not selected)" — but is allowed (useful for targeted re-deploys).

##### Validating a multi-class config

```bash
znvault payara config validate staging
```

Runs all structural checks — duplicate hosts, class names, `serverMap` integrity, resolvable `warPath`/`port` — and exits non-zero on any hard violation. Run this after hand-editing a config before deploying. It makes zero network calls.

##### Authoring multi-class configs

Multi-class configs are authored by **editing `~/.znvault/payara/configs.json` directly**. There is no CLI command to create or modify a `classes` block in v1 — use `payara config validate <name>` as the safety net after each edit. The worked example above is the canonical starting point for a two-class api + worker environment.

#### How it works (per host)

Within the serving batch (and within the final worker batch), each host runs the following sequence:

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

The agent requires two new optional top-level fields in its `config.json` (both have defaults that match a standard deployment). These are **agent-level** fields read directly by the agent — they belong alongside `vaultUrl` and `tenantId`, **not** inside the plugin's `config` block:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": { "apiKey": "znv_..." },
  "znapiBaseUrl": "http://127.0.0.1:8080",
  "internalSecretFile": "/etc/zincapi/scheduler-deploy-secret",
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "config": {
        "payaraHome": "/opt/payara",
        "domain": "domain1",
        "user": "payara",
        "warPath": "/opt/app/MyApp.war",
        "appName": "MyApp"
      }
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `znapiBaseUrl` | `http://127.0.0.1:8080` | Base URL of the local znapi instance. The agent uses this to forward `/scheduler/*` passthrough calls to znapi's loopback `/internal/scheduler/*` endpoints. |
| `internalSecretFile` | `/etc/zincapi/scheduler-deploy-secret` | Path to the shared deploy secret file. The agent reads this file and sends its contents as `X-Internal-Secret` to znapi's `InternalSchedulerFilter`. Must be provisioned during agent setup. |

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
5. **Smoke the loopback seam** — confirm in the deploy output that the quiesce call succeeded. Look for `"Quiescing scheduler..."` in the task output — it appears for every host when quiesce is enabled. If in-flight units were present you will also see `"Draining N in-flight unit(s)..."`, and on timeout `"Scheduler drain timed out — proceeding"`. The absence of any scheduler-related output means the call was skipped (check for `"Scheduler quiesce unavailable"` or `"Scheduler quiesce error"` lines). This smoke step is the single integration point that cannot be covered by automated tests (see Known coverage gap below).
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
znvault payara deploy war ./target/MyApp.war --target server.example.com

# Force full deployment
znvault payara deploy war ./target/MyApp.war --target server.example.com --force

# Dry run - show what would be deployed
znvault payara deploy war ./target/MyApp.war --target server.example.com --dry-run
```

### Server Management

```bash
# Restart Payara
znvault payara restart --target server.example.com
znvault payara restart staging  # All hosts in config

# Check status
znvault payara status --target server.example.com
znvault payara status staging  # All hosts in config

# List applications
znvault payara applications --target server.example.com
znvault payara apps --target server.example.com
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
│  │ payara    │◄─┼──────────────────────────┼──│ WAR File  │  │
│  │ deploy war│  │                          │  └─────┬─────┘  │
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

### v2.0.1
- **Fix: post-deploy migrations no longer fail with `OrphanTrackedRowError`.** The pre/post
  migration phases run the engine against separate directories that share one
  `schema_migrations` history table, so the post phase (scanning only `post/`) saw tracked
  rows for the `pre/` migrations and rejected them as renamed/deleted files. The planner's
  orphan/checksum integrity check now validates rows against the **union** of the pre and post
  directories, while still applying only the current phase's directory. Single-directory
  configs are unaffected. `payara deploy run <cfg> --post-only` now works with prior migrations.

### v2.0.0
- **BREAKING: CLI namespace `deploy` → `payara`.** All commands moved from
  `znvault deploy …` to `znvault payara …`, grouped by concern:
  `payara deploy run/to/war`, `payara config …`, `payara restart/status/applications`,
  `payara tls …`. There is **no `deploy` alias** — update scripts accordingly.
  Deploy configs moved to `~/.znvault/payara/configs.json`; an existing
  `~/.znvault/deploy-configs.json` is **auto-migrated once** on first run
  (non-destructive — the old file is kept as a backup). Prerequisite for
  additional deployers and the upcoming `payara deploy validate` / `plan` commands.

### v1.28.0
- **Post-deploy migration phase.** A deploy config may now carry a second migration block, `postMigration`, that runs **only after a fully successful, unscoped rollout** — for **destructive** schema changes (drop column/table, remove routines) that are unsafe while old-WAR instances are still serving. Full execution order: pre routines → **pre migrations** → deploy all hosts/classes → **post migrations**. The post-deploy gate is deliberately stricter than the deploy's exit code: it skips (with a logged reason — `scoped-subset`, `partial-coverage`, or `rollout-failed`) whenever any host might still be on the old WAR, **including a failed non-blocking worker** or a host dropped pre-rollout. Six flags control which phases run: `--skip-migrations` (skip both), `--skip-pre`, `--skip-post`, `--migrations-only` (run both phases, no rollout), `--pre-only`, `--post-only` (recovery); contradictory combos error before any host is touched. Author phases with `deploy config set-migration <cfg> --phase pre|post …`; `deploy config show` renders both phases + the execution plan. **Pre and post must use separate `migrationsDir` folders** (`deploy config validate` warns if they match). **Existing single-`migration` configs are unchanged** (full back-compat). See [Migration phases](#migration-phases-deploy-run).

### v1.27.0
- **`--skip-migrations` flag.** `znvault deploy run` gained `--skip-migrations` to deploy the WAR without running the schema-migration phase, even when the config declares one (no-op when it doesn't). Mutually exclusive with `--migrations-only`. Superseded/expanded by the six-flag model in v1.28.0.

### v1.22.0
- **Multi-class deploy.** A deploy config may now carry an ordered `classes` block so `znvault deploy run <env>` deploys **every node class** (api, worker, future) as ordered phases of one deploy. Each class is self-describing — its own `strategy`, `blocking`, `haproxy` (drain), `quiesce`, and may override shared config-level defaults (`warPath`, `port`, `tunnel`, `ssh`, `tls`, `healthCheck`). Classes deploy in array order with a **blocking gate**: a blocking class (default: has a non-empty `haproxy.serverMap`) must succeed — including health checks — before the next class runs; a non-blocking class (e.g. a scheduler worker) warns on failure but never aborts the run. New CLI: `--class <name>` (repeatable, scopes to a subset in config order), per-class `--dry-run` plan, class-scoped `--strategy`/`--host`, and `znvault deploy config validate <cfg>` (static, zero-network checks). **Flat configs are unchanged** (full back-compat); `classes` is mutually exclusive with a top-level `hosts`. `quiesce`/`hostConfigs` are per-class only. Authoring multi-class configs is hand-edit-JSON for now (`validate` is the safety net). See [Multi-class configs](#multi-class-configs). Builds on the v1.21.1 per-node-class model.

### v1.21.1
- **Deploy safety: per-node-class strategy.** The deploy strategy (`1+R`, `sequential`, …) now applies to **serving** nodes only (hosts in `haproxy.serverMap`); **worker** nodes (not in `serverMap`) deploy in a separate, final batch — parallel, no drain, and **non-blocking** (a worker failure is warned, never aborts/fails the serving roll). This guarantees the canary is always a serving node and isolates an unrouted scheduler worker that previously could become a meaningless canary (production outage 2026-06-23). No new config fields — `serverMap` membership is the class signal. A mixed serving+worker config now prints a warning, and `--dry-run` shows the serving batch and the final worker batch separately. With no `serverMap`, behaviour is unchanged (one class). See [Node classes & deploy ordering](#node-classes--deploy-ordering).

### v1.19.0
- Added `file:<path>` secret source: reads a local node file and injects its trimmed contents, path must be under `fileSourceRoot` (default `/etc/zn-agent/node/`), omits env var on missing/unreadable/empty/outside-root — enables per-node env markers under a shared host-template.
- Added opt-in scheduler-aware deploy quiesce (`quiesce.enabled: true` on deploy config): drains in-flight znapi scheduler units before WAR transfer, always resumes in `finally`. Off by default — no behaviour change for existing deploy configs. Requires `znapiBaseUrl` and `internalSecretFile` agent-level config fields (both have working defaults for standard deployments).

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
