import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const RUN_ENVELOPE_KIND = 'ux-guard-run-envelope';
export const RUN_ENVELOPE_VERSION = 1;
export const UX_GUARD_TOOL_VERSION = '0.6.1';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const COMPLETION_RESULTS = new Set([
  'successful',
  'failed',
  'skipped',
  'infrastructure-error',
]);
const ERROR_CATEGORIES = new Set(['assertion', 'infrastructure']);

export class RunContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunContractError';
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function policyDigest(policy) {
  return `sha256:${sha256(policy)}`;
}

export function resolveRunIdentity(
  root,
  {
    policy,
    candidateCommit,
    baseCommit,
    browser = { name: 'chromium', profile: 'Desktop Chrome' },
    adapters = { playwright: '1' },
  } = {},
) {
  const candidate = resolveCommit(
    root,
    candidateCommit ?? process.env.UX_GUARD_CANDIDATE_SHA ?? process.env.GITHUB_SHA,
    'candidate',
  );
  const baseInput =
    baseCommit ?? process.env.UX_GUARD_BASE_SHA ?? process.env.UX_GUARD_BASE_COMMIT;
  const usableBase =
    baseInput && !/^0+$/.test(String(baseInput)) ? baseInput : null;
  const base = usableBase
    ? resolveCommit(root, usableBase, 'base')
    : { commit: null, source: 'none' };
  const identity = {
    provenance: { candidate, base },
    tool: {
      name: 'ux-guard',
      version: UX_GUARD_TOOL_VERSION,
      schemas: {
        run: RUN_ENVELOPE_VERSION,
        'journey-report': 5,
        'journey-shard': 1,
        observation: 1,
        policy: 3,
        'journey-baseline': 1,
        'journey-comparison': 2,
        'owner-targets': 2,
        'target-attainment': 1,
        'numerical-score': 1,
        'visual-profile': 1,
        'visual-manifest': 1,
        'visual-comparison': 1,
        'verdict-report': 6,
      },
    },
    policy: {
      algorithm: 'sha256',
      digest: policyDigest(policy ?? null),
    },
    browser: structuredClone(browser),
    adapters: canonicalize(adapters),
  };
  validateRunIdentity(identity);
  return identity;
}

export function createRunEnvelope(
  identity,
  { statuses = [], errors = [], artifacts = [] } = {},
) {
  validateRunIdentity(identity);
  if (!Array.isArray(statuses)) {
    throw new RunContractError('run statuses must be an array');
  }
  const counts = {
    successful: 0,
    failed: 0,
    skipped: 0,
    unexecutable: 0,
    infrastructureError: 0,
  };
  for (const status of statuses) {
    if (status === 'successful') counts.successful += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'skipped') counts.skipped += 1;
    else if (status === 'unexecutable') counts.unexecutable += 1;
    else if (status === 'infrastructure-error') counts.infrastructureError += 1;
    else throw new RunContractError(`unknown journey lifecycle status ${String(status)}`);
  }
  let result = 'successful';
  if (counts.infrastructureError) result = 'infrastructure-error';
  else if (counts.failed) result = 'failed';
  else if (counts.skipped) result = 'skipped';
  const envelope = {
    kind: RUN_ENVELOPE_KIND,
    version: RUN_ENVELOPE_VERSION,
    ...structuredClone(identity),
    completion: {
      status: 'completed',
      result,
      expected: statuses.length,
      received: statuses.length,
      ...counts,
    },
    errors: structuredClone(errors).sort(compareError),
    artifacts: structuredClone(artifacts).sort((left, right) =>
      String(left?.id).localeCompare(String(right?.id)),
    ),
  };
  validateRunEnvelope(envelope);
  return envelope;
}

