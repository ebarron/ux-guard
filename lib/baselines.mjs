import {
  JOURNEY_METRICS,
  validateJourneyReport,
} from './journeys.mjs';
import {
  canonicalJson,
  canonicalize,
  policyDigest,
  sha256,
} from './run-contract.mjs';

export const JOURNEY_BASELINE_KIND = 'ux-guard-journey-baseline';
export const JOURNEY_BASELINE_VERSION = 1;
export const JOURNEY_COMPARISON_KIND = 'ux-guard-journey-comparison';
export const JOURNEY_COMPARISON_VERSION = 2;

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const APPROVAL_STATUSES = new Set(['candidate', 'reviewed']);
const EXECUTION_STATUSES = new Set([
  'successful',
  'failed',
  'skipped',
  'unexecutable',
  'infrastructure-error',
]);
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const COMPARISON_STATUSES = new Set([
  'regression',
  'improvement',
  'unchanged',
  'incompatible',
  'unavailable',
]);
const CHANGE_STATUSES = new Set([
  'regression',
  'improvement',
  'unchanged',
  'unavailable',
]);
const CANARY_STATUSES = new Set(['passed', 'not-recorded']);
const STATUS_RANK = new Map([
  ['infrastructure-error', 0],
  ['failed', 1],
  ['skipped', 2],
  ['unexecutable', 3],
  ['successful', 4],
]);
const SEVERITY_RANK = new Map([
  ['low', 0],
  ['medium', 1],
  ['high', 2],
  ['critical', 3],
]);

export const JOURNEY_BASELINE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:journey-baseline:v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'canonicalHash',
    'approval',
    'provenance',
    'policy',
    'runProfile',
    'tool',
    'coverage',
    'journeys',
    'findings',
    'tolerances',
    'hardFloors',
    'sourceArtifacts',
    'visualManifestRefs',
    'readinessEvidence',
  ],
  properties: {
    kind: { const: JOURNEY_BASELINE_KIND },
    version: { const: JOURNEY_BASELINE_VERSION },
    canonicalHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    approval: { type: 'object', additionalProperties: false },
    provenance: { type: 'object', additionalProperties: false },
    policy: { type: 'object', additionalProperties: false },
    runProfile: { type: 'object', additionalProperties: false },
    tool: { type: 'object', additionalProperties: false },
    coverage: { type: 'object', additionalProperties: false },
    journeys: { type: 'array' },
    findings: { type: 'array' },
    tolerances: { type: 'array' },
    hardFloors: { type: 'object', additionalProperties: false },
    sourceArtifacts: { type: 'array' },
    visualManifestRefs: { type: 'array' },
    readinessEvidence: { type: 'object', additionalProperties: false },
  },
});

export const JOURNEY_COMPARISON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:journey-comparison:v2',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'advisory',
    'trust',
    'status',
    'reason',
    'baselineHash',
    'compatibility',
    'completeness',
    'summary',
    'hardFloors',
    'journeys',
  ],
  properties: {
    kind: { const: JOURNEY_COMPARISON_KIND },
    version: { const: JOURNEY_COMPARISON_VERSION },
    advisory: { const: true },
    trust: { type: 'object', additionalProperties: false },
    status: { enum: [...COMPARISON_STATUSES] },
    reason: { type: 'string' },
    baselineHash: { type: ['string', 'null'] },
    compatibility: { type: 'object', additionalProperties: false },
    completeness: { type: 'object', additionalProperties: false },
    summary: { type: 'object', additionalProperties: false },
    hardFloors: { type: 'array' },
    journeys: { type: 'array' },
  },
});

export class JourneyBaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyBaselineError';
  }
}

