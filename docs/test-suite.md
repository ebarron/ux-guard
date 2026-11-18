# Test suite catalog

ux-guard has exactly 100 generic tests. This catalog was built from the test
names discovered by Node's test runner, not from a feature checklist. Run
`npm test` to execute them and `npm run check:test-catalog` to verify that this
page still matches the test files and names.

The tests use synthetic, consumer-neutral fixtures. A passing test suite proves
the behaviors below; it does not certify the UX quality of a consumer
application.

## `test/authoritative.test.mjs` (1 test)

- `trusted authoritative regeneration owns aggregation, policy, and verdicts` — Proves trusted regeneration derives the final advisory bundle from trusted policy and raw shards instead of accepting a candidate-authored verdict.

## `test/baselines.test.mjs` (7 tests)

- `baseline v1 is canonical, strict, hash-bound, and separates candidate from review` — Proves baseline serialization is deterministic, validates its schema and hashes, and keeps an unreviewed candidate distinct from approval.
- `baseline validation rejects unsafe paths, duplicate artifacts, and malformed approval` — Proves malformed provenance, repeated artifacts, unsafe paths, and invalid review metadata fail closed.
- `synthetic metric changes require reviewed per-metric tolerances` — Proves each interaction metric is compared only with its explicitly reviewed tolerance.
- `coverage, lifecycle, new findings, and severity cannot be offset by improvements` — Proves an improvement in one area cannot hide missing coverage, lifecycle failures, new findings, or worse severity elsewhere.
- `a known-bad baseline preserves defects as evidence without declaring them acceptable` — Proves recording current defects does not convert those defects into acceptable UX.
- `policy, schema, browser, and approval incompatibilities never become comparisons` — Proves incompatible evidence is reported as unavailable instead of being treated as a valid regression comparison.
- `owner target v2 validates desired requirements and metric policy separately from baseline tolerances` — Proves desired targets remain a distinct reviewed contract from current-state regression tolerances.

## `test/catalog.test.mjs` (4 tests)

- `reads navigation surfaces from nested object literals` — Proves catalog discovery recognizes navigation entries nested in source object literals.
- `reports navigation surfaces that no use case covers` — Proves a route missing from the use-case catalog is surfaced as unmapped.
- `accepts assistant starts and deep routes under a surface` — Proves assistant entry points and deeper routes can satisfy a catalogued surface mapping.
- `rejects malformed use cases` — Proves invalid catalog records fail validation instead of being partially accepted.

## `test/cli.test.mjs` (16 tests)

- `init, clean scan, canary, and check pass on a fresh repository` — Proves the pattern lifecycle initializes cleanly and the primary check works on a minimal configured repository.
- `growth fails the scan and update refuses it without explicit acceptance` — Proves new pattern values fail policy checks and cannot enter the baseline accidentally.
- `check JSON is one deterministic document with explicit result and exit semantics` — Proves machine output is stable and states both its finding status and process exit meaning.
- `check reports configured journey lifecycle and advisory verdicts in one JSON document` — Proves policy checks include journey coverage and advisory quality results without conflating them with enforcement.
- `missing journey measurements stay advisory and malformed reports fail closed` — Proves absent evidence is reported without a hard policy failure while invalid evidence is rejected.
- `advisory journey findings render JSON and Markdown without changing exit status` — Proves human and machine reports expose UX findings while preserving advisory exit behavior.
- `journey baseline lifecycle is unapproved, inspectable, no-overwrite, and explicitly promoted` — Proves a journey snapshot requires review, can be inspected, and cannot silently replace a reviewed baseline.
- `journey baseline lifecycle rejects traversal, symlinks, and malformed candidates` — Proves candidate baseline paths and contents cannot escape or bypass repository trust boundaries.
- `update removes stale entries without needing acceptance` — Proves obsolete pattern debt can be removed without authorizing new debt.
- `a complete inventory with an unmapped surface fails, and strict mode fails a partial one` — Proves catalog completeness and strict-mode mapping requirements produce enforceable findings.
- `missing policy, missing baseline, bad options, and unknown commands are errors` — Proves configuration and invocation mistakes return explicit CLI errors.
- `--base trusts committed policy while auditing working-tree source inputs` — Proves a check can use reviewed policy from a commit while evaluating candidate source from the working tree.
- `--base audits candidate catalogs and navigation without allowing policy downgrades` — Proves candidate mappings are evaluated while trusted catalog completeness cannot be weakened.
- `--base uses only the reviewed baseline from the trusted commit` — Proves working-tree edits cannot substitute candidate baselines or targets for reviewed ones.
- `policy paths cannot escape the repository` — Proves configured policy paths are constrained to repository-relative locations.
- `working-tree input symlinks cannot escape the repository` — Proves source scanning rejects symlinks that resolve outside the repository.

## `test/discovery.test.mjs` (5 tests)