export function validateRunIdentity(identity) {
  assertMap(identity, 'run identity');
  assertExactKeys(
    identity,
    ['provenance', 'tool', 'policy', 'browser', 'adapters'],
    'run identity',
  );
  assertMap(identity.provenance, 'run identity.provenance');
  assertExactKeys(
    identity.provenance,
    ['candidate', 'base'],
    'run identity.provenance',
  );
  validateCommit(identity.provenance.candidate, 'run identity.provenance.candidate', false);
  validateCommit(identity.provenance.base, 'run identity.provenance.base', true);
  assertMap(identity.tool, 'run identity.tool');
  assertExactKeys(identity.tool, ['name', 'version', 'schemas'], 'run identity.tool');
  if (identity.tool.name !== 'ux-guard' || identity.tool.version !== UX_GUARD_TOOL_VERSION) {
    throw new RunContractError('run identity.tool is not this ux-guard version');
  }
  assertMap(identity.tool.schemas, 'run identity.tool.schemas');
  for (const [name, version] of Object.entries(identity.tool.schemas)) {
    if (!ID.test(name) || !Number.isSafeInteger(version) || version < 1) {
      throw new RunContractError('run identity.tool.schemas is invalid');
    }
  }
  assertMap(identity.policy, 'run identity.policy');
  assertExactKeys(identity.policy, ['algorithm', 'digest'], 'run identity.policy');
  if (
    identity.policy.algorithm !== 'sha256' ||
    typeof identity.policy.digest !== 'string' ||
    !identity.policy.digest.startsWith('sha256:') ||
    !SHA256.test(identity.policy.digest.slice(7))
  ) {
    throw new RunContractError('run identity.policy digest is invalid');
  }
  assertMap(identity.browser, 'run identity.browser');
  assertExactKeys(identity.browser, ['name', 'profile'], 'run identity.browser');
  assertText(identity.browser.name, 'run identity.browser.name');
  assertText(identity.browser.profile, 'run identity.browser.profile');
  assertMap(identity.adapters, 'run identity.adapters');
  if (Object.keys(identity.adapters).length === 0) {
    throw new RunContractError('run identity.adapters must not be empty');
  }
  for (const [name, version] of Object.entries(identity.adapters)) {
    if (!ID.test(name)) throw new RunContractError(`invalid adapter name ${name}`);
    assertText(version, `run identity.adapters.${name}`);
  }
  return identity;
}

