# @zincapp/znvault-plugin-payara

Payara application server management plugin for ZnVault Agent and CLI. Enables incremental WAR deployment with diff-based file transfer.

## Features

- **WAR Diff Deployment**: Only transfer changed files, not entire WAR
- **Payara Lifecycle Management**: Start, stop, restart Payara domains
- **Certificate Event Safety**: Observe certificate events without restarting Payara
- **Health Monitoring**: Plugin health status in agent health endpoint
- **CLI Commands**: Deploy WAR files from development machine

## Installation

```bash
npm install @zincapp/znvault-plugin-payara@3.0.0
```

Plugin 3 requires Agent 2 and is initially fenced under the isolated `dr-m4`
release channel. Stage the exact compatible pair without restarting between
package installs; publishing or installing it is not production commissioning.

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
        "healthEndpoint": "http://127.0.0.1:8080/public/health/ready",
        "apiKeyFilePath": "/var/lib/zn-vault-agent/zincapi-api-key",
        "mutationAuthTokenFile": "/etc/zn-vault-agent/payara-mutation-token"
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
| `healthEndpoint` | string | No* | Application readiness endpoint. Production commissioning requires a loopback 2xx endpoint; ZincAPI uses `http://127.0.0.1:8080/public/health/ready`. |
| `restartOnCertChange` | boolean | No | Legacy only. `true` is rejected; certificate events cannot restart Payara. |
| `restartOnKeyRotation` | boolean | No | Legacy only. `true` is rejected; use `apiKeyFilePath`. |
| `aggressiveMode` | boolean | No | Full restart cycle on deploy. Cleanup targets only the exact canonical-domain DAS processes. |
| `manageLifecycle` | boolean | No | Must be `true`/omitted. `false` is rejected because agent exec events do not identify the detached DAS safely. |
| `apiKeyFilePath` | string | No | Path to write API key file (enables zero-downtime key rotation) |
| `mutationAuthTokenFile` | string | No | **Node-local server path**, not a controller path or token value. Defaults to `/etc/zn-vault-agent/payara-mutation-token` and must equal the Agent's effective `ZNVAULT_CONTROL_TOKEN_FILE` path. The file must be regular, single-link, and have no group/other permissions. |
| `secrets` | object | No | Environment variables to write to `setenv.conf` |
| `fileSourceRoot` | string | No | Allowlist root for `file:` secret sources (default `/etc/zn-agent/node/`). A `file:` path is resolved under this root; outside-root paths are rejected and the env var omitted. |
| `watchSecrets` | string[] | No | Legacy only. Any non-empty value is rejected. |
| `rootDir` | string | No | Absolute path (or `~/`-prefixed) base for RELATIVE local paths (`warPath`, `migrationsDir`, `scaffoldingFile`). Leading `~/` expands to home; absolute values used as-is. Does NOT affect `healthCheck.path` or `haproxy.socketPath` (remote/URL paths). (v2.5.0) |

### Startup deployment ownership

Payara may restore an application from its persistent server reference after
`start-domain` has already returned. The plugin therefore gives each exact DAS
epoch one deployment writer:

- A persistent `list-application-refs server` entry makes Payara the boot owner.
  Startup records `owner=payara` and never performs the incident-causing
  `undeploy → deploy` sequence during restoration. `list-applications` visibility
  alone is not readiness.
- Startup never performs a first deployment. A later explicit first-deploy
  request can become agent-owned only after both strict inventories remain empty
  for a continuous 20-second monotonic window. A read error resets the window;
  classification, final absence CAS, WAL arm, and deployment share one fence.
- A missing local WAR never authorizes a restart or mutation. If the DAS is
  already running, even with application health at 503, aggressive startup only
  observes refs/runtime and leaves Payara untouched. A restored persistent ref
  can still become health-verified without a local artifact.
- The runtime identity is Linux `boot_id + exact DAS PID + /proc startticks`,
  anchored to the canonical `-Dcom.sun.aas.instanceRoot=<domainRoot>` argv.
  Every correctness-bearing commit rechecks the epoch. TERM/KILL also compares
  startticks immediately before dispatch; the remaining kernel-scale gap would
  require `pidfd`, which this release does not use.
- Startup reconciliation is fully awaited by `onStart` and has a 105-second
  monotonic budget inside the agent's 120-second hook budget. Every subprocess,
  HTTP probe, poll interval, and shutdown check is capped to the remaining time.
  Health and all routes remain 503 unless reconciliation completes.
- `manageLifecycle=false` is rejected. Agent 2.x child events describe its
  supervised launcher, not the detached Payara DAS, and therefore cannot safely
  serve as lifecycle authority. Every non-empty Agent `exec.command` is rejected,
  including commands for unrelated children. Agent `globalReloadCmd`,
  `targets[].reloadCmd`, and `secretTargets[].reloadCmd` are also rejected because
  reload hooks execute outside the shared Payara lock.

While a Payara-owned boot is unverified, deploy, undeploy, stop, restart, WAR
replacement, and process cleanup fail closed. A configured application
`healthEndpoint` returning 2xx releases ordinary boot readiness automatically.
Without that endpoint, read `bootDeployment.bootEpoch` from
`GET /plugins/payara/status`, verify the application externally, then submit a
reasoned attestation for that exact epoch through the agent's loopback endpoint:

  ```http
  POST /plugins/payara/boot-deployment/attest-ready
  Authorization: Bearer <loaded by the client from its private token file>
  Content-Type: application/json

  {
    "bootEpoch": "current-epoch-from-status",
    "source": "rollout-preflight",
    "reason": "service-status and readiness returned HTTP 200"
  }
  ```

