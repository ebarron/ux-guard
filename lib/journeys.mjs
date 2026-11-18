import {
  createObservation,
  evaluateObservationPolicy,
  journeyRecordId,
  validateObservation,
} from './observations.mjs';
import { canonicalize, validateRunEnvelope } from './run-contract.mjs';

export const JOURNEY_REPORT_KIND = 'ux-guard-journey-report';
export const JOURNEY_REPORT_VERSION = 5;

const JOURNEY_STATUSES = new Set([
  'successful',
  'failed',
  'skipped',
  'unexecutable',
  'infrastructure-error',
]);
const METRIC_DEFINITIONS = Object.freeze({
  clicks: { aggregation: 'sum' },
  keystrokes: { aggregation: 'sum' },
  editedFields: { aggregation: 'sum' },
  routeChanges: { aggregation: 'sum' },
  modalDepth: { aggregation: 'max' },
  scrollDistance: { aggregation: 'sum' },
  decisions: { aggregation: 'sum' },
  steps: { aggregation: 'sum', derived: true },
  elapsedMs: { aggregation: 'sum' },
});
export const JOURNEY_METRICS = Object.freeze(Object.keys(METRIC_DEFINITIONS));
export const RECORDABLE_JOURNEY_METRICS = Object.freeze(
  JOURNEY_METRICS.filter((metric) => !METRIC_DEFINITIONS[metric].derived),
);
export const STANDARD_JOURNEY_METRICS = Object.freeze([
  'clicks',
  'keystrokes',
  'editedFields',
  'routeChanges',
  'steps',
]);
export const EXPLICIT_JOURNEY_METRICS = Object.freeze([
  'modalDepth',
  'scrollDistance',
  'decisions',
  'elapsedMs',
]);

const ADDITIVE_METRICS = new Set(
  RECORDABLE_JOURNEY_METRICS.filter((metric) => metric !== 'modalDepth' && metric !== 'elapsedMs'),
);
const STANDARD_RECORDABLE_METRICS = STANDARD_JOURNEY_METRICS.filter(
  (metric) => !METRIC_DEFINITIONS[metric].derived,
);
const ELAPSED_SOURCES = new Set(['mocked', 'logical', 'wall-clock']);
const USE_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class JourneyReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyReportError';
  }
}

export const JOURNEY_REPORT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:journey-report:v5',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'version', 'run', 'journeys', 'findings', 'details'],
  properties: {
    kind: { const: JOURNEY_REPORT_KIND },
    version: { const: JOURNEY_REPORT_VERSION },
    run: { $ref: 'urn:ux-guard:run-envelope:v1' },
    journeys: { type: 'array' },
    findings: { type: 'array' },
    details: {
      type: 'object',
      additionalProperties: false,
      required: ['steps', 'observations'],
      properties: {
        steps: { type: 'array' },
        observations: { type: 'array' },
      },
    },
  },
});

export function createJourneyFinding() {
  throw new JourneyReportError(
    'bindings cannot inject findings, severity, verdicts, or recommendations; emit typed observations',
  );
}