export function validateRunEnvelope(envelope) {
  assertMap(envelope, 'run');
  assertExactKeys(
    envelope,
    [
      'kind',
      'version',
      'provenance',
      'tool',
      'policy',
      'browser',
      'adapters',
      'completion',
      'errors',
      'artifacts',
    ],
    'run',
  );
  if (envelope.kind !== RUN_ENVELOPE_KIND || envelope.version !== RUN_ENVELOPE_VERSION) {
    throw new RunContractError('run envelope has an unsupported kind or version');
  }
  validateRunIdentity({
    provenance: envelope.provenance,
    tool: envelope.tool,
    policy: envelope.policy,
    browser: envelope.browser,
    adapters: envelope.adapters,
  });
  assertMap(envelope.completion, 'run.completion');
  assertExactKeys(
    envelope.completion,
    [
      'status',
      'result',
      'expected',
      'received',
      'successful',
      'failed',
      'skipped',
      'unexecutable',
      'infrastructureError',
    ],
    'run.completion',
  );
  if (
    envelope.completion.status !== 'completed' ||
    !COMPLETION_RESULTS.has(envelope.completion.result)
  ) {
    throw new RunContractError('run.completion status or result is invalid');
  }
  for (const field of [
    'expected',
    'received',
    'successful',
    'failed',
    'skipped',
    'unexecutable',
    'infrastructureError',
  ]) {
    assertCount(envelope.completion[field], `run.completion.${field}`);
  }
  const total =
    envelope.completion.successful +
    envelope.completion.failed +
    envelope.completion.skipped +
    envelope.completion.unexecutable +
    envelope.completion.infrastructureError;
  if (
    total !== envelope.completion.received ||
    envelope.completion.received !== envelope.completion.expected
  ) {
    throw new RunContractError('run.completion counts are inconsistent');
  }
  const expectedResult = envelope.completion.infrastructureError
    ? 'infrastructure-error'
    : envelope.completion.failed
      ? 'failed'
      : envelope.completion.skipped
        ? 'skipped'
        : 'successful';
  if (envelope.completion.result !== expectedResult) {
    throw new RunContractError(`run.completion.result must be ${expectedResult}`);
  }
  if (!Array.isArray(envelope.errors) || !Array.isArray(envelope.artifacts)) {
    throw new RunContractError('run errors and artifacts must be arrays');
  }
  const errorIds = new Set();
  for (const [index, error] of envelope.errors.entries()) {
    const path = `run.errors[${index}]`;
    assertMap(error, path);
    assertExactKeys(error, ['id', 'category', 'message', 'journeyRef'], path);
    assertId(error.id, `${path}.id`);
    if (errorIds.has(error.id)) throw new RunContractError(`duplicate run error ${error.id}`);
    errorIds.add(error.id);
    if (!ERROR_CATEGORIES.has(error.category)) {
      throw new RunContractError(`${path}.category is invalid`);
    }
    assertText(error.message, `${path}.message`);
    assertId(error.journeyRef, `${path}.journeyRef`);
  }
  const artifactIds = new Set();
  for (const [index, artifact] of envelope.artifacts.entries()) {
    const path = `run.artifacts[${index}]`;
    assertMap(artifact, path);
    assertExactKeys(artifact, ['id', 'path', 'sha256'], path);
    assertId(artifact.id, `${path}.id`);
    if (artifactIds.has(artifact.id)) {
      throw new RunContractError(`duplicate run artifact ${artifact.id}`);
    }
    artifactIds.add(artifact.id);
    assertSafeRelativePath(artifact.path, `${path}.path`);
    if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      throw new RunContractError(`${path}.sha256 is invalid`);
    }
  }
  return envelope;
}

function resolveCommit(root, input, label) {
  if (input !== undefined && input !== null && input !== '') {
    const commit = gitCommit(root, String(input));
    if (!commit) throw new RunContractError(`${label} commit ${String(input)} is unavailable`);
    return { commit, source: process.env.CI ? 'ci' : 'git' };
  }
  const commit = gitCommit(root, 'HEAD');
  return commit
    ? { commit, source: 'git' }
    : { commit: null, source: 'unavailable' };
}

function gitCommit(root, ref) {
  try {
    const value = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return COMMIT.test(value) ? value : null;
  } catch {
    return null;
  }
}

function validateCommit(value, path, optional) {
  assertMap(value, path);
  assertExactKeys(value, ['commit', 'source'], path);
  const sources = optional
    ? new Set(['ci', 'git', 'none'])
    : new Set(['ci', 'git', 'unavailable']);
  if (!sources.has(value.source)) throw new RunContractError(`${path}.source is invalid`);
  if (value.commit === null) {
    if (!((optional && value.source === 'none') || (!optional && value.source === 'unavailable'))) {
      throw new RunContractError(`${path}.commit cannot be null for ${value.source}`);
    }
  } else if (typeof value.commit !== 'string' || !COMMIT.test(value.commit)) {
    throw new RunContractError(`${path}.commit is invalid`);
  }
}

function compareError(left, right) {
  return String(left?.journeyRef).localeCompare(String(right?.journeyRef)) ||
    String(left?.id).localeCompare(String(right?.id));
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunContractError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new RunContractError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RunContractError(`${path} must be non-empty text`);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new RunContractError(`${path} is not a safe id`);
  }
}

function assertCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RunContractError(`${path} must be a non-negative safe integer`);
  }
}

function assertSafeRelativePath(value, path) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new RunContractError(`${path} must be a safe relative path`);
  }
}
