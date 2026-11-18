import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOURNEY_REPORT_SCHEMA,
  JourneyReportError,
  aggregateJourneyReport,
  compareJourneyReports,
  createJourneyFinding,
  createJourneyRecorder,
  parseJourneyReport,
  serializeJourneyReport,
  validateJourneyReport,
} from '../lib/journeys.mjs';
import {
  journeyReport,
  measurement,
  policy,
  runFor,
} from './contract-helpers.mjs';

test('records deterministic metrics and typed observations with an injected clock', () => {
  let time = 100;
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
    metrics: ['modalDepth', 'decisions', 'elapsedMs'],
    elapsed: { source: 'mocked', clock: () => time },
  });
  recorder.beginStep('open-form');
  recorder.record('clicks', 2);
  recorder.record('decisions');
  recorder.observeModalDepth(2);
  recorder.observe('accessible-name', {
    concept: 'empty-state-add-action',
    role: 'button',
    name: 'Settings',
    expectedName: 'Create record',
  });
  time = 125;
  recorder.endStep();
  const journey = recorder.finish();

  assert.equal(journey.metrics.clicks, 2);
  assert.equal(journey.metrics.modalDepth, 2);
  assert.equal(journey.metrics.elapsedMs, 25);
  assert.equal(journey.observations[0].type, 'accessible-name');
  assert.equal(journey.timing.deterministic, true);
});

test('standard measurements are always present and explicit metrics stay opt-in', () => {
  const journey = measurement();
  assert.deepEqual(journey.metrics, {
    clicks: 0,
    keystrokes: 0,
    editedFields: 0,
    routeChanges: 0,
    steps: 1,
  });
});

test('wall-clock elapsed data is explicitly non-deterministic report-only metadata', () => {
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
    elapsed: { source: 'wall-clock' },
  });
  recorder.beginStep('complete');
  recorder.endStep({ elapsedMs: 12 });
  assert.deepEqual(recorder.finish().timing, {
    source: 'wall-clock',
    deterministic: false,
  });
});

test('normalizes findings and evidence once and uses references from journeys', () => {
  const reviewed = policy(['standard', 'advanced']);
  const report = journeyReport(reviewed, [
    measurement('standard', { finding: true }),
    measurement('advanced', { finding: true }),
  ]);

  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].journeyRefs.length, 2);
  assert.equal(report.findings[0].evidence.length, 2);
  assert.deepEqual(
    report.journeys.map((journey) => journey.findingRefs),
    [[report.findings[0].id], [report.findings[0].id]],
  );
  assert.equal(report.details.observations.length, 2);
});

test('serializes deterministically and round-trips the explicit v5 schema', () => {
  const reviewed = policy();
  const report = journeyReport(reviewed, [measurement()]);
  const serialized = serializeJourneyReport(report);

  assert.equal(JOURNEY_REPORT_SCHEMA.$id, 'urn:ux-guard:journey-report:v5');
  assert.equal(serialized, serializeJourneyReport(report));
  assert.deepEqual(parseJourneyReport(serialized), report);
});

test('rejects old report versions with an actionable migration error', () => {
  assert.throws(
    () =>
      parseJourneyReport(
        JSON.stringify({ kind: 'ux-guard-journey-report', version: 4, journeys: [] }),
      ),
    /migrate to version 5/,
  );
});

test('failed assertion, skipped, unavailable-path, and infrastructure statuses stay distinct', () => {
  const reviewed = policy(['standard']);
  for (const status of ['successful', 'unexecutable']) {
    const report = journeyReport(reviewed, [measurement('standard', { status })]);
    assert.equal(report.journeys[0].status, status);
  }
  for (const status of ['failed', 'skipped', 'infrastructure-error']) {
    const run = runFor(reviewed, [status], {
      errors:
        status === 'skipped'
          ? []
          : [
              {
                id: `error.create-record.standard.1`,
                category: status === 'failed' ? 'assertion' : 'infrastructure',
                message: status,
                journeyRef: 'journey.create-record.standard',
              },
            ],
    });
    const lifecycle = {
      useCaseId: 'create-record',
      journeyId: 'standard',
      status,
      timing: null,
      metrics: null,
      steps: [],
      observations: [],
    };
    assert.equal(journeyReport(reviewed, [lifecycle], { run }).journeys[0].status, status);
  }
});

test('bindings cannot inject findings, verdicts, severity, or recommendations', () => {
  assert.throws(
    () => createJourneyFinding({ severity: 'critical', recommendation: 'trust me' }),
    /cannot inject findings/,
  );
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
  });
  recorder.beginStep('complete');
  recorder.endStep();
  assert.throws(
    () => recorder.finish({ findings: [], verdict: 'acceptable' }),
    /unknown field/,
  );
});

test('unknown observations and malformed normalized references fail closed', () => {
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
  });
  recorder.beginStep('complete');
  assert.throws(() => recorder.observe('arbitrary-prose', { text: 'pass' }), /unknown/);

  const reviewed = policy();
  const report = journeyReport(reviewed, [measurement()]);
  const knownBad = structuredClone(report);
  knownBad.journeys[0].stepRefs = ['step.traversal'];
  assert.throws(() => validateJourneyReport(knownBad), JourneyReportError);
});

test('aggregates metrics and compares data without manufacturing a regression verdict', () => {
  const reviewed = policy();
  const beforeJourney = measurement();
  beforeJourney.steps[0].metrics.clicks = 1;
  beforeJourney.metrics.clicks = 1;
  const afterJourney = measurement();
  afterJourney.steps[0].metrics.clicks = 2;
  afterJourney.metrics.clicks = 2;
  const before = journeyReport(reviewed, [beforeJourney]);
  const after = journeyReport(reviewed, [afterJourney]);
  const comparison = compareJourneyReports(before, after);

  assert.equal(aggregateJourneyReport(after).metrics.clicks.value, 2);
  assert.equal(comparison.journeys[0].metrics.clicks.delta, 1);
  assert.equal(comparison.regressionStatus, 'not-evaluated');
  assert.equal(Object.hasOwn(comparison, 'score'), false);
});

test('report tampering cannot change completion counts or measured aggregates', () => {
  const reviewed = policy();
  const report = journeyReport(reviewed, [measurement()]);
  for (const mutate of [
    (value) => (value.run.completion.successful = 0),
    (value) => (value.journeys[0].metrics.clicks = 9),
    (value) => (value.details.steps[0].metrics.steps = 2),
    (value) => (value.version = 99),
  ]) {
    const knownBad = structuredClone(report);
    mutate(knownBad);
    assert.throws(() => validateJourneyReport(knownBad));
  }
});
