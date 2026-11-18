import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  createJourneyReport,
  createLifecycleJourney,
} from './journeys.mjs';
import {
  canonicalJson,
  canonicalize,
  createRunEnvelope,
  RunContractError,
  sha256,
  validateRunIdentity,
} from './run-contract.mjs';

export const JOURNEY_SHARD_KIND = 'ux-guard-journey-shard';
export const JOURNEY_SHARD_VERSION = 1;

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const STATUSES = new Set([
  'successful',
  'failed',
  'skipped',
  'unexecutable',
  'infrastructure-error',
]);
const ERROR_CATEGORIES = new Set(['assertion', 'infrastructure']);

export class JourneyShardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyShardError';
  }
}

export class JourneyShardUpgradeError extends JourneyShardError {
  constructor(message) {
    super(message);
    this.name = 'JourneyShardUpgradeError';
  }
}

export function createJourneyShard({
  runIdentity,
  useCaseId,
  journeyId,
  project,
  repeatIndex,
  status,
  journey = null,
  errors = [],
} = {}) {
  validateRunIdentity(runIdentity);
  assertId(useCaseId, 'useCaseId');
  assertId(journeyId, 'journeyId');
  assertId(project, 'project');
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 0) {
    throw new JourneyShardError('repeatIndex must be a non-negative safe integer');
  }
  if (!STATUSES.has(status)) throw new JourneyShardError('shard status is invalid');
  const id = shardId({ useCaseId, journeyId, project, repeatIndex });
  const shard = {
    kind: JOURNEY_SHARD_KIND,
    version: JOURNEY_SHARD_VERSION,
    id,
    runIdentity: structuredClone(runIdentity),
    useCaseId,
    journeyId,
    project,
    repeatIndex,
    status,
    journey: journey === null ? null : structuredClone(journey),
    errors: structuredClone(errors),
  };
  return validateJourneyShard(shard);
}

export function validateJourneyShard(shard) {
  assertMap(shard, 'shard');
  assertExactKeys(
    shard,
    [
      'kind',
      'version',
      'id',
      'runIdentity',
      'useCaseId',
      'journeyId',
      'project',
      'repeatIndex',
      'status',
      'journey',
      'errors',
    ],
    'shard',
  );
  if (shard.kind !== JOURNEY_SHARD_KIND) {
    throw new JourneyShardError(`shard.kind must be ${JOURNEY_SHARD_KIND}`);
  }
  if (shard.version !== JOURNEY_SHARD_VERSION) {
    throw new JourneyShardUpgradeError(
      `unsupported journey shard version ${String(shard.version)}; migrate to version ${JOURNEY_SHARD_VERSION}`,
    );
  }
  try {
    validateRunIdentity(shard.runIdentity);
  } catch (error) {
    if (
      error instanceof RunContractError &&
      /tool is not this ux-guard version|schemas is invalid/.test(error.message)
    ) {
      throw new JourneyShardUpgradeError(
        `trusted ux-guard cannot consume shard tool/schema identity: ${error.message}`,
      );
    }
    throw error;
  }
  assertId(shard.useCaseId, 'shard.useCaseId');
  assertId(shard.journeyId, 'shard.journeyId');
  assertId(shard.project, 'shard.project');
  if (!Number.isSafeInteger(shard.repeatIndex) || shard.repeatIndex < 0) {
    throw new JourneyShardError('shard.repeatIndex is invalid');
  }
  const expectedId = shardId(shard);
  if (shard.id !== expectedId) throw new JourneyShardError('shard.id is not derived from policy ids');
  if (!STATUSES.has(shard.status)) throw new JourneyShardError('shard.status is invalid');
  const measured = shard.status === 'successful' || shard.status === 'unexecutable';
  if (measured) {
    if (
      !shard.journey ||
      shard.journey.useCaseId !== shard.useCaseId ||
      shard.journey.journeyId !== shard.journeyId ||
      shard.journey.status !== shard.status
    ) {
      throw new JourneyShardError('measured shard journey identity or status does not match');
    }
  } else if (shard.journey !== null) {
    throw new JourneyShardError('failed, skipped, and infrastructure shards cannot claim measurements');
  }
  if (!Array.isArray(shard.errors)) throw new JourneyShardError('shard.errors must be an array');
  if (measured && shard.errors.length) {
    throw new JourneyShardError('successful and unexecutable shards cannot contain run errors');
  }
  if (['failed', 'infrastructure-error'].includes(shard.status) && shard.errors.length === 0) {
    throw new JourneyShardError(`${shard.status} shard must contain an error`);
  }
  for (const [index, error] of shard.errors.entries()) {
    const path = `shard.errors[${index}]`;
    assertMap(error, path);
    assertExactKeys(error, ['category', 'message'], path);
    if (!ERROR_CATEGORIES.has(error.category)) {
      throw new JourneyShardError(`${path}.category is invalid`);
    }
    assertText(error.message, `${path}.message`);
  }
  return shard;
}