export function createJourneyRecorder({ useCaseId, journeyId, metrics = [], elapsed = null } = {}) {
  assertId(useCaseId, USE_CASE_ID, 'useCaseId');
  assertId(journeyId, ID, 'journeyId');
  const enabled = normalizeMetricSelection(metrics);
  for (const metric of STANDARD_RECORDABLE_METRICS) enabled.add(metric);
  const timing = normalizeElapsed(elapsed);
  if (enabled.has('elapsedMs') && !timing) {
    throw new JourneyReportError('elapsedMs needs explicit elapsed source metadata');
  }
  if (timing) enabled.add('elapsedMs');
  const now = timing?.clock ?? null;
  const steps = [];
  const observations = [];
  const stepIds = new Set();
  let current = null;
  let finished = false;

  const ensureOpen = () => {
    if (finished) throw new JourneyReportError('journey recorder is already finished');
  };
  const ensureCurrent = () => {
    ensureOpen();
    if (!current) throw new JourneyReportError('begin a step before recording evidence');
    return current;
  };
  const ensureEnabled = (metric) => {
    if (!enabled.has(metric)) {
      throw new JourneyReportError(`${metric} is not enabled for this journey`);
    }
  };

  return Object.freeze({
    useCaseId,
    journeyId,
    metrics: Object.freeze([...enabled]),

    beginStep(id) {
      ensureOpen();
      if (current) throw new JourneyReportError(`step ${current.value.id} is still active`);
      assertId(id, ID, 'step id');
      if (stepIds.has(id)) throw new JourneyReportError(`duplicate step id ${id}`);
      stepIds.add(id);
      const stepMetrics = {};
      for (const metric of JOURNEY_METRICS) {
        if (metric === 'steps') stepMetrics.steps = 1;
        else if (enabled.has(metric)) stepMetrics[metric] = 0;
      }
      current = {
        value: { id, metrics: stepMetrics },
        startedAt: enabled.has('elapsedMs') && now ? readClock(now) : null,
        observationCount: 0,
      };
    },

    record(metric, amount = 1) {
      const step = ensureCurrent();
      if (!ADDITIVE_METRICS.has(metric)) {
        throw new JourneyReportError(
          `${String(metric)} is not additive; use observeModalDepth or endStep`,
        );
      }
      ensureEnabled(metric);
      assertMeasurement(amount, metric);
      step.value.metrics[metric] += amount;
    },

    observeModalDepth(depth) {
      const step = ensureCurrent();
      ensureEnabled('modalDepth');
      assertMeasurement(depth, 'modalDepth');
      step.value.metrics.modalDepth = Math.max(step.value.metrics.modalDepth, depth);
    },

    observe(type, data) {
      const step = ensureCurrent();
      step.observationCount += 1;
      const observation = createObservation({
        id: `observation.${useCaseId}.${journeyId}.${step.value.id}.${step.observationCount}`,
        version: 1,
        type,
        stepId: step.value.id,
        data,
      });
      observations.push(observation);
      return observation.id;
    },

    endStep(options = {}) {
      const step = ensureCurrent();
      assertOptionKeys(options, ['elapsedMs'], 'endStep options');
      const hasExplicitElapsed = Object.hasOwn(options, 'elapsedMs');
      if (enabled.has('elapsedMs')) {
        let value;
        if (hasExplicitElapsed) value = options.elapsedMs;
        else if (now) value = readClock(now) - step.startedAt;
        else {
          throw new JourneyReportError(
            'elapsedMs needs an injected clock or an explicit endStep({ elapsedMs }) value',
          );
        }
        assertMeasurement(value, 'elapsedMs');
        step.value.metrics.elapsedMs = value;
      } else if (hasExplicitElapsed) {
        throw new JourneyReportError('elapsedMs is not enabled for this journey');
      }
      steps.push(step.value);
      current = null;
    },

    finish(options = {}) {
      ensureOpen();
      assertOptionKeys(options, ['status'], 'finish options');
      if (current) throw new JourneyReportError(`step ${current.value.id} is still active`);
      if (steps.length === 0) throw new JourneyReportError('journey must contain at least one step');
      const status = options.status ?? 'successful';
      if (!['successful', 'unexecutable'].includes(status)) {
        throw new JourneyReportError(
          'recorded journey status must be successful or unexecutable',
        );
      }
      finished = true;
      const value = {
        useCaseId,
        journeyId,
        status,
        timing: timing
          ? { source: timing.source, deterministic: timing.source !== 'wall-clock' }
          : null,
        metrics: aggregateSteps(steps),
        steps: structuredClone(steps),
        observations: structuredClone(observations),
      };
      validateRawJourney(value, 'journey');
      return value;
    },
  });
}

export function createLifecycleJourney({ useCaseId, journeyId, status } = {}) {
  assertId(useCaseId, USE_CASE_ID, 'useCaseId');
  assertId(journeyId, ID, 'journeyId');
  if (!['failed', 'skipped', 'infrastructure-error'].includes(status)) {
    throw new JourneyReportError('lifecycle-only journey status is invalid');
  }
  return {
    useCaseId,
    journeyId,
    status,
    timing: null,
    metrics: null,
    steps: [],
    observations: [],
  };
}