export function createJourneyBaselineCandidate({
  report,
  policy,
  reportPath,
  reportSha256,
  canaries = defaultCanaries(),
} = {}) {
  validateJourneyReport(report);
  assertSafeRelativePath(reportPath, 'reportPath');
  assertHash(reportSha256, 'reportSha256');
  if (report.run.policy.digest !== policyDigest(policy)) {
    throw new JourneyBaselineError('source report policy digest does not match policy');
  }
  if (
    report.run.completion.status !== 'completed' ||
    report.run.completion.received !== report.run.completion.expected ||
    report.run.completion.result !== 'successful'
  ) {
    throw new JourneyBaselineError(
      'baseline candidates require a completed report without assertion, skip, or infrastructure failures',
    );
  }
  if (report.run.browser.name === 'none' || report.run.browser.profile === 'not-run') {
    throw new JourneyBaselineError('baseline candidates require a real deterministic run profile');
  }
  if (
    report.journeys.some(
      (journey) => journey.timing && journey.timing.deterministic !== true,
    )
  ) {
    throw new JourneyBaselineError('baseline candidates cannot contain wall-clock measurements');
  }
  if (report.run.artifacts.length === 0) {
    throw new JourneyBaselineError('baseline candidates require hashed source artifacts');
  }
  validateCanaries(canaries, 'canaries');

  const repetitions = parseRepetitions(report.run.adapters.repetitions);
  const coverage = snapshotCoverage(report);
  const candidate = {
    kind: JOURNEY_BASELINE_KIND,
    version: JOURNEY_BASELINE_VERSION,
    canonicalHash: '',
    approval: {
      status: 'candidate',
      reviewer: null,
      reviewedAt: null,
      rationale: null,
    },
    provenance: {
      candidateCommit: report.run.provenance.candidate.commit,
      baseCommit: report.run.provenance.base.commit,
      sourceReport: {
        path: reportPath,
        sha256: reportSha256,
      },
    },
    policy: structuredClone(report.run.policy),
    runProfile: {
      browser: structuredClone(report.run.browser),
      adapters: structuredClone(report.run.adapters),
      repetitions,
    },
    tool: structuredClone(report.run.tool),
    coverage,
    journeys: snapshotJourneys(report),
    findings: snapshotFindings(report),
    tolerances: [],
    hardFloors: {
      minimumMeasuredVariants: coverage.measuredVariants,
      minimumSuccessfulVariants: coverage.successfulVariants,
      maximumFailedVariants: coverage.statuses.failed,
      maximumSkippedVariants: coverage.statuses.skipped,
      maximumInfrastructureErrorVariants: coverage.statuses.infrastructureError,
      maximumCriticalFindings: report.findings.filter(
        (finding) => finding.severity === 'critical',
      ).length,
    },
    sourceArtifacts: [
      {
        id: 'journey-report',
        path: reportPath,
        sha256: reportSha256,
      },
      ...structuredClone(report.run.artifacts),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    visualManifestRefs: [],
    readinessEvidence: {
      deterministicRun: true,
      evidenceComplete: coverage.measuredVariants === coverage.requiredVariants,
      stableRepetitions: repetitions,
      canaries: structuredClone(canaries),
      trustedExecution: false,
      enforcementApproved: false,
    },
  };
  candidate.canonicalHash = journeyBaselineHash(candidate);
  return validateJourneyBaseline(candidate);
}

export function promoteJourneyBaseline(
  candidate,
  { reviewer, reviewedAt, rationale } = {},
) {
  validateJourneyBaseline(candidate);
  if (candidate.approval.status !== 'candidate') {
    throw new JourneyBaselineError('only an unapproved candidate can be promoted');
  }
  assertText(reviewer, 'reviewer');
  assertTimestamp(reviewedAt, 'reviewedAt');
  assertText(rationale, 'rationale');
  const reviewed = structuredClone(candidate);
  reviewed.approval = {
    status: 'reviewed',
    reviewer: reviewer.trim(),
    reviewedAt,
    rationale: rationale.trim(),
  };
  reviewed.canonicalHash = journeyBaselineHash(reviewed);
  return validateJourneyBaseline(reviewed);
}

export function validateJourneyBaseline(baseline) {
  assertMap(baseline, 'baseline');
  assertExactKeys(
    baseline,
    [
      'kind',
      'version',
      'canonicalHash',
      'approval',
      'provenance',
      'policy',
      'runProfile',
      'tool',
      'coverage',
      'journeys',
      'findings',
      'tolerances',
      'hardFloors',
      'sourceArtifacts',
      'visualManifestRefs',
      'readinessEvidence',
    ],
    'baseline',
  );
  if (
    baseline.kind !== JOURNEY_BASELINE_KIND ||
    baseline.version !== JOURNEY_BASELINE_VERSION
  ) {
    throw new JourneyBaselineError('baseline has an unsupported kind or version');
  }
  if (
    typeof baseline.canonicalHash !== 'string' ||
    !DIGEST.test(baseline.canonicalHash) ||
    baseline.canonicalHash !== journeyBaselineHash(baseline)
  ) {
    throw new JourneyBaselineError('baseline canonicalHash does not match canonical content');
  }
  validateApproval(baseline.approval);
  validateProvenance(baseline.provenance);
  validatePolicy(baseline.policy);
  validateRunProfile(baseline.runProfile);
  validateTool(baseline.tool);
  validateCoverage(baseline.coverage);
  validateJourneys(baseline.journeys);
  validateFindings(baseline.findings, new Set(baseline.journeys.map(({ journeyRef }) => journeyRef)));
  const findingIds = new Set(baseline.findings.map(({ id }) => id));
  for (const journey of baseline.journeys) {
    if (journey.findingRefs.some((findingRef) => !findingIds.has(findingRef))) {
      throw new JourneyBaselineError(
        `${journey.journeyRef} references an unknown baseline finding`,
      );
    }
  }
  validateTolerances(
    baseline.tolerances,
    new Map(baseline.journeys.map((journey) => [journey.journeyRef, journey])),
  );
  validateHardFloors(baseline.hardFloors);
  validateArtifacts(baseline.sourceArtifacts, 'baseline.sourceArtifacts');
  validateArtifacts(baseline.visualManifestRefs, 'baseline.visualManifestRefs', true);
  const artifactIds = [
    ...baseline.sourceArtifacts,
    ...baseline.visualManifestRefs,
  ].map(({ id }) => id);
  const artifactPaths = [
    ...baseline.sourceArtifacts,
    ...baseline.visualManifestRefs,
  ].map(({ path }) => path);
  if (
    new Set(artifactIds).size !== artifactIds.length ||
    new Set(artifactPaths).size !== artifactPaths.length
  ) {
    throw new JourneyBaselineError(
      'baseline source and visual artifacts must have unique ids and paths',
    );
  }
  validateReadinessEvidence(baseline.readinessEvidence);
  if (
    baseline.coverage.measuredVariants !== baseline.journeys.length ||
    baseline.coverage.successfulVariants !==
      baseline.journeys.filter(({ status }) => status === 'successful').length
  ) {
    throw new JourneyBaselineError('baseline coverage does not match journey snapshots');
  }
  const statusCounts = lifecycleCounts(baseline.journeys);
  for (const [field, value] of Object.entries(statusCounts)) {
    if (baseline.coverage.statuses[field] !== value) {
      throw new JourneyBaselineError('baseline lifecycle counts do not match journey snapshots');
    }
  }
  for (const finding of baseline.findings) {
    for (const journeyRef of finding.journeyRefs) {
      const journey = baseline.journeys.find((entry) => entry.journeyRef === journeyRef);
      if (!journey.findingRefs.includes(finding.id)) {
        throw new JourneyBaselineError(`${finding.id} is not referenced by ${journeyRef}`);
      }
    }
  }
  return baseline;
}

export function parseJourneyBaseline(text) {
  if (typeof text !== 'string') {
    throw new JourneyBaselineError('journey baseline must be JSON text');
  }
  let baseline;
  try {
    baseline = JSON.parse(text);
  } catch {
    throw new JourneyBaselineError('journey baseline is not valid JSON');
  }
  if (
    baseline?.kind === JOURNEY_BASELINE_KIND &&
    baseline.version !== JOURNEY_BASELINE_VERSION
  ) {
    throw new JourneyBaselineError(
      `unsupported journey baseline version ${String(baseline.version)}; migrate to version ${JOURNEY_BASELINE_VERSION}`,
    );
  }
  return validateJourneyBaseline(baseline);
}

export function serializeJourneyBaseline(baseline) {
  validateJourneyBaseline(baseline);
  return `${JSON.stringify(canonicalize(baseline), null, 2)}\n`;
}

export function journeyBaselineHash(baseline) {
  const content = structuredClone(baseline);
  delete content.canonicalHash;
  return `sha256:${sha256(content)}`;
}

export function compareJourneyBaseline({
  baseline,
  report,
  policy,
  trusted = false,
} = {}) {
  validateJourneyBaseline(baseline);
  validateJourneyReport(report);
  const compatibilityReasons = baselineCompatibilityReasons(
    baseline,
    report,
    policy,
    trusted,
  );
  if (compatibilityReasons.length) {
    return validateJourneyComparison(
      emptyComparison({
        status:
          baseline.approval.status === 'reviewed' && trusted
            ? 'incompatible'
            : 'unavailable',
        reason: compatibilityReasons.join('; '),
        baselineHash: baseline.canonicalHash,
        compatibilityReasons,
      }),
    );
  }

  const current = {
    coverage: snapshotCoverage(report),
    journeys: snapshotJourneys(report),
    findings: snapshotFindings(report),
  };
  const comparison = compareSnapshots(baseline, current);
  comparison.trust = {
    policy: 'trusted-base',
    execution: 'candidate-untrusted',
  };
  comparison.reason =
    comparison.status === 'regression'
      ? 'One or more independent journey, finding, metric, or hard-floor regressions were detected.'
      : comparison.status === 'improvement'
        ? comparison.completeness.status === 'complete'
          ? 'No evaluated regression was detected and at least one independent improvement was measured.'
          : 'At least one independent improvement was measured; some metric evidence remains not evaluated.'
        : comparison.status === 'unchanged'
          ? comparison.completeness.status === 'complete'
            ? 'All configured comparison evidence is unchanged.'
            : 'All evaluated comparison evidence is unchanged; some metric evidence remains not evaluated.'
          : 'Some metric evidence is not evaluated because a reviewed tolerance or comparable measurement is unavailable.';
  return validateJourneyComparison(comparison);
}

export function runJourneyComparisonCanaries() {
  const baseJourney = {
    journeyRef: 'journey.canary.primary',
    useCaseId: 'canary',
    journeyId: 'primary',
    status: 'successful',
    metrics: { clicks: 1 },
    findingRefs: [],
  };
  const baseline = {
    canonicalHash: `sha256:${'a'.repeat(64)}`,
    coverage: canaryCoverage('successful'),
    journeys: [baseJourney],
    findings: [],
    tolerances: [
      {
        journeyRef: baseJourney.journeyRef,
        metric: 'clicks',
        direction: 'lower-is-better',
        permittedRegression: 0,
      },
    ],
    hardFloors: {
      minimumMeasuredVariants: 1,
      minimumSuccessfulVariants: 1,
      maximumFailedVariants: 0,
      maximumSkippedVariants: 0,
      maximumInfrastructureErrorVariants: 0,
      maximumCriticalFindings: 0,
    },
  };
  const snapshot = (journey) => ({
    coverage: canaryCoverage(journey.status),
    journeys: [journey],
    findings: [],
  });
  const regression = compareSnapshots(baseline, snapshot({
    ...baseJourney,
    metrics: { clicks: 2 },
  }));
  const improvement = compareSnapshots(baseline, snapshot({
    ...baseJourney,
    metrics: { clicks: 0 },
  }));
  const unchanged = compareSnapshots(baseline, snapshot(baseJourney));
  const withoutTolerance = compareSnapshots(
    { ...baseline, tolerances: [] },
    snapshot({
      ...baseJourney,
      metrics: { clicks: 2 },
    }),
  );
  const knownBadJourney = {
    ...baseJourney,
    status: 'unexecutable',
    metrics: { clicks: 1 },
    findingRefs: ['finding.canary.known-bad'],
  };
  const knownBad = {
    ...baseline,
    coverage: canaryCoverage('unexecutable'),
    journeys: [knownBadJourney],
    findings: [
      {
        id: 'finding.canary.known-bad',
        ruleId: 'canary.known-bad',
        severity: 'high',
        dimension: 'clarity',
        type: 'requirement',
        journeyRefs: [knownBadJourney.journeyRef],
      },
    ],
    hardFloors: {
      ...baseline.hardFloors,
      minimumSuccessfulVariants: 0,
    },
  };
  const knownBadResult = compareSnapshots(knownBad, {
    coverage: canaryCoverage('unexecutable'),
    journeys: [knownBadJourney],
    findings: knownBad.findings,
  });
  const canaryPolicy = { canary: true };
  const profileBaseline = {
    approval: { status: 'reviewed' },
    policy: { digest: policyDigest(canaryPolicy) },
    tool: { name: 'ux-guard', version: 'canary', schemas: { canary: 1 } },
    runProfile: {
      browser: { name: 'chromium', profile: 'canary' },
      adapters: { canary: '1' },
    },
  };
  const profileReport = {
    run: {
      policy: { digest: policyDigest(canaryPolicy) },
      tool: { name: 'ux-guard', version: 'canary', schemas: { canary: 1 } },
      browser: { name: 'chromium', profile: 'different' },
      adapters: { canary: '1' },
    },
  };
  const compatibility = baselineCompatibilityReasons(
    profileBaseline,
    profileReport,
    canaryPolicy,
    true,
  );
  if (
    regression.status !== 'regression' ||
    improvement.status !== 'improvement' ||
    unchanged.status !== 'unchanged' ||
    withoutTolerance.status !== 'unavailable' ||
    withoutTolerance.journeys[0].metrics[0].status !== 'unavailable' ||
    knownBadResult.status !== 'unchanged' ||
    !compatibility.includes('browser profile differs from the reviewed baseline')
  ) {
    throw new JourneyBaselineError('synthetic journey comparison canary did not detect its known changes');
  }
  return {
    regression: 'passed',
    improvement: 'passed',
    compatibility: 'passed',
    knownBad: 'passed',
  };
}

export function compareJourneyBaselineEnvelopes(before, after) {
  validateJourneyBaseline(before);
  validateJourneyBaseline(after);
  const compatibilityReasons = [];
  if (before.policy.digest !== after.policy.digest) {
    compatibilityReasons.push('policy digest differs');
  }
  if (
    before.tool.name !== after.tool.name ||
    canonicalJson(comparisonCriticalSchemas(before.tool.schemas)) !==
      canonicalJson(comparisonCriticalSchemas(after.tool.schemas))
  ) {
    compatibilityReasons.push('tool or measurement schema versions differ');
  }
  if (
    canonicalJson(before.runProfile.browser) !==
      canonicalJson(after.runProfile.browser) ||
    canonicalJson(before.runProfile.adapters) !==
      canonicalJson(after.runProfile.adapters)
  ) {
    compatibilityReasons.push('run profile differs');
  }
  if (compatibilityReasons.length) {
    return validateJourneyComparison(
      emptyComparison({
        status: 'incompatible',
        reason: compatibilityReasons.join('; '),
        baselineHash: before.canonicalHash,
        compatibilityReasons,
      }),
    );
  }
  const comparison = compareSnapshots(before, after);
  comparison.trust = {
    policy: before.approval.status === 'reviewed' ? 'reviewed-artifact' : 'candidate',
    execution: 'artifact-diff',
  };
  comparison.reason =
    comparison.status === 'regression'
      ? 'The candidate snapshot contains one or more independent regressions.'
      : comparison.status === 'improvement'
        ? comparison.completeness.status === 'complete'
          ? 'The candidate snapshot contains improvements and no evaluated regressions.'
          : 'The candidate snapshot contains improvements while some metric evidence remains not evaluated.'
        : comparison.status === 'unchanged'
          ? comparison.completeness.status === 'complete'
            ? 'The candidate snapshot is unchanged for every configured comparison.'
            : 'All evaluated candidate comparison evidence is unchanged while some metric evidence remains not evaluated.'
          : 'Some candidate metric evidence is not evaluated because a reviewed tolerance or comparable measurement is unavailable.';
  return validateJourneyComparison(comparison);
}

export function unavailableJourneyComparison(reason) {
  assertText(reason, 'reason');
  return validateJourneyComparison(
    emptyComparison({
      status: 'unavailable',
      reason,
      baselineHash: null,
      compatibilityReasons: [],
    }),
  );
}

export function validateJourneyComparison(comparison) {
  assertMap(comparison, 'comparison');
  assertExactKeys(
    comparison,
    [
      'kind',
      'version',
      'advisory',
      'trust',
      'status',
      'reason',
      'baselineHash',
      'compatibility',
      'completeness',
      'summary',
      'hardFloors',
      'journeys',
    ],
    'comparison',
  );
  if (
    comparison.kind !== JOURNEY_COMPARISON_KIND ||
    comparison.version !== JOURNEY_COMPARISON_VERSION ||
    comparison.advisory !== true
  ) {
    throw new JourneyBaselineError('comparison has an unsupported contract');
  }
  assertMap(comparison.trust, 'comparison.trust');
  assertExactKeys(comparison.trust, ['policy', 'execution'], 'comparison.trust');
  assertText(comparison.trust.policy, 'comparison.trust.policy');
  assertText(comparison.trust.execution, 'comparison.trust.execution');
  if (!COMPARISON_STATUSES.has(comparison.status)) {
    throw new JourneyBaselineError('comparison.status is invalid');
  }
  assertText(comparison.reason, 'comparison.reason');
  if (
    comparison.baselineHash !== null &&
    (typeof comparison.baselineHash !== 'string' || !DIGEST.test(comparison.baselineHash))
  ) {
    throw new JourneyBaselineError('comparison.baselineHash is invalid');
  }
  assertMap(comparison.compatibility, 'comparison.compatibility');
  assertExactKeys(
    comparison.compatibility,
    ['status', 'reasons'],
    'comparison.compatibility',
  );
  if (!['compatible', 'incompatible', 'unavailable'].includes(comparison.compatibility.status)) {
    throw new JourneyBaselineError('comparison.compatibility.status is invalid');
  }
  if (
    !Array.isArray(comparison.compatibility.reasons) ||
    comparison.compatibility.reasons.some((reason) => typeof reason !== 'string' || !reason)
  ) {
    throw new JourneyBaselineError('comparison.compatibility.reasons is invalid');
  }
  validateComparisonCompleteness(comparison.completeness);
  assertMap(comparison.summary, 'comparison.summary');
  assertExactKeys(
    comparison.summary,
    ['regressions', 'improvements', 'unchanged', 'unavailable'],
    'comparison.summary',
  );
  for (const field of ['regressions', 'improvements', 'unchanged', 'unavailable']) {
    assertCount(comparison.summary[field], `comparison.summary.${field}`);
  }
  if (!Array.isArray(comparison.hardFloors) || !Array.isArray(comparison.journeys)) {
    throw new JourneyBaselineError('comparison hardFloors and journeys must be arrays');
  }
  const floorIds = new Set();
  for (const [index, floor] of comparison.hardFloors.entries()) {
    const path = `comparison.hardFloors[${index}]`;
    assertMap(floor, path);
    assertExactKeys(floor, ['id', 'status', 'baseline', 'current'], path);
    assertId(floor.id, `${path}.id`);
    if (floorIds.has(floor.id)) throw new JourneyBaselineError(`duplicate hard floor ${floor.id}`);
    floorIds.add(floor.id);
    if (!CHANGE_STATUSES.has(floor.status)) {
      throw new JourneyBaselineError(`${path}.status is invalid`);
    }
    assertCount(floor.baseline, `${path}.baseline`);
    assertCount(floor.current, `${path}.current`);
  }
  const journeyIds = new Set();
  for (const [index, journey] of comparison.journeys.entries()) {
    validateJourneyComparisonRecord(journey, `comparison.journeys[${index}]`);
    if (journeyIds.has(journey.journeyRef)) {
      throw new JourneyBaselineError(`duplicate comparison journey ${journey.journeyRef}`);
    }
    journeyIds.add(journey.journeyRef);
  }
  if (comparison.compatibility.status === 'compatible') {
    const expected = metricCompleteness(
      comparison.journeys.flatMap((journey) => journey.metrics),
    );
    if (canonicalJson(comparison.completeness) !== canonicalJson(expected)) {
      throw new JourneyBaselineError(
        'comparison.completeness does not match its metric records',
      );
    }
  }
  return comparison;
}

export function serializeJourneyComparison(comparison) {
  validateJourneyComparison(comparison);
  return `${JSON.stringify(canonicalize(comparison), null, 2)}\n`;
}

export function renderJourneyBaselineMarkdown(baseline) {
  validateJourneyBaseline(baseline);
  const lines = [
    '# ux-guard journey baseline candidate',
    '',
    `- **Approval:** ${baseline.approval.status === 'reviewed' ? `Reviewed by ${baseline.approval.reviewer}` : 'Unapproved candidate — not trusted for comparison'}`,
    `- **Canonical hash:** \`${baseline.canonicalHash}\``,
    `- **Policy digest:** \`${baseline.policy.digest}\``,
    `- **Profile:** ${baseline.runProfile.browser.name} / ${baseline.runProfile.browser.profile}`,
    `- **Repetitions:** ${baseline.runProfile.repetitions}`,
    `- **Coverage snapshot:** ${baseline.coverage.successfulVariants}/${baseline.coverage.requiredVariants} successful; ${baseline.coverage.measuredVariants}/${baseline.coverage.requiredVariants} measured`,
    `- **Metric tolerances:** ${baseline.tolerances.length ? `${baseline.tolerances.length} explicitly reviewed` : 'None; raw metrics will be unavailable for regression decisions until reviewed'}`,
    '- **Meaning:** This is measured current-state evidence, not approval of existing defects.',
    '',
    '## Hard floors',
    '',
    ...Object.entries(baseline.hardFloors).map(
      ([name, value]) => `- \`${name}\`: ${value}`,
    ),
    '',
    '## Findings snapshot',
    '',
  ];
  if (baseline.findings.length === 0) lines.push('None.');
  else {
    for (const finding of baseline.findings) {
      lines.push(`- **${finding.ruleId}** — ${finding.severity}; ${finding.journeyRefs.length} journey(s)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderJourneyComparisonMarkdown(comparison) {
  validateJourneyComparison(comparison);
  const lines = [
    '# ux-guard advisory journey comparison',
    '',
    '> Candidate code performs this comparison. It is advisory until trusted execution is pinned in roadmap step 7.',
    '',
    `- **Status:** ${comparison.status}`,
    `- **Reason:** ${comparison.reason}`,
    `- **Baseline:** ${comparison.baselineHash ? `\`${comparison.baselineHash}\`` : 'Not available'}`,
    `- **Changes:** ${comparison.summary.regressions} regression(s), ${comparison.summary.improvements} improvement(s), ${comparison.summary.unchanged} unchanged, ${comparison.summary.unavailable} unavailable`,
    `- **Metric completeness:** ${comparison.completeness.status} (${comparison.completeness.metrics.evaluated}/${comparison.completeness.metrics.total} evaluated; ${comparison.completeness.metrics.notEvaluated} not evaluated)`,
    '',
    '## Hard floors',
    '',
  ];
  if (comparison.hardFloors.length === 0) lines.push('Not evaluated.');
  else {
    for (const floor of comparison.hardFloors) {
      lines.push(
        `- \`${floor.id}\`: ${floor.status} (baseline ${floor.baseline}, current ${floor.current})`,
      );
    }
  }
  lines.push('', '## Journey changes', '');
  if (comparison.journeys.length === 0) lines.push('Not evaluated.');
  else {
    for (const journey of comparison.journeys) {
      lines.push(`- \`${journey.journeyRef}\`: ${journey.status}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function baselineCompatibilityReasons(baseline, report, policy, trusted) {
  const reasons = [];
  if (baseline.approval.status !== 'reviewed') {
    reasons.push('baseline is an unapproved candidate');
  }
  if (!trusted) {
    reasons.push('baseline was not loaded from an explicit trusted revision');
  }
  if (baseline.policy.digest !== policyDigest(policy)) {
    reasons.push('policy digest differs from the reviewed baseline');
  }
  if (baseline.policy.digest !== report.run.policy.digest) {
    reasons.push('current report policy digest differs from the reviewed baseline');
  }
  if (baseline.tool.name !== report.run.tool.name) {
    reasons.push('tool name differs from the reviewed baseline');
  }
  if (
    canonicalJson(comparisonCriticalSchemas(baseline.tool.schemas)) !==
    canonicalJson(comparisonCriticalSchemas(report.run.tool.schemas))
  ) {
    reasons.push('measurement schema versions differ from the reviewed baseline');
  }
  if (
    canonicalJson(baseline.runProfile.browser) !==
    canonicalJson(report.run.browser)
  ) {
    reasons.push('browser profile differs from the reviewed baseline');
  }
  if (
    canonicalJson(baseline.runProfile.adapters) !==
    canonicalJson(report.run.adapters)
  ) {
    reasons.push('adapter profile differs from the reviewed baseline');
  }
  return reasons;
}

function compareSnapshots(baseline, current) {
  const tolerances = new Map(
    baseline.tolerances.map((tolerance) => [
      `${tolerance.journeyRef}\0${tolerance.metric}`,
      tolerance,
    ]),
  );
  const beforeFindings = new Map(baseline.findings.map((finding) => [finding.id, finding]));
  const afterFindings = new Map(current.findings.map((finding) => [finding.id, finding]));
  const currentJourneys = new Map(
    current.journeys.map((journey) => [journey.journeyRef, journey]),
  );
  const journeys = baseline.journeys.map((before) => {
    const after = currentJourneys.get(before.journeyRef);
    if (!after) {
      return {
        journeyRef: before.journeyRef,
        status: 'regression',
        lifecycle: {
          status: 'regression',
          baseline: before.status,
          current: 'unavailable',
        },
        findings: {
          status: 'unavailable',
          added: [],
          removed: [],
          severityChanges: [],
        },
        metrics: [],
      };
    }
    const lifecycle = compareLifecycle(before.status, after.status);
    const findingComparison = compareFindings(
      before.findingRefs,
      after.findingRefs,
      beforeFindings,
      afterFindings,
    );
    const metricNames = [...new Set([
      ...Object.keys(before.metrics ?? {}),
      ...Object.keys(after.metrics ?? {}),
    ])].sort();
    const metrics = metricNames.map((metric) =>
      compareMetric(
        before.journeyRef,
        metric,
        before.metrics?.[metric],
        after.metrics?.[metric],
        tolerances.get(`${before.journeyRef}\0${metric}`),
      ),
    );
    const evaluatedMetricStatuses = metrics
      .filter(({ status }) => status !== 'unavailable')
      .map(({ status }) => status);
    const nonMetricStatuses = [lifecycle.status, findingComparison.status];
    const detectedNonMetricChange = nonMetricStatuses.some(
      (status) => status === 'regression' || status === 'improvement',
    );
    return {
      journeyRef: before.journeyRef,
      status:
        evaluatedMetricStatuses.length > 0 || detectedNonMetricChange
          ? combineEvaluatedStatuses([
              ...nonMetricStatuses,
              ...evaluatedMetricStatuses,
            ])
          : 'unavailable',
      lifecycle,
      findings: findingComparison,
      metrics,
    };
  });
  for (const after of current.journeys) {
    if (!baseline.journeys.some(({ journeyRef }) => journeyRef === after.journeyRef)) {
      journeys.push({
        journeyRef: after.journeyRef,
        status: 'unavailable',
        lifecycle: {
          status: 'unavailable',
          baseline: 'unavailable',
          current: after.status,
        },
        findings: {
          status: 'unavailable',
          added: [],
          removed: [],
          severityChanges: [],
        },
        metrics: [],
      });
    }
  }
  journeys.sort((left, right) => left.journeyRef.localeCompare(right.journeyRef));

  const currentCritical = current.findings.filter(
    (finding) => finding.severity === 'critical',
  ).length;
  const floorValues = [
    [
      'required-evidence',
      baseline.hardFloors.minimumMeasuredVariants,
      current.coverage.measuredVariants,
      (value, floor) => value < floor,
    ],
    [
      'required-completion',
      baseline.hardFloors.minimumSuccessfulVariants,
      current.coverage.successfulVariants,
      (value, floor) => value < floor,
    ],
    [
      'failed-lifecycle',
      baseline.hardFloors.maximumFailedVariants,
      current.coverage.statuses.failed,
      (value, floor) => value > floor,
    ],
    [
      'skipped-lifecycle',
      baseline.hardFloors.maximumSkippedVariants,
      current.coverage.statuses.skipped,
      (value, floor) => value > floor,
    ],
    [
      'infrastructure-lifecycle',
      baseline.hardFloors.maximumInfrastructureErrorVariants,
      current.coverage.statuses.infrastructureError,
      (value, floor) => value > floor,
    ],
    [
      'critical-findings',
      baseline.hardFloors.maximumCriticalFindings,
      currentCritical,
      (value, floor) => value > floor,
    ],
  ];
  const hardFloors = floorValues.map(([id, floor, value, regressed]) => ({
    id,
    status: regressed(value, floor)
      ? 'regression'
      : value === floor
        ? 'unchanged'
        : 'improvement',
    baseline: floor,
    current: value,
  }));
  const allStatuses = [
    ...journeys.map(({ status }) => status),
    ...hardFloors.map(({ status }) => status),
  ];
  const completeness = metricCompleteness(
    journeys.flatMap((journey) => journey.metrics),
  );
  const detectedChange = allStatuses.some(
    (status) => status === 'regression' || status === 'improvement',
  );
  return {
    kind: JOURNEY_COMPARISON_KIND,
    version: JOURNEY_COMPARISON_VERSION,
    advisory: true,
    trust: { policy: 'reviewed-artifact', execution: 'candidate-untrusted' },
    status:
      completeness.metrics.evaluated > 0 || detectedChange
        ? combineEvaluatedStatuses(allStatuses)
        : 'unavailable',
    reason: 'Comparison completed.',
    baselineHash: baseline.canonicalHash,
    compatibility: { status: 'compatible', reasons: [] },
    completeness,
    summary: statusSummary(allStatuses),
    hardFloors,
    journeys,
  };
}

function compareLifecycle(before, after) {
  let status = 'unchanged';
  if (before !== after) {
    status = STATUS_RANK.get(after) > STATUS_RANK.get(before) ? 'improvement' : 'regression';
  }
  return { status, baseline: before, current: after };
}

function compareFindings(beforeRefs, afterRefs, beforeFindings, afterFindings) {
  const before = new Set(beforeRefs);
  const after = new Set(afterRefs);
  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  const severityChanges = [...before]
    .filter((id) => after.has(id))
    .map((id) => ({
      findingRef: id,
      baseline: beforeFindings.get(id)?.severity ?? 'unavailable',
      current: afterFindings.get(id)?.severity ?? 'unavailable',
    }))
    .filter(({ baseline, current }) => baseline !== current)
    .sort((left, right) => left.findingRef.localeCompare(right.findingRef));
  const severityStatuses = severityChanges.map(({ baseline, current }) =>
    SEVERITY_RANK.has(baseline) && SEVERITY_RANK.has(current)
      ? SEVERITY_RANK.get(current) > SEVERITY_RANK.get(baseline)
        ? 'regression'
        : 'improvement'
      : 'unavailable',
  );
  return {
    status: combineStatuses([
      ...added.map(() => 'regression'),
      ...removed.map(() => 'improvement'),
      ...severityStatuses,
      ...(added.length || removed.length || severityStatuses.length ? [] : ['unchanged']),
    ]),
    added,
    removed,
    severityChanges,
  };
}

function compareMetric(journeyRef, metric, before, after, tolerance) {
  if (before === undefined || after === undefined || !tolerance) {
    return {
      metric,
      status: 'unavailable',
      baseline: before ?? null,
      current: after ?? null,
      delta: before === undefined || after === undefined ? null : after - before,
      tolerance: tolerance
        ? {
            direction: tolerance.direction,
            permittedRegression: tolerance.permittedRegression,
          }
        : null,
    };
  }
  const delta = after - before;
  let status = 'unchanged';
  if (tolerance.direction === 'lower-is-better') {
    if (delta > tolerance.permittedRegression) status = 'regression';
    else if (delta < 0) status = 'improvement';
  } else {
    if (-delta > tolerance.permittedRegression) status = 'regression';
    else if (delta > 0) status = 'improvement';
  }
  return {
    metric,
    status,
    baseline: before,
    current: after,
    delta,
    tolerance: {
      direction: tolerance.direction,
      permittedRegression: tolerance.permittedRegression,
    },
  };
}

function metricCompleteness(metrics) {
  const total = metrics.length;
  const notEvaluated = metrics.filter(
    ({ status }) => status === 'unavailable',
  ).length;
  const evaluated = total - notEvaluated;
  return {
    status:
      total > 0 && evaluated === 0
        ? 'not-evaluated'
        : notEvaluated > 0
          ? 'partial'
          : 'complete',
    metrics: {
      total,
      evaluated,
      notEvaluated,
    },
  };
}

function combineStatuses(statuses) {
  if (statuses.includes('regression')) return 'regression';
  if (statuses.includes('improvement')) return 'improvement';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'unchanged';
}

function combineEvaluatedStatuses(statuses) {
  return combineStatuses(statuses.filter((status) => status !== 'unavailable'));
}

function validateComparisonCompleteness(completeness) {
  assertMap(completeness, 'comparison.completeness');
  assertExactKeys(
    completeness,
    ['status', 'metrics'],
    'comparison.completeness',
  );
  if (!['complete', 'partial', 'not-evaluated'].includes(completeness.status)) {
    throw new JourneyBaselineError('comparison.completeness.status is invalid');
  }
  assertMap(completeness.metrics, 'comparison.completeness.metrics');
  assertExactKeys(
    completeness.metrics,
    ['total', 'evaluated', 'notEvaluated'],
    'comparison.completeness.metrics',
  );
  for (const [name, value] of Object.entries(completeness.metrics)) {
    assertCount(value, `comparison.completeness.metrics.${name}`);
  }
  const { total, evaluated, notEvaluated } = completeness.metrics;
  if (evaluated + notEvaluated !== total) {
    throw new JourneyBaselineError(
      'comparison.completeness metric counts are inconsistent',
    );
  }
  const expected =
    total > 0 && evaluated === 0
      ? 'not-evaluated'
      : notEvaluated > 0
        ? 'partial'
        : 'complete';
  if (
    completeness.status !== expected &&
    !(
      completeness.status === 'not-evaluated' &&
      total === 0 &&
      evaluated === 0 &&
      notEvaluated === 0
    )
  ) {
    throw new JourneyBaselineError(
      'comparison.completeness.status does not match its metric counts',
    );
  }
}

function comparisonCriticalSchemas(schemas) {
  const names = [
    'run',
    'journey-report',
    'journey-shard',
    'observation',
    'policy',
  ];
  return Object.fromEntries(
    names.map((name) => [name, schemas[name] ?? null]),
  );
}

function statusSummary(statuses) {
  return {
    regressions: statuses.filter((status) => status === 'regression').length,
    improvements: statuses.filter((status) => status === 'improvement').length,
    unchanged: statuses.filter((status) => status === 'unchanged').length,
    unavailable: statuses.filter((status) => status === 'unavailable').length,
  };
}

function emptyComparison({
  status,
  reason,
  baselineHash,
  compatibilityReasons,
}) {
  return {
    kind: JOURNEY_COMPARISON_KIND,
    version: JOURNEY_COMPARISON_VERSION,
    advisory: true,
    trust: {
      policy: status === 'unavailable' ? 'unavailable' : 'trusted-base',
      execution: 'candidate-untrusted',
    },
    status,
    reason,
    baselineHash,
    compatibility: {
      status: status === 'unavailable' ? 'unavailable' : 'incompatible',
      reasons: compatibilityReasons,
    },
    completeness: {
      status: 'not-evaluated',
      metrics: {
        total: 0,
        evaluated: 0,
        notEvaluated: 0,
      },
    },
    summary: {
      regressions: 0,
      improvements: 0,
      unchanged: 0,
      unavailable: 0,
    },
    hardFloors: [],
    journeys: [],
  };
}

function snapshotCoverage(report) {
  const statuses = lifecycleCounts(report.journeys);
  return {
    requiredVariants: report.run.completion.expected,
    measuredVariants: report.run.completion.received,
    successfulVariants: report.run.completion.successful,
    statuses,
  };
}

function snapshotJourneys(report) {
  return report.journeys
    .map((journey) => ({
      journeyRef: journey.id,
      useCaseId: journey.useCaseId,
      journeyId: journey.journeyId,
      status: journey.status,
      metrics: journey.metrics === null ? null : structuredClone(journey.metrics),
      findingRefs: [...journey.findingRefs].sort(),
    }))
    .sort((left, right) => left.journeyRef.localeCompare(right.journeyRef));
}

function snapshotFindings(report) {
  return report.findings
    .map((finding) => ({
      id: finding.id,
      ruleId: finding.ruleId,
      severity: finding.severity,
      dimension: finding.dimension,
      type: finding.type,
      journeyRefs: [...finding.journeyRefs].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function lifecycleCounts(journeys) {
  return {
    successful: journeys.filter(({ status }) => status === 'successful').length,
    failed: journeys.filter(({ status }) => status === 'failed').length,
    skipped: journeys.filter(({ status }) => status === 'skipped').length,
    unexecutable: journeys.filter(({ status }) => status === 'unexecutable').length,
    infrastructureError: journeys.filter(
      ({ status }) => status === 'infrastructure-error',
    ).length,
  };
}

function canaryCoverage(status) {
  return {
    requiredVariants: 1,
    measuredVariants: 1,
    successfulVariants: status === 'successful' ? 1 : 0,
    statuses: {
      successful: status === 'successful' ? 1 : 0,
      failed: status === 'failed' ? 1 : 0,
      skipped: status === 'skipped' ? 1 : 0,
      unexecutable: status === 'unexecutable' ? 1 : 0,
      infrastructureError: status === 'infrastructure-error' ? 1 : 0,
    },
  };
}

function defaultCanaries() {
  return {
    regression: 'not-recorded',
    improvement: 'not-recorded',
    compatibility: 'not-recorded',
    knownBad: 'not-recorded',
  };
}

function parseRepetitions(value) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new JourneyBaselineError('run adapter repetitions must be a positive integer string');
  }
  const repetitions = Number(value);
  if (!Number.isSafeInteger(repetitions)) {
    throw new JourneyBaselineError('run adapter repetitions is too large');
  }
  return repetitions;
}

function validateApproval(approval) {
  assertMap(approval, 'baseline.approval');
  assertExactKeys(
    approval,
    ['status', 'reviewer', 'reviewedAt', 'rationale'],
    'baseline.approval',
  );
  if (!APPROVAL_STATUSES.has(approval.status)) {
    throw new JourneyBaselineError('baseline.approval.status is invalid');
  }
  if (approval.status === 'candidate') {
    if (
      approval.reviewer !== null ||
      approval.reviewedAt !== null ||
      approval.rationale !== null
    ) {
      throw new JourneyBaselineError('candidate baseline cannot claim review metadata');
    }
  } else {
    assertText(approval.reviewer, 'baseline.approval.reviewer');
    assertTimestamp(approval.reviewedAt, 'baseline.approval.reviewedAt');
    assertText(approval.rationale, 'baseline.approval.rationale');
  }
}

function validateProvenance(provenance) {
  assertMap(provenance, 'baseline.provenance');
  assertExactKeys(
    provenance,
    ['candidateCommit', 'baseCommit', 'sourceReport'],
    'baseline.provenance',
  );
  validateOptionalCommit(provenance.candidateCommit, 'baseline.provenance.candidateCommit');
  validateOptionalCommit(provenance.baseCommit, 'baseline.provenance.baseCommit');
  assertMap(provenance.sourceReport, 'baseline.provenance.sourceReport');
  assertExactKeys(
    provenance.sourceReport,
    ['path', 'sha256'],
    'baseline.provenance.sourceReport',
  );
  assertSafeRelativePath(
    provenance.sourceReport.path,
    'baseline.provenance.sourceReport.path',
  );
  assertHash(provenance.sourceReport.sha256, 'baseline.provenance.sourceReport.sha256');
}

function validatePolicy(policy) {
  assertMap(policy, 'baseline.policy');
  assertExactKeys(policy, ['algorithm', 'digest'], 'baseline.policy');
  if (policy.algorithm !== 'sha256' || typeof policy.digest !== 'string' || !DIGEST.test(policy.digest)) {
    throw new JourneyBaselineError('baseline.policy is invalid');
  }
}

function validateRunProfile(profile) {
  assertMap(profile, 'baseline.runProfile');
  assertExactKeys(
    profile,
    ['browser', 'adapters', 'repetitions'],
    'baseline.runProfile',
  );
  assertMap(profile.browser, 'baseline.runProfile.browser');
  assertExactKeys(
    profile.browser,
    ['name', 'profile'],
    'baseline.runProfile.browser',
  );
  assertText(profile.browser.name, 'baseline.runProfile.browser.name');
  assertText(profile.browser.profile, 'baseline.runProfile.browser.profile');
  assertStringMap(profile.adapters, 'baseline.runProfile.adapters');
  if (!Number.isSafeInteger(profile.repetitions) || profile.repetitions < 1) {
    throw new JourneyBaselineError('baseline.runProfile.repetitions is invalid');
  }
}

function validateTool(tool) {
  assertMap(tool, 'baseline.tool');
  assertExactKeys(tool, ['name', 'version', 'schemas'], 'baseline.tool');
  assertText(tool.name, 'baseline.tool.name');
  assertText(tool.version, 'baseline.tool.version');
  assertMap(tool.schemas, 'baseline.tool.schemas');
  if (
    Object.keys(tool.schemas).length === 0 ||
    Object.entries(tool.schemas).some(
      ([name, version]) => !ID.test(name) || !Number.isSafeInteger(version) || version < 1,
    )
  ) {
    throw new JourneyBaselineError('baseline.tool.schemas is invalid');
  }
}

function validateCoverage(coverage) {
  assertMap(coverage, 'baseline.coverage');
  assertExactKeys(
    coverage,
    ['requiredVariants', 'measuredVariants', 'successfulVariants', 'statuses'],
    'baseline.coverage',
  );
  for (const field of ['requiredVariants', 'measuredVariants', 'successfulVariants']) {
    assertCount(coverage[field], `baseline.coverage.${field}`);
  }
  if (
    coverage.successfulVariants > coverage.measuredVariants ||
    coverage.measuredVariants > coverage.requiredVariants
  ) {
    throw new JourneyBaselineError('baseline.coverage counts are inconsistent');
  }
  assertMap(coverage.statuses, 'baseline.coverage.statuses');
  assertExactKeys(
    coverage.statuses,
    ['successful', 'failed', 'skipped', 'unexecutable', 'infrastructureError'],
    'baseline.coverage.statuses',
  );
  for (const [field, value] of Object.entries(coverage.statuses)) {
    assertCount(value, `baseline.coverage.statuses.${field}`);
  }
  if (
    Object.values(coverage.statuses).reduce((total, value) => total + value, 0) !==
    coverage.measuredVariants
  ) {
    throw new JourneyBaselineError('baseline.coverage statuses are inconsistent');
  }
}

function validateJourneys(journeys) {
  if (!Array.isArray(journeys)) throw new JourneyBaselineError('baseline.journeys must be an array');
  const ids = new Set();
  for (const [index, journey] of journeys.entries()) {
    const path = `baseline.journeys[${index}]`;
    assertMap(journey, path);
    assertExactKeys(
      journey,
      [
        'journeyRef',
        'useCaseId',
        'journeyId',
        'status',
        'metrics',
        'findingRefs',
      ],
      path,
    );
    assertId(journey.journeyRef, `${path}.journeyRef`);
    assertId(journey.useCaseId, `${path}.useCaseId`);
    assertId(journey.journeyId, `${path}.journeyId`);
    if (ids.has(journey.journeyRef)) {
      throw new JourneyBaselineError(`baseline.journeys repeats ${journey.journeyRef}`);
    }
    ids.add(journey.journeyRef);
    if (!EXECUTION_STATUSES.has(journey.status)) {
      throw new JourneyBaselineError(`${path}.status is invalid`);
    }
    if (journey.metrics === null) {
      if (!['failed', 'skipped', 'infrastructure-error'].includes(journey.status)) {
        throw new JourneyBaselineError(`${path}.metrics cannot be null for measured evidence`);
      }
    } else {
      assertMap(journey.metrics, `${path}.metrics`);
      for (const [metric, value] of Object.entries(journey.metrics)) {
        if (!JOURNEY_METRICS.includes(metric)) {
          throw new JourneyBaselineError(`${path}.metrics has unknown metric ${metric}`);
        }
        assertCount(value, `${path}.metrics.${metric}`);
      }
    }
    if (
      !Array.isArray(journey.findingRefs) ||
      new Set(journey.findingRefs).size !== journey.findingRefs.length ||
      journey.findingRefs.some((id) => typeof id !== 'string' || !ID.test(id))
    ) {
      throw new JourneyBaselineError(`${path}.findingRefs is invalid`);
    }
  }
}

function validateFindings(findings, journeyIds) {
  if (!Array.isArray(findings)) throw new JourneyBaselineError('baseline.findings must be an array');
  const ids = new Set();
  for (const [index, finding] of findings.entries()) {
    const path = `baseline.findings[${index}]`;
    assertMap(finding, path);
    assertExactKeys(
      finding,
      ['id', 'ruleId', 'severity', 'dimension', 'type', 'journeyRefs'],
      path,
    );
    assertId(finding.id, `${path}.id`);
    assertId(finding.ruleId, `${path}.ruleId`);
    if (ids.has(finding.id)) throw new JourneyBaselineError(`duplicate finding ${finding.id}`);
    ids.add(finding.id);
    if (!SEVERITIES.has(finding.severity)) {
      throw new JourneyBaselineError(`${path}.severity is invalid`);
    }
    assertText(finding.dimension, `${path}.dimension`);
    assertText(finding.type, `${path}.type`);
    if (
      !Array.isArray(finding.journeyRefs) ||
      finding.journeyRefs.length === 0 ||
      new Set(finding.journeyRefs).size !== finding.journeyRefs.length ||
      finding.journeyRefs.some((id) => !journeyIds.has(id))
    ) {
      throw new JourneyBaselineError(`${path}.journeyRefs is invalid`);
    }
  }
}

function validateTolerances(tolerances, journeys) {
  if (!Array.isArray(tolerances)) {
    throw new JourneyBaselineError('baseline.tolerances must be an array');
  }
  const ids = new Set();
  for (const [index, tolerance] of tolerances.entries()) {
    const path = `baseline.tolerances[${index}]`;
    assertMap(tolerance, path);
    assertExactKeys(
      tolerance,
      ['journeyRef', 'metric', 'direction', 'permittedRegression'],
      path,
    );
    const journey = journeys.get(tolerance.journeyRef);
    if (!journey) throw new JourneyBaselineError(`${path}.journeyRef is unknown`);
    if (
      !JOURNEY_METRICS.includes(tolerance.metric) ||
      !journey.metrics ||
      !Object.hasOwn(journey.metrics, tolerance.metric)
    ) {
      throw new JourneyBaselineError(`${path}.metric is not measured by its journey`);
    }
    if (!['lower-is-better', 'higher-is-better'].includes(tolerance.direction)) {
      throw new JourneyBaselineError(`${path}.direction is invalid`);
    }
    assertCount(tolerance.permittedRegression, `${path}.permittedRegression`);
    const id = `${tolerance.journeyRef}\0${tolerance.metric}`;
    if (ids.has(id)) throw new JourneyBaselineError(`${path} duplicates a tolerance`);
    ids.add(id);
  }
}

function validateHardFloors(floors) {
  assertMap(floors, 'baseline.hardFloors');
  assertExactKeys(
    floors,
    [
      'minimumMeasuredVariants',
      'minimumSuccessfulVariants',
      'maximumFailedVariants',
      'maximumSkippedVariants',
      'maximumInfrastructureErrorVariants',
      'maximumCriticalFindings',
    ],
    'baseline.hardFloors',
  );
  for (const [name, value] of Object.entries(floors)) {
    assertCount(value, `baseline.hardFloors.${name}`);
  }
}

function validateArtifacts(artifacts, path, visual = false) {
  if (!Array.isArray(artifacts)) throw new JourneyBaselineError(`${path} must be an array`);
  const ids = new Set();
  const paths = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const itemPath = `${path}[${index}]`;
    assertMap(artifact, itemPath);
    assertExactKeys(
      artifact,
      visual ? ['id', 'path', 'sha256', 'schemaVersion'] : ['id', 'path', 'sha256'],
      itemPath,
    );
    assertId(artifact.id, `${itemPath}.id`);
    assertSafeRelativePath(artifact.path, `${itemPath}.path`);
    assertHash(artifact.sha256, `${itemPath}.sha256`);
    if (visual) {
      if (!Number.isSafeInteger(artifact.schemaVersion) || artifact.schemaVersion < 1) {
        throw new JourneyBaselineError(`${itemPath}.schemaVersion is invalid`);
      }
    }
    if (ids.has(artifact.id)) throw new JourneyBaselineError(`${path} repeats id ${artifact.id}`);
    if (paths.has(artifact.path)) {
      throw new JourneyBaselineError(`${path} repeats path ${artifact.path}`);
    }
    ids.add(artifact.id);
    paths.add(artifact.path);
  }
}

function validateReadinessEvidence(evidence) {
  assertMap(evidence, 'baseline.readinessEvidence');
  assertExactKeys(
    evidence,
    [
      'deterministicRun',
      'evidenceComplete',
      'stableRepetitions',
      'canaries',
      'trustedExecution',
      'enforcementApproved',
    ],
    'baseline.readinessEvidence',
  );
  for (const field of [
    'deterministicRun',
    'evidenceComplete',
    'trustedExecution',
    'enforcementApproved',
  ]) {
    if (typeof evidence[field] !== 'boolean') {
      throw new JourneyBaselineError(`baseline.readinessEvidence.${field} must be boolean`);
    }
  }
  if (
    !Number.isSafeInteger(evidence.stableRepetitions) ||
    evidence.stableRepetitions < 1
  ) {
    throw new JourneyBaselineError('baseline.readinessEvidence.stableRepetitions is invalid');
  }
  validateCanaries(evidence.canaries, 'baseline.readinessEvidence.canaries');
}

function validateCanaries(canaries, path) {
  assertMap(canaries, path);
  assertExactKeys(
    canaries,
    ['regression', 'improvement', 'compatibility', 'knownBad'],
    path,
  );
  for (const [name, status] of Object.entries(canaries)) {
    if (!CANARY_STATUSES.has(status)) {
      throw new JourneyBaselineError(`${path}.${name} is invalid`);
    }
  }
}

function validateJourneyComparisonRecord(journey, path) {
  assertMap(journey, path);
  assertExactKeys(
    journey,
    ['journeyRef', 'status', 'lifecycle', 'findings', 'metrics'],
    path,
  );
  assertId(journey.journeyRef, `${path}.journeyRef`);
  if (!CHANGE_STATUSES.has(journey.status)) {
    throw new JourneyBaselineError(`${path}.status is invalid`);
  }
  assertMap(journey.lifecycle, `${path}.lifecycle`);
  assertExactKeys(
    journey.lifecycle,
    ['status', 'baseline', 'current'],
    `${path}.lifecycle`,
  );
  if (!CHANGE_STATUSES.has(journey.lifecycle.status)) {
    throw new JourneyBaselineError(`${path}.lifecycle.status is invalid`);
  }
  for (const field of ['baseline', 'current']) {
    if (
      journey.lifecycle[field] !== 'unavailable' &&
      !EXECUTION_STATUSES.has(journey.lifecycle[field])
    ) {
      throw new JourneyBaselineError(`${path}.lifecycle.${field} is invalid`);
    }
  }
  assertMap(journey.findings, `${path}.findings`);
  assertExactKeys(
    journey.findings,
    ['status', 'added', 'removed', 'severityChanges'],
    `${path}.findings`,
  );
  if (!CHANGE_STATUSES.has(journey.findings.status)) {
    throw new JourneyBaselineError(`${path}.findings.status is invalid`);
  }
  for (const field of ['added', 'removed', 'severityChanges']) {
    if (!Array.isArray(journey.findings[field])) {
      throw new JourneyBaselineError(`${path}.findings.${field} must be an array`);
    }
  }
  if (!Array.isArray(journey.metrics)) {
    throw new JourneyBaselineError(`${path}.metrics must be an array`);
  }
  const metrics = new Set();
  for (const [index, metric] of journey.metrics.entries()) {
    const metricPath = `${path}.metrics[${index}]`;
    assertMap(metric, metricPath);
    assertExactKeys(
      metric,
      ['metric', 'status', 'baseline', 'current', 'delta', 'tolerance'],
      metricPath,
    );
    if (!JOURNEY_METRICS.includes(metric.metric) || metrics.has(metric.metric)) {
      throw new JourneyBaselineError(`${metricPath}.metric is invalid`);
    }
    metrics.add(metric.metric);
    if (!CHANGE_STATUSES.has(metric.status)) {
      throw new JourneyBaselineError(`${metricPath}.status is invalid`);
    }
    for (const field of ['baseline', 'current']) {
      if (metric[field] !== null) assertCount(metric[field], `${metricPath}.${field}`);
    }
    if (metric.delta !== null && !Number.isSafeInteger(metric.delta)) {
      throw new JourneyBaselineError(`${metricPath}.delta is invalid`);
    }
    if (metric.tolerance !== null) {
      assertMap(metric.tolerance, `${metricPath}.tolerance`);
      assertExactKeys(
        metric.tolerance,
        ['direction', 'permittedRegression'],
        `${metricPath}.tolerance`,
      );
      if (
        !['lower-is-better', 'higher-is-better'].includes(metric.tolerance.direction)
      ) {
        throw new JourneyBaselineError(`${metricPath}.tolerance.direction is invalid`);
      }
      assertCount(
        metric.tolerance.permittedRegression,
        `${metricPath}.tolerance.permittedRegression`,
      );
    }
  }
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JourneyBaselineError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new JourneyBaselineError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JourneyBaselineError(`${path} must be non-empty text`);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new JourneyBaselineError(`${path} is not a safe id`);
  }
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JourneyBaselineError(`${path} must be a non-negative safe integer`);
  }
}

function assertHash(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new JourneyBaselineError(`${path} must be a canonical SHA-256 hash`);
  }
}

function assertTimestamp(value, path) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  const normalized =
    parsed && !Number.isNaN(parsed.valueOf())
      ? parsed.toISOString().replace('.000Z', 'Z')
      : null;
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    normalized !== value.replace('.000Z', 'Z')
  ) {
    throw new JourneyBaselineError(`${path} must be an explicit UTC timestamp`);
  }
}

function assertSafeRelativePath(value, path) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new JourneyBaselineError(`${path} must be a safe repository-relative path`);
  }
}

function validateOptionalCommit(value, path) {
  if (value !== null && (typeof value !== 'string' || !COMMIT.test(value))) {
    throw new JourneyBaselineError(`${path} must be a commit or null`);
  }
}

function assertStringMap(value, path) {
  assertMap(value, path);
  if (
    Object.keys(value).length === 0 ||
    Object.entries(value).some(
      ([key, entry]) =>
        !ID.test(key) || typeof entry !== 'string' || !entry.trim(),
    )
  ) {
    throw new JourneyBaselineError(`${path} must be a non-empty version map`);
  }
}
