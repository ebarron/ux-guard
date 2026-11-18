# One-time npm bootstrap for 0.6.0

This runbook and `workflows/bootstrap-release-0.6.0.yml` are temporary. They
exist only to publish `@edjbarron/ux-guard@0.6.0`, after which npm trusted
publishing can be configured for the permanent OIDC-only workflow.

## Before dispatch

1. Merge the bootstrap pull request through protected `main` and record the
   resulting full 40-character commit SHA.
2. In the protected GitHub `npm` environment, create a short-lived granular
   environment secret named `NPM_TOKEN`. Limit it to the
   `@edjbarron/ux-guard` package with only the access needed to publish, and
   retain the environment's protected-branch and reviewer controls.
3. Confirm release immutability with an administrator credential. GitHub's
   per-run token cannot read this administration-scoped setting:

   ```sh
   test "$(gh api repos/ebarron/ux-guard/immutable-releases --jq .enabled)" = true
   ```

4. Confirm that `@edjbarron/ux-guard@0.6.0`, `v0.6.0`, and the corresponding
   GitHub release remain absent.
5. Do not publish locally, create the tag manually, or run any other version.

After the secret is confirmed, dispatch exactly:

```sh
gh workflow run bootstrap-release-0.6.0.yml \
  --repo ebarron/ux-guard \
  --ref main \
  -f package='@edjbarron/ux-guard@0.6.0' \
  -f commit='<FULL_MERGED_MAIN_SHA>'
```

The workflow accepts no other package or version. It requires the supplied
commit to be the protected, verified head of `main`; repeats all 111 tests,
hygiene, test-catalog, package allowlist, dry-pack, and packed install/setup
smoke checks; builds the tarball, SHA-256 checksums, CycloneDX SBOM, and
GitHub/Sigstore attestations; and publishes with public access and npm
provenance. The token is referenced only as the protected environment secret
for the single `npm publish` step.

The release tag and draft are created only after npm exposes the exact expected
tarball integrity. A rerun fails closed unless npm has that identical integrity
and GitHub is missing the release or has an exact draft/tag for the same
commit. That recovery path may finish the GitHub release but cannot publish a
different artifact.

## Mandatory immediate cleanup

Complete all of these steps as soon as the immutable release and its assets
verify successfully:

1. Delete the environment secret:

   ```sh
   gh secret delete NPM_TOKEN --env npm --repo ebarron/ux-guard
   ```

2. Open and merge an immediate cleanup pull request that deletes both
   `.github/workflows/bootstrap-release-0.6.0.yml` and this runbook. Do not
   retain a token-capable workflow.
3. In npm package settings, configure a GitHub Actions trusted publisher with:
   owner `ebarron`, repository `ux-guard`, workflow filename `release.yml`,
   and environment `npm`.
4. Prove the future path is OIDC-only: confirm the environment has no
   `NPM_TOKEN`, run `npm run check:package`, and verify
   `.github/workflows/release.yml` has no `secrets.*` or `_authToken`
   reference. The package-boundary check enforces those conditions and the
   permanent workflow explicitly unsets `NODE_AUTH_TOKEN` and `NPM_TOKEN`
   before its OIDC publish.

Do not delete the secret or bootstrap workflow while a failed run still needs
the exact-integrity recovery path. Never use the bootstrap workflow after
`v0.6.0` is complete.