export function createJourneyReport(journeys, { catalog, policy, run } = {}) {
  if (!Array.isArray(journeys)) throw new JourneyReportError('journeys must be an array');
  validateRunEnvelope(run);
  const raw = structuredClone(journeys).sort(compareJourneyIdentity);
  const identities = new Set();
  for (const [index, journey] of raw.entries()) {
    validateRawJourney(journey, `journeys[${index}]`);
    const identity = `${journey.useCaseId}\0${journey.journeyId}`;
    if (identities.has(identity)) {
      throw new JourneyReportError(`duplicate journey ${journey.useCaseId}/${journey.journeyId}`);
    }
    identities.add(identity);
  }
  if (catalog !== undefined) validateRawJourneyCatalog(raw, catalog);
  const findings = policy ? evaluateObservationPolicy(policy, raw) : [];
  const steps = raw.flatMap((journey) =>
    journey.steps.map((step) => ({
      id: stepRecordId(journey.useCaseId, journey.journeyId, step.id),
      journeyRef: journeyRecordId(journey.useCaseId, journey.journeyId),
      stepId: step.id,
      metrics: step.metrics,
    })),
  );
  const observations = raw.flatMap((journey) =>
    journey.observations.map((observation) => ({
      ...observation,
      journeyRef: journeyRecordId(journey.useCaseId, journey.journeyId),
      stepRef: stepRecordId(journey.useCaseId, journey.journeyId, observation.stepId),
    })),
  );
  const normalizedJourneys = raw.map((journey) => {
    const id = journeyRecordId(journey.useCaseId, journey.journeyId);
    return {
      id,
      useCaseId: journey.useCaseId,
      journeyId: journey.journeyId,
      status: journey.status,
      timing: journey.timing,
      metrics: journey.metrics,
      stepRefs: journey.steps.map((step) =>
        stepRecordId(journey.useCaseId, journey.journeyId, step.id),
      ),
      observationRefs: journey.observations.map(({ id: observationId }) => observationId),
      findingRefs: findings
        .filter((finding) => finding.journeyRefs.includes(id))
        .map((finding) => finding.id)
        .sort(),
    };
  });
  const report = {
    kind: JOURNEY_REPORT_KIND,
    version: JOURNEY_REPORT_VERSION,
    run: structuredClone(run),
    journeys: normalizedJourneys,
    findings,
    details: {
      steps: steps.sort((left, right) => left.id.localeCompare(right.id)),
      observations: observations.sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
  return validateJourneyReport(report);
}

export function validateJourneyReport(report) {
  assertMap(report, 'report');
  assertExactKeys(report, ['kind', 'version', 'run', 'journeys', 'findings', 'details'], 'report');
  if (report.kind !== JOURNEY_REPORT_KIND) {
    throw new JourneyReportError(`report.kind must be ${JOURNEY_REPORT_KIND}`);
  }
  if (report.version !== JOURNEY_REPORT_VERSION) {
    throw new JourneyReportError(
      `unsupported journey report version ${String(report.version)}; migrate to version ${JOURNEY_REPORT_VERSION}`,
    );
  }
  validateRunEnvelope(report.run);
  if (!Array.isArray(report.journeys) || !Array.isArray(report.findings)) {
    throw new JourneyReportError('report journeys and findings must be arrays');
  }
  assertMap(report.details, 'report.details');
  assertExactKeys(report.details, ['steps', 'observations'], 'report.details');
  if (!Array.isArray(report.details.steps) || !Array.isArray(report.details.observations)) {
    throw new JourneyReportError('report.details steps and observations must be arrays');
  }

  const steps = new Map();
  for (const [index, step] of report.details.steps.entries()) {
    const path = `report.details.steps[${index}]`;
    assertMap(step, path);
    assertExactKeys(step, ['id', 'journeyRef', 'stepId', 'metrics'], path);
    assertId(step.id, ID, `${path}.id`);
    if (steps.has(step.id)) throw new JourneyReportError(`duplicate step record ${step.id}`);
    assertId(step.journeyRef, ID, `${path}.journeyRef`);
    assertId(step.stepId, ID, `${path}.stepId`);
    validateMetrics(step.metrics, `${path}.metrics`);
    if (step.metrics.steps !== 1) throw new JourneyReportError(`${path}.metrics.steps must be 1`);
    steps.set(step.id, step);
  }
  const observations = new Map();
  for (const [index, observation] of report.details.observations.entries()) {
    const path = `report.details.observations[${index}]`;
    assertMap(observation, path);
    assertExactKeys(
      observation,
      ['id', 'version', 'type', 'stepId', 'data', 'journeyRef', 'stepRef'],
      path,
    );
    if (observations.has(observation.id)) {
      throw new JourneyReportError(`duplicate observation ${observation.id}`);
    }
    const raw = {
      id: observation.id,
      version: observation.version,
      type: observation.type,
      stepId: observation.stepId,
      data: observation.data,
    };
    validateObservation(raw, path);
    assertId(observation.journeyRef, ID, `${path}.journeyRef`);
    assertId(observation.stepRef, ID, `${path}.stepRef`);
    if (!steps.has(observation.stepRef)) {
      throw new JourneyReportError(`${path}.stepRef names an unknown step`);
    }
    observations.set(observation.id, observation);
  }

  const journeyIds = new Set();
  for (const [index, journey] of report.journeys.entries()) {
    const path = `report.journeys[${index}]`;
    validateNormalizedJourney(journey, path, steps, observations);
    if (journeyIds.has(journey.id)) throw new JourneyReportError(`duplicate journey ${journey.id}`);
    journeyIds.add(journey.id);
  }
  const findingIds = new Set();
  for (const [index, finding] of report.findings.entries()) {
    validateFinding(finding, `report.findings[${index}]`, journeyIds, observations);
    if (findingIds.has(finding.id)) throw new JourneyReportError(`duplicate finding ${finding.id}`);
    findingIds.add(finding.id);
  }
  for (const journey of report.journeys) {
    for (const findingRef of journey.findingRefs) {
      const finding = report.findings.find((candidate) => candidate.id === findingRef);
      if (!finding || !finding.journeyRefs.includes(journey.id)) {
        throw new JourneyReportError(`${journey.id} has an invalid finding reference`);
      }
    }
  }
  const statuses = report.journeys.map((journey) => journey.status);
  const completion = report.run.completion;
  const expectedCounts = {
    successful: statuses.filter((status) => status === 'successful').length,
    failed: statuses.filter((status) => status === 'failed').length,
    skipped: statuses.filter((status) => status === 'skipped').length,
    unexecutable: statuses.filter((status) => status === 'unexecutable').length,
    infrastructureError: statuses.filter((status) => status === 'infrastructure-error').length,
  };
  if (
    completion.received !== report.journeys.length ||
    Object.entries(expectedCounts).some(([key, value]) => completion[key] !== value)
  ) {
    throw new JourneyReportError('run completion does not match journey lifecycle records');
  }
  return report;
}

export function validateJourneyCatalog(report, catalog) {
  validateJourneyReport(report);
  const ids = catalogIds(catalog);
  const unknown = [
    ...new Set(
      report.journeys
        .map((journey) => journey.useCaseId)
        .filter((useCaseId) => !ids.has(useCaseId)),
    ),
  ].sort();
  if (unknown.length) {
    throw new JourneyReportError(`journey report names uncatalogued use cases: ${unknown.join(', ')}`);
  }
  return report;
}

export function parseJourneyReport(text) {
  if (typeof text !== 'string') throw new JourneyReportError('journey report must be JSON text');
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new JourneyReportError('journey report is not valid JSON');
  }
  if (report?.kind === JOURNEY_REPORT_KIND && report.version !== JOURNEY_REPORT_VERSION) {
    throw new JourneyReportError(
      `unsupported journey report version ${String(report.version)}; migrate to version ${JOURNEY_REPORT_VERSION}`,
    );
  }
  return validateJourneyReport(report);
}

export function serializeJourneyReport(report) {
  validateJourneyReport(report);
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}

export function aggregateJourneyReport(report) {
  validateJourneyReport(report);
  const metrics = {};
  for (const metric of JOURNEY_METRICS) {
    const measured = report.journeys.filter(
      (journey) => journey.metrics && Object.hasOwn(journey.metrics, metric),
    );
    if (measured.length === 0) continue;
    const aggregation = METRIC_DEFINITIONS[metric].aggregation;
    metrics[metric] = {
      value:
        aggregation === 'max'
          ? Math.max(...measured.map((journey) => journey.metrics[metric]))
          : measured.reduce((total, journey) => total + journey.metrics[metric], 0),
      aggregation,
      journeysMeasured: measured.length,
      journeysTotal: report.journeys.length,
    };
  }
  return {
    kind: 'ux-guard-journey-aggregate',
    version: JOURNEY_REPORT_VERSION,
    useCases: new Set(report.journeys.map((journey) => journey.useCaseId)).size,
    journeys: report.journeys.length,
    metrics,
  };
}

export function compareJourneyReports(before, after) {
  validateJourneyReport(before);
  validateJourneyReport(after);
  const beforeById = new Map(before.journeys.map((journey) => [journey.id, journey]));
  const afterById = new Map(after.journeys.map((journey) => [journey.id, journey]));
  const journeys = [...beforeById.keys()]
    .filter((id) => afterById.has(id))
    .sort()
    .map((id) => compareJourney(beforeById.get(id), afterById.get(id)));
  return {
    kind: 'ux-guard-journey-comparison',
    version: JOURNEY_REPORT_VERSION,
    regressionStatus: 'not-evaluated',
    addedJourneyRefs: [...afterById.keys()].filter((id) => !beforeById.has(id)).sort(),
    removedJourneyRefs: [...beforeById.keys()].filter((id) => !afterById.has(id)).sort(),
    journeys,
  };
}

function validateRawJourney(journey, path) {
  assertMap(journey, path);
  assertExactKeys(
    journey,
    ['useCaseId', 'journeyId', 'status', 'timing', 'metrics', 'steps', 'observations'],
    path,
  );
  assertId(journey.useCaseId, USE_CASE_ID, `${path}.useCaseId`);
  assertId(journey.journeyId, ID, `${path}.journeyId`);
  if (!JOURNEY_STATUSES.has(journey.status)) {
    throw new JourneyReportError(`${path}.status is invalid`);
  }
  if (['failed', 'skipped', 'infrastructure-error'].includes(journey.status)) {
    if (
      journey.timing !== null ||
      journey.metrics !== null ||
      !Array.isArray(journey.steps) ||
      journey.steps.length !== 0 ||
      !Array.isArray(journey.observations) ||
      journey.observations.length !== 0
    ) {
      throw new JourneyReportError(`${path} lifecycle-only status cannot claim measurements`);
    }
    return;
  }
  validateMetrics(journey.metrics, `${path}.metrics`);
  validateTiming(journey.timing, journey.metrics, `${path}.timing`);
  if (!Array.isArray(journey.steps) || journey.steps.length === 0) {
    throw new JourneyReportError(`${path}.steps must be a non-empty array`);
  }
  const stepIds = new Set();
  const metricKeys = Object.keys(journey.metrics).sort();
  for (const [index, step] of journey.steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    assertMap(step, stepPath);
    assertExactKeys(step, ['id', 'metrics'], stepPath);
    assertId(step.id, ID, `${stepPath}.id`);
    if (stepIds.has(step.id)) throw new JourneyReportError(`${path} repeats step ${step.id}`);
    stepIds.add(step.id);
    validateMetrics(step.metrics, `${stepPath}.metrics`);
    if (step.metrics.steps !== 1) throw new JourneyReportError(`${stepPath}.metrics.steps must be 1`);
    if (!sameStrings(metricKeys, Object.keys(step.metrics).sort())) {
      throw new JourneyReportError(`${stepPath}.metrics does not match journey metrics`);
    }
  }
  const aggregate = aggregateSteps(journey.steps);
  for (const metric of metricKeys) {
    if (aggregate[metric] !== journey.metrics[metric]) {
      throw new JourneyReportError(`${path}.metrics.${metric} is not the step aggregate`);
    }
  }
  if (!Array.isArray(journey.observations)) {
    throw new JourneyReportError(`${path}.observations must be an array`);
  }
  const observationIds = new Set();
  for (const [index, observation] of journey.observations.entries()) {
    validateObservation(observation, `${path}.observations[${index}]`);
    if (observationIds.has(observation.id)) {
      throw new JourneyReportError(`${path} repeats observation ${observation.id}`);
    }
    observationIds.add(observation.id);
    if (!stepIds.has(observation.stepId)) {
      throw new JourneyReportError(`${path} observation names unknown step ${observation.stepId}`);
    }
  }
}

function validateNormalizedJourney(journey, path, steps, observations) {
  assertMap(journey, path);
  assertExactKeys(
    journey,
    [
      'id',
      'useCaseId',
      'journeyId',
      'status',
      'timing',
      'metrics',
      'stepRefs',
      'observationRefs',
      'findingRefs',
    ],
    path,
  );
  assertId(journey.id, ID, `${path}.id`);
  if (journey.id !== journeyRecordId(journey.useCaseId, journey.journeyId)) {
    throw new JourneyReportError(`${path}.id is not derived from its policy ids`);
  }
  assertId(journey.useCaseId, USE_CASE_ID, `${path}.useCaseId`);
  assertId(journey.journeyId, ID, `${path}.journeyId`);
  if (!JOURNEY_STATUSES.has(journey.status)) throw new JourneyReportError(`${path}.status is invalid`);
  for (const field of ['stepRefs', 'observationRefs', 'findingRefs']) {
    if (
      !Array.isArray(journey[field]) ||
      journey[field].some((id) => typeof id !== 'string' || !ID.test(id)) ||
      new Set(journey[field]).size !== journey[field].length
    ) {
      throw new JourneyReportError(`${path}.${field} is invalid`);
    }
  }
  if (['failed', 'skipped', 'infrastructure-error'].includes(journey.status)) {
    if (
      journey.timing !== null ||
      journey.metrics !== null ||
      journey.stepRefs.length ||
      journey.observationRefs.length ||
      journey.findingRefs.length
    ) {
      throw new JourneyReportError(`${path} lifecycle-only status cannot reference evidence`);
    }
    return;
  }
  validateMetrics(journey.metrics, `${path}.metrics`);
  validateTiming(journey.timing, journey.metrics, `${path}.timing`);
  if (journey.stepRefs.length === 0) throw new JourneyReportError(`${path}.stepRefs is empty`);
  const journeySteps = journey.stepRefs.map((id) => {
    const step = steps.get(id);
    if (!step || step.journeyRef !== journey.id) {
      throw new JourneyReportError(`${path}.stepRefs names an invalid step`);
    }
    return { id: step.stepId, metrics: step.metrics };
  });
  const aggregate = aggregateSteps(journeySteps);
  for (const metric of Object.keys(journey.metrics)) {
    if (aggregate[metric] !== journey.metrics[metric]) {
      throw new JourneyReportError(`${path}.metrics.${metric} is inconsistent`);
    }
  }
  for (const id of journey.observationRefs) {
    const observation = observations.get(id);
    if (!observation || observation.journeyRef !== journey.id) {
      throw new JourneyReportError(`${path}.observationRefs names invalid evidence`);
    }
  }
}

function validateFinding(finding, path, journeys, observations) {
  assertMap(finding, path);
  assertExactKeys(
    finding,
    [
      'id',
      'ruleId',
      'severity',
      'dimension',
      'type',
      'summary',
      'policy',
      'recommendation',
      'journeyRefs',
      'evidence',
    ],
    path,
  );
  assertId(finding.id, ID, `${path}.id`);
  assertId(finding.ruleId, ID, `${path}.ruleId`);
  if (!['low', 'medium', 'high', 'critical'].includes(finding.severity)) {
    throw new JourneyReportError(`${path}.severity is invalid`);
  }
  if (
    !['efficiency', 'clarity', 'feedback-and-recovery', 'accessibility', 'consistency'].includes(
      finding.dimension,
    )
  ) {
    throw new JourneyReportError(`${path}.dimension is invalid`);
  }
  if (!['requirement', 'recommendation'].includes(finding.type)) {
    throw new JourneyReportError(`${path}.type is invalid`);
  }
  assertText(finding.summary, `${path}.summary`);
  assertText(finding.recommendation, `${path}.recommendation`);
  if (
    !Array.isArray(finding.journeyRefs) ||
    finding.journeyRefs.length === 0 ||
    finding.journeyRefs.some((id) => !journeys.has(id))
  ) {
    throw new JourneyReportError(`${path}.journeyRefs is invalid`);
  }
  if (!Array.isArray(finding.policy) || finding.policy.length === 0) {
    throw new JourneyReportError(`${path}.policy is invalid`);
  }
  for (const [index, reference] of finding.policy.entries()) {
    const referencePath = `${path}.policy[${index}]`;
    assertMap(reference, referencePath);
    assertExactKeys(reference, ['source', 'field', 'statement'], referencePath);
    assertText(reference.source, `${referencePath}.source`);
    assertText(reference.field, `${referencePath}.field`);
    assertText(reference.statement, `${referencePath}.statement`);
  }
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    throw new JourneyReportError(`${path}.evidence is invalid`);
  }
  const ids = new Set();
  for (const [index, evidence] of finding.evidence.entries()) {
    const evidencePath = `${path}.evidence[${index}]`;
    assertMap(evidence, evidencePath);
    assertExactKeys(
      evidence,
      ['id', 'journeyRef', 'observationRef', 'stepId', 'facts'],
      evidencePath,
    );
    assertId(evidence.id, ID, `${evidencePath}.id`);
    if (ids.has(evidence.id)) throw new JourneyReportError(`${path} repeats evidence id`);
    ids.add(evidence.id);
    if (!finding.journeyRefs.includes(evidence.journeyRef)) {
      throw new JourneyReportError(`${evidencePath}.journeyRef is invalid`);
    }
    const observation = observations.get(evidence.observationRef);
    if (
      !observation ||
      observation.journeyRef !== evidence.journeyRef ||
      observation.stepId !== evidence.stepId
    ) {
      throw new JourneyReportError(`${evidencePath} does not reference its observation`);
    }
    if (!Array.isArray(evidence.facts) || evidence.facts.length === 0) {
      throw new JourneyReportError(`${evidencePath}.facts is invalid`);
    }
  }
}

