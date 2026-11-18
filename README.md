# ux-guard

ux-guard helps teams catch UI inconsistency and workflow backslide, explain the
evidence in human terms, and decide what to improve without declaring today's
defects acceptable.

It separates four questions that are often blurred together:

- Is the current UI aligned with reviewed repository policy?
- Did important user workflows get better or worse?
- Are product-owned UX targets being met?
- What evidence is missing or unexecutable?

## What it does

- Keeps component, control-prop, icon, and styling patterns aligned with the
  conventions a team reviewed.
- Detects UX workflow backslide without treating a historical baseline as a
  declaration that the old experience was good.
- Measures interaction cost, including clicks, typing, route changes, modal
  depth, and policy-selected observations.
- Gives human-facing quality verdicts and actionable recommendations while
  preserving the underlying evidence.
- Protects reviewed visual evidence with strict profiles, checkpoint policy,
  hashes, dimensions, masks, repository boundaries, and no-overwrite
  promotion.
- Keeps baseline, target, and policy changes explicit so candidate code cannot
  silently redefine what it is judged against.
- Separates UX quality, target attainment, regression, and numerical scores so
  one signal cannot impersonate another.

ux-guard is consumer-neutral: your repository owns its use-case catalog,
policy, browser harness, reviewed baselines, targets, artifact locations, and
CI enforcement decision.

## Quickstart

Requirements: Node.js 22 or newer, npm, and a TypeScript UI project with JSX or
TSX source.

```sh
npm install --save-dev @edjbarron/ux-guard
npx ux-guard setup
```

Or ask your agent:

> Set up ux-guard in this repo.

`npx` executes the installed local package, so the project controls the
ux-guard version.

`setup` inspects non-test UI source and reports what it could establish:

```text
Good
  - No inline styles were observed in the inspected files.

Needs attention
  - 3 hard-coded colors observed; review before deciding policy.

Unknown
  - No use-case catalog was inspected, so workflow coverage is unknown.
  - No trusted baseline was used, so regression from main is unknown.

Setup proposal
  Saved ux-guard/setup-proposal.json.
  Status: unapproved.
```

The proposal records observations and missing decisions. Setup does not create
active policy, a reviewed baseline, a waiver, or enforcement, and it never
overwrites an existing proposal. Review the proposed source roots, component
and icon conventions, catalog paths, and baseline destination with the people
responsible for product, design, and engineering before approving activation.

If there is no executable UI evidence yet, setup says so, writes nothing, and
gives the next safe action instead of reporting success.

## Understand results

Suppose a reviewed pattern baseline contains `Button size="sm"` and a change
introduces `Button size="xl"`:

- `check` reports a new control value and exits `1`.
- A journey report may still say that a tested workflow is acceptable. That
  advisory UX verdict does not erase the policy finding.
- If no trusted workflow baseline was available, regression remains unknown.
- If the baseline contains the same value, `unchanged` means only “equal to
  reviewed comparison evidence.” It does not mean the UX is good.

Exit `0` means no enforceable catalog or pattern finding. Exit `1` means those
findings are present. Exit `2` means configuration, evidence, or execution
failed; it must not be interpreted as clean.

## Daily use

After reviewed policy is active:

```sh
npx ux-guard check
npx ux-guard report
```

Use a trusted base when reviewing a change against policy and baselines from
main:

```sh
npx ux-guard check --base origin/main
npx ux-guard report --base origin/main
```

`check` validates the use-case catalog and source patterns, then includes
configured journey and visual evidence as advisory sections. `report` explains
configured UX quality, evidence gaps, target attainment, regression, supported
scores, and recommendations. Report generation requires reviewed journey
policy; until then, the CLI explains what is missing.

## Reference

- [CLI reference and advanced maintainer commands](docs/cli-reference.md)
- [111-test catalog](docs/test-suite.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Source provenance](PROVENANCE.md)
- [Changelog](CHANGELOG.md)

The package exposes eleven explicit module subpaths:

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

TypeScript `5.9.3` is an exact runtime dependency. The ux-guard tool version
is `0.6.1`, and existing public schema versions are unchanged.

## Development

```sh
npm ci --ignore-scripts
npm run check:hygiene
npm run check:test-catalog
npm run check:package
npm test
npm pack --dry-run --ignore-scripts
npm run test:install
```

The synchronized [test catalog](docs/test-suite.md) must be updated whenever a
test file or test name changes.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
