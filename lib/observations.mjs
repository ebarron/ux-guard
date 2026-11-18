export const OBSERVATION_VERSION = 1;

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const OBSERVATION_DEFINITIONS = Object.freeze({
  'interaction-metrics': {
    required: ['metric', 'value'],
    allowed: ['metric', 'value'],
  },
  'field-required': {
    required: ['concept', 'label', 'required', 'edited'],
    allowed: ['concept', 'label', 'required', 'edited', 'order', 'defaultValue'],
  },
  'accessible-name': {
    required: ['concept', 'role', 'name', 'expectedName'],
    allowed: ['concept', 'role', 'name', 'expectedName'],
  },
  'extra-post-success-decision': {
    required: ['concept', 'decision', 'beforeVisibleCompletion'],
    allowed: ['concept', 'decision', 'beforeVisibleCompletion'],
  },
  'visible-section': {
    required: ['concept', 'visible'],
    allowed: ['concept', 'visible', 'detail'],
  },
  terminology: {
    required: ['concept', 'value', 'rawIdentifier'],
    allowed: ['concept', 'value', 'rawIdentifier'],
  },
  'unsupported-path': {
    required: ['capability', 'currentScope', 'executable'],
    allowed: ['capability', 'currentScope', 'executable'],
  },
  'payload-assertion': {
    required: ['concept', 'expected', 'present'],
    allowed: ['concept', 'expected', 'present', 'value'],
  },
  'action-result-visibility': {
    required: ['concept', 'visible'],
    allowed: ['concept', 'visible', 'value'],
  },
});

export const OBSERVATION_TYPES = Object.freeze(Object.keys(OBSERVATION_DEFINITIONS));

export class ObservationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObservationError';
  }
}

export function createObservation(value) {
  const observation = structuredClone(value);
  validateObservation(observation, 'observation');
  return observation;
}

export function validateObservation(observation, path = 'observation') {
  assertMap(observation, path);
  assertExactKeys(observation, ['id', 'version', 'type', 'stepId', 'data'], path);
  assertId(observation.id, `${path}.id`);
  if (observation.version !== OBSERVATION_VERSION) {
    throw new ObservationError(`${path}.version must be ${OBSERVATION_VERSION}`);
  }
  const definition = OBSERVATION_DEFINITIONS[observation.type];
  if (!definition) throw new ObservationError(`${path}.type is unknown`);
  assertId(observation.stepId, `${path}.stepId`);
  assertMap(observation.data, `${path}.data`);
  const keys = Object.keys(observation.data).sort();
  const allowed = [...definition.allowed].sort();
  if (keys.some((key) => !allowed.includes(key))) {
    throw new ObservationError(`${path}.data has an unknown field`);
  }
  for (const key of definition.required) {
    if (!Object.hasOwn(observation.data, key)) {
      throw new ObservationError(`${path}.data.${key} is required`);
    }
  }
  for (const [key, value] of Object.entries(observation.data)) {
    if (!validFact(value)) {
      throw new ObservationError(`${path}.data.${key} is not a factual scalar`);
    }
  }
  return observation;
}

