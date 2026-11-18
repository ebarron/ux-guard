# Contributing

ux-guard is an incubating v0.x project. Changes may refine contracts, but
behavior must remain deterministic and generic.

## Development

Use Node.js 22 or newer and npm:

```sh
npm ci --ignore-scripts
npm run check:hygiene
npm run check:package
npm test
npm pack --dry-run --ignore-scripts
npm run test:install
```

Changes to policy behavior need positive, negative, and failure-path tests.
Changes to schemas, exported paths, or the tool version must update the package
consistency checks and changelog together. Keep fixtures synthetic and free of
consumer-specific names, links, identifiers, hashes, and screenshots.

Do not add a reusable workflow action or a privileged browser runner. Execution
authority and enforcement remain consumer responsibilities.

## Pull requests

Keep commits reviewable, explain compatibility effects, and include tests.
CI installs dependencies with lifecycle scripts disabled and checks the exact
package tarball boundary.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
