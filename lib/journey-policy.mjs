import {
  EXPLICIT_JOURNEY_METRICS,
  STANDARD_JOURNEY_METRICS,
  validateJourneyCatalog,
  validateJourneyReport,
} from './journeys.mjs';
import { validateObservationRule } from './observations.mjs';
import { canonicalize } from './run-contract.mjs';

export const JOURNEY_POLICY_KIND = 'ux-guard-journey-policy';
export const JOURNEY_POLICY_VERSION = 3;
export const JOURNEY_ARTIFACT_KIND = 'ux-guard-journey-artifact';
export const JOURNEY_ARTIFACT_VERSION = 2;

const USE_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VARIANTS = new Set(['canonical', 'alternative', 'required']);
const APPROVAL_STATUSES = new Set(['candidate', 'owner-approved']);
const AUTOMATION_STATUSES = new Set(['missing', 'bound']);
const ELAPSED_SOURCES = new Set(['mocked', 'logical', 'wall-clock']);
const EXECUTION_STATUSES = new Set([
  'unmeasured',
  'successful',
  'failed',
  'skipped',
  'unexecutable',
  'infrastructure-error',
]);

export class JourneyPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyPolicyError';
  }
}

export function createJourneyPolicy(journeys = [], { coverage, rules = [] } = {}) {
  if (!Array.isArray(journeys)) throw new JourneyPolicyError('journeys must be an array');
  const normalized = structuredClone(journeys);
  for (const journey of normalized) {
    if (Array.isArray(journey?.measurements?.explicit)) {
      journey.measurements.explicit.sort(
        (left, right) =>
          EXPLICIT_JOURNEY_METRICS.indexOf(left) - EXPLICIT_JOURNEY_METRICS.indexOf(right),
      );
    }
  }
  const policy = {
    kind: JOURNEY_POLICY_KIND,
    version: JOURNEY_POLICY_VERSION,
    coverage: coverage === undefined ? defaultCoverage(normalized) : structuredClone(coverage),
    rules: structuredClone(rules).sort((left, right) =>
      String(left?.ruleId).localeCompare(String(right?.ruleId)),
    ),
    journeys: normalized.sort(compareJourneyIdentity),
  };
  policy.coverage.sort((left, right) => String(left?.useCaseId).localeCompare(String(right?.useCaseId)));
  return validateJourneyPolicy(policy);
}

