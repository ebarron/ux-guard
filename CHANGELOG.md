# Changelog

All notable changes use the structure from Keep a Changelog. Compatibility is
not guaranteed before 1.0.

## [Unreleased]

## [0.6.1] - 2026-11-18

### Changed

- No functional CLI or schema changes.

### Distribution

- First permanent OIDC-only release through `.github/workflows/release.yml` and
  the protected `npm` environment, validating tokenless trusted publishing.
- Supersedes the `0.6.0` bootstrap artifact.

## [0.6.0] - 2026-11-17

### Added

- Added the safe `setup` first-run command with human and JSON results,
  no-overwrite setup proposals, and explicit approval boundaries.
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