An attestation from another epoch, an active startup, or inconsistent inventory
is rejected. Crucially, attestation can only release ordinary readiness: it can
never clear a deploy/undeploy `*-outcome-unknown` in the same DAS. It requires
the same file-backed control-plane Bearer as every other Payara route and also
retains its direct-loopback/no-forwarding-header check. The Bearer is machine
authorization; it does not replace the named human GO.

### Ambiguous outcome quarantine and recovery

Before the first remote application mutation, the plugin fsyncs a WAL record at
`/var/lib/zn-vault-agent/payara-mutation-quarantine/state.json`. Its namespace is
the canonical physical domain root, not the configured username spelling. The
supported plugin factory always uses this fixed local-POSIX path; per-process
overrides are not part of the public configuration.

- The parent `/var/lib/zn-vault-agent` must be trusted and not group/world
  writable. The store creates its private directory as `0700` and file as `0600`.
  All plugin processes for the host must see the same local filesystem. NFS and
  container-private copies are unsupported.
- Command rejection, timeout, process death, or lost response leaves
  `mutationOutcomeUnknown=true`. A replacement DAS does **not** resolve this:
  the replacement may have received the command through the same admin port.
  Only reconciliation after a strictly confirmed stopped domain with zero
  matching JVMs may clear the durable WAL. Never attest, retry, or roll back
  over this state.
- An ambiguous lifecycle command retains
  `/var/lib/zn-vault-agent/znvault-deploy.lock` with `quarantined`, `errorName`,
  `reason`, step, PID, and ownership token. It is never age-reaped.
- Finite manual recovery requires stopping/quiescing the agent and every deploy
  entry point, proving no late `asadmin` remains, reconciling the exact DAS/PIDs
  and WAL, then removing only the inspected lock pathname. If the recorded PID
  is still the running agent, stop it first. Do not downgrade or roll back the
  plugin while either durable quarantine exists.

Every WAR or lifecycle route uses the same create-exclusive lock. Certificate
and secret sync in the agent host must acquire that exact pathname too; an agent
build without the shared mutation lock is not commissionable. Authenticated
status routes take that lock for coherent snapshots. Public Agent `/health` and
`/ready` consume the plugin's bounded cached snapshot and never acquire the
deployment lock, synchronize the boot epoch, or promote readiness. WAR and
`setenv.conf` replacements preserve metadata, fsync content and parent directory,
and atomically rename. Strict inventory/undeploy errors propagate instead of
becoming fabricated empty/success states.

### Secrets Configuration

Secrets are written to Payara's `setenv.conf` file, NOT passed via command line (security improvement in v1.7.0).

> Throughout this README, host addresses are **RFC 5737 documentation ranges**
> (`192.0.2.0/24` for application nodes, `198.51.100.0/24` for load balancers)
> and vault alias paths are illustrative. Substitute your own — real addresses
> and the real alias names live in your deploy config and your vault, never in
> this repo.

```json
{
  "secrets": {
    "ZINC_CONFIG_USE_VAULT": "literal:true",
    "ZINC_CONFIG_APPLICATION_FILE": "literal:app/staging/config",
    "ZINC_CONFIG_VAULT_API_KEY": "api-key:my-managed-key",
    "AWS_ACCESS_KEY_ID": "alias:app/staging/object-store.accessKeyId",
    "AWS_SECRET_ACCESS_KEY": "alias:app/staging/object-store.secretAccessKey"
  }
}
```

Secret value prefixes:
- `literal:` - Static value
- `alias:` - Vault secret alias (with optional `.field` extraction)
- `api-key:` - Managed API key value
- `file:<path>` - Read a local file on the node and inject its trimmed contents. Path must be under `fileSourceRoot` (default `/etc/zn-agent/node/`). A missing, unreadable, empty, or outside-root file **omits** the env var so the application can fall back to its own default. Use this for per-node markers (scheduler role, zone) under a shared host-template.

These mappings are resolved during the bounded startup transaction. Runtime
secret events never rewrite `setenv.conf` or restart Payara. Managed API-key
rotation is the sole live update: it atomically replaces `apiKeyFilePath`; both
standalone `managedKey` mode and `api-key:` mappings validate the rotated key
name and serialize generations so the last event wins.

`apiKeyFilePath` is a two-identity filesystem contract, not merely a pathname.
`zn-vault-agent setup` makes `/var/lib/zn-vault-agent` Agent-owned, assigns
Payara's primary group, sets mode `2750`, and gives the Agent service that group
as supplementary. Each replacement requires an Agent-owned setgid `2750`
directory and an Agent-owned `0640` file in Payara's primary group; every parent
must be traversable by Payara. The plugin aborts with
`PAYARA_API_KEY_PERMISSION_CONTRACT` on drift. Never work around this with
world-readable keys or a group-writable directory.

After installing/upgrading the pair, rerun setup and restart the Agent before
commissioning so systemd applies the group:

```bash
sudo zn-vault-agent setup --yes
sudo systemctl restart zn-vault-agent
payara_group="$(id -gn payara)"
stat -c '%U:%G %a %n' /var/lib/zn-vault-agent
id -Gn zn-vault-agent
# Expect zn-vault-agent:"$payara_group" 2750 and "$payara_group" in the id output.
```

## HTTP API

The plugin registers routes under `/plugins/payara/`:

Every non-`OPTIONS` route in this namespace requires the Agent control-plane
Bearer, including status, hashes, readback, applications, and file reads. The
Agent's root `/health`, `/ready`, `/live`, and `/metrics` probes are outside this
namespace. Use the plugin CLI or an audited client that reads the credential
from a private file internally. Never put the token value in a command line,
environment variable, deploy config, ticket, log, or shell expansion such as
`Authorization: Bearer $(cat ...)`. The executable `curl` examples that used to
appear here were removed deliberately.

### GET /plugins/payara/readback

