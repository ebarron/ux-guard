# ux-guard

ux-guard helps a team notice when a UI becomes less consistent, harder to use,
or less trustworthy than the version people reviewed. It turns repository
policy and captured workflow evidence into checks and human-readable advice.

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

Requirements: Node.js 22 or newer, npm, Git, at least one `tsconfig` file, and
non-test JSX or TSX source. Version `0.6.0` is public source only: it is not
published to npm and has no release or tag.

### 1. Install one exact GitHub commit

Resolve the current public `main` commit, inspect that commit on GitHub, and
continue only after it is the revision you intend to use:

```sh
UX_GUARD_SHA="$(
  git ls-remote https://github.com/ebarron/ux-guard.git refs/heads/main |
    cut -f1
)"
test "${#UX_GUARD_SHA}" -eq 40
printf 'Review https://github.com/ebarron/ux-guard/commit/%s\n' "$UX_GUARD_SHA"
npm install --save-dev --ignore-scripts \
  "https://github.com/ebarron/ux-guard/archive/${UX_GUARD_SHA}.tar.gz"
```

The saved dependency and lockfile now reference that full commit, rather than
a moving branch or an unpublished package version. The package is marked
`private` to prevent accidental npm publication.

### 2. Add commands named for their outcomes

```sh
npm pkg set \
  'scripts.ux:first-audit=npx --no-install ux-guard discover --root .' \
  'scripts.ux:policy-check=npx --no-install ux-guard check --root . --format json' \
  'scripts.ux:backslide-check=npx --no-install ux-guard check --root . --base origin/main --format json' \
  'scripts.ux:human-report=npx --no-install ux-guard report --root . --base origin/main --format markdown'
```

`npx --no-install` guarantees that the checked-in local dependency is used and
prevents an implicit network install.

### 3. Get the first results

```sh
npm run ux:first-audit
```

This read-only audit reports observed component libraries, controls, props,
icon libraries, styling, source roots, and pattern debt. It writes nothing and
labels every suggested setting as requiring review.

### 4. Turn reviewed observations into policy

Write an unapproved review artifact:

```sh
npx --no-install ux-guard discover write-candidate --root . \
  --candidate ux/ux-guard-candidate.json --format json
```

Review `ux/ux-guard-candidate.json`; observed usage is evidence, not approval.
Before promotion:

- set `approval.status` to `approved`, record `reviewer` and `reviewedAt`, and
  set `patternPolicyReviewed` to `true`;
- add `config.catalog.path` and `config.catalog.navigation`;
- choose `config.patterns.baseline`, source roots, exclusions, approved control
  props, and allowed icon libraries; and
- create the catalog file. Start with `inventory: partial` until its use cases
  intentionally cover all discovered navigation surfaces.

A minimal catalog entry has this shape:

```yaml
version: 1
inventory: partial
use_cases:
  - id: create-record
    title: Create a record
    persona: Operator
    tier: primary
    effect: create
    owner: product-owner
    goal: "Create a record."
    success: "The record appears."
    starts:
      - nav_id: records
        route: /records
```

Promote only the reviewed artifact. Promotion creates `.uxguard.json` and the
selected pattern baseline; it refuses to overwrite either file.

```sh
npx --no-install ux-guard discover promote --root . \
  --candidate ux/ux-guard-candidate.json --format json
npm run ux:policy-check
```

Commit the installed dependency, lockfile, scripts, `.uxguard.json`, catalog,
and reviewed baseline together. Add journey and visual policy later when the
consumer has trustworthy browser evidence for those capabilities.

## Understand your first results

The first audit is current-state discovery, not a pass/fail grade. It helps a
human choose policy:

- **Observed libraries and values** show what the code uses today. Frequent
  usage is not automatic approval.
- **Pattern debt** counts configured concerns such as native controls,
  hard-coded colors, pixel literals, inline styles, and unapproved icon
  libraries.
- **Candidate profile** is a starting point. Empty or incomplete fields are
  decisions the owner must make.
- **Unmapped surfaces** are navigation entries not covered by a catalogued use
  case. A partial inventory reports them; strict or complete inventory can
  reject them.

Later reports keep four meanings separate:

- **Quality** is the human-oriented verdict derived from reviewed UX rules and
  evidence: for example, acceptable, needs improvement, incomplete, or a run
  error.
- **Target attainment** says whether owner-selected requirements and
  interaction limits were met.
- **Regression** says what changed relative to a reviewed current-state
  baseline and its tolerances.
- **Numerical score** summarizes measured interaction cost only where target
  coverage supports a score. It is not a quality verdict.

