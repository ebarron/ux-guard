# ux-guard

`ux-guard` is a generic Node 22 package for deterministic UX policy checks,
journey evidence contracts, strict visual profile/manifest lifecycles, trusted
evidence validation, and advisory verdict reports. It contains no
consumer-specific paths, products, or framework assumptions.

The package owns schemas, validation, aggregation, comparison, rendering, and
optional structural browser bindings. A consumer owns its catalog, policy,
baselines, browser harness, framework readiness, artifact locations, and CI
materialization. `authoritative` accepts raw shards only, reconstructs the
expected run identity from trusted inputs, and emits one advisory bundle; it
does not accept a candidate verdict.

TypeScript is an exact package dependency, not a consumer-configured executable
path. The repository lock integrity-pins it, and trusted CI installs with npm
lifecycle scripts disabled.

## Distribution state

Version `0.6.0` remains an embedded, private package. It has not been published,
tagged, or released, and its planned public repository has not been created.
After the host preparation change merges, the first external distribution step
is public source and CI under `ebarron/ux-guard`; package publication remains a
separate later decision.

## Extraction boundary

The future public source consists of this directory's `bin/`, `lib/`, `test/`,
and `scripts/` trees plus its package metadata, lock, README, license, and
notice. The following stay consumer-owned and outside the extracted source:

- configuration, catalogs, policies, targets, reviewed baselines, and images;
- end-to-end journeys, browser startup, framework styling/readiness, and
  consumer artifact paths;
- trusted-runner isolation, repository workflows, and repository assertions.

The embedded consumer tests exercise those outside-the-package responsibilities
without making them public package fixtures. This preparation does not change
schemas, exported module paths, the tool version, or enforcement decisions.

Trust limitations: browser bindings can fabricate measurements unless they run
inside a stronger sandbox. Trusted aggregation prevents candidate code from
choosing policy or the final report; it does not establish that untrusted
measurements reflect real user behavior.

Visual v1 keeps images outside the compact verdict report. A consumer supplies
strict canonical profile and checkpoint policy files, while the package
validates image paths, regular-file type, symlink boundaries, hashes,
dimensions, profile identity, exact per-checkpoint tolerances, and reviewed
masks. Candidate bundles are explicitly unapproved and no-overwrite.
`visual inspect`, `visual diff`, and `visual promote` implement owner review;
`visual canary` proves one-pixel-class, missing-checkpoint, profile-mismatch,
and fail-closed behavior. With no reviewed baseline, comparison is
`not-evaluated` and advisory.

Owner targets v2 keep desired policy separate from current-state baselines.
They explicitly classify each interaction metric as non-regressing after a
reviewed comparison source exists or report-only until calibrated, and their
hard floors independently bound successful, unexecutable, failed, skipped,
infrastructure-error, and critical-finding counts.

Target attainment v1 evaluates every configured hard floor and per-journey
metric target. Numerical score v1 is owner-target-backed only: an at-most
target scores 100 when attained, otherwise `round(100 * target / actual)`,
with a breached zero target scoring 0. Journey and use-case aggregation use
the minimum so stronger metrics cannot compensate for the weakest configured
metric or scored required journey. Unmeasured and unexecutable journeys are
not scored, partial target coverage stays explicit, and no product-wide scalar
is emitted. Quality, target attainment, regression/backslide, numerical
scores, and recommendations are separate verdict-report v6 sections.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