- `discover audits a project without policy and emits review-only JSON candidates` — Proves first-run discovery inventories a project without requiring or installing policy.
- `discover text names the approval boundary and writes nothing` — Proves human output says observed usage is not approval and leaves the working tree unchanged.
- `discover rejects trusted-revision mode` — Proves discovery is explicitly a working-tree audit rather than a trusted-baseline operation.
- `candidate writing is explicit, unapproved, repository-local, and never overwrites` — Proves creating a review candidate is opt-in, local, visibly unapproved, and no-overwrite.
- `promotion requires recorded human review and regenerates the approved baseline` — Proves policy promotion requires approval metadata and rebuilds the baseline from reviewed configuration and current source.

## `test/hygiene.test.mjs` (1 test)

- `public-source hygiene rejects consumer and framework assumptions` — Proves the public package remains generic and excludes consumer-specific identifiers, private links, and fixed framework assumptions.

## `test/journey-policy.test.mjs` (7 tests)

- `readiness requires every reviewed required variant, not only the canonical journey` — Proves readiness includes all required variants instead of relying on one happy path.
- `all required variants must be approved, bound, measured, and successful` — Proves enforcement readiness requires complete ownership, automation, measurement, and successful execution.
- `complete successful required coverage is enforcement-ready and round-trips` — Proves a fully reviewed policy serializes deterministically and can reach ready state.
- `failed, skipped, unexecutable, and infrastructure-error required variants differ` — Proves distinct completion failures retain their separate operational meanings.
- `unknown rule types and malformed lifecycle declarations fail closed` — Proves unsupported rules and invalid lifecycle data cannot enter policy.
- `old policy versions produce explicit migration errors` — Proves obsolete policy schemas receive an actionable version error.
- `policy serialization is deterministic and records typed rules` — Proves reviewed journey policy has stable output with explicit rule types.

## `test/journeys.test.mjs` (11 tests)

- `records deterministic metrics and typed observations with an injected clock` — Proves journey recording is reproducible and observations retain their declared types.
- `standard measurements are always present and explicit metrics stay opt-in` — Proves core interaction counts are universal while optional measurements require policy selection.
- `wall-clock elapsed data is explicitly non-deterministic report-only metadata` — Proves elapsed time cannot masquerade as deterministic policy evidence.
- `normalizes findings and evidence once and uses references from journeys` — Proves shared evidence is stored once and linked instead of copied inconsistently.
- `serializes deterministically and round-trips the explicit v5 schema` — Proves journey reports have stable serialization and strict current-schema parsing.
- `rejects old report versions with an actionable migration error` — Proves stale report contracts are rejected with upgrade guidance.
- `failed assertion, skipped, unavailable-path, and infrastructure statuses stay distinct` — Proves product failures, omissions, unavailable workflows, and runner failures are not collapsed together.
- `bindings cannot inject findings, verdicts, severity, or recommendations` — Proves measurement adapters cannot author the human-facing judgment they are meant to inform.
- `unknown observations and malformed normalized references fail closed` — Proves unsupported evidence and broken references are rejected.
- `aggregates metrics and compares data without manufacturing a regression verdict` — Proves numerical aggregation remains separate from regression classification.
- `report tampering cannot change completion counts or measured aggregates` — Proves derived completion and metric summaries are recalculated rather than trusted from input.

## `test/patterns.test.mjs` (4 tests)

- `records control values only for configured components from the configured module` — Proves pattern inventory ignores lookalike controls outside the reviewed component source.
- `counts each debt rule` — Proves inline styles, hard-coded colors, pixel literals, native controls, and icon-library use are counted independently.
- `compare blocks new control values and per-file debt growth, and reports stale entries` — Proves policy comparison catches new variation and debt while identifying removable baseline entries.
- `baselines are deterministic and malformed baselines fail closed` — Proves pattern snapshots serialize stably and invalid snapshots are rejected.

## `test/playwright.test.mjs` (8 tests)

- `optional Playwright adapter flushes independent browser counts into a step` — Proves browser-observed interaction counts are captured separately and committed to the active journey step.
- `adapter ignores child frames, stops route capture on dispose, and rejects bad events` — Proves frame noise, post-disposal events, and malformed browser messages cannot contaminate measurements.
- `adapter retries a flush that races with main-frame navigation` — Proves navigation timing does not silently lose pending interaction counts.
- `adapter requires a Page-compatible object and a safe binding name` — Proves invalid browser objects and unsafe exposed-function names are rejected.
- `visual capture derives generic font readiness from the reviewed profile` — Proves screenshot readiness uses fonts declared by the reviewed visual profile.
- `visual capture rejects an unreviewed viewport` — Proves screenshots cannot be accepted under dimensions outside the reviewed profile.
- `visual capture rejects an unreviewed browser version` — Proves browser identity must match the reviewed visual profile.
- `visual capture requires every reviewed mask to match` — Proves visual masks are valid only when every reviewed selector resolves.

