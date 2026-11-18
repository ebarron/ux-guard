import {
  JOURNEY_METRICS,
  validateJourneyReport,
} from './journeys.mjs';
import { canonicalize, sha256 } from './run-contract.mjs';

export const OWNER_TARGETS_KIND = 'ux-guard-owner-targets';
export const OWNER_TARGETS_VERSION = 2;
export const TARGET_ATTAINMENT_KIND = 'ux-guard-target-attainment';
export const TARGET_ATTAINMENT_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const APPROVAL_STATUSES = new Set(['candidate', 'reviewed']);
const OPERATORS = new Set(['at-most', 'at-least', 'exactly']);
const ATTAINMENT_STATUSES = new Set([
  'met',
  'breached',
  'partial',
  'not-configured',
  'not-evaluated',
  'incompatible',
]);
const RESULT_STATUSES = new Set(['met', 'breached', 'not-evaluated']);
const EXECUTION_STATUSES = new Set([
  'successful',
  'failed',
  'skipped',
  'unexecutable',
  'infrastructure-error',
  'unmeasured',
]);
const HARD_FLOORS = Object.freeze([
  ['minimumMeasuredVariants', 'at-least', (report) => report.run.completion.received],
  ['minimumSuccessfulVariants', 'at-least', (report) => report.run.completion.successful],
  ['maximumUnexecutableVariants', 'at-most', (report) => report.run.completion.unexecutable],
  ['maximumFailedVariants', 'at-most', (report) => report.run.completion.failed],
  ['maximumSkippedVariants', 'at-most', (report) => report.run.completion.skipped],
  [
    'maximumInfrastructureErrorVariants',
    'at-most',
    (report) => report.run.completion.infrastructureError,
  ],
  [
    'maximumCriticalFindings',
    'at-most',
    (report) =>
      report.findings.filter((finding) => finding.severity === 'critical').length,
  ],
]);
const HARD_FLOOR_IDS = new Set(HARD_FLOORS.map(([id]) => id));

export const OWNER_TARGETS_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:owner-targets:v2',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'canonicalHash',
    'approval',
    'policy',
    'requirements',
    'metrics',
    'metricPolicy',
    'hardFloors',
    'sourceArtifacts',
  ],
  properties: {
    kind: { const: OWNER_TARGETS_KIND },
    version: { const: OWNER_TARGETS_VERSION },
    canonicalHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    approval: { type: 'object', additionalProperties: false },
    policy: { type: 'object', additionalProperties: false },
    requirements: { type: 'array' },
    metrics: { type: 'array' },
    metricPolicy: { type: 'object', additionalProperties: false },
    hardFloors: { type: 'object', additionalProperties: false },
    sourceArtifacts: { type: 'array' },
  },
});

export const TARGET_ATTAINMENT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:target-attainment:v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'status',
    'reason',
    'canonicalHash',
    'summary',
    'hardFloors',
    'journeys',
  ],
  properties: {
    kind: { const: TARGET_ATTAINMENT_KIND },
    version: { const: TARGET_ATTAINMENT_VERSION },
    status: { enum: [...ATTAINMENT_STATUSES] },
    reason: { type: 'string' },
    canonicalHash: { type: ['string', 'null'] },
    summary: { type: 'object', additionalProperties: false },
    hardFloors: { type: 'array' },
    journeys: { type: 'array' },
  },
});

export class OwnerTargetsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnerTargetsError';
  }
}

export function validateOwnerTargets(targets) {
  assertMap(targets, 'targets');
  assertExactKeys(
    targets,
    [
      'kind',
      'version',
      'canonicalHash',
      'approval',
      'policy',
      'requirements',
      'metrics',
      'metricPolicy',
      'hardFloors',
      'sourceArtifacts',
    ],
    'targets',
  );
  if (
    targets.kind !== OWNER_TARGETS_KIND ||
    targets.version !== OWNER_TARGETS_VERSION
  ) {
    throw new OwnerTargetsError('targets have an unsupported kind or version');
  }
  if (
    typeof targets.canonicalHash !== 'string' ||
    !DIGEST.test(targets.canonicalHash) ||
    targets.canonicalHash !== ownerTargetsHash(targets)
  ) {
    throw new OwnerTargetsError('targets canonicalHash does not match canonical content');
  }
  validateApproval(targets.approval);
  validatePolicy(targets.policy);
  validateRequirements(targets.requirements);
  validateMetrics(targets.metrics);
  validateMetricPolicy(targets.metricPolicy);
  validateHardFloors(targets.hardFloors);
  validateArtifacts(targets.sourceArtifacts);
  return targets;
}

