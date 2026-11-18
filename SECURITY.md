# Security Policy

## Supported versions

Published `0.6.x` npm releases receive security fixes until a newer supported
minor release is available. Before publication, fixes target the latest commit
on `main`.

## Reporting

Use GitHub private vulnerability reporting for `ebarron/ux-guard`. Do not open
a public issue for an unpatched vulnerability. Include affected commits,
reproduction steps, impact, and any suggested mitigation.

You should receive an acknowledgement within seven days. No bounty or response
time is guaranteed.

## Security model

The CLI reads repository files and may invoke local Git. It does not need a
network service, send telemetry, or provide a privileged browser runner.
Configuration, evidence, repository files, and candidate artifacts are
untrusted input.

Reports can contain repository paths and source-derived names. Treat generated
output according to the consumer repository's sensitivity. Consumers should
install the public npm package and verify its registry provenance and GitHub
release checksums and attestations.
