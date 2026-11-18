# Scoring and backslide protection

This page defines what ux-guard scores, what it compares, and which results can
affect a command exit code. Quality, target attainment, regression, and
numerical scores are separate signals.

## Where scoring appears

After reviewed policy and journey evidence are configured, run:

```sh
npx ux-guard report
npx ux-guard report --base origin/main
```

The Markdown report has separate **Quality verdict**, **Target attainment**,
**Regression and backslide**, and **Numerical scores** sections. JSON keeps the
same meanings in separate `quality`, `targetAttainment`, `regression`, and
`scoring` fields.

The trusted-base form loads reviewed policy, owner targets, and comparison
baselines from the resolved `origin/main` commit while evaluating candidate
source and evidence. A candidate cannot replace those reviewed inputs with
more favorable policy or baselines.

## How scores are created

Numerical scores require explicit, reviewed, product-owned metric targets.
Historical baselines do not produce scores. Only an `at-most` target has an
approved numerical formula:

- If `actual <= target`, the metric score is 100.
- If `actual > target`, the score is
  `round(100 * target / actual)`.
- If a zero target is breached, the score is 0.

For example, if a workflow should edit at most 3 fields and actually edits 4,
its metric score is `round(100 * 3 / 4)`, or 75. That score means the reviewed
interaction target was missed. It does not change or summarize the independent
quality verdict.

The aggregation is deliberately non-compensating:

- A journey score is the minimum of its scoreable configured metric scores.
- A use-case score is the minimum of its scored required journey scores.
- A missing, unexecutable, unsuccessful, or unmeasured journey is not scored.
- An `at-least` or `exactly` target is evaluated for attainment but is not
  numerically scored.
- Partial score coverage stays `partially-scored`; absent coverage stays
  `not-scored`.
- There is no product-wide scalar score.

## What backslide detection compares

Reviewed comparison evidence can detect each signal independently:

- a metric increase beyond its explicitly reviewed tolerance;
- lifecycle degradation, missing required journeys, or reduced measured and
  successful coverage;
- newly introduced findings or increased finding severity;
- breaches of reviewed hard floors for evidence, completion, failures, skips,
  infrastructure errors, or critical findings;
- growth in static control values or pattern debt beyond the reviewed
  non-growth baseline;
- visual manifest, browser profile, checkpoint, image hash, image dimension,
  or related reviewed visual-contract drift.

Baseline equality means only that comparable evidence did not backslide. It
does not declare the UX good or make known defects acceptable.

## Detection versus merge prevention

ux-guard defaults to detection and advisory reporting:

- `report` exits 0 whenever it renders successfully, including when it reports
  a quality problem, target breach, or regression. Invalid or unavailable
  required configuration or evidence exits 2.
- `check` exits 0 when there is no enforceable catalog or static-pattern
  finding, 1 when those findings exist, and 2 for configuration, evidence, or
  execution failure.
- Journey, target, regression, score, and visual sections remain advisory
  unless the consumer adopts a separate, reviewed enforcement decision.

A merge is prevented only when the consumer runs a pinned, trusted ux-guard
configuration in CI and makes that check required. Requiring `report` alone
does not block advisory backslide because a successful report returns 0.
Consumers that choose to enforce advisory signals need a trusted classifier or
wrapper with an explicit reviewed failure policy.

Useful Agent Skill prompts:

> Show me where ux-guard scoring comes from and explain every score

> Compare this branch with origin/main and explain every backslide signal; do
> not change policy or baselines

See the [CLI reference](cli-reference.md#scoring-and-backslide-protection) for
commands and exit behavior.
