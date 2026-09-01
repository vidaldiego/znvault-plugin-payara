# Migration guide: legacy `zinc_updater` to Payara plugin 3

This guide covers a controlled migration from the Python `zinc_updater` to
`@zincapp/znvault-plugin-payara` 3.x hosted by `@zincapp/zn-vault-agent` 2.x.
Publishing these packages does not deploy or commission them on a Payara host.
Each host still requires its own explicit change authorization and evidence.

## Safety contract

The old updater and the Payara plugin are both application/lifecycle writers.
They must never be live writers for the same Payara domain at the same time.
The legacy updater does not participate in the plugin's create-exclusive lock,
so a parallel or canary period with both mutation endpoints enabled is unsafe.

The compatible production pair is:

- Node.js 22.13.0 or newer;
- `@zincapp/zn-vault-agent` 2.x;
- `@zincapp/znvault-plugin-payara` 3.x.

The initial stable pair is published under the isolated npm dist-tag `dr-m4`,
not `latest`, `next`, or `beta`. Select exact package versions when staging.
Moving either package to `latest` requires a separate fleet/auto-update gate;
it is not part of this release or this migration runbook.

Agent 2 may expose a loaded Payara 2 package only through its recovery-only
updater metadata rail; the Plugin 3 CLI will not invoke that package's status,
analysis, lifecycle, migration, or WAR routes. It accepts the transient state
only when the unique Payara record exactly matches the running version and proves
the `dr-m4` Plugin 3 target is ready. Explicit update consent, an exact
caller-owned request UUID/current/target receipt, restart, and a fresh full
Plugin 3 preflight are required before any database or WAR work. Do not leave a
mixed pair commissioned.

## Preflight: finite NO-GO gates

Before changing a host, capture a read-only baseline and stop if any item is
unknown or contradictory:

1. Identify the exact Payara domain root and prove there is exactly one matching
   DAS process.
2. Record `asadmin list-domains`, `list-applications`, and
   `list-application-refs server` for the configured application.
3. Record the application's loopback readiness endpoint and require HTTP 2xx.
4. Confirm there is no deploy, restart, `asadmin`, migration, or updater job in
   flight.
5. Inspect `/var/lib/zn-vault-agent/znvault-deploy.lock` and
   `/var/lib/zn-vault-agent/payara-mutation-quarantine/state.json`. A live lock,
   an armed durable record, or an unknown mutation outcome is a NO-GO; reconcile
   it before migration rather than deleting or aging it out.
6. Confirm `/var/lib/zn-vault-agent` is local, trusted, and not group/world
   writable. Container-private copies and NFS do not provide the host-wide
   protocol required by this release.
7. Confirm the systemd stop budget is `TimeoutStopSec>=900` and the unit uses
   `KillMode=mixed`.
8. Resolve `payara_group="$(id -gn payara)"`; require
   `/var/lib/zn-vault-agent` to be `zn-vault-agent:"$payara_group"` mode `2750`
   and require `id -Gn zn-vault-agent` to contain that group. Missing membership,
   group write, or world access is a NO-GO.
9. Require `/etc/zn-vault-agent/payara-mutation-token` to be one regular,
   single-link `0600` file owned by `zn-vault-agent:zn-vault-agent`. Never print,
   paste, copy the value into config, or pass it through argv or environment.
   A controller that will deploy must instead receive an exact private per-host
   file through an approved encrypted provisioning channel.

Preserve this baseline in the change record. Process liveness alone is not
readiness and a successful package install is not commissioning evidence.

## Prepare the Agent 2 / plugin 3 configuration

The plugin entry has this shape:

```json
{
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
        "apiKeyFilePath": "/var/lib/zn-vault-agent/myapp-api-key",
        "mutationAuthTokenFile": "/etc/zn-vault-agent/payara-mutation-token"
      }
    }
  ]
}
```

Do not carry these legacy settings into plugin 3:

- `restartOnCertChange=true`;
- `restartOnKeyRotation=true`;
- a non-empty `watchSecrets`;
- `manageLifecycle=false`;
- any non-empty Agent `exec.command`, even one intended for an unrelated child;
- any Agent `globalReloadCmd`, `targets[].reloadCmd`, or
  `secretTargets[].reloadCmd`.

Agent exec child events do not identify the detached Payara DAS, so plugin 3
rejects every non-empty exec command rather than attempting to infer whether it
is related. Reload hooks execute outside the shared Payara lock and are likewise
rejected regardless of their command text. Managed key rotation must use
`apiKeyFilePath`. Runtime secret changes never rewrite `setenv.conf`; update
startup configuration through an explicitly authorized lifecycle window.

Validate the prepared configuration offline and keep credentials out of argv,
shell history, tickets, and release receipts. Use the Agent's generated systemd
unit rather than hand-authoring a shorter stop timeout.

The API-key file is deliberately Agent-owned and only group-readable by Payara.
Its parent is setgid `2750`, its final mode is `0640`, and the plugin validates
Payara traversal on every parent before accepting an atomic replacement. A
`PAYARA_API_KEY_PERMISSION_CONTRACT` error is a NO-GO; rerun setup and restart
the Agent instead of weakening permissions.

### Provision controller credential copies