Returns a bounded, status-only observation of the Payara runtime and the exact
stored WAR identity. It never starts, stops, restarts, deploys or dispatches an
application, and it omits the potentially large per-entry hash map.

```json
{
  "schema": "zincapp.payara.deployment-readback/v1",
  "status": "ok",
  "statusOnly": true,
  "dispatchAllowed": false,
  "appName": "zincapi",
  "warPath": "/var/lib/zn-vault-agent/payara/zincapi.war",
  "artifact": {
    "size": 297114914,
    "sha256": "0123456789abcdef...",
    "contentSha256": "fedcba9876543210..."
  },
  "domain": "zincapi",
  "running": true,
  "healthy": true,
  "observedAtUtc": "2026-08-16T17:55:00.000Z",
  "processCount": 1,
  "appDeployed": true
}
```

When the stored WAR is absent, `status` is `no_war` and `artifact` is `null`.
The response is marked `Cache-Control: no-store`; `observedAtUtc` makes stale
readback fail closed. Runtime fields remain observations rather than an
instruction to change state.

### GET /plugins/payara/hashes

Returns one coherent readback of the stored WAR: its exact byte size/raw
SHA-256, its canonical entry-content SHA-256, and the SHA-256 of every contained
file. Diff clients use the `hashes` field; deployment clients bind mutations to
the raw base while verifying the logical target independently of ZIP metadata.

Response:
```json
{
  "status": "ok",
  "artifact": {
    "size": 123456789,
    "sha256": "0123456789abcdef...",
    "contentSha256": "fedcba9876543210..."
  },
  "hashes": {
    "WEB-INF/web.xml": "abc123...",
    "index.html": "def456..."
  },
  "fileCount": 2
}
```

When no WAR exists, `status` is `no_war`, `artifact` is `null` and `hashes`
is empty.

### POST /plugins/payara/boot-deployment/stage-artifact

Narrow recovery-only staging for the `persistent ref + runtime app absent +
local WAR absent` state. Copy `bootEpoch` from a fresh local status readback and
pass it explicitly as the query parameter. It accepts a complete WAR as
`application/octet-stream`, only over a direct loopback socket with no forwarded
headers. Under the shared deployment lock and Payara mutation lease it requires
the same epoch, `phase=payara-booting`, `owner=payara`, ref present, runtime app
absent, and no UNKNOWN/quarantine both before writing and immediately before the
create-exclusive commit. It refuses to overwrite an existing WAR, returns the
stored SHA-256, and never invokes Payara or releases boot ownership.

Invoke this recovery rail only with an audited same-host client that loads the
Bearer from the private file internally and preserves the named authorization.
Do not reconstruct it as an interactive `curl -H Authorization` command.

### POST /plugins/payara/boot-deployment/recover

Consumes one immediate, one-shot operator authorization for a stuck
Payara-owned boot. Copy `bootEpoch` and `runtimeFingerprint` from a fresh local
status readback, and `expectedArtifactSha256` from the staging/readback response.
The manager rechecks exact refs/apps, DAS identity and WAR digest immediately
before WAL arm, then rehashes the WAR again inside the armed WAL immediately
before spawning deploy and after deploy returns. Persistent drift observed after
undeploy therefore remains an UNKNOWN outcome and deploy is not spawned; the
documented same-host pathname race limitations still apply.

```json
{
  "bootEpoch": "current-epoch-from-status",
  "runtimeFingerprint": "64-lowercase-hex-characters",
  "expectedArtifactSha256": "64-lowercase-hex-characters",
  "authorizationId": "GO-NODE-RECOVERY-001",
  "expectedRuntimeListed": false,
  "reason": "persistent ref exists but runtime application is absent",
  "source": "audited-example-runbook"
}
```

This route is also direct-loopback-only and rejects forwarding headers. Local
socket trust is not cryptographic human authorization: production procedure must
carry the named GO and preserve the request/result in the incident record.

### POST /plugins/payara/deploy

Apply file changes and deploy. Files are base64-encoded.

Every diff, full, binary, and chunk mutation requires a caller-generated
lowercase UUIDv4 `deploymentId` before any decode, session, lock, or WAR change.
Diff/full/chunk requests carry it in JSON; binary upload uses
`x-znvault-deployment-id`; every chunk continuation repeats the exact UUID.
The server never generates a fallback ID, so a caller can reconcile a lost
response against `/deploy/status` without guessing which operation ran.

Use `znvault payara deploy war` or `znvault payara deploy run`; those commands
load the credential file and add the header without printing the token.

Response:
```json
{
  "status": "deployed",
  "deploymentId": "00000000-0000-4000-8000-000000000001",
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
  "pluginVersion": "3.0.0",
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

This read is authenticated because it can disclose application artifacts. Use
an audited client that implements the file-backed credential contract.

## CLI Commands

The plugin adds a `payara` command group to `znvault`, organized by concern:

- `znvault payara deploy run/to/war` — deploy WAR files (multi-host config or single-host)
- `znvault payara config …` — manage deployment configurations (peer of `deploy`)
- `znvault payara restart/status/applications` — lifecycle & status (peers of `deploy`)
- `znvault payara tls …` — TLS management (peer of `deploy`)

### Control-plane credential files

Agent setup creates an independent random credential on each node at
`/etc/zn-vault-agent/payara-mutation-token` (or the absolute path named by the
Agent's `ZNVAULT_CONTROL_TOKEN_FILE`). The plugin server reads that same path;
it rejects a different `mutationAuthTokenFile`, because the Agent outer gate and
plugin inner gate must compare the same bytes.

The deploy controller cannot normally read the node's Agent-owned `0600` file.
Provision an exact per-host copy over an approved encrypted channel into a
controller-owned `0600` regular file, without displaying it. A secret manager is
preferred. The following is an example for an already authorized SSH-CA window;
stdout is redirected straight to a private temporary file and must never be run
without the redirect:

```bash
set -euo pipefail
control_dir=/secure/controller/znvault/payara-control
control_dest="$control_dir/node-a"
install -d -m 700 -- "$control_dir"
umask 077
control_tmp="$(mktemp "$control_dir/.node-a.XXXXXX")"
trap 'rm -f -- "$control_tmp"' EXIT
ssh -T sysadmin@192.0.2.55 \
  'sudo -n -u zn-vault-agent /bin/cat -- /etc/zn-vault-agent/payara-mutation-token' \
  >"$control_tmp"
