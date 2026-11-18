# Contributing

ux-guard is an incubating v0.x project. Changes may refine contracts, but
behavior must remain deterministic and generic.

## Development

Use Node.js 22 or newer and npm:

```sh
npm ci --ignore-scripts
npm run check:hygiene
npm run check:test-catalog
npm run check:package
npm test
npm pack --dry-run --ignore-scripts
npm run test:install
```

Changes to policy behavior need positive, negative, and failure-path tests.
Changes to schemas, exported paths, or the tool version must update the package
consistency checks and changelog together. Keep fixtures synthetic and free of
consumer-specific names, links, identifiers, hashes, and screenshots.
When a test is added, removed, or renamed, update
[the test suite catalog](docs/test-suite.md); the catalog check compares its
file groups and names with test discovery.

Do not add a reusable workflow action or a privileged browser runner. Execution
authority and enforcement remain consumer responsibilities.

## Releases

Maintainers release from the verified head of protected `main` with the manual
`Release` workflow. Enter the exact package version without the `v` prefix.
The protected `npm` environment must approve the deployment, repository release
immutability must already be enabled, and npm must trust `release.yml` for the
`npm` environment with direct publishing allowed.

Never create the release tag by hand, rerun a successful version, add a classic
npm token, or bypass a failed preflight. The workflow publishes the exact tested
tarball through OIDC, confirms its registry integrity, and only then publishes
the prepared immutable GitHub release.

## Pull requests

Keep commits reviewable, explain compatibility effects, and include tests.
CI installs dependencies with lifecycle scripts disabled and checks the exact
package tarball boundary.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
