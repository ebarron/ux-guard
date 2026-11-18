# ux-guard

`@edjbarron/ux-guard` is a generic Node.js package for deterministic UX policy
checks, journey evidence contracts, strict visual profile and manifest
lifecycles, trusted evidence validation, and advisory verdict reports. It has
no consumer-specific paths, products, or framework assumptions.

The package owns schemas, validation, aggregation, comparison, rendering, and
optional structural browser bindings. A consumer owns its catalog, policy,
baselines, browser harness, framework readiness, artifact locations, and CI
materialization. `authoritative` accepts raw shards only, reconstructs the
expected run identity from trusted inputs, and emits one advisory bundle; it
does not accept a candidate verdict.

TypeScript `5.9.3` is an exact runtime dependency, not a
consumer-configured executable path. The lockfile integrity-pins it, and CI
installs with npm lifecycle scripts disabled.

## Distribution state

Version `0.6.0` is public source but is not published to npm. There is no
release or tag. Install a reviewed GitHub source snapshot by full commit:

```sh
UX_GUARD_SHA=<reviewed-40-character-commit-sha>
npm install --save-dev \
  "https://github.com/ebarron/ux-guard/archive/${UX_GUARD_SHA}.tar.gz"
npx --no-install ux-guard
```

The package remains marked `private` to prevent accidental npm publication.

## Requirements

- Node.js 22 or newer
- npm
- Git for trusted-revision reads

## CLI

```sh
npx --no-install ux-guard check --root .
npx --no-install ux-guard report --root . --format markdown
npx --no-install ux-guard authoritative --root . --base origin/main
npx --no-install ux-guard baseline canary --root .
npx --no-install ux-guard visual canary --root .
npx --no-install ux-guard patterns canary --root .
```

Commands consume repository-relative policy and evidence paths. Review
candidate and baseline promotion output before committing it. The CLI is
advisory; consumers decide how to stage or enforce its results.

## Module exports

The package exposes eleven explicit subpaths:

- `@edjbarron/ux-guard/authoritative`
- `@edjbarron/ux-guard/baselines`
- `@edjbarron/ux-guard/journey-policy`
- `@edjbarron/ux-guard/journeys`
- `@edjbarron/ux-guard/observations`
- `@edjbarron/ux-guard/playwright`
- `@edjbarron/ux-guard/run-contract`
- `@edjbarron/ux-guard/shards`
- `@edjbarron/ux-guard/targets`
- `@edjbarron/ux-guard/visuals`
- `@edjbarron/ux-guard/verdicts`

## Trust boundary

Browser bindings can fabricate measurements unless they run inside a stronger
sandbox. Trusted aggregation prevents candidate code from choosing policy or
the final report; it does not establish that untrusted measurements reflect
real user behavior.

Visual v1 keeps images outside the compact verdict report. A consumer supplies
strict canonical profile and checkpoint policy files, while the package
validates image paths, regular-file type, symlink boundaries, hashes,
dimensions, profile identity, exact per-checkpoint tolerances, and reviewed
masks. Candidate bundles are explicitly unapproved and no-overwrite.

Owner targets v2 keep desired policy separate from current-state baselines.
Target attainment v1 evaluates every configured hard floor and per-journey
metric target. Quality, target attainment, regression, numerical scores, and
recommendations remain separate report sections.

## Development

```sh
npm ci --ignore-scripts
npm run check:hygiene
npm run check:package
npm test
npm pack --dry-run --ignore-scripts
npm run test:install
```

The test suite contains 100 generic tests. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [PROVENANCE.md](PROVENANCE.md).

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