export function validateObservationRule(rule, path = 'rule') {
  assertMap(rule, path);
  assertExactKeys(
    rule,
    ['ruleId', 'useCaseId', 'journeyIds', 'observation', 'finding', 'policy'],
    path,
  );
  assertId(rule.ruleId, `${path}.ruleId`);
  assertId(rule.useCaseId, `${path}.useCaseId`);
  if (
    !Array.isArray(rule.journeyIds) ||
    rule.journeyIds.some((journeyId) => typeof journeyId !== 'string' || !ID.test(journeyId))
  ) {
    throw new ObservationError(`${path}.journeyIds must contain safe ids`);
  }
  if (new Set(rule.journeyIds).size !== rule.journeyIds.length) {
    throw new ObservationError(`${path}.journeyIds contains duplicates`);
  }
  assertMap(rule.observation, `${path}.observation`);
  assertExactKeys(rule.observation, ['type', 'match'], `${path}.observation`);
  const definition = OBSERVATION_DEFINITIONS[rule.observation.type];
  if (!definition) throw new ObservationError(`${path}.observation.type is unknown`);
  assertMap(rule.observation.match, `${path}.observation.match`);
  if (Object.keys(rule.observation.match).length === 0) {
    throw new ObservationError(`${path}.observation.match must not be empty`);
  }
  for (const [key, value] of Object.entries(rule.observation.match)) {
    if (!definition.allowed.includes(key) || !validFact(value)) {
      throw new ObservationError(`${path}.observation.match.${key} is invalid`);
    }
  }
  assertMap(rule.finding, `${path}.finding`);
  assertExactKeys(
    rule.finding,
    ['severity', 'dimension', 'type', 'summary', 'recommendation'],
    `${path}.finding`,
  );
  if (!['low', 'medium', 'high', 'critical'].includes(rule.finding.severity)) {
    throw new ObservationError(`${path}.finding.severity is invalid`);
  }
  if (
    ![
      'efficiency',
      'clarity',
      'feedback-and-recovery',
      'accessibility',
      'consistency',
    ].includes(rule.finding.dimension)
  ) {
    throw new ObservationError(`${path}.finding.dimension is invalid`);
  }
  if (!['requirement', 'recommendation'].includes(rule.finding.type)) {
    throw new ObservationError(`${path}.finding.type is invalid`);
  }
  assertText(rule.finding.summary, `${path}.finding.summary`);
  assertText(rule.finding.recommendation, `${path}.finding.recommendation`);
  if (!Array.isArray(rule.policy) || rule.policy.length === 0) {
    throw new ObservationError(`${path}.policy must be a non-empty array`);
  }
  for (const [index, reference] of rule.policy.entries()) {
    const referencePath = `${path}.policy[${index}]`;
    assertMap(reference, referencePath);
    assertExactKeys(reference, ['source', 'field', 'statement'], referencePath);
    if (!['use-case-requirement', 'owner-approved-journey'].includes(reference.source)) {
      throw new ObservationError(`${referencePath}.source is invalid`);
    }
    if (
      !['requirements', 'intent.summary', 'intent.steps', 'intent.success'].includes(
        reference.field,
      )
    ) {
      throw new ObservationError(`${referencePath}.field is invalid`);
    }
    if (
      (reference.source === 'use-case-requirement') !==
      (reference.field === 'requirements')
    ) {
      throw new ObservationError(`${referencePath} source and field do not agree`);
    }
    assertText(reference.statement, `${referencePath}.statement`);
  }
  return rule;
}

export function evaluateObservationPolicy(policy, journeys) {
  if (!Array.isArray(policy?.rules)) {
    throw new ObservationError('policy.rules must be an array');
  }
  if (!Array.isArray(journeys)) throw new ObservationError('journeys must be an array');
  const byRule = new Map();
  for (const [ruleIndex, rule] of policy.rules.entries()) {
    validateObservationRule(rule, `policy.rules[${ruleIndex}]`);
    for (const journey of journeys) {
      if (journey.useCaseId !== rule.useCaseId) continue;
      if (rule.journeyIds.length && !rule.journeyIds.includes(journey.journeyId)) continue;
      const matches = (journey.observations ?? []).filter(
        (observation) =>
          observation.type === rule.observation.type &&
          Object.entries(rule.observation.match).every(
            ([key, value]) => observation.data[key] === value,
          ),
      );
      if (matches.length === 0) continue;
      const finding =
        byRule.get(rule.ruleId) ??
        {
          id: `finding.${rule.ruleId}`,
          ruleId: rule.ruleId,
          severity: rule.finding.severity,
          dimension: rule.finding.dimension,
          type: rule.finding.type,
          summary: rule.finding.summary,
          policy: structuredClone(rule.policy),
          recommendation: rule.finding.recommendation,
          journeyRefs: [],
          evidence: [],
        };
      const journeyRef = journeyRecordId(journey.useCaseId, journey.journeyId);
      if (!finding.journeyRefs.includes(journeyRef)) finding.journeyRefs.push(journeyRef);
      for (const observation of matches) {
        finding.evidence.push({
          id: `evidence.${rule.ruleId}.${observation.id}`,
          journeyRef,
          observationRef: observation.id,
          stepId: observation.stepId,
          facts: Object.entries(observation.data)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => ({ key, value })),
        });
      }
      byRule.set(rule.ruleId, finding);
    }
  }
  return [...byRule.values()]
    .map((finding) => ({
      ...finding,
      journeyRefs: finding.journeyRefs.sort(),
      evidence: finding.evidence.sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

export function journeyRecordId(useCaseId, journeyId) {
  return `journey.${useCaseId}.${journeyId}`;
}

function validFact(value) {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (Number.isSafeInteger(value) && value >= 0)
  );
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ObservationError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ObservationError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new ObservationError(`${path} has invalid id`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ObservationError(`${path} must be non-empty text`);
  }
}
