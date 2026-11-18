import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOURNEY_BASELINE_SCHEMA,
  JOURNEY_COMPARISON_SCHEMA,
  compareJourneyBaseline,
  createJourneyBaselineCandidate,
  journeyBaselineHash,
  parseJourneyBaseline,
  promoteJourneyBaseline,
  runJourneyComparisonCanaries,
  serializeJourneyBaseline,
  validateJourneyBaseline,
} from '../lib/baselines.mjs';
import {
  OWNER_TARGETS_SCHEMA,
  ownerTargetsHash,
  parseOwnerTargets,
  validateOwnerTargets,
} from '../lib/targets.mjs';
import { createVerdictReport } from '../lib/verdicts.mjs';
import {
  catalog,
  journeyReport,
  measurement,
  policy,
  runFor,
} from './contract-helpers.mjs';

const SOURCE_ARTIFACT = {
  id: 'journey-shards',
  path: 'test-results/ux-guard/shards',
  sha256: 'a'.repeat(64),
};
const CANARIES = {
  regression: 'passed',
  improvement: 'passed',
  compatibility: 'passed',
  knownBad: 'passed',
};

function measured(journeyId = 'standard', { clicks = 1, finding = false, status = 'successful' } = {}) {
  const value = measurement(journeyId, { finding, status });
  value.steps[0].metrics.clicks = clicks;
  value.metrics.clicks = clicks;
  return value;
}

function report(reviewed, journeys, options = {}) {
  return journeyReport(reviewed, journeys, {
    run: runFor(reviewed, journeys.map(({ status }) => status), {
      adapters: { playwright: '1', repetitions: '3' },
      artifacts: [SOURCE_ARTIFACT],
      browser: options.browser,
    }),
  });
}

function candidateFor(reviewed, journeys, options = {}) {
  const candidate = createJourneyBaselineCandidate({
    report: report(reviewed, journeys, options),
    policy: reviewed,
    reportPath: 'test-results/ux-guard/journeys.json',
    reportSha256: 'b'.repeat(64),
    canaries: CANARIES,
  });
  candidate.tolerances = candidate.journeys.flatMap((journey) =>
    journey.metrics && Object.hasOwn(journey.metrics, 'clicks')
      ? [
          {
            journeyRef: journey.journeyRef,
            metric: 'clicks',
            direction: 'lower-is-better',
            permittedRegression: 0,
          },
        ]
      : [],
  );
  candidate.canonicalHash = journeyBaselineHash(candidate);
  validateJourneyBaseline(candidate);
  return candidate;
}

function reviewedBaseline(reviewed, journeys, options = {}) {
  return promoteJourneyBaseline(candidateFor(reviewed, journeys, options), {
    reviewer: 'product-owner',
    reviewedAt: '2026-11-16T18:00:00Z',
    rationale: 'Reviewed current-state evidence for regression comparison.',
  });
}

test('baseline v1 is canonical, strict, hash-bound, and separates candidate from review', () => {
  const reviewed = policy();
  const candidate = candidateFor(reviewed, [measured()]);
  assert.equal(JOURNEY_BASELINE_SCHEMA.$id, 'urn:ux-guard:journey-baseline:v1');
  assert.equal(JOURNEY_COMPARISON_SCHEMA.$id, 'urn:ux-guard:journey-comparison:v2');
  assert.equal(candidate.approval.status, 'candidate');
  assert.equal(candidate.tolerances[0].permittedRegression, 0);
  assert.deepEqual(parseJourneyBaseline(serializeJourneyBaseline(candidate)), candidate);

  const promoted = promoteJourneyBaseline(candidate, {
    reviewer: 'product-owner',
    reviewedAt: '2026-11-16T18:00:00Z',
    rationale: 'Evidence reviewed without accepting known defects.',
  });
  assert.equal(promoted.approval.status, 'reviewed');
  assert.notEqual(promoted.canonicalHash, candidate.canonicalHash);

  const tampered = structuredClone(promoted);
  tampered.hardFloors.minimumSuccessfulVariants = 0;
  assert.throws(() => validateJourneyBaseline(tampered), /canonicalHash/);
});

test('baseline validation rejects unsafe paths, duplicate artifacts, and malformed approval', () => {
  const candidate = candidateFor(policy(), [measured()]);
  for (const mutate of [
    (value) => (value.provenance.sourceReport.path = '../escape.json'),
    (value) =>
      value.sourceArtifacts.push({
        ...value.sourceArtifacts[0],
        id: 'duplicate-path',
      }),
    (value) => {
      value.approval.status = 'reviewed';
      value.approval.reviewer = '';
    },
  ]) {
    const malformed = structuredClone(candidate);
    mutate(malformed);
    malformed.canonicalHash = journeyBaselineHash(malformed);
    assert.throws(() => validateJourneyBaseline(malformed));
  }
});

