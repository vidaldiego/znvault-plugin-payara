# Publishing Guide

This package uses npm OIDC Trusted Publishing for secure, tokenless releases from GitHub Actions.

## Initial Setup (One-time)

### 1. Configure Trusted Publisher on npm

⚠️ **IMPORTANT**: These values MUST match EXACTLY (case-sensitive):

1. Go to [npmjs.com](https://www.npmjs.com) and log in
2. Navigate to your package: `@zincapp/znvault-plugin-payara`
3. Go to **Settings** → **Publishing access**
4. Under **Trusted Publishers**, click **Add new publisher** or **Add trusted publisher**
5. Select **GitHub Actions**
6. Fill in **EXACTLY** as shown:

   | Field | Value |
   |-------|-------|
   | **Owner** | `vidaldiego` |
   | **Repository** | `znvault-plugin-payara` |
   | **Workflow** | `publish.yml` |
   | **Environment** | `npm-publish` |

7. Click **Add**

**Troubleshooting 404 Errors:**
- Verify the workflow filename is `publish.yml` (not `release.yml`)
- Verify the environment is `npm-publish` (or remove from both workflow and npm settings)
- The GitHub owner (`vidaldiego`) must match exactly, not the npm scope (`@zincapp`)
- For scoped packages like `@zincapp/*`, you may need org-level permissions on npm

### 2. Create GitHub Environment

1. Go to your repo: https://github.com/vidaldiego/znvault-plugin-payara
2. Navigate to **Settings** → **Environments**
3. Click **New environment**
4. Name it: `npm-publish`
5. Optionally add protection rules (required reviewers, etc.)

## Releasing

### Automated Release (Recommended)

1. Update the version without creating an implicit partial release commit.
2. Stage and validate the complete release snapshot.
3. Commit, push, then create and push only the intended annotated tag:

```bash
# Update package.json and package-lock.json without committing or tagging.
npm version patch --no-git-tag-version  # or minor, major

# The release commit must contain the complete reviewed tree, including new
# files; staging only version metadata can silently omit release code.
git add -A
git diff --cached --check
git status --short
RELEASE_VERSION=$(node -p "require('./package.json').version")
git commit -m "chore(release): v$RELEASE_VERSION"

# Push the release commit and only the intended tag. Do not use --tags: local
# historical tags may not have been published.
git push origin HEAD:main
git tag -a "v$RELEASE_VERSION" -m "v$RELEASE_VERSION"
git push origin "refs/tags/v$RELEASE_VERSION"
```

The GitHub Action will:
1. Run tests
2. Build the package
3. Pack one tarball and verify that exact artifact's contents, installation,
   imports, and version
4. Publish the same digest-checked tarball to npm with provenance
5. Create a GitHub release

### Plugin 3 migration-channel fence

Stable plugin 3 releases, including `3.0.0`, are intentionally published with
the isolated npm dist-tag `dr-m4`. The workflow does **not** move `latest`, and
the corresponding GitHub Release is created with `make_latest=false`. `dr-m4`
is deliberately not a conventional updater channel such as `next` or `beta`.

Publish and verify the dependency chain in this order:

1. `@zincapp/znvault-deploy-core@0.2.4` with the authenticated request API and
   transport fence;
2. the exact Agent 2 release that consumes that core and owns the outer route
   gate/setup contract;
3. the exact Payara plugin 3 release whose dependency resolves to core 0.2.x and
   whose dev/peer dependency resolves to that Agent 2 build.

Before tagging the plugin, regenerate the lockfile from the public registry and
verify it contains no `file:` tarball/path, resolves
`@zincapp/znvault-deploy-core` to `0.2.x`, and resolves the Agent dev dependency
to `2.x`. A locally packed dependency is suitable only for pre-publication
testing and must not enter the release commit.

Agent 2 and plugin 3 form one coordinated migration pair. Publishing their exact
versions under `dr-m4` makes the artifacts available for explicit staging; it
does not authorize an install, restart, rollout, or production commissioning.
Promoting either package to npm `latest` requires a separate operational gate
that proves the fleet auto-update policy, compatible pair availability, and
per-host rollout controls. That promotion is intentionally absent from this
workflow.

### Release Recovery

If OIDC publishing fails, correct the trusted-publisher or workflow issue and
re-run the workflow for the exact existing tag. Do not bypass provenance or
the test/build/audit/artifact gates with a local `npm publish`. The workflow
packs exactly once in its publish job; recovery must reuse the existing tag and
reproduce that source snapshot, never publish an independently packed directory.

## Verification

After publishing, verify:

1. **npm page**: https://www.npmjs.com/package/@zincapp/znvault-plugin-payara
2. **Exact version**: the version matching the pushed `v$RELEASE_VERSION` tag
   resolves under `dr-m4`
3. **Dist-tags**: `latest` remains on the prior production-compatible release
4. **Provenance badge**: Should show "Provenance" badge on npm
5. **GitHub release**: Should be created automatically and must not be latest

## Troubleshooting

### "Unable to authenticate" error

- Verify workflow filename matches exactly (case-sensitive)
- Check environment name matches (`npm-publish`)
- Ensure `id-token: write` permission is set

### 404 on publish

- npm couldn't match workflow to Trusted Publisher config
- Double-check org/user, repo, workflow, environment settings

### Publish fails before npm upload

- Verify the tag belongs to `main` and exactly matches `package.json`.
- Verify the trusted publisher and `npm-publish` environment configuration.
- Re-run the same workflow; do not create a replacement tag for different
  source content.

## References

- [npm Trusted Publishing Docs](https://docs.npmjs.com/trusted-publishers/)
- [GitHub OIDC for npm](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
