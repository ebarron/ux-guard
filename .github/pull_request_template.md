## Summary

Describe the change and its compatibility impact.

## Verification

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run check:hygiene`
- [ ] `npm run check:package`
- [ ] `npm test`
- [ ] `npm pack --dry-run --ignore-scripts`
- [ ] `npm run test:install`

## Contract changes

- [ ] Package version, exported paths, and schema versions are unchanged.
- [ ] Any intentional contract change is documented in `CHANGELOG.md` and has
      migration and failure-path tests.
- [ ] No consumer-specific policy, evidence, browser runner, or configuration
      is included.
