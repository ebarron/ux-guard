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

