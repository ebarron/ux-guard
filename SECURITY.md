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

The CLI reads repository files and may invoke local Git. It does not send
telemetry or provide a privileged browser runner. Configuration, evidence,
repository files, and candidate artifacts are untrusted input.

`ux-guard review` is the only command that listens on a socket. It binds to
`127.0.0.1` on an ephemeral port for the life of the review and serves only
its bundled page, script, and stylesheet. API requests require a per-session
token delivered in the printed link's URL fragment, a loopback `Host` header
(rejecting DNS rebinding), a same-origin JSON request, and a bounded body.
Responses set a restrictive content security policy and forbid framing,
caching, and content sniffing. The app can save only unapproved review
artifacts; changing the active catalog requires the separate `review adopt`
command. Treat the printed link like a password for the session.

Reports can contain repository paths and source-derived names. Treat generated
output according to the consumer repository's sensitivity. Consumers should
install the public npm package and verify its registry provenance and GitHub
release checksums and attestations.