export function serializeJourneyShard(shard) {
  validateJourneyShard(shard);
  return `${JSON.stringify(canonicalize(shard), null, 2)}\n`;
}

export function parseJourneyShard(text) {
  let shard;
  try {
    shard = JSON.parse(text);
  } catch {
    throw new JourneyShardError('journey shard is not valid JSON');
  }
  return validateJourneyShard(shard);
}

export function shardId({ useCaseId, journeyId, project, repeatIndex }) {
  for (const [label, value] of Object.entries({ useCaseId, journeyId, project })) {
    assertId(value, label);
  }
  if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 0) {
    throw new JourneyShardError('repeatIndex must be a non-negative safe integer');
  }
  return `shard.${sha256(`${useCaseId}\0${journeyId}\0${project}\0${repeatIndex}`)}`;
}

export function shardFileName(shard) {
  validateShardIdentity(shard);
  const digest = shardId(shard).slice('shard.'.length, 'shard.'.length + 24);
  return `${safeSegment(shard.useCaseId)}--${safeSegment(shard.journeyId)}--${digest}.json`;
}

export function writeJourneyShard(directory, shard) {
  validateJourneyShard(shard);
  validateShardDirectory(directory);
  const path = join(directory, shardFileName(shard));
  try {
    writeFileSync(path, serializeJourneyShard(shard), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new JourneyShardError(`immutable journey shard already exists: ${basename(path)}`);
    }
    throw new JourneyShardError(`journey shard could not be written: ${basename(path)}`);
  }
  return path;
}

export function aggregateJourneyShards({
  directory,
  policy,
  catalog,
  runIdentity,
  project = 'chromium',
  repetitions = 1,
  artifactPath = 'test-results/ux-guard/shards',
} = {}) {
  validateRunIdentity(runIdentity);
  assertId(project, 'project');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new JourneyShardError('repetitions must be a positive safe integer');
  }
  validateShardDirectory(directory);
  const expected = expectedShards(policy, project, repetitions);
  const files = readdirSync(directory).sort();
  if (files.some((file) => !file.endsWith('.json'))) {
    throw new JourneyShardError('shard directory contains an unexpected non-JSON artifact');
  }
  const byLogicalId = new Map();
  const shardIds = new Set();
  const manifest = [];
  for (const file of files) {
    if (file !== basename(file) || file.includes('..')) {
      throw new JourneyShardError('shard path traversal is not allowed');
    }
    const path = join(directory, file);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new JourneyShardError(`shard ${file} must be a regular file, not a symlink`);
    }
    const text = readFileSync(path, 'utf8');
    const shard = parseJourneyShard(text);
    if (file !== shardFileName(shard)) {
      throw new JourneyShardError(`shard ${file} does not match its collision-resistant id`);
    }
    if (shardIds.has(shard.id)) throw new JourneyShardError(`duplicate shard id ${shard.id}`);
    shardIds.add(shard.id);
    assertExpectedRunIdentity(shard.runIdentity, runIdentity, file);
    const logicalId = logicalShardId(shard);
    if (!expected.has(logicalId)) {
      throw new JourneyShardError(`unexpected shard ${shard.useCaseId}/${shard.journeyId}`);
    }
    if (byLogicalId.has(logicalId)) {
      throw new JourneyShardError(`duplicate expected shard ${logicalId}`);
    }
    byLogicalId.set(logicalId, shard);
    manifest.push({ id: shard.id, path: file, sha256: sha256(text) });
  }
  const missing = [...expected.keys()].filter((id) => !byLogicalId.has(id));
  if (missing.length) {
    throw new JourneyShardError(`missing expected shards: ${missing.join(', ')}`);
  }

  const collapsed = [];
  const statuses = [];
  const runErrors = [];
  for (const required of requiredVariants(policy)) {
    const repeated = [];
    for (let repeatIndex = 0; repeatIndex < repetitions; repeatIndex += 1) {
      repeated.push(
        byLogicalId.get(
          logicalShardId({
            useCaseId: required.useCaseId,
            journeyId: required.journeyId,
            project,
            repeatIndex,
          }),
        ),
      );
    }
    const reference = stableShardPayload(repeated[0]);
    for (const shard of repeated.slice(1)) {
      if (canonicalJson(stableShardPayload(shard)) !== canonicalJson(reference)) {
        throw new JourneyShardError(
          `unstable repeated measurement for ${required.useCaseId}/${required.journeyId}`,
        );
      }
    }
    const shard = repeated[0];
    statuses.push(shard.status);
    if (shard.journey) collapsed.push(shard.journey);
    else {
      collapsed.push(
        createLifecycleJourney({
          useCaseId: shard.useCaseId,
          journeyId: shard.journeyId,
          status: shard.status,
        }),
      );
    }
    shard.errors.forEach((error, index) => {
      runErrors.push({
        id: `error.${shard.useCaseId}.${shard.journeyId}.${index + 1}`,
        category: error.category,
        message: error.message,
        journeyRef: `journey.${shard.useCaseId}.${shard.journeyId}`,
      });
    });
  }
  const manifestHash = sha256(canonicalJson(manifest));
  const run = createRunEnvelope(runIdentity, {
    statuses,
    errors: runErrors,
    artifacts: [
      {
        id: 'journey-shards',
        path: artifactPath,
        sha256: manifestHash,
      },
    ],
  });
  return createJourneyReport(collapsed, { catalog, policy, run });
}