export function parseOwnerTargets(text) {
  if (typeof text !== 'string') throw new OwnerTargetsError('owner targets must be JSON text');
  let targets;
  try {
    targets = JSON.parse(text);
  } catch {
    throw new OwnerTargetsError('owner targets are not valid JSON');
  }
  if (
    targets?.kind === OWNER_TARGETS_KIND &&
    targets.version !== OWNER_TARGETS_VERSION
  ) {
    throw new OwnerTargetsError(
      `unsupported owner targets version ${String(targets.version)}; migrate to version ${OWNER_TARGETS_VERSION}`,
    );
  }
  return validateOwnerTargets(targets);
}

export function serializeOwnerTargets(targets) {
  validateOwnerTargets(targets);
  return `${JSON.stringify(canonicalize(targets), null, 2)}\n`;
}

export function ownerTargetsHash(targets) {
  const content = structuredClone(targets);
  delete content.canonicalHash;
  return `sha256:${sha256(content)}`;
}

export function evaluateTargetAttainment({ targets, report } = {}) {
  validateOwnerTargets(targets);
  validateJourneyReport(report);
  if (targets.approval.status !== 'reviewed') {
    throw new OwnerTargetsError('only reviewed owner targets can be evaluated');
  }

  const hardFloors = HARD_FLOORS.map(([id, operator, actualValue]) => {
    const target = targets.hardFloors[id];
    const actual = actualValue(report);
    return {
      id,
      operator,
      target,
      actual,
      status: targetStatus(operator, actual, target),
    };
  });
  const measurements = new Map(
    report.journeys.map((journey) => [journey.id, journey]),
  );
  const grouped = new Map();
  for (const target of targets.metrics) {
    const measurement = measurements.get(target.journeyRef);
    const actual =
      measurement?.status === 'successful' &&
      measurement.metrics &&
      Object.hasOwn(measurement.metrics, target.metric)
        ? measurement.metrics[target.metric]
        : null;
    const metric = {
      metric: target.metric,
      operator: target.operator,
      target: target.value,
      actual,
      status:
        actual === null
          ? 'not-evaluated'
          : targetStatus(target.operator, actual, target.value),
    };
    const journey =
      grouped.get(target.journeyRef) ??
      {
        journeyRef: target.journeyRef,
        useCaseId: measurement?.useCaseId ?? useCaseFromJourneyRef(target.journeyRef),
        executionStatus: measurement?.status ?? 'unmeasured',
        status: 'not-evaluated',
        metrics: [],
      };
    journey.metrics.push(metric);
    grouped.set(target.journeyRef, journey);
  }
  const journeys = [...grouped.values()]
    .map((journey) => ({
      ...journey,
      status: combinedJourneyTargetStatus(
        journey.metrics.map(({ status }) => status),
      ),
      metrics: journey.metrics.sort((left, right) =>
        left.metric.localeCompare(right.metric),
      ),
    }))
    .sort((left, right) => left.journeyRef.localeCompare(right.journeyRef));
  const results = [
    ...hardFloors.map(({ status }) => status),
    ...journeys.flatMap((journey) =>
      journey.metrics.map(({ status }) => status),
    ),
  ];
  const summary = targetSummary(results);
  const status = combinedTargetStatus(results);
  const attainment = {
    kind: TARGET_ATTAINMENT_KIND,
    version: TARGET_ATTAINMENT_VERSION,
    status,
    reason:
      status === 'breached'
        ? `${summary.breached} configured target${summary.breached === 1 ? '' : 's'} breached.`
        : status === 'partial'
          ? `${summary.notEvaluated} configured target${summary.notEvaluated === 1 ? '' : 's'} could not be evaluated.`
          : 'Every configured target was attained.',
    canonicalHash: targets.canonicalHash,
    summary,
    hardFloors,
    journeys,
  };
  return validateTargetAttainment(attainment);
}

export function unavailableTargetAttainment(
  status,
  reason,
  canonicalHash = null,
) {
  if (!['not-configured', 'not-evaluated', 'incompatible'].includes(status)) {
    throw new OwnerTargetsError('unavailable target attainment status is invalid');
  }
  assertText(reason, 'reason');
  const attainment = {
    kind: TARGET_ATTAINMENT_KIND,
    version: TARGET_ATTAINMENT_VERSION,
    status,
    reason,
    canonicalHash,
    summary: {
      configured: 0,
      evaluated: 0,
      met: 0,
      breached: 0,
      notEvaluated: 0,
    },
    hardFloors: [],
    journeys: [],
  };
  return validateTargetAttainment(attainment);
}