function validateMetrics(metrics, path) {
  assertMap(metrics, path);
  for (const metric of STANDARD_JOURNEY_METRICS) {
    if (!Object.hasOwn(metrics, metric)) {
      throw new JourneyReportError(`${path}.${metric} is a standard required measurement`);
    }
  }
  for (const [metric, value] of Object.entries(metrics)) {
    if (!Object.hasOwn(METRIC_DEFINITIONS, metric)) {
      throw new JourneyReportError(`${path} has unknown metric ${metric}`);
    }
    assertMeasurement(value, `${path}.${metric}`);
  }
}

function validateTiming(timing, metrics, path) {
  const hasElapsed = Object.hasOwn(metrics, 'elapsedMs');
  if (!hasElapsed) {
    if (timing !== null) throw new JourneyReportError(`${path} must be null without elapsedMs`);
    return;
  }
  assertMap(timing, path);
  assertExactKeys(timing, ['source', 'deterministic'], path);
  if (!ELAPSED_SOURCES.has(timing.source)) throw new JourneyReportError(`${path}.source is invalid`);
  if (timing.deterministic !== (timing.source !== 'wall-clock')) {
    throw new JourneyReportError(`${path}.deterministic does not match its source`);
  }
}

function aggregateSteps(steps) {
  const measured = new Set(steps.flatMap((step) => Object.keys(step.metrics)));
  const metrics = {};
  for (const metric of JOURNEY_METRICS) {
    if (!measured.has(metric)) continue;
    metrics[metric] =
      METRIC_DEFINITIONS[metric].aggregation === 'max'
        ? Math.max(...steps.map((step) => step.metrics[metric]))
        : steps.reduce((total, step) => total + step.metrics[metric], 0);
  }
  return metrics;
}