function assertExpectedRunIdentity(actual, expected, file) {
  if (canonicalJson(actual) === canonicalJson(expected)) return;
  if (
    canonicalJson(actual.tool) !== canonicalJson(expected.tool) ||
    canonicalJson(actual.policy) !== canonicalJson(expected.policy)
  ) {
    throw new JourneyShardUpgradeError(
      `trusted ux-guard cannot consume ${file}: tool/schema or policy generation differs from the trusted base`,
    );
  }
  throw new JourneyShardError(
    `shard ${file} provenance, browser/profile, or adapter identity does not match the expected run`,
  );
}

function expectedShards(policy, project, repetitions) {
  const expected = new Map();
  for (const required of requiredVariants(policy)) {
    for (let repeatIndex = 0; repeatIndex < repetitions; repeatIndex += 1) {
      const identity = {
        useCaseId: required.useCaseId,
        journeyId: required.journeyId,
        project,
        repeatIndex,
      };
      expected.set(logicalShardId(identity), identity);
    }
  }
  return expected;
}

function requiredVariants(policy) {
  if (!Array.isArray(policy?.coverage)) {
    throw new JourneyShardError('policy.coverage must be an array');
  }
  const variants = policy.coverage.flatMap((useCase) =>
    useCase.requiredVariants.map((variant) => ({
      useCaseId: useCase.useCaseId,
      journeyId: variant.journeyId,
    })),
  );
  const ids = new Set();
  for (const variant of variants) {
    const id = `${variant.useCaseId}\0${variant.journeyId}`;
    if (ids.has(id)) throw new JourneyShardError(`policy repeats required variant ${id}`);
    ids.add(id);
  }
  return variants.sort(
    (left, right) =>
      left.useCaseId.localeCompare(right.useCaseId) ||
      left.journeyId.localeCompare(right.journeyId),
  );
}

function stableShardPayload(shard) {
  return {
    status: shard.status,
    journey: shard.journey,
    errors: shard.errors,
  };
}

function logicalShardId({ useCaseId, journeyId, project, repeatIndex }) {
  return `${useCaseId}/${journeyId}/${project}/${repeatIndex}`;
}

function validateShardDirectory(directory) {
  if (typeof directory !== 'string' || !directory) {
    throw new JourneyShardError('shard directory must be a path');
  }
  if (!existsSync(directory)) throw new JourneyShardError('shard directory does not exist');
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new JourneyShardError('shard directory must be a real directory, not a symlink');
  }
}

function validateShardIdentity(shard) {
  assertId(shard.useCaseId, 'useCaseId');
  assertId(shard.journeyId, 'journeyId');
  assertId(shard.project, 'project');
  if (!Number.isSafeInteger(shard.repeatIndex) || shard.repeatIndex < 0) {
    throw new JourneyShardError('repeatIndex is invalid');
  }
}

function safeSegment(value) {
  if (!ID.test(value)) throw new JourneyShardError('unsafe shard path segment');
  return value;
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JourneyShardError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new JourneyShardError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new JourneyShardError(`${path} is not a safe id`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JourneyShardError(`${path} must be non-empty text`);
  }
}