test -s "$control_tmp"
chmod 600 -- "$control_tmp"
mv -- "$control_tmp" "$control_dest"
trap - EXIT
```

Repeat per host; do not assume two setup-generated tokens are equal. Configure
only the local paths, never the values:

```json
{
  "name": "staging",
  "hosts": ["192.0.2.55", "192.0.2.56"],
  "tunnel": true,
  "mutationAuthTokenFiles": {
    "192.0.2.55": "/secure/controller/znvault/payara-control/node-a",
    "192.0.2.56": "/secure/controller/znvault/payara-control/node-b"
  }
}
```

`znvault payara config set-auth-token-file <config> <host> <path>` records one
path. The singular `mutationAuthTokenFile` and CLI
`--mutation-auth-token-file <path>` are explicit fleet-shared/single-command
fallbacks only. All selected files are validated and loaded before any tunnel,
network request, migration, or deployment. The Payara plugin 3 CLI then gates
every target on Agent major 2 plus authenticated Agent-owned updater metadata.
An already-compatible host must prove that root health, authenticated status,
and updater `current` name the same exact Plugin 3 version. A Plugin 2 host is
only a transient bootstrap candidate: its root-health version must exactly match
the unique Payara record, whose `channel=dr-m4`, `updaterReady=true`, and
`targetVersion=latest` fields must bind an offered Plugin 3 target. The CLI calls
no Plugin 2 status or analysis route. With explicit update consent it updates all
targets, verifies caller-request-ID/current/target receipts, waits for restart,
and repeats a full Plugin 3 preflight for every host before proceeding.
Migration-only commands do not bootstrap and require Plugin 3 directly. Plugin 3 does
not register `--skip-version-check` or `--skip-preflight`; legacy invocations
are rejected by argument parsing before config, credentials, tunnels, network,
database migrations, or WAR operations are reached.

For a rollout, all selected host analyses and all selected HAProxy connectivity
checks form one global read-only boundary. No class may update its plugin, run a
pre-deploy migration, or receive a WAR until every class and load balancer has
passed. If plugin updates are requested, every class update completes before a
second global host preflight replaces the stale observations. HAProxy is checked
once at the boundary and is not checked again after migrations begin. Each
class's TLS/CA policy is rebound immediately before its update and re-preflight,
so process-global client state cannot leak from another class.

### Multi-Host Deployment Configs

Create and manage deployment configurations for multiple hosts:

```bash
# Create a new deployment config
znvault payara config create staging \
  --war /path/to/app.war \
  --host 192.0.2.55 \
  --host 192.0.2.56 \
  --host 192.0.2.57 \
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
znvault payara config set-migration staging --phase post --role appdb-rw --dir docs/migrations/post
znvault payara deploy to staging --skip-post

# Manage configs
znvault payara config list
znvault payara config show staging
znvault payara config add-host staging 192.0.2.58
znvault payara config set staging war /new/path.war
znvault payara config delete staging
```

### Config templates & rootDir (portable configs)

A deploy config's local paths (`warPath`, each phase's `migrationsDir` and
`scaffoldingFile`) are normally absolute — fine on the machine that authored the
config, but not portable to another checkout or another engineer's laptop.
**`rootDir`** makes them relative: it is a config-level base that RELATIVE local
paths resolve against, so a config can be checked into a repo and used anywhere.

Resolution is per-path:

- a leading `~/` (or bare `~`) expands to the home directory;
- an **absolute path wins** — it is used as-is and `rootDir` is ignored;
- a **relative path joins `rootDir`**.

`rootDir` only anchors *local* paths (`warPath` + each class's `warPath`, and each
migration phase's `migrationsDir` + `scaffoldingFile`). It never touches
`healthCheck.path` or `haproxy.socketPath` — those are remote/URL paths on the
Payara host. Set it on a saved config with:

```bash
znvault payara config set staging rootdir /Users/me/dev/zincapi-parent
# (an empty value clears it)
```

`znvault payara config show <cfg>` renders a `Root:` line when `rootDir` is set.

**Validation** (`config validate <cfg>`, also run before every import/deploy):

- A relative local path with **no `rootDir`** configured → a **WARNING**: it still
  works (it resolves against the current working directory), but the base is
  unstable. Set `rootDir` for a stable anchor.
- A **relative `rootDir` itself** → a hard **ERROR**: an anchor has nothing to
  anchor to, so `rootDir` must be absolute or start with `~/`.

#### Exporting a portable template

```bash
znvault payara config export staging [file]
```

Writes a saved config out to a portable template file with **`rootDir` stripped**
(it is machine-specific — you supply it on the other side with `--with-root`). The
default output file is `<name>.payara.json`.

#### Importing a template

```bash
znvault payara config import <file> [--with-root <dir>] [--name <n>] [-f|--force]
```

Reads a template into the saved-config store. `--with-root <dir>` sets (or
overrides) the config's `rootDir` to the resolved directory — `--with-root .`
anchors it to the current directory. `--name` overrides the stored name (defaults
to the file's `name` field). The config is **validated before it is saved** (a hard
error aborts the import). Importing over an existing config is an *upgrade*: on a
TTY you are prompted to confirm; `--force` skips the prompt; a non-TTY import over
an existing name without `--force` errors.

#### Deploying directly from a file

```bash
znvault payara deploy run <file> [--with-root <dir>]
```

When the positional argument looks like a **file path** — it contains `/`, `\`, or
ends in `.json` — `deploy run` reads that config from the file and deploys it
**ephemerally**: the config is never written to the store. This is a purely lexical
decision, so a saved config name (which never contains a separator or `.json`) is
never misclassified. `--with-root` also works on a **saved** config name — it
overrides that config's `rootDir` **for this single run only** (it operates on a
copy; the stored config is never mutated).

#### Example: move a config between machines

```bash
# Machine A — export the staging config to a portable template and check it in
znvault payara config export staging
git add staging.payara.json && git commit -m "chore: portable staging deploy config"

