# ux-guard CLI reference

The primary workflow is:

```sh
ux-guard setup
ux-guard check
ux-guard report
```

Use `ux-guard --help` or command-specific `--help` for current options. Setup
and proposal writes are repository-local, reject traversal and symbolic-link
escapes, and never overwrite existing review work.

## Primary commands

### `setup`

Inspects non-test JSX and TSX source, reports good observations, potential
problems, and unknowns, then writes an unapproved setup proposal to
`ux-guard/setup-proposal.json`.

Options:

- `--proposal <path>` selects another repository-relative path.
- `--format json` emits one deterministic automation document.
- `--typescript <path>` selects an explicit TypeScript package for unusual
  workspaces.

Setup does not create `.uxguard.json`, a baseline, a waiver, or enforcement. An
existing proposal or active policy is never overwritten.

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

## Advanced policy lifecycle

These commands support maintainers and agents that need to inspect or activate
reviewed policy. They are not required for first results.

- `discover` performs read-only convention discovery.
- `discover write-candidate --candidate <path>` preserves the original v0.6
  unapproved policy-artifact interface.
- `discover promote --candidate <path>` accepts either that original artifact
  or a `setup` proposal. It requires recorded human review and creates policy
  plus a freshly generated pattern baseline without overwriting either.
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