test('synthetic metric changes require reviewed per-metric tolerances', () => {
  assert.deepEqual(runJourneyComparisonCanaries(), CANARIES);
  const reviewed = policy();
  const baseline = reviewedBaseline(reviewed, [measured()]);
  const regression = compareJourneyBaseline({
    baseline,
    report: report(reviewed, [measured('standard', { clicks: 2 })]),
    policy: reviewed,
    trusted: true,
  });
  const improvement = compareJourneyBaseline({
    baseline,
    report: report(reviewed, [measured('standard', { clicks: 0 })]),
    policy: reviewed,
    trusted: true,
  });
  const unchanged = compareJourneyBaseline({
    baseline,
    report: report(reviewed, [measured()]),
    policy: reviewed,
    trusted: true,
  });

  assert.equal(regression.status, 'regression');
  assert.equal(regression.journeys[0].metrics[0].status, 'regression');
  assert.equal(improvement.status, 'improvement');
  assert.equal(improvement.completeness.status, 'partial');
  assert.equal(improvement.journeys[0].metrics[0].status, 'improvement');
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.journeys[0].status, 'unchanged');
  assert.equal(unchanged.completeness.status, 'partial');
  assert.equal(unchanged.summary.regressions, 0);
  assert.equal(unchanged.summary.unavailable, 0);
  assert.match(unchanged.reason, /All evaluated comparison evidence is unchanged/);
  assert.ok(
    unchanged.journeys[0].metrics.some(
      ({ metric, status }) => metric === 'editedFields' && status === 'unavailable',
    ),
  );

  const withoutTolerance = structuredClone(baseline);
  withoutTolerance.tolerances = [];
  withoutTolerance.canonicalHash = journeyBaselineHash(withoutTolerance);
  const unreviewedClickChange = compareJourneyBaseline({
    baseline: withoutTolerance,
    report: report(reviewed, [measured('standard', { clicks: 2 })]),
    policy: reviewed,
    trusted: true,
  });
  assert.equal(unreviewedClickChange.status, 'unavailable');
  assert.equal(unreviewedClickChange.completeness.status, 'not-evaluated');
  assert.equal(unreviewedClickChange.summary.regressions, 0);
  assert.equal(
    unreviewedClickChange.journeys[0].metrics.find(
      ({ metric }) => metric === 'clicks',
    ).status,
    'unavailable',
  );
});

test('coverage, lifecycle, new findings, and severity cannot be offset by improvements', () => {
  const reviewed = policy(['standard', 'advanced']);
  const baseline = reviewedBaseline(reviewed, [
    measured('standard', { clicks: 2 }),
    measured('advanced'),
  ]);
  const current = report(reviewed, [
    measured('standard', { clicks: 0 }),
    measured('advanced', { finding: true, status: 'unexecutable' }),
  ]);
  const comparison = compareJourneyBaseline({
    baseline,
    report: current,
    policy: reviewed,
    trusted: true,
  });

  assert.equal(comparison.status, 'regression');
  assert.ok(comparison.summary.improvements > 0);
  assert.ok(comparison.summary.regressions > 0);
  assert.equal(
    comparison.hardFloors.find(({ id }) => id === 'required-completion').status,
    'regression',
  );
  assert.equal(
    comparison.journeys.find(({ journeyRef }) => journeyRef.endsWith('advanced'))
      .findings.status,
    'regression',
  );
});

test('a known-bad baseline preserves defects as evidence without declaring them acceptable', () => {
  const reviewed = policy();
  const knownBad = measured('standard', {
    finding: true,
    status: 'unexecutable',
  });
  const baseline = reviewedBaseline(reviewed, [knownBad]);
  const comparison = compareJourneyBaseline({
    baseline,
    report: report(reviewed, [knownBad]),
    policy: reviewed,
    trusted: true,
  });
  const verdict = createVerdictReport({
    catalog: catalog(),
    policy: reviewed,
    measurements: report(reviewed, [knownBad]),
    patterns: { findings: [] },
    comparison,
    readinessEvidence: baseline.readinessEvidence,
  });

  assert.equal(baseline.coverage.successfulVariants, 0);
  assert.equal(baseline.findings.length, 1);
  assert.equal(comparison.status, 'unchanged');
  assert.equal(comparison.journeys[0].lifecycle.current, 'unexecutable');
  assert.equal(verdict.quality.verdict, 'incomplete');
  assert.equal(verdict.readiness.state, 'stable');
  assert.equal(verdict.readiness.trustedExecution, false);
});