# Machine B — import it, anchoring relative paths to the repo checkout
znvault payara config import staging.payara.json --with-root .
```

### Migration phases (`payara deploy run`)

A deploy config may carry **two** schema-migration blocks:

- **`migration`** (pre-deploy) — runs **before** any host is deployed. A failure
  aborts the deploy before any host is touched. Set with `--phase pre` (default).
- **`postMigration`** (post-deploy) — runs **only after a fully successful
  rollout**. Use it for **destructive** changes (drop column/table, remove
  routines) that are unsafe while old-WAR instances are still serving. Set with
  `--phase post`.

The full execution order is: **pre migrations** → deploy all hosts/classes →
**post migrations**.

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
    Role:     appdb-rw
    Database: (from Vault dynamic-secrets connection)
    Pre-deploy:
      Dir:    docs/migrations/pre
    Post-deploy:
      Dir:    docs/migrations/post

  Execution plan (what 'payara deploy run staging' does, in order):
    1. Run pre-deploy schema migrations (role appdb-rw; aborts the deploy on failure)
    2. Roll out hosts (…)
    3. Run post-deploy schema migrations (role appdb-rw; only if the rollout succeeded)
       ⚠ point of no return: post-deploy migrations may apply destructive changes;
         rollback to the previous application version may no longer be possible.
```

(If the two phases use different roles or databases, each renders under its own
`Migration (pre-deploy):` / `Migration (post-deploy):` section instead.)

> In a **multi-class** config, scoping also counts when a per-class `--host`
> override narrows the one named class — even if `--class` names every class — so
> post-deploy is still skipped as `scoped-subset` in that case.

### Migration scaffolding

A migration phase (`migration` or `postMigration`) can carry a **scaffolding file** —
a SQL file of migration-helper procedures/functions (e.g. `zn_assert_*`,
`zn_drop_column_if_exists`) that exist only to support the migrations in that
directory. Set it with `--scaffolding-file` on `config set-migration`:

```bash
znvault payara config set-migration staging \
  --phase pre --role appdb-rw --dir docs/migrations/pre \
  --scaffolding-file migration_utils.sql
```

