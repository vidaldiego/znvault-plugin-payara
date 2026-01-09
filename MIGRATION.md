# Migration Guide: Python zinc_updater to znvault-plugin-payara

This guide covers migrating from the Python-based `zinc_updater` to the new `@zincapp/znvault-plugin-payara` plugin for zn-vault-agent.

## Overview

| Aspect | Python zinc_updater | znvault-plugin-payara |
|--------|--------------------|-----------------------|
| Language | Python 3.x | TypeScript/Node.js |
| Port | 9909 | 9100 (agent health port) |
| Architecture | Standalone server | Agent plugin |
| Auth | Custom token | Agent authentication |
| WAR Diff | Yes | Yes (improved) |
| Secrets | Vault integration via Python | Native agent integration |

## Benefits of Migration

1. **Unified Management**: Single agent process instead of separate Python server
2. **Native Vault Integration**: Direct access to secrets, certificates, KMS
3. **Event-Driven**: React to certificate deployments automatically
4. **Better Monitoring**: Integrated with agent health endpoint
5. **Single Deployment**: One package instead of Python + dependencies
6. **Improved Reliability**: TypeScript type safety, comprehensive tests

## Migration Steps

### Step 1: Install zn-vault-agent with Plugin Support

```bash
# On each staging/production server
npm install -g @zincapp/zn-vault-agent
npm install -g @zincapp/znvault-plugin-payara
```

### Step 2: Create Agent Configuration

Create `/etc/zn-vault-agent/config.json`:

```json
{
  "vaultUrl": "https://vault.zincapp.dev",
  "tenantId": "zincapp",
  "auth": {
    "apiKey": "znv_..."
  },
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "config": {
        "payaraHome": "/opt/payara",
        "domain": "domain1",
        "user": "payara",
        "warPath": "/opt/zinc_updater/ZincAPI.war",
        "appName": "ZincAPI",
        "healthEndpoint": "http://localhost:8080/service-status",
        "restartOnCertChange": true
      }
    }
  ]
}
```

### Step 3: Configuration Mapping

Map your Python configuration to the new format:

| Python Config | Plugin Config |
|---------------|---------------|
| `PAYARA_HOME` env var | `payaraHome` |
| `DOMAIN_NAME` env var | `domain` |
| `PAYARA_USER` env var | `user` |
| `WAR_PATH` env var | `warPath` |
| `APP_NAME` env var | `appName` |
| `HEALTH_URL` env var | `healthEndpoint` |

### Step 4: Update Client Deployment Scripts

**Before (Python client):**
```bash
# Old zinc_updater client
python3 deploy_client.py \
  --server staging-1.zincapp.dev:9909 \
  --war ./target/ZincAPI.war
```

**After (znvault CLI):**
```bash
# New znvault CLI
znvault deploy war ./target/ZincAPI.war \
  --target https://staging-1.zincapp.dev:9100
```

### Step 5: Parallel Operation (Recommended)

Run both systems in parallel during transition:

```bash
# Python server (keep running)
# Port 9909

# zn-vault-agent with plugin (new)
# Port 9100
zn-vault-agent start --health-port 9100
```

Test the new deployment:
```bash
# Test with new CLI
znvault deploy war ./target/ZincAPI.war \
  --target https://staging-1.zincapp.dev:9100 \
  --dry-run

# If looks good, deploy for real
znvault deploy war ./target/ZincAPI.war \
  --target https://staging-1.zincapp.dev:9100
```

### Step 6: Create Systemd Service

Create `/etc/systemd/system/zn-vault-agent.service`:

```ini
[Unit]
Description=ZN-Vault Agent with Payara Plugin
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/zn-vault-agent start --health-port 9100
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable zn-vault-agent
systemctl start zn-vault-agent
```

### Step 7: Verify and Cutover

```bash
# Check agent health
curl -s http://localhost:9100/health | jq

# Check plugin status
curl -s http://localhost:9100/plugins/payara/status | jq

# Verify WAR hashes
curl -s http://localhost:9100/plugins/payara/hashes | jq
```

### Step 8: Retire Python Server

Once verified:

```bash
# Stop Python server
systemctl stop zinc-updater

# Disable Python server
systemctl disable zinc-updater

# Optional: Remove Python installation
rm -rf /opt/zinc_updater/venv
```

## API Endpoint Mapping

| Python Endpoint | Plugin Endpoint |
|-----------------|-----------------|
| `POST /deploy` | `POST /plugins/payara/deploy` |
| `GET /hashes` | `GET /plugins/payara/hashes` |
| `POST /restart` | `POST /plugins/payara/restart` |
| `GET /status` | `GET /plugins/payara/status` |
| `GET /health` | `GET /health` (agent-level) |

## Request/Response Changes

### Deploy Request

**Python format:**
```json
{
  "token": "auth-token",
  "files": [
    {"path": "file.txt", "content": "base64..."}
  ],
  "deletions": ["old.txt"]
}
```

**Plugin format:**
```json
{
  "files": [
    {"path": "file.txt", "content": "base64..."}
  ],
  "deletions": ["old.txt"]
}
```

Note: Authentication is handled by the agent, not per-request tokens.

### Status Response

**Python format:**
```json
{
  "status": "running",
  "payara_healthy": true
}
```

**Plugin format:**
```json
{
  "running": true,
  "healthy": true,
  "domain": "domain1"
}
```

## CI/CD Integration

Update your CI/CD scripts:

**Before (Python):**
```yaml
deploy:
  script:
    - pip install zinc-updater-client
    - python -m zinc_updater.deploy \
        --server $DEPLOY_HOST:9909 \
        --war target/app.war \
        --token $DEPLOY_TOKEN
```

**After (Plugin):**
```yaml
deploy:
  script:
    - npm install -g @zincapp/znvault-cli
    - npm install -g @zincapp/znvault-plugin-payara
    - znvault deploy war target/app.war \
        --target https://$DEPLOY_HOST:9100
```

## Rollback Plan

If issues arise, rollback is simple:

```bash
# Stop agent
systemctl stop zn-vault-agent

# Restart Python server
systemctl start zinc-updater

# Python continues on port 9909
```

Update deployment scripts back to Python client if needed.

## Troubleshooting

### Agent won't start

```bash
# Check logs
journalctl -u zn-vault-agent -f

# Verify config
cat /etc/zn-vault-agent/config.json | jq
```

### Plugin not loading

```bash
# Check if plugin is installed
npm list -g @zincapp/znvault-plugin-payara

# Verify plugin in health output
curl -s http://localhost:9100/health | jq '.plugins'
```

### Deployment fails

```bash
# Check Payara status
curl -s http://localhost:9100/plugins/payara/status | jq

# Check if asadmin works
sudo -u payara /opt/payara/bin/asadmin list-domains
```

### Permission errors

Ensure the agent has permission to:
- Run `asadmin` commands (possibly via sudo)
- Write to the WAR file location
- Read Payara domain directory

## Support

For issues or questions:
- GitHub Issues: https://github.com/zincware/znvault-plugin-payara/issues
- Documentation: https://docs.zincapp.dev/vault/plugins/payara