test('policy, schema, browser, and approval incompatibilities never become comparisons', () => {
  const reviewed = policy();
  const baseline = reviewedBaseline(reviewed, [measured()]);
  const changedBrowser = report(reviewed, [measured()], {
    browser: { name: 'chromium', profile: 'Different profile' },
  });
  const incompatible = compareJourneyBaseline({
    baseline,
    report: changedBrowser,
    policy: reviewed,
    trusted: true,
  });
  const unavailable = compareJourneyBaseline({
    baseline: candidateFor(reviewed, [measured()]),
    report: report(reviewed, [measured()]),
    policy: reviewed,
    trusted: false,
  });
  const changedMeasurementSchema = report(reviewed, [measured()]);
  changedMeasurementSchema.run.tool.schemas['journey-report'] += 1;
  const schemaIncompatible = compareJourneyBaseline({
    baseline,
    report: changedMeasurementSchema,
    policy: reviewed,
    trusted: true,
  });

  const reportOnlyUpgrade = structuredClone(baseline);
  reportOnlyUpgrade.tool.version = '0.5.0';
  reportOnlyUpgrade.tool.schemas['journey-comparison'] = 1;
  reportOnlyUpgrade.tool.schemas['verdict-report'] = 5;
  delete reportOnlyUpgrade.tool.schemas['target-attainment'];
  delete reportOnlyUpgrade.tool.schemas['numerical-score'];
  reportOnlyUpgrade.canonicalHash = journeyBaselineHash(reportOnlyUpgrade);
  const compatibleOutputUpgrade = compareJourneyBaseline({
    baseline: reportOnlyUpgrade,
    report: report(reviewed, [measured()]),
    policy: reviewed,
    trusted: true,
  });

  assert.equal(incompatible.status, 'incompatible');
  assert.match(incompatible.reason, /browser profile/);
  assert.equal(schemaIncompatible.status, 'incompatible');
  assert.match(schemaIncompatible.reason, /measurement schema/);
  assert.notEqual(compatibleOutputUpgrade.status, 'incompatible');
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /unapproved candidate/);
});

test('owner target v2 validates desired requirements and metric policy separately from baseline tolerances', () => {
  const reviewed = policy();
  const targets = {
    kind: 'ux-guard-owner-targets',
    version: 2,
    canonicalHash: '',
    approval: {
      status: 'reviewed',
      reviewer: 'product-owner',
      reviewedAt: '2026-11-16T18:00:00Z',
      rationale: 'Desired UX requirements reviewed.',
    },
    policy: {
      algorithm: 'sha256',
      digest: runFor(reviewed, []).policy.digest,
    },
    requirements: [
      {
        useCaseId: 'create-record',
        statements: ['Workspace is optional.'],
      },
    ],
    metrics: [
      {
        journeyRef: 'journey.create-record.standard',
        metric: 'clicks',
        operator: 'at-most',
        value: 5,
      },
    ],
    metricPolicy: {
      nonRegressionAfterReview: [
        'clicks',
        'editedFields',
        'routeChanges',
        'modalDepth',
        'steps',
      ],
      reportOnlyUntilCalibrated: [
        'keystrokes',
        'scrollDistance',
        'decisions',
        'elapsedMs',
      ],
    },
    hardFloors: {
      minimumMeasuredVariants: 1,
      minimumSuccessfulVariants: 1,
      maximumUnexecutableVariants: 0,
      maximumFailedVariants: 0,
      maximumSkippedVariants: 0,
      maximumInfrastructureErrorVariants: 0,
      maximumCriticalFindings: 0,
    },
    sourceArtifacts: [],
  };
  targets.canonicalHash = ownerTargetsHash(targets);

  assert.equal(OWNER_TARGETS_SCHEMA.$id, 'urn:ux-guard:owner-targets:v2');
  assert.deepEqual(parseOwnerTargets(JSON.stringify(targets)), targets);
  assert.equal(Object.hasOwn(targets, 'tolerances'), false);

  const duplicate = structuredClone(targets);
  duplicate.metrics.push(structuredClone(duplicate.metrics[0]));
  duplicate.canonicalHash = ownerTargetsHash(duplicate);
  assert.throws(() => validateOwnerTargets(duplicate), /duplicates/);

  const overlap = structuredClone(targets);
  overlap.metricPolicy.nonRegressionAfterReview.push('keystrokes');
  overlap.canonicalHash = ownerTargetsHash(overlap);
  assert.throws(() => validateOwnerTargets(overlap), /disjoint/);
});