function compareJourney(before, after) {
  const metrics = {};
  for (const metric of JOURNEY_METRICS) {
    if (
      before.metrics &&
      after.metrics &&
      Object.hasOwn(before.metrics, metric) &&
      Object.hasOwn(after.metrics, metric)
    ) {
      metrics[metric] = {
        before: before.metrics[metric],
        after: after.metrics[metric],
        delta: after.metrics[metric] - before.metrics[metric],
      };
    }
  }
  return {
    journeyRef: before.id,
    status: {
      before: before.status,
      after: after.status,
      changed: before.status !== after.status,
    },
    metrics,
  };
}

function normalizeMetricSelection(metrics) {
  if (!Array.isArray(metrics)) throw new JourneyReportError('metrics must be an array');
  const selected = new Set();
  for (const metric of metrics) {
    if (!RECORDABLE_JOURNEY_METRICS.includes(metric)) {
      throw new JourneyReportError(`unknown or derived journey metric ${String(metric)}`);
    }
    selected.add(metric);
  }
  return selected;
}

function normalizeElapsed(elapsed) {
  if (elapsed === null) return null;
  assertMap(elapsed, 'elapsed');
  const keys = Object.keys(elapsed);
  if (
    !keys.every((key) => key === 'source' || key === 'clock') ||
    !Object.hasOwn(elapsed, 'source')
  ) {
    throw new JourneyReportError('elapsed accepts source and optional clock only');
  }
  if (!ELAPSED_SOURCES.has(elapsed.source)) {
    throw new JourneyReportError('elapsed.source must be mocked, logical, or wall-clock');
  }
  if (elapsed.clock === undefined) return { source: elapsed.source, clock: null };
  const now = typeof elapsed.clock === 'function' ? elapsed.clock : elapsed.clock?.now;
  if (typeof now !== 'function') {
    throw new JourneyReportError('elapsed.clock must be a function or an object with now()');
  }
  return {
    source: elapsed.source,
    clock: now.bind(typeof elapsed.clock === 'object' ? elapsed.clock : undefined),
  };
}

