# ux-guard

ux-guard helps teams catch UI inconsistency and workflow backslide, explain the
evidence in human terms, and decide what to improve without declaring today's
defects acceptable.

[Getting started](#getting-started) · [Daily use](#daily-use) ·
[Safety and approval](#safety-and-approval) ·
[Scoring and backslide protection](#scoring-and-backslide-protection) ·
[Reference](#reference)

## What it does

- Checks components, controls, icons, and styling against conventions your team
  reviewed.
- Compares important user workflows with reviewed evidence from an earlier
  state, such as `main`.
- Reports UX quality, targets, regression, and missing evidence as separate
  signals.
- Keeps policy and baseline changes explicit so a change cannot silently
  redefine what it is judged against.

ux-guard does not decide which workflows matter or which UI patterns are good.
It can discover observations, but your repository owns the use cases, policy,
browser harness, baselines, targets, and enforcement decision. A human product
owner must review those choices.

## Getting started

Requirements: Node.js 22 or newer, npm, and a TypeScript UI project with JSX or
TSX source.

```sh
npm install --save-dev @edjbarron/ux-guard
npx ux-guard setup
```

Or ask your agent:

> Set up ux-guard in this repo.

`npx` uses the version installed in your project. Setup inspects non-test UI
source and writes an unapproved supporting review file when it finds usable
source. It does not know whether observed patterns are intentional, and it does
not inspect or invent your important workflows.

Work through these four review stages to get a useful first result.

### 1. Define the user outcomes that matter

Start with workflows, not routes or components. Identify who is trying to do
what, where they start, what success means, and who owns the decision. The
result is a repository-owned use-case catalog for product review.

> Help me define and review ux-guard use cases for this repo. Identify the
> important user workflows, personas, goals, success outcomes, starting points,
> priority tiers, and owners. Prepare the use-case catalog for review, but do
> not approve or activate it.

A product owner should confirm that the catalog covers the workflows whose
quality and backslide actually matter.

### 2. Decide which UI patterns are allowed

Review what setup observed: buttons and other controls, their props, component
and icon libraries, styling, and repeated pattern debt. Frequency is evidence
of current usage, not proof that a pattern is good.

> Inspect ux-guard's setup findings and `ux-guard/setup-proposal.json`. Show me
> the observed controls, control props, components, icons, and styling patterns.
> Help me classify each as an approved convention, tolerated existing debt to
> record in the baseline, or a non-approved pattern to fix. Do not change policy
> or baselines.

The product or design owner makes those classifications. Approved conventions
become policy. Tolerated debt can be recorded so new debt is visible.
Non-approved patterns should not be legitimized by a baseline.

### 3. Prepare reviewed comparison evidence

A baseline records what happened; it does not declare the experience good.
Collect only evidence that really executed. If a browser journey cannot run,
leave it unknown instead of creating substitute data.

> Prepare ux-guard's baseline review work for the approved use cases and UI
> conventions. Use only real repository evidence: the setup proposal for static
> patterns and the existing browser harness for configured journeys or visuals.
> Show what each proposed baseline would tolerate, keep every artifact
> unapproved, and stop before promotion.

Review pattern, journey, and visual evidence separately. The owner should reject
unexpected controls, failed workflows, unstable screenshots, or incomplete
coverage instead of accepting them just to make a check pass.

### 4. Run the first meaningful check

Approval must name the exact review artifacts and the files they may create.
After that one-time approval, ask the agent to activate only those artifacts and
run the checks:

> These exact ux-guard review artifacts and resulting files are approved:
> [list paths]. Activate only those approvals. Run ux-guard check and, if
> journey reporting is configured, ux-guard report. Explain the first result as
> good, needs attention, and unknown. Separate enforceable policy findings from
> advisory UX findings. Do not add waivers or change policy or baselines.

You now have a result tied to product-owned workflows, reviewed UI conventions,
and actual evidence. Missing or unexecutable evidence remains visible rather
than being reported as success.

## Daily use

### Check current work

> Check my current work with ux-guard. Run the installed local check and, when
> configured, report. Summarize good, needs attention, and unknown evidence. Do
> not change policy, baselines, waivers, or enforcement.

### Compare a change with `main`

> Compare this change with `origin/main` using ux-guard's trusted-base mode.
> Explain every policy finding and advisory backslide signal, including missing
> evidence. Do not change policy or baselines.

### Explain and fix findings

> Explain the ux-guard findings in this branch, then fix the actionable UI
> issues without weakening policy, adding waivers, or updating baselines just
> to make the result green. Explain the intended user outcome before editing
> production UI, and rerun the same ux-guard checks afterward.

CLI and CI equivalents:

```sh
# Current working tree
npx ux-guard check
npx ux-guard report

# Current code against reviewed policy and baselines from main
npx ux-guard check --base origin/main
npx ux-guard report --base origin/main
```

`check` validates the use-case catalog and source patterns. Configured journey
and visual evidence appears in advisory sections. `report` explains journey
quality, evidence gaps, targets, regression, supported scores, and
recommendations. `report` requires reviewed journey policy and a configured
journey report path; until those exist, use `check` and complete the missing
setup.

## Reading a result

- **Policy finding:** current code conflicts with a reviewed catalog or static
  pattern decision.
- **Advisory finding:** journey, target, regression, score, or visual evidence
  needs attention but is not enforced by `report`.
- **Unknown:** evidence was missing, incompatible, or could not execute. Unknown
  never means clean.
- **Unchanged:** current evidence matches the reviewed comparison evidence. It
  does not mean the UX is good.

For example, if a reviewed pattern baseline contains `Button size="sm"` and a
change introduces `Button size="xl"`, `check` reports a new control value. A
journey can still receive an acceptable advisory verdict; that does not erase
the policy finding.

## Safety and approval

- `setup` never activates policy, a baseline, a waiver, or enforcement.
- Setup supporting files and baseline promotions never silently overwrite
  existing review work.
- If setup finds no executable UI source evidence, it writes nothing and
  explains the next safe action.
- Observed usage is inventory, not approval. A human must approve policy,
  tolerated debt, targets, and comparison evidence.
- A baseline can preserve known defects for comparison without declaring them
  acceptable.
- `report` is advisory. A rendered report can describe a regression or target
  breach and still exit successfully.
- Merge prevention exists only when the repository adopts a reviewed
  enforcement decision and configures the relevant trusted check as required
  in CI.

### Exit codes

- `check` exits `0` when no enforceable catalog or static-pattern finding is
  present, `1` when one is present, and `2` when configuration, evidence, or
  execution failed.
- `report` exits `0` when it renders successfully, even with advisory findings.
  Missing active journey policy and malformed or unsafe inputs exit `2`.

Never interpret exit `0` as a blanket UX approval or exit `2` as clean.

## Scoring and backslide protection

Scores exist only for explicit, reviewed, product-owned metric targets. A score
describes target performance, not overall quality, and ux-guard does not create
a product-wide score. Trusted-base mode loads policy and baselines from the
resolved base commit so the change under review cannot redefine its judge.

See [scoring and backslide semantics](docs/scoring-and-backslide.md) for the
formulas, comparison signals, and enforcement boundaries.

Useful Agent Skill prompts:

> Show me where ux-guard scoring comes from and explain every score.

> Compare this branch with origin/main and explain every backslide signal; do
> not change policy or baselines.

## Setup output reference

Setup tailors its next steps to the observations it found. Pattern review is
omitted when no potential pattern problems were observed. Catalog or baseline
work appears only when that evidence is missing.

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
  4. After human approval and activation, run ux-guard check. Run ux-guard report after reviewed journey policy and a journey report path are configured.
  No policy, baseline, waiver, or enforcement was activated.
```

If no executable UI source evidence is available, setup writes nothing and
gives the next safe action instead of reporting success.

## Reference

- [CLI reference and advanced maintainer commands](docs/cli-reference.md)
- [Scoring and backslide semantics](docs/scoring-and-backslide.md)
- [Enumerated 111-test catalog and verification commands](docs/test-suite.md)
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