## `test/run-contract.test.mjs` (5 tests)

- `policy digests use canonicalized content and Node cryptographic hashes` — Proves equivalent policy content has a stable cryptographic identity.
- `run envelope records provenance, versions, profile, completion, errors, and hashes` — Proves every evidence run carries the context needed for later trust decisions.
- `unexecutable product paths are completion evidence, not infrastructure errors` — Proves an unavailable user workflow is distinguished from runner failure.
- `tampered completion, traversal artifacts, and bad digests fail closed` — Proves altered summaries, unsafe artifact paths, and invalid hashes are rejected.
- `completion result is derived rather than journey-authored` — Proves the final run result is computed from evidence rather than accepted from a producer.

## `test/shards.test.mjs` (8 tests)

- `immutable per-test shards aggregate deterministically independent of file order` — Proves parallel evidence fragments produce one stable aggregate regardless of directory order.
- `aggregation records a consumer-neutral default artifact path` — Proves aggregate provenance uses a generic default location rather than a product-specific path.
- `parallel shard paths are safe and collision-resistant from policy ids` — Proves policy identifiers become repository-safe shard names without collisions.
- `immutable writes reject duplicate expected shard output` — Proves a test cannot silently overwrite another evidence fragment.
- `aggregation fails closed on missing, malformed, and unstable shards` — Proves incomplete, invalid, or changing evidence directories are rejected.
- `aggregation rejects symlinks and filename/content mismatches` — Proves shard identity cannot be redirected or mislabeled through filesystem tricks.
- `corruption canary detects a duplicate shard id under another path` — Proves duplicate logical evidence is detected even when stored under a different filename.
- `aggregation distinguishes forged run identity from a tool or policy upgrade` — Proves tampering is reported separately from a legitimate contract-version mismatch.

## `test/targets.test.mjs` (6 tests)

- `target attainment evaluates hard floors and strict at-most metrics` — Proves owner requirements and interaction ceilings are evaluated with their declared strictness.
- `at-most score is 100 when met, proportional when breached, and zero for a breached zero target` — Proves score arithmetic handles success, proportional overage, and zero-limit breaches deterministically.
- `journey and use-case scores use non-compensating minimum aggregation` — Proves a strong metric cannot hide a weaker one in rolled-up scores.
- `partial and absent target coverage remain explicit without a global score` — Proves incomplete target definitions do not produce a misleading overall number.
- `unexecutable and unmeasured target journeys are not scored` — Proves missing evidence does not become a fabricated low or high score.
- `target breaches render independently with actionable recommendations` — Proves target failures remain separate from quality findings and receive specific remediation text.

## `test/verdicts.test.mjs` (9 tests)

- `policy-evaluated observations change verdicts and emit one recommendation` — Proves reviewed rules, not raw adapters, determine quality verdicts and recommendations.
- `shared cross-variant findings render once with per-variant evidence` — Proves repeated issues are deduplicated while preserving each affected journey variant.
- `missing and unexecutable required variants stay incomplete, not unmeasured success` — Proves absent required workflows cannot be interpreted as a clean UX result.
- `normalized output uses references rather than repeated findings` — Proves report structure links normalized evidence consistently.
- `Markdown orders run errors, incomplete, needs improvement, then acceptable` — Proves human reports prioritize the most urgent and least complete results.
- `JSON and Markdown preserve no-score and advisory semantics` — Proves both formats avoid implying enforcement or a score when neither exists.
- `pattern growth is regression evidence without changing the quality verdict` — Proves code-pattern backslide is reported independently from human UX quality judgment.
- `human wording separates quality, unknown evidence, and recommendations` — Proves report language distinguishes observed quality, evidence gaps, and proposed action.
- `unknown references and old report versions fail closed` — Proves broken links and obsolete report contracts cannot render as trusted advice.

## `test/visuals.test.mjs` (5 tests)

- `strict visual profiles and checkpoint policies are canonical and versioned` — Proves visual capture settings and checkpoint rules are explicit, stable contracts.
- `manifest validation fails closed for missing checkpoints and profile mismatch` — Proves incomplete evidence and captures from the wrong profile are rejected.
- `image path, symlink, hash, and dimensions are validated` — Proves screenshot files are repository-local regular files with expected content and geometry.
- `candidate write and owner promotion never overwrite artifacts` — Proves visual evidence promotion preserves review history and refuses silent replacement.
- `comparison reports individual changes without aggregate masking` — Proves each checkpoint change remains visible instead of disappearing into one aggregate number.

## `test/yaml.test.mjs` (3 tests)

- `parses mappings, nested list mappings, and quoted text` — Proves the supported catalog YAML subset handles its required structural forms.
- `ignores comments outside quotes and keeps hashes inside quotes` — Proves comment parsing does not corrupt quoted values containing hash characters.
- `rejects input outside the supported subset` — Proves unsupported YAML constructs fail explicitly instead of being misread.