export function validateTargetAttainment(attainment) {
  assertMap(attainment, 'attainment');
  assertExactKeys(
    attainment,
    [
      'kind',
      'version',
      'status',
      'reason',
      'canonicalHash',
      'summary',
      'hardFloors',
      'journeys',
    ],
    'attainment',
  );
  if (
    attainment.kind !== TARGET_ATTAINMENT_KIND ||
    attainment.version !== TARGET_ATTAINMENT_VERSION
  ) {
    throw new OwnerTargetsError('target attainment has an unsupported contract');
  }
  if (!ATTAINMENT_STATUSES.has(attainment.status)) {
    throw new OwnerTargetsError('attainment.status is invalid');
  }
  assertText(attainment.reason, 'attainment.reason');
  if (
    attainment.canonicalHash !== null &&
    (typeof attainment.canonicalHash !== 'string' ||
      !DIGEST.test(attainment.canonicalHash))
  ) {
    throw new OwnerTargetsError('attainment.canonicalHash is invalid');
  }
  assertMap(attainment.summary, 'attainment.summary');
  assertExactKeys(
    attainment.summary,
    ['configured', 'evaluated', 'met', 'breached', 'notEvaluated'],
    'attainment.summary',
  );
  for (const [name, value] of Object.entries(attainment.summary)) {
    assertCount(value, `attainment.summary.${name}`);
  }
  if (
    !Array.isArray(attainment.hardFloors) ||
    !Array.isArray(attainment.journeys)
  ) {
    throw new OwnerTargetsError(
      'attainment hardFloors and journeys must be arrays',
    );
  }
  const floorIds = new Set();
  for (const [index, floor] of attainment.hardFloors.entries()) {
    const path = `attainment.hardFloors[${index}]`;
    validateTargetResult(floor, path, true);
    if (floorIds.has(floor.id)) {
      throw new OwnerTargetsError(`${path}.id is duplicated`);
    }
    floorIds.add(floor.id);
    if (floor.status === 'not-evaluated') {
      throw new OwnerTargetsError(`${path} must always be evaluated`);
    }
  }
  const journeyIds = new Set();
  const resultStatuses = attainment.hardFloors.map(({ status }) => status);
  for (const [index, journey] of attainment.journeys.entries()) {
    const path = `attainment.journeys[${index}]`;
    assertMap(journey, path);
    assertExactKeys(
      journey,
      [
        'journeyRef',
        'useCaseId',
        'executionStatus',
        'status',
        'metrics',
      ],
      path,
    );
    assertId(journey.journeyRef, `${path}.journeyRef`);
    assertId(journey.useCaseId, `${path}.useCaseId`);
    if (journeyIds.has(journey.journeyRef)) {
      throw new OwnerTargetsError(`${path}.journeyRef is duplicated`);
    }
    journeyIds.add(journey.journeyRef);
    if (!EXECUTION_STATUSES.has(journey.executionStatus)) {
      throw new OwnerTargetsError(`${path}.executionStatus is invalid`);
    }
    if (!RESULT_STATUSES.has(journey.status)) {
      throw new OwnerTargetsError(`${path}.status is invalid`);
    }
    if (!Array.isArray(journey.metrics) || journey.metrics.length === 0) {
      throw new OwnerTargetsError(`${path}.metrics must not be empty`);
    }
    const metrics = new Set();
    for (const [metricIndex, metric] of journey.metrics.entries()) {
      const metricPath = `${path}.metrics[${metricIndex}]`;
      validateTargetResult(metric, metricPath, false);
      if (metrics.has(metric.metric)) {
        throw new OwnerTargetsError(`${metricPath}.metric is duplicated`);
      }
      metrics.add(metric.metric);
      resultStatuses.push(metric.status);
    }
    if (
      journey.status !==
      combinedJourneyTargetStatus(journey.metrics.map(({ status }) => status))
    ) {
      throw new OwnerTargetsError(`${path}.status does not match its metrics`);
    }
  }
  const summary = targetSummary(resultStatuses);
  if (
    Object.entries(summary).some(
      ([name, value]) => attainment.summary[name] !== value,
    )
  ) {
    throw new OwnerTargetsError('attainment.summary does not match its results');
  }
  const available = ['met', 'breached', 'partial'].includes(attainment.status);
  if (
    available &&
    attainment.status !== combinedTargetStatus(resultStatuses)
  ) {
    throw new OwnerTargetsError('attainment.status does not match its results');
  }
  if (
    !available &&
    (resultStatuses.length !== 0 || attainment.canonicalHash !== null &&
      attainment.status === 'not-configured')
  ) {
    throw new OwnerTargetsError('unavailable target attainment is inconsistent');
  }
  return attainment;
}