| Flag | Required | Description |
|------|:---:|-------------|
| `--scaffolding-file <path>` | No | The scaffolding SQL file: either a bare filename **relative to `--dir`** (a relative path with `/` or `\` fails validation *unless `rootDir` is set*), an **absolute path**, or — when the config has a `rootDir` — a **relative path with separators** (it resolves against `rootDir`). Applied at the start of the phase and cleaned up after reconcile. |

An absolute path can be used so a single helper file serves **both** the pre-
and post-deploy phases — which normally have different `migrationsDir`s, so a
bare filename resolves against two different directories:

```bash
znvault payara config set-migration staging \
  --phase pre --role appdb-rw --dir docs/migrations/pre \
  --scaffolding-file /path/to/docs/migrations/0000_migration-helpers.sql

znvault payara config set-migration staging \
  --phase post --role appdb-rw --dir docs/migrations/post \
  --scaffolding-file /path/to/docs/migrations/0000_migration-helpers.sql
```

**What the runner does:** if `scaffoldingFile` is set, the runner applies that
file's statements immediately after acquiring the migration lock — before any
seeding, reconcile, or pending work — so migration bodies can `CALL` the helpers
it defines. After the phase's reconcile + pending work finishes (whether it
succeeded or threw), the runner unconditionally sweeps every procedure,
function, trigger, and event whose `DEFINER` is the ephemeral migrate lease
user and drops it (`DROP ... IF EXISTS`), scoped to that lease user only. This
is what makes the migrate lease's later `DROP USER` immune to MySQL 8.4's
`ER 4006` ("account is referenced as a definer") — once the lease user is the
definer of nothing, the drop cannot fail on that account.

**No magic-name fallback.** Earlier revisions of the migration engine created
a fixed set of `zn_*` helper procedures on every run (owned by whichever
ephemeral user happened to run the migration) — that's the exact pattern that
caused the ER-4006 leftover-user bug. There is no default filename and no
convention-based lookup: if `scaffoldingFile` is unset, the phase runs with no
scaffolding step at all, byte-identical to a config without this field.

Scaffolding is a *phase-scoped, disposable* concept — a scaffolding file's
objects are meant to be destroyed at the end of every run of that phase.

#### The persistent-definer-object rule (app authorship)

Scaffolding cleanup drops **every** object owned by the migrate lease user —
it cannot distinguish "this was a throwaway helper" from "this was meant to
outlive the migration." That means migration authors have a hard obligation:

> **Any object a migration creates that must survive the deploy — a view, a
> persistent procedure/function the application calls at runtime, a trigger —
> and that carries a `DEFINER`, must be created `SQL SECURITY INVOKER` or with
> an explicit `DEFINER = '<persistent-account>'@'%'`. It must never be left
> owned by the ephemeral migrate user.**

If a persistent object is left DEFINER'd as the migrate user, one of two bad
outcomes happens:

- **With scaffolding configured:** the object is a definer-carrying object
  owned by the migrate user, so the end-of-phase sweep drops it — the
  migration silently destroys the very object it just created.
- **Without scaffolding configured (or if the sweep is somehow bypassed):**
  the object survives, but now the migrate lease's `DROP USER` on revoke hits
  the same `ER 4006` this whole mechanism exists to prevent — a leftover
  account that can never be cleanly revoked.

This rule is **not enforced by vault or by this plugin** — it is app-repo
authorship discipline. Recommend adding an INVOKER / no-transient-DEFINER lint
to the app repo's migration CI (e.g. reject any `CREATE {VIEW|PROCEDURE|
FUNCTION|TRIGGER}` in a migration file that lacks `SQL SECURITY INVOKER` and
lacks an explicit, non-migrate `DEFINER=`) so this can't regress silently.

### Tunneled Deployment (`tunnel: true`, default in plugin 3)

Deploy agents bind their `:9100` deploy/health server to loopback only, so it
is never exposed on the network. Plugin 3 defaults an omitted `tunnel` to `true`
and routes the deploy through an **SSH-CA-authenticated local port-forward** to each host
instead — the deploy opens one `znvault ssh forward` per host, rewrites only the
fetched agent URL to `127.0.0.1:<ephemeral>`, runs the existing preflight + WAR
transfer through the tunnel, and tears it down afterward.

```jsonc
{
  "name": "staging",
  "war": "/path/to/app.war",
  "hosts": ["192.0.2.55", "192.0.2.56", "192.0.2.57"],
  "tunnel": true,
  "ssh": {
    "user": "sysadmin",            // optional; SSH user for the forward
    "readinessTimeoutMs": 30000    // optional; wait for /health through the tunnel
  }
}
```

| Config field | Type | Required | Description |
|--------------|------|----------|-------------|
| `tunnel` | boolean | No | Route the deploy through a per-host SSH-CA port-forward (plugin 3 default: `true`) |
| `ssh.user` | string | No | SSH user for the forward (default: `sysadmin`, honoring `~/.ssh/config`) |
| `ssh.readinessTimeoutMs` | number | No | How long to wait for the Agent's public, cached root `/health` through the tunnel before failing |

Requires `@zincapp/znvault-cli` >= 4.5.0 (ships `znvault ssh forward`) and this
plugin >= 1.18.0. See the
[Deployment Guide → Tunneled Deploys](../docs/DEPLOYMENT_GUIDE.md#tunneled-deploys)
for the full how-it-works, version matrix, loopback cutover procedure, and the
important caution about `deploy --force` with `aggressiveMode`.

Tunnel creation is fail-closed: a failed forward never falls back to the direct
host while carrying a Bearer. Explicit `tunnel:false`/`--no-tunnel` is accepted
only for loopback or verified HTTPS. Remote HTTP and unverified remote TLS are
rejected before the credential is sent.

### Scheduler-aware deploy (quiesce)

Scheduler-aware deploy is **opt-in and off by default**. A deploy config without a `quiesce` block (or with `quiesce.enabled: false`) is byte-identical to the current behaviour — no scheduler calls are made, no new secrets are required.

When enabled, the deploy drains the HAProxy backend for the target node, then asks znapi's in-process scheduler to stop accepting new units and waits until all in-flight units finish before transferring the WAR. This prevents a mid-deploy unit run from using a partially-updated WAR. The scheduler is always resumed in `finally`, even if the deploy itself fails.

#### Config block

Add a `quiesce` block to a deploy config and, optionally, per-host timeout overrides in `hostConfigs`:

```jsonc
{
  "name": "znapi-staging",
  "war": "/path/to/znapi.war",
  "hosts": ["192.0.2.55", "192.0.2.56", "192.0.2.57"],
  "tunnel": true,
  "ssh": { "user": "sysadmin" },
  "haproxy": {
    "hosts": ["198.51.100.20"],
    "backend": "znapi",
    "serverMap": {
      "192.0.2.55": "znapi-01",
      "192.0.2.56": "znapi-02"
      // 192.0.2.57 is absent from serverMap → treated as a WORKER:
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
    "192.0.2.57": {
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
      "hosts": ["192.0.2.55", "192.0.2.56", "192.0.2.57"],
      "strategy": "1+R",
      "haproxy": {
        "hosts": ["198.51.100.20", "198.51.100.21", "198.51.100.22"],
        "backend": "packleader_api_backend",
        "serverMap": {
          "192.0.2.55": "server1",
          "192.0.2.56": "server2",
          "192.0.2.57": "server3"
        },
        "socketPath": "/run/haproxy/admin.sock",
        "drainWaitSeconds": 10
      }
      // `blocking` defaults true (resolved haproxy has a non-empty serverMap).
      // Inherits warPath / port / tunnel / ssh / healthCheck from the top level.
    },
    {
      "name": "worker",
      "hosts": ["192.0.2.58"],
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
znvault payara deploy run staging --class api --host 192.0.2.55

# Dry run — print the ordered plan without deploying
znvault payara deploy run staging --dry-run
znvault payara deploy run staging --class worker --dry-run
```

`--dry-run` output example:

```
Dry run — staging (2 classes, ordered):
 1. api     [blocking]      1+R       drain     192.0.2.55, .56, .57
 2. worker  [non-blocking]  parallel  no-drain  192.0.2.58
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

> **File-based portability (v2.6.0).** You no longer have to hand-edit the live
> store in place: `payara config export <name>` writes a config (multi-class
> `classes` block included) to a standalone template file you can edit and check
> into a repo, and `payara config import <file> [--with-root .]` reads it back into
> the store (validated before saving). See
> [Config templates & rootDir](#config-templates--rootdir-portable-configs) — this
> is the recommended way to move or version a multi-class config across machines.

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

1. CLI reads the local WAR once into an immutable snapshot and calculates its
   raw SHA-256, canonical entry-content SHA-256, and per-entry hashes
2. CLI requests one coherent raw/canonical identity and current hashes from the
   agent (`GET /plugins/payara/hashes`)
3. CLI compares hashes to determine:
   - **Changed files**: Hash differs or file is new
   - **Deleted files**: Exists remotely but not locally
4. CLI sends only changed files (base64-encoded), the deletion list, the exact
   expected raw base SHA-256 (or `null`), and the canonical target SHA-256
5. Under the shared mutation lock, the agent revalidates and extracts those same
   base bytes; drift aborts without modifying the WAR
6. Agent applies changes (updates, creates, deletes files)
7. Agent repackages WAR
8. Agent verifies the proposed target, deploys it, re-reads the stored artifact,
   and returns a target-bound receipt that the CLI verifies

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

Certificate events are informational only. `restartOnCertChange=true` is
rejected at initialization because an event callback cannot safely coordinate a
Payara restart with every other process-level mutation.

### onKeyRotated

For the configured managed key, atomically replaces `apiKeyFilePath` without a
Payara restart. Events for other keys are ignored. Inline rotation and
`restartOnKeyRotation=true` are rejected.

### onSecretChanged

Informational only. Non-empty `watchSecrets` is rejected; update startup
environment through an explicit fenced deployment/restart procedure.

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

Because the Agent root health/readiness probes are public, this hook is a
five-second cached, single-flight snapshot. Concurrent probes cause at most one
bounded refresh; the hook never forces status refresh, takes the deployment
lock, synchronizes an epoch, or promotes boot readiness. Authenticated Payara
requests and lifecycle/key events invalidate the snapshot.

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

Run `npm test` for the authoritative count. The suite covers unit, integration,
route, and E2E flows; agent-dependent E2E cases are skipped when no local agent is
available.

## Requirements

- Node.js 22.13+
- Payara Server with the `asadmin` commands used here (production is verified
  separately against Payara 7.2025.2; do not infer commissioning from unit tests)
- `asadmin` in PATH or at `$PAYARA_HOME/bin/asadmin`
- Linux procfs readable for `/proc/sys/kernel/random/boot_id` and each candidate
  `/proc/<pid>/{cmdline,stat}`. `hidepid`, non-Linux hosts, malformed `ps -ww`, or
  an unresolvable canonical domain root fail closed.
- The WAR parent must permit an atomic same-directory temp file, metadata
  preservation, rename, file fsync, and directory fsync. The Payara user must be
  able to read the resulting regular non-empty WAR.
- Local POSIX storage for `/var/lib/zn-vault-agent`, shared by every plugin
  process on the host; no NFS or per-container copies. Parent ownership/mode must
  prevent untrusted unlink/replacement. The pathname protocol cannot defend
  against an actor that already has write authority over that directory.
- If the agent is not the Payara user, passwordless non-interactive sudo for the
  exact deployed command set. `setenv.conf` replacement invokes
  `sudo -u <user> /usr/bin/bash -c <fixed-script> ...`, whose fixed script uses
  `/usr/bin/tee`, `chmod`, `sync -f`, `mv`, and `rm`. Process cleanup requires
  only `kill`/legacy `pkill` executed as the configured Payara user; the plugin
  never requests root process authority. A same-domain JVM owned by another UID
  stays visible but cannot be signalled and therefore fails the cleanup closed.
  Validate the actual sudoers rule with `sudo -n` before activation; never put
  credentials in argv or logs.
- A loopback application readiness URL. For ZincAPI production use
  `http://127.0.0.1:8080/public/health/ready`; a mere live DAS is not readiness.
- `manageLifecycle=true`/omitted, no non-empty Agent `exec.command`, and no Agent
  `globalReloadCmd`, `targets[].reloadCmd`, or `secretTargets[].reloadCmd`.
- ZnVault Agent 2.x on the host. Agent 2.0.0 introduced the coordinated
  ownership-safe lock used by certificate, secret, CLI, startup-cleanup, and
  Payara mutations. Plugin 3 must not run with agent 1.x.
- systemd must allow the lock owner to reach a terminal command result. With the
  defaults, require `TimeoutStopSec >= 900` (`deployTimeout + 2 ×
  operationTimeout + 60 s` margin) and a unit kill policy that terminates all
  descendants after that bound. The currently observed 30-second host timeout
  is incompatible and is a **NO_GO** gate, not a warning.

## Supported package surface and versioning

The supported root package surface is the plugin factory, CLI factory, session
store, agent types, and pure WAR hash/diff helpers. `PayaraManager`,
`WarDeployer`, their construction options, and raw route registration are no
longer exported: constructing them directly bypassed the cross-process mutation
fence. This is the intentional **breaking change** shipped in plugin 3.0.0. Do
not backport it as a `2.7.x` patch or minor.

Stable plugin 3 artifacts are initially published under the isolated npm
dist-tag `dr-m4`; neither npm `latest` nor GitHub's latest-release pointer moves.
Promotion requires a separate fleet/auto-update gate and is not part of the
package release workflow.

## Production commissioning gate

Passing tests, building a tarball, or publishing a version is not deployment.
Before a one-node reboot canary:

1. Build and inspect the exact package; typecheck every known consumer against
   the reduced public surface. Install it without activating lifecycle changes.
2. Verify the effective node config: canonical Payara/domain paths, Payara user,
   regular readable WAR, loopback readiness URL, `manageLifecycle=true`, no
   non-empty Agent `exec.command`, no Agent reload command, and no competing
   systemd controller.
3. Verify private local-POSIX quarantine storage, the shared deployment-lock
   pathname, and that plugin routes plus every agent certificate/secret writer
   contend on it. Verify atomic `setenv.conf`/WAR replacement, sudo
   non-interactively, exact procfs identity, `asadmin uptime`, strict refs/apps,
   and a single DAS PID.
4. Verify `systemctl show zn-vault-agent -p TimeoutStopUSec -p KillMode` against
   the finite bound above. Confirm operator routes reject remote and forwarded
   requests; their loopback/SSH boundary is node-local trust, not cryptographic
   proof of the human GO.
5. Obtain an exact named production GO for one serving-node reboot canary. During
   boot, require `boot-owned-skip`, `deploymentAttempted=false`, zero explicit
   undeploy/deploy from the plugin, one DAS, `bootDeployment.phase=ready`,
   `readiness=health-verified`, and application/KMS readiness 2xx.
6. Hold the canary through the normal monitoring window, then roll one node at a
   time. Stop immediately on `UNKNOWN`, retained/quarantined lock, duplicate DAS,
   contradictory inventory, non-ready health, or version drift.

Rollback is permitted only when no startup/deploy task is active and both the
WAL and deployment lock are absent after exact reconciliation. A retained record
is a recovery incident, not authorization to downgrade.

## Migration from Python zinc_updater

See [MIGRATION.md](./MIGRATION.md) for step-by-step migration guide from the Python-based zinc_updater.

## Changelog

### v3.0.0 — 2026-08-31
- **Payara boot single-writer fence.** Startup now records a unique boot epoch,
  treats persistent application refs as Payara-owned, and never undeploys or
  redeploys an app merely because it appears in `list-applications`. Ownership
  classification and deployment are serialized; errors fail closed. Startup is
  fully awaited with a 105-second monotonic deadline inside the agent's
  120-second plugin hook, and subprocess groups are terminally killed before a
  timeout is returned. A missing WAR never causes
  a restart; a running restored app is still classified from strict refs/runtime.
- **External-restart and artifact fencing.** DAS uptime plus exact Linux process
  identity rotate stale epochs; every async readiness commit uses the boot epoch
  as a CAS token. PID startticks are rechecked immediately before signals, and
  stopped+PID0 is rechecked after `setenv.conf` immediately before start. All in-process mutations share a
  re-entrant lease, WAR deploy routes take one create-exclusive cross-process lock,
  and WAR/`setenv.conf` replacement uses fsync plus atomic rename. Live locks do
  not age out; stale locks require quiesced manual recovery.
- **Durable ambiguity quarantine.** Application mutations arm a fixed-path WAL
  keyed by canonical domain root; same-runtime attestation cannot clear any
  ambiguous command. Lifecycle ambiguity retains a lock with reason/error/step.
  Health and both status routes fail closed across processes and bypass cached
  pre-deploy health.
- **Strict inventory and undeploy contracts.** `listApplications()` propagates
  command/parse failures, and undeploy must be confirmed absent before restart.
- **Breaking supported surface.** Raw manager/deployer/route construction is no
  longer exported, `manageLifecycle=false` is rejected, and every non-empty Agent
  exec or reload command is rejected. Release only as a coordinated major version.
- **Explicit stuck-boot recovery.** A loopback-only staging route can store only
  a missing WAR without deployment. One-shot recovery is bound to boot epoch,
  exact DAS fingerprint, expected runtime inventory and staged WAR SHA-256.
- **Event-path closure.** Certificate/secret/key-triggered Payara restarts are
  rejected; managed key files rotate atomically. Commissioning requires the
  coordinated agent shared lock and a systemd stop timeout covering the maximum
  fenced operation.

### v2.6.0
- **Config templates: `export` / `import` + deploy-from-file.** A saved deploy
  config can now be moved between checkouts and machines as a portable template.
  `payara config export <name> [file]` writes the config to `<name>.payara.json`
  (default) with the machine-specific `rootDir` **stripped**;
  `payara config import <file> [--with-root <dir>] [--name <n>] [-f|--force]` reads
  a template into the store, stamping in a `rootDir` via `--with-root` (`.` = the
  current dir), validating before it saves, and treating an import over an existing
  name as an upgrade (TTY confirm; `--force` to skip; non-TTY without `--force`
  errors). `payara deploy run <file> [--with-root <dir>]` deploys **ephemerally**
  straight from a file when the argument looks like a path (contains `/`, `\`, or
  ends `.json`) — never saved; `--with-root` on a **saved** config name overrides
  its `rootDir` for that single run only (the stored config is untouched). See
  [Config templates & rootDir](#config-templates--rootdir-portable-configs).

### v2.5.0
- **Config-level `rootDir` for relative local paths.** A deploy config may set
  `rootDir` — an absolute (or `~/`-prefixed) base that RELATIVE local paths resolve
  against, making a config portable instead of hard-coding absolute paths. It
  anchors `warPath` (top-level + per-class) and each migration phase's
  `migrationsDir` + `scaffoldingFile`; it never touches `healthCheck.path` or
  `haproxy.socketPath` (remote/URL paths). Per-path rule: leading `~/` expands to
  home, an absolute path wins (used as-is), a relative path joins `rootDir`. Paths
  resolve **exactly once** before rollout (the config is validated as-stored, then
  run fully absolute). Validation: a relative local path with no `rootDir` → a
  **warning** (resolves against cwd; back-compat preserved); a relative `rootDir`
  itself → a hard **error**. Set it with `payara config set <name> rootdir <path>`;
  `payara config show` renders a `Root:` line. See
  [Config templates & rootDir](#config-templates--rootdir-portable-configs).

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
