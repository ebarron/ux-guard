# ux-guard CLI reference

[Primary commands](#primary-commands) ·
[Scoring and backslide protection](#scoring-and-backslide-protection) ·
[Advanced policy lifecycle](#advanced-policy-lifecycle)

The primary workflow is:

```sh
ux-guard setup
ux-guard check
ux-guard report
```

Use `ux-guard --help` or command-specific `--help` for current options. Setup
supporting-file writes are repository-local, reject traversal and symbolic-link
escapes, and never overwrite existing review work.

## Primary commands

### `setup`

Inspects non-test JSX and TSX source, reports good observations, potential
problems, and unknowns, then ends with ordered next steps tailored to those
findings. The policy-and-baseline review step explains the supporting review
file, which records observed source roots, components, pattern counts, and
unresolved choices without approving them. The file also records observed icon
usage when present.

Options:

- `--proposal <path>` selects the repository-relative supporting review file.
- `--format json` emits one deterministic automation document.
- `--typescript <path>` selects an explicit TypeScript package for unusual
  workspaces.

Setup does not create `.uxguard.json`, a baseline, a waiver, or enforcement. An
existing supporting review file or active policy is never overwritten.

### `check`

Validates the configured use-case catalog and compares current source patterns
with reviewed policy.

- Exit `0`: no enforceable catalog or pattern finding.
- Exit `1`: enforceable findings are present.
- Exit `2`: configuration, evidence, or execution failed.

Journey and visual sections remain advisory unless the repository adopts a
separate reviewed enforcement decision.

### `report`

Renders configured journey quality, evidence gaps, target attainment,
regression, scores where supported, and recommendations. Use `--format
markdown` for a review document or `--format json` for another renderer.

`report` requires configured journey policy. Missing or unexecutable evidence
stays visible as incomplete or unavailable.

### Trusted-base comparisons

`check --base <ref>` and `report --base <ref>` load reviewed policy, targets,
and baselines from the resolved commit while auditing current source and
evidence. A missing or invalid base is an error, never a clean result.

## Scoring and backslide protection

[Detailed formulas, comparison signals, and trust boundaries](scoring-and-backslide.md)

### Where scoring appears and how to get it

After reviewed policy is active, `npx ux-guard report` and
`npx ux-guard report --base origin/main` render quality, target attainment,
regression/backslide, and numerical scores as separate outputs. The trusted
base form loads reviewed main policy and baselines, so candidate code cannot
redefine its judge.

A numerical score exists only when explicit, reviewed, product-owned metric
targets are configured. An `at-most` metric scores 100 when met and otherwise
scores `round(100 * target / actual)`; a breached zero target scores 0. Thus a
target of at most 3 edited fields with an actual value of 4 scores 75. Score 75
describes target performance, not the independent quality verdict.

A journey uses its weakest scoreable configured metric. A use case uses the
minimum across its scored required journeys. Missing, unexecutable, or
unmeasured evidence is not scored and stays partial or not-scored. ux-guard
does not emit a product-wide scalar.

### How backslide is detected and enforced

Trusted comparisons detect reviewed-tolerance metric increases, lifecycle
degradation and missing journeys, new findings and severity increases,
hard-floor breaches, static pattern-debt growth, and visual manifest, profile,
hash, or dimension drift.

Detection is advisory by default. `report` returns 0 after a successful render
even when it reports regression or a target breach; it does not block a merge.
`check` returns 1 for enforceable catalog or static-pattern findings and 2 for
configuration, evidence, or execution failure. Journey, target, regression,
score, and visual results need a separate reviewed enforcement decision to
fail CI. Merge prevention occurs only when a consumer configures trusted
ux-guard execution as a required CI check; making `report` alone required does
not convert advisory signals into failures.

## Advanced policy lifecycle

These commands support maintainers and agents that need to inspect or activate
reviewed policy. They are not required for first results.

- `discover` performs read-only convention discovery.
- `discover write-candidate --candidate <path>` preserves the original v0.6
  unapproved policy-artifact interface.
- `discover promote --candidate <path>` accepts either that original artifact
  or the supporting review file written by `setup`. It requires recorded human
  review and creates policy plus a freshly generated pattern baseline without
  overwriting either.
- `patterns init`, `patterns scan`, and `patterns update` manage the pattern
  snapshot. Growth requires `--accept-growth`.
- `baseline propose`, `baseline inspect`, `baseline diff`, and `baseline
  promote` manage reviewed journey comparison evidence.
- `visual inspect`, `visual diff`, and `visual promote` manage reviewed visual
  evidence.
- `authoritative --format json` regenerates trusted advisory output from raw
  shards and trusted policy. Candidate-authored verdicts are not accepted.

Promotion is not proof that current UX is good. It records an explicit human
decision about policy or comparison evidence.

## Contributor canaries

The following commands test ux-guard's own failure detection. They do not audit
the consumer repository:

```sh
ux-guard patterns canary
ux-guard baseline canary
ux-guard visual canary
```

## Other options

Run `ux-guard help advanced` for the complete advanced option list, including
trusted aggregation identity, browser profile, review metadata, and explicit
artifact paths.