function readClock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JourneyReportError('clock.now() must return a non-negative safe integer');
  }
  return value;
}

function validateRawJourneyCatalog(journeys, catalog) {
  const ids = catalogIds(catalog);
  const unknown = [...new Set(journeys.map(({ useCaseId }) => useCaseId).filter((id) => !ids.has(id)))];
  if (unknown.length) {
    throw new JourneyReportError(`journey report names uncatalogued use cases: ${unknown.sort().join(', ')}`);
  }
}

function catalogIds(catalog) {
  let entries;
  if (catalog instanceof Set || Array.isArray(catalog)) entries = [...catalog];
  else if (Array.isArray(catalog?.use_cases)) entries = catalog.use_cases.map((entry) => entry?.id);
  else if (Array.isArray(catalog?.useCases)) entries = catalog.useCases.map((entry) => entry?.id);
  else throw new JourneyReportError('catalog must contain use-case ids');
  if (entries.some((entry) => typeof entry !== 'string' || !USE_CASE_ID.test(entry))) {
    throw new JourneyReportError('catalog contains an invalid use-case id');
  }
  return new Set(entries);
}

function stepRecordId(useCaseId, journeyId, stepId) {
  return `step.${useCaseId}.${journeyId}.${stepId}`;
}

function compareJourneyIdentity(left, right) {
  return left.useCaseId.localeCompare(right.useCaseId) || left.journeyId.localeCompare(right.journeyId);
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JourneyReportError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameStrings(actual, wanted)) {
    throw new JourneyReportError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertOptionKeys(value, allowed, path) {
  assertMap(value, path);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new JourneyReportError(`${path} has unknown field ${unknown[0]}`);
}

function assertId(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new JourneyReportError(`${path} has invalid id ${JSON.stringify(value)}`);
  }
}

function assertMeasurement(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JourneyReportError(`${path} must be a non-negative safe integer`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JourneyReportError(`${path} must be non-empty text`);
  }
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