function validateTargetResult(result, path, floor) {
  assertMap(result, path);
  assertExactKeys(
    result,
    floor
      ? ['id', 'operator', 'target', 'actual', 'status']
      : ['metric', 'operator', 'target', 'actual', 'status'],
    path,
  );
  if (floor) {
    if (!HARD_FLOOR_IDS.has(result.id)) {
      throw new OwnerTargetsError(`${path}.id is invalid`);
    }
  }
  else if (!JOURNEY_METRICS.includes(result.metric)) {
    throw new OwnerTargetsError(`${path}.metric is invalid`);
  }
  if (!OPERATORS.has(result.operator)) {
    throw new OwnerTargetsError(`${path}.operator is invalid`);
  }
  assertCount(result.target, `${path}.target`);
  if (result.actual !== null) assertCount(result.actual, `${path}.actual`);
  if (!RESULT_STATUSES.has(result.status)) {
    throw new OwnerTargetsError(`${path}.status is invalid`);
  }
  if (
    (result.actual === null) !== (result.status === 'not-evaluated') ||
    (result.actual !== null &&
      result.status !== targetStatus(result.operator, result.actual, result.target))
  ) {
    throw new OwnerTargetsError(`${path}.status does not match its values`);
  }
}

function targetStatus(operator, actual, target) {
  const met =
    operator === 'at-most'
      ? actual <= target
      : operator === 'at-least'
        ? actual >= target
        : actual === target;
  return met ? 'met' : 'breached';
}

function combinedTargetStatus(statuses) {
  if (statuses.includes('breached')) return 'breached';
  if (statuses.includes('not-evaluated')) return 'partial';
  return 'met';
}

function combinedJourneyTargetStatus(statuses) {
  if (statuses.includes('breached')) return 'breached';
  if (statuses.includes('not-evaluated')) return 'not-evaluated';
  return 'met';
}

function targetSummary(statuses) {
  const met = statuses.filter((status) => status === 'met').length;
  const breached = statuses.filter((status) => status === 'breached').length;
  const notEvaluated = statuses.filter(
    (status) => status === 'not-evaluated',
  ).length;
  return {
    configured: statuses.length,
    evaluated: met + breached,
    met,
    breached,
    notEvaluated,
  };
}

function useCaseFromJourneyRef(journeyRef) {
  const match = /^journey\.([a-z0-9]+(?:[._-][a-z0-9]+)*)\./.exec(journeyRef);
  return match?.[1] ?? 'unknown';
}

function validateApproval(approval) {
  assertMap(approval, 'targets.approval');
  assertExactKeys(
    approval,
    ['status', 'reviewer', 'reviewedAt', 'rationale'],
    'targets.approval',
  );
  if (!APPROVAL_STATUSES.has(approval.status)) {
    throw new OwnerTargetsError('targets.approval.status is invalid');
  }
  if (approval.status === 'candidate') {
    if (
      approval.reviewer !== null ||
      approval.reviewedAt !== null ||
      approval.rationale !== null
    ) {
      throw new OwnerTargetsError('candidate targets cannot claim review metadata');
    }
    return;
  }
  assertText(approval.reviewer, 'targets.approval.reviewer');
  assertTimestamp(approval.reviewedAt, 'targets.approval.reviewedAt');
  assertText(approval.rationale, 'targets.approval.rationale');
}

function validatePolicy(policy) {
  assertMap(policy, 'targets.policy');
  assertExactKeys(policy, ['algorithm', 'digest'], 'targets.policy');
  if (
    policy.algorithm !== 'sha256' ||
    typeof policy.digest !== 'string' ||
    !DIGEST.test(policy.digest)
  ) {
    throw new OwnerTargetsError('targets.policy is invalid');
  }
}

function validateRequirements(requirements) {
  if (!Array.isArray(requirements)) {
    throw new OwnerTargetsError('targets.requirements must be an array');
  }
  const ids = new Set();
  for (const [index, requirement] of requirements.entries()) {
    const path = `targets.requirements[${index}]`;
    assertMap(requirement, path);
    assertExactKeys(
      requirement,
      ['useCaseId', 'statements'],
      path,
    );
    assertId(requirement.useCaseId, `${path}.useCaseId`);
    if (ids.has(requirement.useCaseId)) {
      throw new OwnerTargetsError(`targets.requirements repeats ${requirement.useCaseId}`);
    }
    ids.add(requirement.useCaseId);
    if (
      !Array.isArray(requirement.statements) ||
      requirement.statements.length === 0 ||
      new Set(requirement.statements).size !== requirement.statements.length ||
      requirement.statements.some(
        (statement) => typeof statement !== 'string' || !statement.trim(),
      )
    ) {
      throw new OwnerTargetsError(`${path}.statements must be unique non-empty text`);
    }
  }
}