`mutationAuthTokenFile` in the plugin entry above is the **node-local server
path**. It must equal the Agent's effective `ZNVAULT_CONTROL_TOKEN_FILE` path so
the Agent and plugin gates read the same bytes. It is not the path used by a
remote deployment workstation.

Agent setup normally generates a different token per host. From an explicitly
authorized controller, provision each exact value over an approved encrypted
channel into a controller-owned regular `0600` file without displaying it. For
example, an authorized SSH-CA workflow may redirect the remote read directly to
a private temporary file:

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

Never run the remote read without redirection and never put the resulting value
in shell history, environment, config, logs, tickets, or receipts. Prefer the
organization's secret manager when available. Configure controller paths with
`mutationAuthTokenFiles.<host>` (preferred) or
`payara config set-auth-token-file <config> <host> <path>`. A singular
`mutationAuthTokenFile` is valid only for a deliberately provisioned fleet-wide
credential; it is not compatible with independently generated host tokens.

## Cutover procedure

Perform the following only inside the approved per-host window:

1. Block every deployment entry point and stop accepting new legacy updater
   requests.
2. Stop and disable the Python updater. Prove its process and all descendant
   `asadmin` commands have exited.
3. Re-run the lock, quarantine, DAS identity, persistent-ref, runtime-app, and
   readiness preflight. Any drift returns the change to NO-GO.
4. Stage the exact package pair, plugin 3 first and Agent 2 second. Do not start
   the service between installs.
5. Run `sudo zn-vault-agent setup --yes` to create/validate the private mutation
   token and shared-group/setgid contract. Verify `TimeoutStopSec>=900`,
   `KillMode=mixed`, token `0600`, state directory `2750`, and the Agent's Payara
   supplementary group; then start the Agent once.
6. Provision/rotate the controller's per-host private copies as described above,
   then validate every configured path without printing file contents.
7. Do not send a deploy/restart request during startup reconciliation.

The plugin never performs a first deployment at startup. A persistent
application reference makes Payara the boot owner; the plugin observes
restoration and waits for readiness. A missing WAR does not authorize a restart,
undeploy, or replacement deployment.

## Commissioning evidence

Before unblocking deployment traffic, record all of the following from the same
boot epoch:

- Agent `/health` reports `status=healthy`, its Payara plugin entry reports
  `status=healthy`, and that entry's `details.startupReconciliation=complete`;
- the authenticated CLI/client read of `/plugins/payara/status` reports
  `pluginVersion=3.x`, `running=true`, `healthy=true`, and `appDeployed=true`;
- that same fresh authenticated status reports `bootDeployment.owner=payara`,
  `bootDeployment.phase=ready`, `bootDeployment.readiness=health-verified`,
  and `bootDeployment.runtimeListed=true`;
- `bootDeployment.startupReceipt.outcome=boot-owned-skip` and
  `bootDeployment.startupReceipt.deploymentAttempted=false`, with the receipt's
  `bootEpoch` and `runtimeFingerprint` exactly equal to the enclosing
  `bootDeployment` values. A missing or mismatched receipt is a NO-GO; an
  `agent`-owned recovery boot cannot be used as commissioning evidence and must
  be followed by a clean Payara-owned boot;
- the exact domain has one DAS process and a stable runtime fingerprint;
- the expected persistent reference and runtime application agree;
- the application readiness endpoint returns 2xx;
- `mutationOutcomeUnknown=false` and no durable quarantine is armed;
- the shared mutation lock is absent after startup;
- the installed Agent and plugin versions are the approved pair.

Only after that read-only receipt passes may a separately authorized deployment
exercise the mutation path. Start with a dry-run from the controller, preserve
its resolved host/class plan, then perform the smallest reversible deployment.
The Payara plugin 3 CLI (hosted by `@zincapp/znvault-cli` >= 4.5.0) must report
Agent 2 and plugin 3 on every selected target before any
migration. Plugin 3 exposes no flag that bypasses this compatibility gate;
legacy `--skip-version-check` and `--skip-preflight` invocations are rejected.
Re-check readiness, process identity, boot epoch, lock release, and quarantine
afterward.

## Rollback

Rollback is not "start the Python service again" while the new writer is live.
First block deployment ingress, stop the Agent, and prove there is no late
`asadmin` or mutation work. If the lock is quarantined or the durable WAL records
an ambiguous outcome, do not delete it, retry, attest, downgrade, or start the
legacy writer. Reconcile the exact domain and application using the recovery
procedure in the main README.

Once the state is clean and the new writer is fully stopped, an authorized
rollback may restore the previous updater. If reverting npm packages, revert the
Agent/plugin compatibility pair together while stopped. At no point may both
writers be reachable.

## Required change receipt

Keep the following with the change record:

- authorization identifier and host/domain scope;
- exact npm versions and registry integrity values;
- preflight and post-change DAS identity, refs/apps, readiness, lock, and
  quarantine observations;
- systemd stop-budget evidence;
- dry-run and deployment result, if a deployment was separately authorized;
- explicit final state: commissioned, rolled back, or NO-GO.

See [README.md](./README.md) for the boot-ownership, ambiguity-quarantine,
recovery, status, and deployment APIs.
