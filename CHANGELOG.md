# Changelog

All notable changes use the structure from Keep a Changelog. Compatibility is
not guaranteed before 1.0.

## [Unreleased]

### Added

- Added `ux-guard review`, a local use-case review app bound to `127.0.0.1`
  with no external assets or telemetry. Owners approve, revise, reject, merge,
  split, or add use cases, map every surface and workflow to a use case or an
  explicit exclusion, see unresolved decisions and coverage totals, and
  preview the exact catalog diff. Saving records an unapproved review.
- Added `ux-guard review prepare`, which validates an assessment draft and
  stamps an unapproved candidate with repository and source identity so stale
  candidates are detected.
- Added `ux-guard review adopt`, the separate owner command that writes the
  catalog from a saved, current, conflict-free review with recorded approval
  and an exact-hash replacement guard. It leaves configuration, inventory,
  baselines, targets, waivers, and enforcement unchanged.
- Added use-case review guidance and prompts to the bundled skill,
  `docs/use-case-review.md`, and `docs/use-case-review-design.md`.
- Added 36 tests for the review model, storage safety, local-server security,
  CLI, and keyboard and labelling behavior.

## [0.6.1] - 2026-11-18

### Changed

- Setup keeps the Good, Needs attention, and Unknown sections, then ends with
  ordered next steps tailored to actual catalog, baseline, and pattern findings.
- The supporting setup review file is explained only where policy and baseline
  decisions need it; no policy, baseline, waiver, or enforcement is activated.
- The README terminal transcript is verified against actual CLI output. Public
  schema versions are unchanged.
- Restored the detailed adoption overview and added linked scoring/backslide
  guidance covering formulas, trusted-base detection, advisory results, and
  consumer-owned CI enforcement. Scoring and enforcement behavior is unchanged.

### Distribution

- First permanent OIDC-only release through `.github/workflows/release.yml` and
  the protected `npm` environment, validating tokenless trusted publishing.
- Supersedes the `0.6.0` bootstrap artifact.

## [0.6.0] - 2026-11-17

### Added

- Added the safe `setup` first-run command with human and JSON results,
  no-overwrite supporting review files, and explicit approval boundaries.
- Added the distributable `skills/ux-guard` project skill.
- Fresh public-source extraction of the generic CLI, library modules, and 100
  generic tests.
- Eleven explicit module subpath exports and the `ux-guard` executable.
- Deterministic journey, evidence, visual, baseline, target, and advisory
  report contracts.
- Public-source hygiene, package-boundary verification, install smoke testing,
  multi-platform compatibility testing, and code scanning.

### Changed

- Reframed primary help and documentation around setup, daily checks, and
  human-readable reports while retaining advanced v0.6 interfaces.
- Expanded package, install, and test-catalog validation for onboarding.

### Documentation

- Reworked the README around outcomes, one first-results flow, result
  interpretation, and daily use.
- Expanded the synchronized catalog to describe all 111 generic tests.

### Distribution

- Releases use the protected `npm` environment and npm OIDC trusted publishing
  with provenance; no long-lived npm publish token is stored.
- The immutable GitHub release carries the exact npm tarball, SHA-256 checksums,
  a CycloneDX SBOM, package manifest, and GitHub/Sigstore attestations.

[Unreleased]: https://github.com/ebarron/ux-guard/commits/main
[0.6.1]: https://github.com/ebarron/ux-guard/releases/tag/v0.6.1
[0.6.0]: https://github.com/ebarron/ux-guard/releases/tag/v0.6.0
