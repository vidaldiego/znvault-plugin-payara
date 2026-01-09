# Publishing Guide

This package uses npm OIDC Trusted Publishing for secure, tokenless releases from GitHub Actions.

## Initial Setup (One-time)

### 1. Create npm Package (First publish only)

For the first publish, you need to use a classic npm token:

```bash
# Login to npm
npm login

# Publish manually first time
npm publish --access public
```

### 2. Configure Trusted Publisher on npm

1. Go to [npmjs.com](https://www.npmjs.com) and log in
2. Navigate to your package: `@zincapp/znvault-plugin-payara`
3. Go to **Settings** → **Trusted Publishers**
4. Click **Add Trusted Publisher** → **GitHub Actions**
5. Fill in:
   - **Organization/User**: `vidaldiego`
   - **Repository**: `znvault-plugin-payara`
   - **Workflow filename**: `release.yml`
   - **Environment**: `npm-publish`
6. Click **Set up connection**

### 3. Create GitHub Environment

1. Go to your repo: https://github.com/vidaldiego/znvault-plugin-payara
2. Navigate to **Settings** → **Environments**
3. Click **New environment**
4. Name it: `npm-publish`
5. Optionally add protection rules (required reviewers, etc.)

## Releasing

### Automated Release (Recommended)

1. Update version in `package.json`
2. Commit the change
3. Create and push a git tag:

```bash
# Update version
npm version patch  # or minor, major

# Push with tags
git push origin main --tags
```

The GitHub Action will:
1. Run tests
2. Build the package
3. Publish to npm with provenance
4. Create a GitHub release

### Manual Release (Fallback)

If OIDC fails, you can still publish manually:

```bash
npm login
npm publish --access public
```

## Verification

After publishing, verify:

1. **npm page**: https://www.npmjs.com/package/@zincapp/znvault-plugin-payara
2. **Provenance badge**: Should show "Provenance" badge on npm
3. **GitHub release**: Should be created automatically

## Troubleshooting

### "Unable to authenticate" error

- Verify workflow filename matches exactly (case-sensitive)
- Check environment name matches (`npm-publish`)
- Ensure `id-token: write` permission is set

### 404 on publish

- npm couldn't match workflow to Trusted Publisher config
- Double-check org/user, repo, workflow, environment settings

### First publish fails

- First publish must use classic npm token
- After first publish, configure Trusted Publisher
- Subsequent publishes use OIDC

## References

- [npm Trusted Publishing Docs](https://docs.npmjs.com/trusted-publishers/)
- [GitHub OIDC for npm](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
