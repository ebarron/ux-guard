# ux-guard

ux-guard helps teams catch UI inconsistency and workflow backslide, explain the
evidence in human terms, and decide what to improve without declaring today's
defects acceptable.

It separates four questions that are often blurred together:

- Is the current UI aligned with reviewed repository policy?
- Did important user workflows get better or worse?
- Are product-owned UX targets being met?
- What evidence is missing or unexecutable?

[Quickstart](#quickstart) · [Daily use](#daily-use) ·
[Scoring and backslide protection](#scoring-and-backslide-protection) ·
[CLI reference](docs/cli-reference.md)

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
ux-guard setup

Inspected
  1 non-test UI source files across 1 source roots.
  TypeScript projects: tsconfig.json.
  Component libraries: (none observed).
  Icon libraries: (none observed).
  Signals: component use, control props, icons, styling, pattern debt.

Good
  - Inspected 1 non-test UI source files.
  - No inline styles were observed in the inspected files.
  - No pixel literals were observed in the inspected files.
  - No raw button elements were observed in the inspected files.
  - No icon-library uses were observed in the inspected files.

Needs attention
  - 3 hard-coded colors observed; review before deciding policy.
    src/Page.tsx: 3

Unknown
  - Observed conventions have not been approved as policy.
  - No use-case catalog was inspected, so workflow coverage is unknown.
  - No trusted baseline was used, so regression from main is unknown.
  - Enforcement is not enabled.

Next steps
  1. Define the important user workflows and use cases. Agent Skill prompt: "Help me define ux-guard use cases for this repo"
  2. Review the observed styling and pattern issues (hard-coded colors) and decide which are intentional conventions versus UX debt. Agent Skill prompt: "Review ux-guard's observed hard-coded colors in this repo and help me decide which are intentional conventions versus UX debt; do not change policy or baselines"
  3. Decide what should become reviewed policy and prepare the initial baseline. Use ux-guard/setup-proposal.json as a supporting review file; it contains observed source roots, component and icon usage, pattern counts, and unresolved policy choices. Do not activate policy or baseline until a human explicitly approves them. Agent Skill prompt: "Help me review ux-guard/setup-proposal.json, decide what should become reviewed ux-guard policy, and prepare the initial baseline; do not activate anything until I explicitly approve it"
  4. After human approval and activation, run ux-guard check and ux-guard report; report will explain any remaining journey evidence gaps.
  No policy, baseline, waiver, or enforcement was activated.
```

The ordered next steps come from the findings: pattern review is omitted when
no pattern issues were observed, and catalog or baseline work appears only
when that evidence is missing. Setup does not activate policy, a baseline, a
waiver, or enforcement, and it never overwrites existing review work.

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

## Scoring and backslide protection

[Detailed scoring and backslide semantics](docs/scoring-and-backslide.md) ·
[CLI commands and exit behavior](docs/cli-reference.md#scoring-and-backslide-protection)

### Where scoring appears

After reviewed policy is active, `npx ux-guard report` shows quality verdict,
target attainment, regression/backslide, and numerical scores as separate
outputs. `npx ux-guard report --base origin/main` shows the same outputs while
loading reviewed policy and baselines from `origin/main`. Markdown uses
separate sections; JSON uses separate `quality`, `targetAttainment`,
`regression`, and `scoring` fields.

### How to get and interpret scores

A score exists only for an explicit, reviewed, product-owned `at-most` metric
target. A met target scores 100. A breach scores
`round(100 * target / actual)`; a breached zero target scores 0. For example,
a target of at most 3 edited fields with an actual value of 4 scores 75.
That 75 is target performance, not the quality verdict: quality can remain
acceptable while a product-owned target is breached.

A journey score is the weakest score among its scoreable configured metrics.
A use-case score is the minimum across its scored required journeys, so a
stronger workflow cannot hide a weaker one. Missing, unexecutable, or
unmeasured evidence is not scored and remains explicit as partial or
not-scored. ux-guard does not calculate a product-wide scalar score.

### Whether and how ux-guard prevents backslide

Trusted-base mode loads reviewed main policy and baselines before evaluating
candidate source and evidence, so candidate code cannot redefine its judge. It
detects reviewed-tolerance metric increases, journey lifecycle degradation or
missing journeys, new findings and severity increases, hard-floor breaches,
static pattern-debt growth, and visual manifest, profile, hash, or dimension
drift.

Detection is advisory by default. A successfully rendered `report` exits 0
even when it describes a target breach or regression; it does not block a
merge. `check` exits 1 for enforceable catalog or static-pattern findings and
2 for configuration, evidence, or execution failure. Journey, target,
regression, and visual results remain advisory unless the consumer adds a
trusted classifier or other reviewed enforcement decision. Merge prevention
occurs only when the consumer configures trusted ux-guard execution as a
required CI check; making `report` alone required does not turn advisory
signals into a failure.

Ask an Agent Skill:

> Show me where ux-guard scoring comes from and explain every score

> Compare this branch with origin/main and explain every backslide signal; do
> not change policy or baselines

## Reference

- [CLI reference and advanced maintainer commands](docs/cli-reference.md)
- [Scoring and backslide semantics](docs/scoring-and-backslide.md)
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