export function validateJourneyPolicy(policy) {
  assertMap(policy, 'policy');
  assertExactKeys(policy, ['kind', 'version', 'coverage', 'rules', 'journeys'], 'policy');
  if (policy.kind !== JOURNEY_POLICY_KIND) {
    throw new JourneyPolicyError(`policy.kind must be ${JOURNEY_POLICY_KIND}`);
  }
  if (policy.version !== JOURNEY_POLICY_VERSION) {
    throw new JourneyPolicyError(
      `unsupported journey policy version ${String(policy.version)}; migrate to version ${JOURNEY_POLICY_VERSION}`,
    );
  }
  if (!Array.isArray(policy.journeys) || !Array.isArray(policy.rules)) {
    throw new JourneyPolicyError('policy.journeys and policy.rules must be arrays');
  }
  const coverage = validateCoveragePolicy(policy.coverage);
  const identities = new Set();
  const canonical = new Set();
  for (const [index, journey] of policy.journeys.entries()) {
    validateDefinition(journey, `policy.journeys[${index}]`);
    const identity = journeyIdentity(journey);
    if (identities.has(identity)) {
      throw new JourneyPolicyError(`duplicate journey ${journey.useCaseId}/${journey.journeyId}`);
    }
    identities.add(identity);
    if (journey.variant === 'canonical') {
      if (canonical.has(journey.useCaseId)) {
        throw new JourneyPolicyError(`${journey.useCaseId} has more than one canonical journey`);
      }
      canonical.add(journey.useCaseId);
    }
  }
  for (const [useCaseId, variants] of coverage) {
    for (const variant of variants) {
      if (!identities.has(`${useCaseId}\0${variant.journeyId}`)) {
        throw new JourneyPolicyError(
          `required variant ${useCaseId}/${variant.journeyId} has no journey definition`,
        );
      }
    }
  }
  const ruleIds = new Set();
  for (const [index, rule] of policy.rules.entries()) {
    try {
      validateObservationRule(rule, `policy.rules[${index}]`);
    } catch (error) {
      throw new JourneyPolicyError(error.message);
    }
    if (ruleIds.has(rule.ruleId)) throw new JourneyPolicyError(`duplicate rule ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);
    if (!policy.journeys.some((journey) => journey.useCaseId === rule.useCaseId)) {
      throw new JourneyPolicyError(`rule ${rule.ruleId} names unknown use case ${rule.useCaseId}`);
    }
    for (const journeyId of rule.journeyIds) {
      if (!identities.has(`${rule.useCaseId}\0${journeyId}`)) {
        throw new JourneyPolicyError(`rule ${rule.ruleId} names unknown journey ${journeyId}`);
      }
    }
  }
  return policy;
}

export function parseJourneyPolicy(text) {
  if (typeof text !== 'string') throw new JourneyPolicyError('journey policy must be JSON text');
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    throw new JourneyPolicyError('journey policy is not valid JSON');
  }
  if (policy?.kind === JOURNEY_POLICY_KIND && policy.version !== JOURNEY_POLICY_VERSION) {
    throw new JourneyPolicyError(
      `unsupported journey policy version ${String(policy.version)}; migrate to version ${JOURNEY_POLICY_VERSION}`,
    );
  }
  return validateJourneyPolicy(policy);
}

export function serializeJourneyPolicy(policy) {
  validateJourneyPolicy(policy);
  return `${JSON.stringify(canonicalize(policy), null, 2)}\n`;
}

export function createJourneyArtifact({ catalog, policy, report = null } = {}) {
  validateJourneyPolicy(policy);
  const catalogSet = catalogIds(catalog);
  if (report !== null) {
    validateJourneyReport(report);
    validateJourneyCatalog(report, catalog);
  }
  const definitions = new Map(
    policy.journeys.map((journey) => [journeyIdentity(journey), journey]),
  );
  for (const journey of policy.journeys) {
    if (!catalogSet.has(journey.useCaseId)) {
      throw new JourneyPolicyError(`journey policy names uncatalogued use case ${journey.useCaseId}`);
    }
  }
  const measured = new Map(
    (report?.journeys ?? []).map((journey) => [
      `${journey.useCaseId}\0${journey.journeyId}`,
      journey,
    ]),
  );
  for (const journey of report?.journeys ?? []) {
    if (!definitions.has(`${journey.useCaseId}\0${journey.journeyId}`)) {
      throw new JourneyPolicyError(
        `measurement has no journey policy for ${journey.useCaseId}/${journey.journeyId}`,
      );
    }
  }

  const findings = [];
  const useCases = policy.coverage.map((useCase) => {
    if (!catalogSet.has(useCase.useCaseId)) {
      throw new JourneyPolicyError(
        `journey coverage policy names uncatalogued use case ${useCase.useCaseId}`,
      );
    }
    const variants = useCase.requiredVariants.map((required) => {
      const identity = `${useCase.useCaseId}\0${required.journeyId}`;
      const definition = definitions.get(identity);
      const measurement = measured.get(identity);
      if (definition.approval.status !== 'owner-approved') {
        findings.push(finding('required-variant-owner-approval-required', useCase.useCaseId, required));
      }
      if (definition.automation.status !== 'bound') {
        findings.push(finding('required-variant-executable-coverage-required', useCase.useCaseId, required));
      }
      if (!measurement) {
        findings.push(finding('required-variant-measurement-missing', useCase.useCaseId, required));
      } else {
        if (!measurementMatchesReference(measurement, definition)) {
          findings.push(finding('measurement-contract-mismatch', useCase.useCaseId, required));
        }
        if (measurement.status !== 'successful') {
          findings.push(
            finding(`required-variant-${measurement.status}`, useCase.useCaseId, required),
          );
        }
      }
      return {
        variantId: required.variantId,
        label: required.label,
        journeyId: required.journeyId,
        approval: definition.approval.status,
        automation: definition.automation.status,
        executionStatus: measurement?.status ?? 'unmeasured',
      };
    });
    return { useCaseId: useCase.useCaseId, variants };
  });
  for (const useCaseId of catalogSet) {
    if (!policy.coverage.some((entry) => entry.useCaseId === useCaseId)) {
      findings.push({
        rule: 'required-use-case-coverage-missing',
        scope: 'final-enforcement',
        useCaseId,
      });
    }
  }
  const requiredVariants = useCases.reduce((total, useCase) => total + useCase.variants.length, 0);
  const measuredVariants = useCases.reduce(
    (total, useCase) =>
      total + useCase.variants.filter((variant) => variant.executionStatus !== 'unmeasured').length,
    0,
  );
  const successfulVariants = useCases.reduce(
    (total, useCase) =>
      total + useCase.variants.filter((variant) => variant.executionStatus === 'successful').length,
    0,
  );
  const artifact = {
    kind: JOURNEY_ARTIFACT_KIND,
    version: JOURNEY_ARTIFACT_VERSION,
    rollout: 'advisory',
    coverage: {
      cataloguedUseCases: catalogSet.size,
      requiredVariants,
      measuredVariants,
      successfulVariants,
      useCases,
      findings: findings.sort(compareFinding),
    },
    measurementReport: report
      ? {
          kind: report.kind,
          version: report.version,
          policyDigest: report.run.policy.digest,
        }
      : null,
  };
  return validateJourneyArtifact(artifact);
}

export function validateJourneyArtifact(artifact) {
  assertMap(artifact, 'artifact');
  assertExactKeys(
    artifact,
    ['kind', 'version', 'rollout', 'coverage', 'measurementReport'],
    'artifact',
  );
  if (
    artifact.kind !== JOURNEY_ARTIFACT_KIND ||
    artifact.version !== JOURNEY_ARTIFACT_VERSION
  ) {
    throw new JourneyPolicyError('journey artifact has an unsupported kind or version');
  }
  if (artifact.rollout !== 'advisory') {
    throw new JourneyPolicyError('artifact.rollout must be advisory');
  }
  const coverage = artifact.coverage;
  assertMap(coverage, 'artifact.coverage');
  assertExactKeys(
    coverage,
    [
      'cataloguedUseCases',
      'requiredVariants',
      'measuredVariants',
      'successfulVariants',
      'useCases',
      'findings',
    ],
    'artifact.coverage',
  );
  for (const field of [
    'cataloguedUseCases',
    'requiredVariants',
    'measuredVariants',
    'successfulVariants',
  ]) {
    assertCount(coverage[field], `artifact.coverage.${field}`);
  }
  if (
    coverage.successfulVariants > coverage.measuredVariants ||
    coverage.measuredVariants > coverage.requiredVariants
  ) {
    throw new JourneyPolicyError('artifact.coverage counts are inconsistent');
  }
  if (!Array.isArray(coverage.useCases) || !Array.isArray(coverage.findings)) {
    throw new JourneyPolicyError('artifact.coverage useCases and findings must be arrays');
  }
  const requiredCount = coverage.useCases.reduce((total, useCase, index) => {
    const path = `artifact.coverage.useCases[${index}]`;
    assertMap(useCase, path);
    assertExactKeys(useCase, ['useCaseId', 'variants'], path);
    assertId(useCase.useCaseId, USE_CASE_ID, `${path}.useCaseId`);
    if (!Array.isArray(useCase.variants) || useCase.variants.length === 0) {
      throw new JourneyPolicyError(`${path}.variants must be a non-empty array`);
    }
    useCase.variants.forEach((variant, variantIndex) =>
      validateArtifactVariant(variant, `${path}.variants[${variantIndex}]`),
    );
    return total + useCase.variants.length;
  }, 0);
  if (
    coverage.useCases.length > coverage.cataloguedUseCases ||
    requiredCount !== coverage.requiredVariants
  ) {
    throw new JourneyPolicyError('artifact.coverage inventory counts are inconsistent');
  }
  if (artifact.measurementReport !== null) {
    assertMap(artifact.measurementReport, 'artifact.measurementReport');
    assertExactKeys(
      artifact.measurementReport,
      ['kind', 'version', 'policyDigest'],
      'artifact.measurementReport',
    );
    assertText(artifact.measurementReport.kind, 'artifact.measurementReport.kind');
    assertCount(artifact.measurementReport.version, 'artifact.measurementReport.version');
    assertText(artifact.measurementReport.policyDigest, 'artifact.measurementReport.policyDigest');
  }
  return artifact;
}

export function serializeJourneyArtifact(artifact) {
  validateJourneyArtifact(artifact);
  return `${JSON.stringify(canonicalize(artifact), null, 2)}\n`;
}

export function parseJourneyArtifact(text) {
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch {
    throw new JourneyPolicyError('journey artifact is not valid JSON');
  }
  if (artifact?.kind === JOURNEY_ARTIFACT_KIND && artifact.version !== JOURNEY_ARTIFACT_VERSION) {
    throw new JourneyPolicyError(
      `unsupported journey artifact version ${String(artifact.version)}; migrate to version ${JOURNEY_ARTIFACT_VERSION}`,
    );
  }
  return validateJourneyArtifact(artifact);
}

export function assertJourneyEnforcementReady(artifact) {
  validateJourneyArtifact(artifact);
  if (artifact.coverage.findings.length) {
    throw new JourneyPolicyError(
      `journey coverage is not ready for final enforcement: ${artifact.coverage.findings
        .map((value) => `${value.useCaseId}:${value.rule}`)
        .join(', ')}`,
    );
  }
  return artifact;
}

function defaultCoverage(journeys) {
  const byUseCase = new Map();
  for (const journey of journeys) {
    const entry = byUseCase.get(journey.useCaseId) ?? {
      useCaseId: journey.useCaseId,
      requiredVariants: [],
    };
    entry.requiredVariants.push({
      variantId: journey.journeyId,
      label: journey.journeyId,
      journeyId: journey.journeyId,
    });
    byUseCase.set(journey.useCaseId, entry);
  }
  return [...byUseCase.values()];
}

function validateCoveragePolicy(coverage) {
  if (!Array.isArray(coverage)) throw new JourneyPolicyError('policy.coverage must be an array');
  const result = new Map();
  for (const [index, useCase] of coverage.entries()) {
    const path = `policy.coverage[${index}]`;
    assertMap(useCase, path);
    assertExactKeys(useCase, ['useCaseId', 'requiredVariants'], path);
    assertId(useCase.useCaseId, USE_CASE_ID, `${path}.useCaseId`);
    if (result.has(useCase.useCaseId)) {
      throw new JourneyPolicyError(`policy.coverage repeats ${useCase.useCaseId}`);
    }
    if (!Array.isArray(useCase.requiredVariants) || useCase.requiredVariants.length === 0) {
      throw new JourneyPolicyError(`${path}.requiredVariants must be a non-empty array`);
    }
    const ids = new Set();
    for (const [variantIndex, variant] of useCase.requiredVariants.entries()) {
      const variantPath = `${path}.requiredVariants[${variantIndex}]`;
      assertMap(variant, variantPath);
      assertExactKeys(variant, ['variantId', 'label', 'journeyId'], variantPath);
      assertId(variant.variantId, ID, `${variantPath}.variantId`);
      assertId(variant.journeyId, ID, `${variantPath}.journeyId`);
      assertText(variant.label, `${variantPath}.label`);
      if (ids.has(variant.journeyId)) {
        throw new JourneyPolicyError(`${path}.requiredVariants repeats ${variant.journeyId}`);
      }
      ids.add(variant.journeyId);
    }
    result.set(useCase.useCaseId, useCase.requiredVariants);
  }
  return result;
}

function validateDefinition(journey, path) {
  assertMap(journey, path);
  assertExactKeys(
    journey,
    ['useCaseId', 'journeyId', 'variant', 'intent', 'approval', 'automation', 'measurements'],
    path,
  );
  assertId(journey.useCaseId, USE_CASE_ID, `${path}.useCaseId`);
  assertId(journey.journeyId, ID, `${path}.journeyId`);
  if (!VARIANTS.has(journey.variant)) throw new JourneyPolicyError(`${path}.variant is invalid`);
  assertMap(journey.intent, `${path}.intent`);
  assertExactKeys(journey.intent, ['summary', 'steps', 'success'], `${path}.intent`);
  assertText(journey.intent.summary, `${path}.intent.summary`);
  assertText(journey.intent.success, `${path}.intent.success`);
  if (
    !Array.isArray(journey.intent.steps) ||
    journey.intent.steps.length === 0 ||
    journey.intent.steps.some((step) => typeof step !== 'string' || !step.trim())
  ) {
    throw new JourneyPolicyError(`${path}.intent.steps must be a non-empty text list`);
  }
  assertMap(journey.approval, `${path}.approval`);
  assertExactKeys(journey.approval, ['status', 'approvedBy'], `${path}.approval`);
  if (!APPROVAL_STATUSES.has(journey.approval.status)) {
    throw new JourneyPolicyError(`${path}.approval.status is invalid`);
  }
  if (journey.approval.status === 'candidate' && journey.approval.approvedBy !== null) {
    throw new JourneyPolicyError(`${path}.approval.approvedBy must be null for candidates`);
  }
  if (journey.approval.status === 'owner-approved') {
    assertText(journey.approval.approvedBy, `${path}.approval.approvedBy`);
  }
  assertMap(journey.automation, `${path}.automation`);
  assertExactKeys(journey.automation, ['status', 'source'], `${path}.automation`);
  if (!AUTOMATION_STATUSES.has(journey.automation.status)) {
    throw new JourneyPolicyError(`${path}.automation.status is invalid`);
  }
  if (journey.automation.status === 'missing' && journey.automation.source !== null) {
    throw new JourneyPolicyError(`${path}.automation.source must be null when missing`);
  }
  if (journey.automation.status === 'bound') {
    assertText(journey.automation.source, `${path}.automation.source`);
  }
  validateMeasurementSelection(journey.measurements, `${path}.measurements`);
}

function validateMeasurementSelection(measurements, path) {
  assertMap(measurements, path);
  assertExactKeys(measurements, ['explicit', 'elapsed'], path);
  if (!Array.isArray(measurements.explicit)) {
    throw new JourneyPolicyError(`${path}.explicit must be an array`);
  }
  const selected = new Set();
  for (const metric of measurements.explicit) {
    if (!EXPLICIT_JOURNEY_METRICS.includes(metric) || selected.has(metric)) {
      throw new JourneyPolicyError(`${path}.explicit is invalid`);
    }
    selected.add(metric);
  }
  if (selected.has('elapsedMs')) {
    assertMap(measurements.elapsed, `${path}.elapsed`);
    assertExactKeys(measurements.elapsed, ['source'], `${path}.elapsed`);
    if (!ELAPSED_SOURCES.has(measurements.elapsed.source)) {
      throw new JourneyPolicyError(`${path}.elapsed.source is invalid`);
    }
  } else if (measurements.elapsed !== null) {
    throw new JourneyPolicyError(`${path}.elapsed must be null without elapsedMs`);
  }
}

function measurementMatchesReference(measurement, definition) {
  if (!measurement.metrics) return true;
  const expected = new Set([
    ...STANDARD_JOURNEY_METRICS,
    ...definition.measurements.explicit,
  ]);
  const actual = Object.keys(measurement.metrics);
  if (actual.length !== expected.size || actual.some((metric) => !expected.has(metric))) {
    return false;
  }
  const elapsed = definition.measurements.elapsed;
  return elapsed ? measurement.timing?.source === elapsed.source : measurement.timing === null;
}

function finding(rule, useCaseId, required) {
  return {
    rule,
    scope: rule === 'measurement-contract-mismatch' ? 'measurement' : 'final-enforcement',
    useCaseId,
    variantId: required.variantId,
    journeyId: required.journeyId,
  };
}

function validateArtifactVariant(variant, path) {
  assertMap(variant, path);
  assertExactKeys(
    variant,
    ['variantId', 'label', 'journeyId', 'approval', 'automation', 'executionStatus'],
    path,
  );
  assertId(variant.variantId, ID, `${path}.variantId`);
  assertText(variant.label, `${path}.label`);
  assertId(variant.journeyId, ID, `${path}.journeyId`);
  if (!APPROVAL_STATUSES.has(variant.approval)) {
    throw new JourneyPolicyError(`${path}.approval is invalid`);
  }
  if (!AUTOMATION_STATUSES.has(variant.automation)) {
    throw new JourneyPolicyError(`${path}.automation is invalid`);
  }
  if (!EXECUTION_STATUSES.has(variant.executionStatus)) {
    throw new JourneyPolicyError(`${path}.executionStatus is invalid`);
  }
}

function catalogIds(catalog) {
  let entries;
  if (catalog instanceof Set || Array.isArray(catalog)) entries = [...catalog];
  else if (Array.isArray(catalog?.use_cases)) entries = catalog.use_cases.map((entry) => entry?.id);
  else if (Array.isArray(catalog?.useCases)) entries = catalog.useCases.map((entry) => entry?.id);
  else throw new JourneyPolicyError('catalog must contain use cases');
  if (entries.some((entry) => typeof entry !== 'string' || !USE_CASE_ID.test(entry))) {
    throw new JourneyPolicyError('catalog contains an invalid use-case id');
  }
  return new Set(entries);
}

function journeyIdentity(journey) {
  return `${journey.useCaseId}\0${journey.journeyId}`;
}

function compareJourneyIdentity(left, right) {
  return left.useCaseId.localeCompare(right.useCaseId) || left.journeyId.localeCompare(right.journeyId);
}

function compareFinding(left, right) {
  return left.useCaseId.localeCompare(right.useCaseId) ||
    left.rule.localeCompare(right.rule) ||
    (left.journeyId ?? '').localeCompare(right.journeyId ?? '');
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JourneyPolicyError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new JourneyPolicyError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertId(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new JourneyPolicyError(`${path} has invalid id ${JSON.stringify(value)}`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JourneyPolicyError(`${path} must be non-empty text`);
  }
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JourneyPolicyError(`${path} must be a non-negative safe integer`);
  }
}
