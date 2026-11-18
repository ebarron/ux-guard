import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TARGET_ATTAINMENT_SCHEMA,
  evaluateTargetAttainment,
  validateTargetAttainment,
} from '../lib/targets.mjs';
import {
  createVerdictReport,
  renderVerdictMarkdown,
} from '../lib/verdicts.mjs';
import {
  catalog,
  journeyReport,
  measurement,
  ownerTargets,
  policy,
} from './contract-helpers.mjs';

function measured(journeyId, values = {}, status = 'successful') {
  const journey = measurement(journeyId, { status });
  for (const [metric, value] of Object.entries(values)) {
    journey.metrics[metric] = value;
    journey.steps[0].metrics[metric] = value;
  }
  return journey;
}

function metricTarget(journeyId, metric, value, operator = 'at-most') {
  return {
    journeyRef: `journey.create-record.${journeyId}`,
    metric,
    operator,
    value,
  };
}

function evaluate({
  variants = ['standard'],
  journeys = [measured('standard')],
  metrics = [],
  hardFloors,
} = {}) {
  const reviewed = policy(variants);
  const measurements = journeyReport(reviewed, journeys);
  const targets = ownerTargets(reviewed, { metrics, hardFloors });
  const attainment = evaluateTargetAttainment({
    targets,
    report: measurements,
  });
  const verdict = createVerdictReport({
    catalog: catalog(),
    policy: reviewed,
    measurements,
    patterns: { findings: [] },
    targets: attainment,
  });
  return { attainment, verdict };
}

test('target attainment evaluates hard floors and strict at-most metrics', () => {
  assert.equal(
    TARGET_ATTAINMENT_SCHEMA.$id,
    'urn:ux-guard:target-attainment:v1',
  );
  const { attainment } = evaluate({
    journeys: [measured('standard', { editedFields: 4 })],
    metrics: [metricTarget('standard', 'editedFields', 3)],
    hardFloors: {
      minimumMeasuredVariants: 1,
      minimumSuccessfulVariants: 2,
      maximumUnexecutableVariants: 0,
    },
  });

  assert.equal(attainment.status, 'breached');
  assert.equal(
    attainment.hardFloors.find(
      ({ id }) => id === 'minimumMeasuredVariants',
    ).status,
    'met',
  );
  assert.equal(
    attainment.hardFloors.find(
      ({ id }) => id === 'minimumSuccessfulVariants',
    ).status,
    'breached',
  );
  assert.deepEqual(attainment.journeys[0].metrics[0], {
    metric: 'editedFields',
    operator: 'at-most',
    target: 3,
    actual: 4,
    status: 'breached',
  });
  assert.doesNotThrow(() => validateTargetAttainment(attainment));
});

test('at-most score is 100 when met, proportional when breached, and zero for a breached zero target', () => {
  const cases = [
    { actual: 3, target: 3, expected: 100 },
    { actual: 4, target: 3, expected: 75 },
    { actual: 1, target: 0, expected: 0 },
  ];
  for (const { actual, target, expected } of cases) {
    const { verdict } = evaluate({
      journeys: [measured('standard', { editedFields: actual })],
      metrics: [metricTarget('standard', 'editedFields', target)],
    });
    assert.equal(verdict.scoring.journeys[0].score, expected);
  }
});

test('journey and use-case scores use non-compensating minimum aggregation', () => {
  const { verdict } = evaluate({
    variants: ['standard', 'advanced'],
    journeys: [
      measured('standard', { clicks: 6, editedFields: 4 }),
      measured('advanced', { clicks: 8 }),
    ],
    metrics: [
      metricTarget('standard', 'clicks', 6),
      metricTarget('standard', 'editedFields', 2),
      metricTarget('advanced', 'clicks', 2),
    ],
  });

  const standard = verdict.scoring.journeys.find(({ journeyRef }) =>
    journeyRef.endsWith('.standard'),
  );
  const advanced = verdict.scoring.journeys.find(({ journeyRef }) =>
    journeyRef.endsWith('.advanced'),
  );
  assert.deepEqual(
    standard.metrics.map(({ score }) => score),
    [100, 50],
  );
  assert.equal(standard.score, 50);
  assert.equal(advanced.score, 25);
  assert.equal(verdict.scoring.useCases[0].score, 25);
  assert.equal(Object.hasOwn(verdict.scoring, 'score'), false);
});

test('partial and absent target coverage remain explicit without a global score', () => {
  const partial = evaluate({
    variants: ['standard', 'advanced'],
    journeys: [measured('standard'), measured('advanced')],
    metrics: [metricTarget('standard', 'clicks', 1)],
  }).verdict.scoring;
  assert.equal(partial.status, 'partially-scored');
  assert.equal(partial.useCases[0].status, 'partially-scored');
  assert.equal(partial.useCases[0].score, 100);
  assert.equal(
    partial.journeys.find(({ journeyRef }) =>
      journeyRef.endsWith('.advanced'),
    ).status,
    'not-targeted',
  );

  const absent = evaluate({
    variants: ['standard', 'advanced'],
    journeys: [measured('standard'), measured('advanced')],
  }).verdict.scoring;
  assert.equal(absent.status, 'not-scored');
  assert.ok(absent.useCases.every(({ score }) => score === null));
  assert.equal(Object.hasOwn(absent, 'score'), false);
});

test('unexecutable and unmeasured target journeys are not scored', () => {
  const unexecutable = evaluate({
    journeys: [measured('standard', { editedFields: 0 }, 'unexecutable')],
    metrics: [metricTarget('standard', 'editedFields', 3)],
  });
  assert.equal(unexecutable.attainment.journeys[0].status, 'not-evaluated');
  assert.equal(unexecutable.verdict.scoring.journeys[0].status, 'not-scored');
  assert.equal(unexecutable.verdict.scoring.journeys[0].score, null);

  const unmeasured = evaluate({
    variants: ['standard', 'advanced'],
    journeys: [measured('standard')],
    metrics: [metricTarget('advanced', 'editedFields', 3)],
  });
  const score = unmeasured.verdict.scoring.journeys.find(({ journeyRef }) =>
    journeyRef.endsWith('.advanced'),
  );
  assert.equal(score.status, 'not-scored');
  assert.equal(score.score, null);
});

test('target breaches render independently with actionable recommendations', () => {
  const { verdict } = evaluate({
    journeys: [measured('standard', { editedFields: 4 })],
    metrics: [metricTarget('standard', 'editedFields', 3)],
  });
  const markdown = renderVerdictMarkdown(verdict);

  assert.equal(verdict.targetAttainment.status, 'breached');
  assert.equal(verdict.quality.verdict, 'acceptable');
  assert.match(markdown, /Target attainment/);
  assert.match(markdown, /Reduce editedFields/);
  assert.match(markdown, /baselines never produce scores/i);
});