`unchanged` means “the same as the reviewed baseline,” not “good.” A baseline
can preserve known defects as comparison evidence without approving them.

## Daily and CI usage

After policy is reviewed and committed, the normal commands stay short:

```sh
npm run ux:first-audit
npm run ux:policy-check
npm run ux:backslide-check
npm run ux:human-report
```

- Use `ux:first-audit` when conventions or source layout change and policy may
  need another human review.
- Use `ux:policy-check` while editing the checked-out policy and source.
- Use `ux:backslide-check` in pull requests after fetching `origin/main`. It
  audits candidate source while loading policy and baselines from that trusted
  commit.
- Use `ux:human-report` after journey reporting is configured. It renders
  advisory verdicts and recommendations for reviewers.

`check` returns nonzero for enforceable catalog or pattern findings and for
invalid input. Journey, target, visual, and recommendation sections remain
advisory unless the consumer adds an explicit, reviewed enforcement policy.
Consumers decide how to retain artifacts and translate results into CI gates.

## Commands and reference

### Discover current conventions

- `discover` audits the working tree without policy and writes nothing.
- `discover write-candidate --candidate <path>` writes one explicitly
  unapproved review artifact.
- `discover promote --candidate <path>` installs a human-approved candidate
  without overwriting policy or baseline files.

### Check alignment and backslide

- `check [--strict] [--base <ref>]` runs catalog validation and pattern checks,
  then includes configured journey and visual advisory results.
- `catalog [--strict]` validates use-case coverage and lists unmapped
  navigation surfaces.
- `patterns scan` checks current patterns against the reviewed snapshot.
- `patterns init` creates the first pattern snapshot; `patterns update`
  removes stale entries and requires `--accept-growth` before adding debt.

### Produce human advice

- `report --format markdown` renders quality verdicts, evidence status, target
  attainment, regression, scores where available, and recommendations.
- `report --format json` emits the same advisory model for another renderer.

### Review baseline and visual evidence

- `baseline propose`, `baseline inspect`, `baseline diff`, and
  `baseline promote` provide an explicit no-overwrite journey-baseline review
  lifecycle.
- `visual inspect`, `visual diff`, and `visual promote` validate and review
  visual manifests and their image bundles.
- `authoritative --format json` is the advanced trusted-aggregation entry
  point. It accepts raw shards, reconstructs expected run identity from trusted
  inputs, and creates the advisory bundle; it does not accept a candidate
  verdict.

Run an invalid or empty invocation to print the complete option list:

```sh
npx --no-install ux-guard
```

### Module exports

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

TypeScript `5.9.3` is an exact runtime dependency, not a consumer-configured
executable path. The lockfile integrity-pins it.

## Trust, advisory, and baseline model

Candidate code can fabricate measurements unless its browser and test process
run in a stronger sandbox. Trusted aggregation prevents candidate code from
choosing policy, reviewed baselines, run identity, or the final report; it
cannot prove that untrusted measurements reflect real user behavior.

Use `--base <ref>` to read policy, targets, and reviewed baselines from an
explicit trusted commit while auditing working-tree source and current
evidence. Missing, malformed, incompatible, or unreviewed evidence stays
visible as unavailable or incomplete instead of becoming success.

Current-state baselines answer “what changed?” Owner targets answer “did we
reach the desired outcome?” Quality rules answer “what does the evidence mean
for a person?” Scores answer only “how did measured interaction cost compare
with configured targets?” The report intentionally does not collapse these
questions into one pass/fail number.

Visual images remain outside the compact verdict report. ux-guard validates
their repository paths, regular-file type, symlink boundaries, hashes,
dimensions, profile identity, exact checkpoint tolerances, and reviewed masks.
Candidate visual bundles remain unapproved and promotion never overwrites a
reviewed bundle.

## Contributor diagnostics

These canaries test ux-guard's own comparison and failure-detection logic. They
do **not** audit the consumer repository and are not part of the primary user
path:

```sh
npx --no-install ux-guard baseline canary --root .
npx --no-install ux-guard visual canary --root .
npx --no-install ux-guard patterns canary --root .
```

For package development:

```sh
npm ci --ignore-scripts
npm run check:hygiene
npm run check:test-catalog
npm run check:package
npm test
npm pack --dry-run --ignore-scripts
npm run test:install
```

The suite contains
[100 generic tests grouped by capability](docs/test-suite.md). The catalog
sync check fails if a test file or test name changes without a matching
documentation update.

## Deeper documentation

- [Test suite catalog](docs/test-suite.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Source provenance](PROVENANCE.md)
- [Changelog](CHANGELOG.md)

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