function validateMetrics(metrics) {
  if (!Array.isArray(metrics)) {
    throw new OwnerTargetsError('targets.metrics must be an array');
  }
  const ids = new Set();
  for (const [index, target] of metrics.entries()) {
    const path = `targets.metrics[${index}]`;
    assertMap(target, path);
    assertExactKeys(
      target,
      ['journeyRef', 'metric', 'operator', 'value'],
      path,
    );
    assertId(target.journeyRef, `${path}.journeyRef`);
    if (!JOURNEY_METRICS.includes(target.metric)) {
      throw new OwnerTargetsError(`${path}.metric is invalid`);
    }
    if (!OPERATORS.has(target.operator)) {
      throw new OwnerTargetsError(`${path}.operator is invalid`);
    }
    assertCount(target.value, `${path}.value`);
    const id = `${target.journeyRef}\0${target.metric}`;
    if (ids.has(id)) throw new OwnerTargetsError(`${path} duplicates a metric target`);
    ids.add(id);
  }
}

function validateMetricPolicy(metricPolicy) {
  assertMap(metricPolicy, 'targets.metricPolicy');
  assertExactKeys(
    metricPolicy,
    ['nonRegressionAfterReview', 'reportOnlyUntilCalibrated'],
    'targets.metricPolicy',
  );
  for (const field of [
    'nonRegressionAfterReview',
    'reportOnlyUntilCalibrated',
  ]) {
    const metrics = metricPolicy[field];
    if (
      !Array.isArray(metrics) ||
      metrics.length === 0 ||
      new Set(metrics).size !== metrics.length ||
      metrics.some((metric) => !JOURNEY_METRICS.includes(metric))
    ) {
      throw new OwnerTargetsError(
        `targets.metricPolicy.${field} must contain unique journey metrics`,
      );
    }
  }
  const nonRegression = new Set(metricPolicy.nonRegressionAfterReview);
  const reportOnly = new Set(metricPolicy.reportOnlyUntilCalibrated);
  if (
    metricPolicy.nonRegressionAfterReview.some((metric) =>
      reportOnly.has(metric),
    )
  ) {
    throw new OwnerTargetsError('targets.metricPolicy groups must be disjoint');
  }
  if (
    JOURNEY_METRICS.some(
      (metric) => !nonRegression.has(metric) && !reportOnly.has(metric),
    )
  ) {
    throw new OwnerTargetsError(
      'targets.metricPolicy must classify every journey metric',
    );
  }
}

function validateHardFloors(floors) {
  assertMap(floors, 'targets.hardFloors');
  assertExactKeys(
    floors,
    [
      'minimumMeasuredVariants',
      'minimumSuccessfulVariants',
      'maximumUnexecutableVariants',
      'maximumFailedVariants',
      'maximumSkippedVariants',
      'maximumInfrastructureErrorVariants',
      'maximumCriticalFindings',
    ],
    'targets.hardFloors',
  );
  for (const [name, value] of Object.entries(floors)) {
    assertCount(value, `targets.hardFloors.${name}`);
  }
}

function validateArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    throw new OwnerTargetsError('targets.sourceArtifacts must be an array');
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    const path = `targets.sourceArtifacts[${index}]`;
    assertMap(artifact, path);
    assertExactKeys(artifact, ['id', 'path', 'sha256'], path);
    assertId(artifact.id, `${path}.id`);
    assertSafeRelativePath(artifact.path, `${path}.path`);
    if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      throw new OwnerTargetsError(`${path}.sha256 is invalid`);
    }
    if (ids.has(artifact.id)) {
      throw new OwnerTargetsError(`targets.sourceArtifacts repeats id ${artifact.id}`);
    }
    if (paths.has(artifact.path)) {
      throw new OwnerTargetsError(`targets.sourceArtifacts repeats path ${artifact.path}`);
    }
    ids.add(artifact.id);
    paths.add(artifact.path);
  }
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OwnerTargetsError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new OwnerTargetsError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OwnerTargetsError(`${path} must be non-empty text`);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new OwnerTargetsError(`${path} is not a safe id`);
  }
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OwnerTargetsError(`${path} must be a non-negative safe integer`);
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
    throw new OwnerTargetsError(`${path} must be an explicit UTC timestamp`);
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
    throw new OwnerTargetsError(`${path} must be a safe repository-relative path`);
  }
}
