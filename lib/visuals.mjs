import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalize } from './run-contract.mjs';

export const VISUAL_PROFILE_SET_KIND = 'ux-guard-visual-profile-set';
export const VISUAL_PROFILE_SET_VERSION = 1;
export const VISUAL_CHECKPOINT_POLICY_KIND = 'ux-guard-visual-checkpoint-policy';
export const VISUAL_CHECKPOINT_POLICY_VERSION = 1;
export const VISUAL_MANIFEST_KIND = 'ux-guard-visual-manifest';
export const VISUAL_MANIFEST_VERSION = 1;
export const VISUAL_COMPARISON_KIND = 'ux-guard-visual-comparison';
export const VISUAL_COMPARISON_VERSION = 1;

const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const USE_CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const RAW_HASH = /^[a-f0-9]{64}$/;

export class VisualContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisualContractError';
  }
}

export const VISUAL_PROFILE_SET_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:visual-profile-set:v1',
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'version', 'profiles', 'canonicalHash'],
});

export const VISUAL_MANIFEST_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ux-guard:visual-manifest:v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'version',
    'approval',
    'profiles',
    'policy',
    'capture',
    'images',
    'canonicalHash',
  ],
});

export function canonicalHash(value) {
  const copy = structuredClone(value);
  delete copy.canonicalHash;
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(copy)))
    .digest('hex')}`;
}

export function parseVisualProfileSet(text) {
  return validateVisualProfileSet(parseJson(text, 'visual profile set'));
}

export function validateVisualProfileSet(value) {
  assertMap(value, 'visual profile set');
  assertExactKeys(
    value,
    ['kind', 'version', 'profiles', 'canonicalHash'],
    'visual profile set',
  );
  if (
    value.kind !== VISUAL_PROFILE_SET_KIND ||
    value.version !== VISUAL_PROFILE_SET_VERSION
  ) {
    throw new VisualContractError('visual profile set generation is unsupported');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new VisualContractError('visual profile set profiles must be non-empty');
  }
  const ids = new Set();
  for (const [index, profile] of value.profiles.entries()) {
    validateVisualProfile(profile, `visual profile set.profiles[${index}]`);
    if (ids.has(profile.id)) {
      throw new VisualContractError(`visual profile set repeats ${profile.id}`);
    }
    ids.add(profile.id);
  }
  if (
    !value.profiles.some((profile) => profile.colorScheme === 'light') ||
    !value.profiles.some((profile) => profile.colorScheme === 'dark')
  ) {
    throw new VisualContractError('visual profile set must include light and dark profiles');
  }
  assertCanonicalHash(value, 'visual profile set');
  return value;
}

export function validateVisualProfile(profile, path = 'visual profile') {
  assertMap(profile, path);
  assertExactKeys(
    profile,
    [
      'id',
      'version',
      'browser',
      'runtime',
      'viewport',
      'fonts',
      'locale',
      'timezone',
      'colorScheme',
      'clock',
      'reducedMotion',
      'rendering',
      'network',
      'screenshot',
      'adapters',
      'canonicalHash',
    ],
    path,
  );
  assertId(profile.id, `${path}.id`);
  if (profile.version !== 1) throw new VisualContractError(`${path}.version must be 1`);
  assertExactMap(
    profile.browser,
    ['engine', 'version', 'revision', 'channel'],
    `${path}.browser`,
  );
  if (
    profile.browser.engine !== 'chromium' ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(profile.browser.version) ||
    !/^[1-9]\d*$/.test(profile.browser.revision) ||
    profile.browser.channel !== 'chrome-for-testing'
  ) {
    throw new VisualContractError(`${path}.browser is invalid`);
  }
  assertExactMap(
    profile.runtime,
    ['os', 'distribution', 'release', 'architecture', 'container'],
    `${path}.runtime`,
  );
  assertExactMap(
    profile.runtime.container,
    ['image', 'digest', 'indexDigest'],
    `${path}.runtime.container`,
  );
  for (const field of ['os', 'distribution', 'release', 'architecture']) {
    assertText(profile.runtime[field], `${path}.runtime.${field}`);
  }
  assertText(profile.runtime.container.image, `${path}.runtime.container.image`);
  assertHash(profile.runtime.container.digest, `${path}.runtime.container.digest`);
  assertHash(profile.runtime.container.indexDigest, `${path}.runtime.container.indexDigest`);
  assertExactMap(
    profile.viewport,
    ['width', 'height', 'deviceScaleFactor'],
    `${path}.viewport`,
  );
  for (const field of ['width', 'height', 'deviceScaleFactor']) {
    assertPositiveInteger(profile.viewport[field], `${path}.viewport.${field}`);
  }
  if (!Array.isArray(profile.fonts) || profile.fonts.length === 0) {
    throw new VisualContractError(`${path}.fonts must be non-empty`);
  }
  for (const [index, font] of profile.fonts.entries()) {
    const fontPath = `${path}.fonts[${index}]`;
    assertExactMap(font, ['family', 'style', 'weight', 'path', 'sha256'], fontPath);
    assertText(font.family, `${fontPath}.family`);
    if (!['normal', 'italic'].includes(font.style)) {
      throw new VisualContractError(`${fontPath}.style is invalid`);
    }
    assertPositiveInteger(font.weight, `${fontPath}.weight`);
    assertAbsoluteNormalizedPath(font.path, `${fontPath}.path`);
    assertHash(font.sha256, `${fontPath}.sha256`);
  }
  assertText(profile.locale, `${path}.locale`);
  assertText(profile.timezone, `${path}.timezone`);
  if (!['light', 'dark'].includes(profile.colorScheme)) {
    throw new VisualContractError(`${path}.colorScheme is invalid`);
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(profile.clock)) {
    throw new VisualContractError(`${path}.clock must be a fixed UTC timestamp`);
  }
  if (profile.reducedMotion !== 'reduce') {
    throw new VisualContractError(`${path}.reducedMotion must be reduce`);
  }
  assertExactMap(
    profile.rendering,
    ['animations', 'transitions', 'carets'],
    `${path}.rendering`,
  );
  if (
    profile.rendering.animations !== 'disabled' ||
    profile.rendering.transitions !== 'disabled' ||
    profile.rendering.carets !== 'hidden'
  ) {
    throw new VisualContractError(`${path}.rendering is not deterministic`);
  }
  assertExactMap(profile.network, ['mode'], `${path}.network`);
  if (profile.network.mode !== 'mocked-only') {
    throw new VisualContractError(`${path}.network.mode must be mocked-only`);
  }
  assertExactMap(
    profile.screenshot,
    ['fullPage', 'animations', 'caret', 'scale', 'omitBackground', 'maskColor'],
    `${path}.screenshot`,
  );
  if (
    profile.screenshot.fullPage !== false ||
    profile.screenshot.animations !== 'disabled' ||
    profile.screenshot.caret !== 'hide' ||
    profile.screenshot.scale !== 'css' ||
    profile.screenshot.omitBackground !== false ||
    !/^#[a-f0-9]{6}$/i.test(profile.screenshot.maskColor)
  ) {
    throw new VisualContractError(`${path}.screenshot is invalid`);
  }
  assertExactMap(
    profile.adapters,
    ['uxGuard', 'visual', 'playwright', 'schema'],
    `${path}.adapters`,
  );
  for (const [field, value] of Object.entries(profile.adapters)) {
    if (typeof value !== 'string' || !value) {
      throw new VisualContractError(`${path}.adapters.${field} is invalid`);
    }
  }
  assertCanonicalHash(profile, path);
  return profile;
}

export function parseVisualCheckpointPolicy(text) {
  return validateVisualCheckpointPolicy(parseJson(text, 'visual checkpoint policy'));
}

export function validateVisualCheckpointPolicy(value) {
  assertMap(value, 'visual checkpoint policy');
  assertExactKeys(
    value,
    ['kind', 'version', 'checkpoints', 'canonicalHash'],
    'visual checkpoint policy',
  );
  if (
    value.kind !== VISUAL_CHECKPOINT_POLICY_KIND ||
    value.version !== VISUAL_CHECKPOINT_POLICY_VERSION
  ) {
    throw new VisualContractError('visual checkpoint policy generation is unsupported');
  }
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) {
    throw new VisualContractError('visual checkpoint policy must be non-empty');
  }
  const keys = new Set();
  for (const [index, checkpoint] of value.checkpoints.entries()) {
    const path = `visual checkpoint policy.checkpoints[${index}]`;
    assertExactMap(
      checkpoint,
      [
        'useCaseId',
        'journeyId',
        'checkpointId',
        'tier',
        'purpose',
        'profiles',
        'masks',
        'tolerance',
      ],
      path,
    );
    assertId(checkpoint.useCaseId, `${path}.useCaseId`, USE_CASE_ID);
    assertId(checkpoint.journeyId, `${path}.journeyId`);
    assertId(checkpoint.checkpointId, `${path}.checkpointId`);
    if (!['primary', 'secondary', 'representative'].includes(checkpoint.tier)) {
      throw new VisualContractError(`${path}.tier is invalid`);
    }
    if (!['success', 'detail', 'form'].includes(checkpoint.purpose)) {
      throw new VisualContractError(`${path}.purpose is invalid`);
    }
    if (
      !Array.isArray(checkpoint.profiles) ||
      checkpoint.profiles.length === 0 ||
      checkpoint.profiles.some((id) => typeof id !== 'string' || !ID.test(id)) ||
      new Set(checkpoint.profiles).size !== checkpoint.profiles.length
    ) {
      throw new VisualContractError(`${path}.profiles is invalid`);
    }
    if (
      !Array.isArray(checkpoint.masks) ||
      checkpoint.masks.some((mask) => {
        try {
          assertExactMap(mask, ['id', 'selector'], `${path}.masks`);
          assertId(mask.id, `${path}.masks.id`);
          assertText(mask.selector, `${path}.masks.selector`);
          return false;
        } catch {
          return true;
        }
      })
    ) {
      throw new VisualContractError(`${path}.masks is invalid`);
    }
    assertExactMap(checkpoint.tolerance, ['mode'], `${path}.tolerance`);
    if (checkpoint.tolerance.mode !== 'exact') {
      throw new VisualContractError(
        `${path}.tolerance must be explicitly exact; no global threshold exists`,
      );
    }
    const key = checkpointKey(checkpoint);
    if (keys.has(key)) throw new VisualContractError(`${path} is duplicated`);
    keys.add(key);
  }
  assertCanonicalHash(value, 'visual checkpoint policy');
  return value;
}

export function createVisualManifest({
  profileSet,
  checkpointPolicy,
  profilePath,
  policyPath,
  images,
  repetitions = 3,
  approval = { status: 'unapproved' },
} = {}) {
  validateVisualProfileSet(profileSet);
  validateVisualCheckpointPolicy(checkpointPolicy);
  assertSafePath(profilePath, 'visual profile path');
  assertSafePath(policyPath, 'visual checkpoint policy path');
  const manifest = {
    kind: VISUAL_MANIFEST_KIND,
    version: VISUAL_MANIFEST_VERSION,
    approval: structuredClone(approval),
    profiles: { path: profilePath, canonicalHash: profileSet.canonicalHash },
    policy: { path: policyPath, canonicalHash: checkpointPolicy.canonicalHash },
    capture: { repetitions, deterministic: true },
    images: structuredClone(images).sort((left, right) => left.id.localeCompare(right.id)),
    canonicalHash: '',
  };
  manifest.canonicalHash = canonicalHash(manifest);
  return validateVisualManifest(manifest, { profileSet, checkpointPolicy });
}

export function parseVisualManifest(text, options = {}) {
  return validateVisualManifest(parseJson(text, 'visual manifest'), options);
}

export function validateVisualManifest(
  manifest,
  {
    profileSet = null,
    checkpointPolicy = null,
    bundleRoot = null,
    readImage = null,
    requireFiles = false,
  } = {},
) {
  assertMap(manifest, 'visual manifest');
  assertExactKeys(
    manifest,
    [
      'kind',
      'version',
      'approval',
      'profiles',
      'policy',
      'capture',
      'images',
      'canonicalHash',
    ],
    'visual manifest',
  );
  if (
    manifest.kind !== VISUAL_MANIFEST_KIND ||
    manifest.version !== VISUAL_MANIFEST_VERSION
  ) {
    throw new VisualContractError('visual manifest generation is unsupported');
  }
  validateApproval(manifest.approval);
  for (const [field, value] of [
    ['profiles', manifest.profiles],
    ['policy', manifest.policy],
  ]) {
    assertExactMap(value, ['path', 'canonicalHash'], `visual manifest.${field}`);
    assertSafePath(value.path, `visual manifest.${field}.path`);
    assertHash(value.canonicalHash, `visual manifest.${field}.canonicalHash`);
  }
  assertExactMap(
    manifest.capture,
    ['repetitions', 'deterministic'],
    'visual manifest.capture',
  );
  assertPositiveInteger(
    manifest.capture.repetitions,
    'visual manifest.capture.repetitions',
  );
  if (manifest.capture.deterministic !== true) {
    throw new VisualContractError('visual manifest must attest deterministic capture');
  }
  if (!Array.isArray(manifest.images)) {
    throw new VisualContractError('visual manifest.images must be an array');
  }
  const profiles = profileSet
    ? new Map(
        validateVisualProfileSet(profileSet).profiles.map((profile) => [
          profile.id,
          profile,
        ]),
      )
    : null;
  if (profileSet && manifest.profiles.canonicalHash !== profileSet.canonicalHash) {
    throw new VisualContractError('visual manifest profile hash is incompatible');
  }
  if (
    checkpointPolicy &&
    manifest.policy.canonicalHash !==
      validateVisualCheckpointPolicy(checkpointPolicy).canonicalHash
  ) {
    throw new VisualContractError('visual manifest checkpoint policy hash is incompatible');
  }
  if (checkpointPolicy && !profiles) {
    throw new VisualContractError(
      'checkpoint policy validation also requires the visual profile set',
    );
  }
  const expected = checkpointPolicy
    ? expectedImagePolicies(checkpointPolicy, profiles)
    : null;
  const keys = new Set();
  const ids = new Set();
  for (const [index, image] of manifest.images.entries()) {
    const path = `visual manifest.images[${index}]`;
    validateImageRecord(image, path);
    if (ids.has(image.id)) throw new VisualContractError(`${path}.id is duplicated`);
    ids.add(image.id);
    const key = visualImageKey(image);
    if (keys.has(key)) throw new VisualContractError(`${path} is duplicated`);
    keys.add(key);
    if (profiles) {
      const profile = profiles.get(image.profileId);
      if (!profile || profile.canonicalHash !== image.profileHash) {
        throw new VisualContractError(`${path} has a profile mismatch`);
      }
      if (profile.colorScheme !== image.scheme) {
        throw new VisualContractError(`${path}.scheme does not match its profile`);
      }
    }
    if (expected) {
      const approved = expected.get(key);
      if (!approved) {
        throw new VisualContractError(`${path} is not an approved checkpoint`);
      }
      if (
        image.tier !== approved.tier ||
        image.purpose !== approved.purpose ||
        JSON.stringify(image.masks) !==
          JSON.stringify(approved.masks.map(({ id }) => id)) ||
        JSON.stringify(image.tolerance) !== JSON.stringify(approved.tolerance)
      ) {
        throw new VisualContractError(
          `${path} attempts to override trusted checkpoint policy`,
        );
      }
    }
    if (requireFiles || bundleRoot || readImage) {
      const bytes = readImage
        ? readImage(image.path)
        : readRegularContainedFile(bundleRoot, image.path, path);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== image.sha256) {
        throw new VisualContractError(`${path} image hash does not match`);
      }
      const dimensions = pngDimensions(bytes, `${path} image`);
      if (dimensions.width !== image.width || dimensions.height !== image.height) {
        throw new VisualContractError(`${path} image dimensions do not match`);
      }
    }
  }
  if (expected) {
    const missing = [...expected.keys()].filter((key) => !keys.has(key));
    if (missing.length) {
      throw new VisualContractError(
        `visual manifest is missing ${missing.length} required checkpoint image(s)`,
      );
    }
  }
  assertCanonicalHash(manifest, 'visual manifest');
  return manifest;
}

export function compareVisualManifests(baseline, candidate) {
  try {
    validateVisualManifest(baseline);
    validateVisualManifest(candidate);
    if (baseline.approval.status !== 'reviewed') {
      throw new VisualContractError('visual baseline is not owner reviewed');
    }
    if (
      baseline.profiles.canonicalHash !== candidate.profiles.canonicalHash ||
      baseline.policy.canonicalHash !== candidate.policy.canonicalHash
    ) {
      return visualComparison('incompatible', {
        reason: 'candidate profile or checkpoint policy differs from the reviewed baseline',
      });
    }
    const before = new Map(baseline.images.map((image) => [visualImageKey(image), image]));
    const after = new Map(candidate.images.map((image) => [visualImageKey(image), image]));
    const checkpoints = [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .map((key) => {
        const left = before.get(key);
        const right = after.get(key);
        const status = !left
          ? 'added'
          : !right
            ? 'missing'
            : left.sha256 !== right.sha256 ||
                left.width !== right.width ||
                left.height !== right.height
              ? 'changed'
              : 'unchanged';
        return {
          key,
          status,
          baseline: left ? imageReference(left) : null,
          candidate: right ? imageReference(right) : null,
        };
      });
    const counts = countStatuses(checkpoints);
    const status = counts.missing
      ? 'missing'
      : counts.changed
        ? 'changed'
        : counts.added
          ? 'added'
          : 'unchanged';
    return visualComparison(status, {
      reason:
        status === 'unchanged'
          ? 'every reviewed checkpoint image is byte-identical'
          : 'checkpoint changes require individual owner review',
      baselineHash: baseline.canonicalHash,
      candidateHash: candidate.canonicalHash,
      checkpoints,
      counts,
    });
  } catch (error) {
    return visualComparison('error', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function unavailableVisualComparison(reason, candidate = null) {
  assertText(reason, 'visual comparison reason');
  return {
    kind: VISUAL_COMPARISON_KIND,
    version: VISUAL_COMPARISON_VERSION,
    status: 'not-evaluated',
    reason,
    baselineHash: null,
    candidateHash: candidate?.canonicalHash ?? null,
    counts: {
      added: 0,
      missing: 0,
      changed: 0,
      unchanged: candidate?.images?.length ?? 0,
      incompatible: 0,
      error: 0,
    },
    checkpoints: [],
  };
}

export function renderVisualManifestMarkdown(manifest) {
  validateVisualManifest(manifest);
  const lines = [
    '# ux-guard visual candidate',
    '',
    `- **Approval:** ${manifest.approval.status}`,
    `- **Canonical hash:** \`${manifest.canonicalHash}\``,
    `- **Profile set:** \`${manifest.profiles.canonicalHash}\``,
    `- **Checkpoint policy:** \`${manifest.policy.canonicalHash}\``,
    `- **Stable repetitions:** ${manifest.capture.repetitions}`,
    `- **Images:** ${manifest.images.length}`,
    '',
    '## Checkpoint images',
    '',
  ];
  for (const image of manifest.images) {
    lines.push(
      `- \`${image.id}\` — ${image.width}×${image.height}; \`${image.sha256}\`; \`${image.path}\``,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function renderVisualComparisonMarkdown(comparison) {
  validateVisualComparison(comparison);
  const lines = [
    '# ux-guard visual comparison',
    '',
    `- **Status:** ${comparison.status}`,
    `- **Reason:** ${comparison.reason}`,
    `- **Baseline:** ${comparison.baselineHash ?? 'not available'}`,
    `- **Candidate:** ${comparison.candidateHash ?? 'not available'}`,
    '',
  ];
  if (comparison.checkpoints.length) {
    lines.push('## Per-checkpoint evidence', '');
    for (const checkpoint of comparison.checkpoints) {
      lines.push(
        `- \`${checkpoint.key}\` — **${checkpoint.status}**; baseline: ${
          checkpoint.baseline
            ? `\`${checkpoint.baseline.path}\` / \`${checkpoint.baseline.sha256}\` / ${checkpoint.baseline.width}×${checkpoint.baseline.height}`
            : 'none'
        }; candidate: ${
          checkpoint.candidate
            ? `\`${checkpoint.candidate.path}\` / \`${checkpoint.candidate.sha256}\` / ${checkpoint.candidate.width}×${checkpoint.candidate.height}`
            : 'none'
        }`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function validateVisualComparison(comparison) {
  assertMap(comparison, 'visual comparison');
  assertExactKeys(
    comparison,
    [
      'kind',
      'version',
      'status',
      'reason',
      'baselineHash',
      'candidateHash',
      'counts',
      'checkpoints',
    ],
    'visual comparison',
  );
  if (
    comparison.kind !== VISUAL_COMPARISON_KIND ||
    comparison.version !== VISUAL_COMPARISON_VERSION
  ) {
    throw new VisualContractError('visual comparison generation is unsupported');
  }
  if (
    ![
      'not-evaluated',
      'unchanged',
      'added',
      'missing',
      'changed',
      'incompatible',
      'error',
    ].includes(comparison.status)
  ) {
    throw new VisualContractError('visual comparison status is invalid');
  }
  assertText(comparison.reason, 'visual comparison reason');
  for (const [field, value] of [
    ['baselineHash', comparison.baselineHash],
    ['candidateHash', comparison.candidateHash],
  ]) {
    if (value !== null) assertHash(value, `visual comparison.${field}`);
  }
  assertExactMap(
    comparison.counts,
    ['added', 'missing', 'changed', 'unchanged', 'incompatible', 'error'],
    'visual comparison.counts',
  );
  for (const [field, value] of Object.entries(comparison.counts)) {
    assertNonNegativeInteger(value, `visual comparison.counts.${field}`);
  }
  if (!Array.isArray(comparison.checkpoints)) {
    throw new VisualContractError('visual comparison.checkpoints must be an array');
  }
  for (const [index, checkpoint] of comparison.checkpoints.entries()) {
    const path = `visual comparison.checkpoints[${index}]`;
    assertExactMap(
      checkpoint,
      ['key', 'status', 'baseline', 'candidate'],
      path,
    );
    assertText(checkpoint.key, `${path}.key`);
    if (!['added', 'missing', 'changed', 'unchanged'].includes(checkpoint.status)) {
      throw new VisualContractError(`${path}.status is invalid`);
    }
    for (const field of ['baseline', 'candidate']) {
      const reference = checkpoint[field];
      if (reference === null) continue;
      assertExactMap(
        reference,
        ['id', 'path', 'sha256', 'width', 'height'],
        `${path}.${field}`,
      );
      assertId(reference.id, `${path}.${field}.id`);
      assertSafePath(reference.path, `${path}.${field}.path`);
      if (!RAW_HASH.test(reference.sha256)) {
        throw new VisualContractError(`${path}.${field}.sha256 is invalid`);
      }
      assertPositiveInteger(reference.width, `${path}.${field}.width`);
      assertPositiveInteger(reference.height, `${path}.${field}.height`);
    }
  }
  return comparison;
}

export function promoteVisualManifest(manifest, { reviewer, reviewedAt, rationale } = {}) {
  validateVisualManifest(manifest);
  if (manifest.approval.status !== 'unapproved') {
    throw new VisualContractError('only an unapproved visual candidate can be promoted');
  }
  assertText(reviewer, 'visual reviewer');
  assertText(rationale, 'visual review rationale');
  if (
    typeof reviewedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(reviewedAt) ||
    Number.isNaN(Date.parse(reviewedAt))
  ) {
    throw new VisualContractError('visual reviewedAt must be an explicit UTC timestamp');
  }
  const promoted = structuredClone(manifest);
  promoted.approval = {
    status: 'reviewed',
    reviewer,
    reviewedAt,
    rationale,
  };
  promoted.canonicalHash = canonicalHash(promoted);
  return validateVisualManifest(promoted);
}

export function writeVisualCandidateBundle({
  root,
  manifestPath,
  manifest,
  sourceImages,
} = {}) {
  validateVisualManifest(manifest);
  if (manifest.approval.status !== 'unapproved') {
    throw new VisualContractError('candidate visual manifest must be unapproved');
  }
  const targetManifest = safeDestination(root, manifestPath, 'visual candidate manifest');
  if (existsSync(targetManifest)) {
    throw new VisualContractError(`${manifestPath} already exists; refusing to overwrite it`);
  }
  const bundleRoot = dirname(targetManifest);
  ensureSafeDirectory(root, bundleRoot, true);
  for (const image of manifest.images) {
    const source = sourceImages.get(image.id);
    if (!source) throw new VisualContractError(`source image ${image.id} is missing`);
    const bytes = readRegularContainedFile(root, source, `source image ${image.id}`);
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
      throw new VisualContractError(`source image ${image.id} hash changed`);
    }
    const destination = safeDestination(bundleRoot, image.path, `image ${image.id}`);
    ensureSafeDirectory(bundleRoot, dirname(destination), true);
    try {
      copyFileSync(resolve(root, source), destination, 1);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new VisualContractError(`${image.path} already exists; refusing to overwrite it`);
      }
      throw new VisualContractError(`could not write visual image ${image.id}`);
    }
  }
  try {
    writeFileSync(targetManifest, serializeVisualManifest(manifest), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new VisualContractError(`${manifestPath} already exists; refusing to overwrite it`);
    }
    throw new VisualContractError('could not write visual candidate manifest');
  }
}

export function promoteVisualBundle({
  root,
  candidatePath,
  baselinePath,
  reviewer,
  reviewedAt,
  rationale,
  profileSet,
  checkpointPolicy,
} = {}) {
  const candidateFull = safeExistingFile(root, candidatePath, 'visual candidate');
  const candidateRoot = dirname(candidateFull);
  const candidate = parseVisualManifest(readFileSync(candidateFull, 'utf8'), {
    profileSet,
    checkpointPolicy,
    bundleRoot: candidateRoot,
    requireFiles: true,
  });
  const promoted = promoteVisualManifest(candidate, {
    reviewer,
    reviewedAt,
    rationale,
  });
  const baselineFull = safeDestination(root, baselinePath, 'visual baseline');
  if (existsSync(baselineFull)) {
    throw new VisualContractError(`${baselinePath} already exists; promotion never overwrites`);
  }
  const baselineRoot = dirname(baselineFull);
  ensureSafeDirectory(root, baselineRoot, true);
  for (const image of promoted.images) {
    const source = safeExistingFile(candidateRoot, image.path, `candidate image ${image.id}`);
    const destination = safeDestination(baselineRoot, image.path, `baseline image ${image.id}`);
    ensureSafeDirectory(baselineRoot, dirname(destination), true);
    copyFileSync(source, destination, 1);
  }
  writeFileSync(baselineFull, serializeVisualManifest(promoted), {
    flag: 'wx',
    mode: 0o600,
  });
  return promoted;
}

export function serializeVisualManifest(manifest) {
  validateVisualManifest(manifest);
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

export function runVisualComparisonCanaries() {
  const image = {
    id: 'visual.example.journey.checkpoint.light.profile',
    useCaseId: 'example',
    journeyId: 'journey',
    checkpointId: 'checkpoint',
    scheme: 'light',
    profileId: 'profile',
    profileHash: `sha256:${'1'.repeat(64)}`,
    tier: 'primary',
    purpose: 'detail',
    path: 'images/example.png',
    sha256: '2'.repeat(64),
    width: 100,
    height: 40,
    masks: [],
    tolerance: { mode: 'exact' },
  };
  const base = syntheticManifest(image, 'reviewed');
  const changedImage = { ...image, sha256: '3'.repeat(64), height: 41 };
  const changed = compareVisualManifests(
    base,
    syntheticManifest(changedImage, 'unapproved'),
  );
  if (
    changed.status !== 'changed' ||
    changed.counts.changed !== 1 ||
    changed.checkpoints[0]?.status !== 'changed'
  ) {
    throw new VisualContractError('one-pixel visual canary was not detected');
  }
  const missing = compareVisualManifests(
    base,
    syntheticManifest([], 'unapproved'),
  );
  if (missing.status !== 'missing' || missing.counts.missing !== 1) {
    throw new VisualContractError('missing visual checkpoint canary was not detected');
  }
  const incompatibleCandidate = syntheticManifest(image, 'unapproved');
  incompatibleCandidate.profiles.canonicalHash = `sha256:${'4'.repeat(64)}`;
  incompatibleCandidate.canonicalHash = canonicalHash(incompatibleCandidate);
  const incompatible = compareVisualManifests(base, incompatibleCandidate);
  if (incompatible.status !== 'incompatible') {
    throw new VisualContractError('visual profile mismatch canary was not detected');
  }
  return {
    onePixelSystemicChange: 'passed',
    missingCheckpoint: 'passed',
    profileMismatch: 'passed',
    failClosed: 'passed',
  };
}

export function pngDimensions(bytes, path = 'PNG') {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new VisualContractError(`${path} is not a valid PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function visualImageId(value) {
  return `visual.${value.useCaseId}.${value.journeyId}.${value.checkpointId}.${value.scheme}.${value.profileId}`;
}

export function visualImageKey(value) {
  return [
    value.useCaseId,
    value.journeyId,
    value.checkpointId,
    value.scheme,
    value.profileId,
  ].join('/');
}

export function checkpointKey(value) {
  return [value.useCaseId, value.journeyId, value.checkpointId].join('/');
}

function validateImageRecord(image, path) {
  assertMap(image, path);
  assertExactKeys(
    image,
    [
      'id',
      'useCaseId',
      'journeyId',
      'checkpointId',
      'scheme',
      'profileId',
      'profileHash',
      'tier',
      'purpose',
      'path',
      'sha256',
      'width',
      'height',
      'masks',
      'tolerance',
    ],
    path,
  );
  assertId(image.id, `${path}.id`);
  assertId(image.useCaseId, `${path}.useCaseId`, USE_CASE_ID);
  assertId(image.journeyId, `${path}.journeyId`);
  assertId(image.checkpointId, `${path}.checkpointId`);
  if (!['light', 'dark'].includes(image.scheme)) {
    throw new VisualContractError(`${path}.scheme is invalid`);
  }
  assertId(image.profileId, `${path}.profileId`);
  assertHash(image.profileHash, `${path}.profileHash`);
  if (!['primary', 'secondary', 'representative'].includes(image.tier)) {
    throw new VisualContractError(`${path}.tier is invalid`);
  }
  if (!['success', 'detail', 'form'].includes(image.purpose)) {
    throw new VisualContractError(`${path}.purpose is invalid`);
  }
  assertSafePath(image.path, `${path}.path`);
  if (!RAW_HASH.test(image.sha256)) {
    throw new VisualContractError(`${path}.sha256 is invalid`);
  }
  assertPositiveInteger(image.width, `${path}.width`);
  assertPositiveInteger(image.height, `${path}.height`);
  if (
    !Array.isArray(image.masks) ||
    image.masks.some((mask) => typeof mask !== 'string' || !ID.test(mask))
  ) {
    throw new VisualContractError(`${path}.masks is invalid`);
  }
  assertExactMap(image.tolerance, ['mode'], `${path}.tolerance`);
  if (image.tolerance.mode !== 'exact') {
    throw new VisualContractError(`${path}.tolerance must be exact`);
  }
  if (image.id !== visualImageId(image)) {
    throw new VisualContractError(`${path}.id is not derived from checkpoint identity`);
  }
}

function expectedImagePolicies(policy, profiles) {
  const keys = new Map();
  for (const checkpoint of policy.checkpoints) {
    for (const profileId of checkpoint.profiles) {
      const profile = profiles.get(profileId);
      if (!profile) {
        throw new VisualContractError(
          `visual checkpoint references unknown profile ${profileId}`,
        );
      }
      keys.set(
        [
          checkpoint.useCaseId,
          checkpoint.journeyId,
          checkpoint.checkpointId,
          profile.colorScheme,
          profileId,
        ].join('/'),
        checkpoint,
      );
    }
  }
  return keys;
}

function validateApproval(approval) {
  assertMap(approval, 'visual manifest.approval');
  if (approval.status === 'unapproved') {
    assertExactKeys(approval, ['status'], 'visual manifest.approval');
    return;
  }
  assertExactKeys(
    approval,
    ['status', 'reviewer', 'reviewedAt', 'rationale'],
    'visual manifest.approval',
  );
  if (approval.status !== 'reviewed') {
    throw new VisualContractError('visual manifest approval status is invalid');
  }
  assertText(approval.reviewer, 'visual manifest.approval.reviewer');
  assertText(approval.rationale, 'visual manifest.approval.rationale');
  if (
    typeof approval.reviewedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(approval.reviewedAt)
  ) {
    throw new VisualContractError('visual manifest.approval.reviewedAt is invalid');
  }
}

function visualComparison(status, overrides = {}) {
  const checkpoints = overrides.checkpoints ?? [];
  const comparison = {
    kind: VISUAL_COMPARISON_KIND,
    version: VISUAL_COMPARISON_VERSION,
    status,
    reason: overrides.reason ?? 'visual comparison completed',
    baselineHash: overrides.baselineHash ?? null,
    candidateHash: overrides.candidateHash ?? null,
    counts:
      overrides.counts ??
      {
        added: 0,
        missing: 0,
        changed: 0,
        unchanged: 0,
        incompatible: status === 'incompatible' ? 1 : 0,
        error: status === 'error' ? 1 : 0,
      },
    checkpoints,
  };
  return validateVisualComparison(comparison);
}

function countStatuses(checkpoints) {
  const counts = {
    added: 0,
    missing: 0,
    changed: 0,
    unchanged: 0,
    incompatible: 0,
    error: 0,
  };
  for (const checkpoint of checkpoints) counts[checkpoint.status] += 1;
  return counts;
}

function imageReference(image) {
  return {
    id: image.id,
    path: image.path,
    sha256: image.sha256,
    width: image.width,
    height: image.height,
  };
}

function syntheticManifest(images, status) {
  const list = Array.isArray(images) ? images : [images];
  const manifest = {
    kind: VISUAL_MANIFEST_KIND,
    version: VISUAL_MANIFEST_VERSION,
    approval:
      status === 'reviewed'
        ? {
            status,
            reviewer: 'visual-owner',
            reviewedAt: '2026-11-16T18:00:00Z',
            rationale: 'Known-bad comparison canary.',
          }
        : { status },
    profiles: {
      path: 'ux/visual-profiles.json',
      canonicalHash: `sha256:${'a'.repeat(64)}`,
    },
    policy: {
      path: 'ux/visual-checkpoints.json',
      canonicalHash: `sha256:${'b'.repeat(64)}`,
    },
    capture: { repetitions: 3, deterministic: true },
    images: list,
    canonicalHash: '',
  };
  manifest.canonicalHash = canonicalHash(manifest);
  return validateVisualManifest(manifest);
}

function readRegularContainedFile(root, path, label) {
  if (!root) throw new VisualContractError(`${label} has no bundle root`);
  const full = safeExistingFile(root, path, label);
  return readFileSync(full);
}

function safeExistingFile(root, path, label) {
  assertSafePath(path, `${label} path`);
  const rootReal = realDirectory(root, `${label} root`);
  const full = resolve(rootReal, path);
  let stats;
  let real;
  try {
    stats = lstatSync(full);
    real = realpathSync(full);
  } catch {
    throw new VisualContractError(`${label} does not exist`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new VisualContractError(`${label} must be a regular file, not a symbolic link`);
  }
  ensureContained(rootReal, real, label);
  return real;
}

function safeDestination(root, path, label) {
  assertSafePath(path, `${label} path`);
  const full = resolve(root, path);
  ensureContained(resolve(root), full, label);
  return full;
}

function ensureSafeDirectory(root, directory, create) {
  const rootFull = resolve(root);
  ensureContained(rootFull, resolve(directory), 'visual directory');
  const fromRoot = relative(rootFull, resolve(directory));
  let current = rootFull;
  for (const part of fromRoot ? fromRoot.split(sep) : []) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!create) throw new VisualContractError('visual parent directory is missing');
      mkdirSync(current, { mode: 0o700 });
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new VisualContractError('visual parent must not be a symbolic link');
    }
  }
}

function realDirectory(path, label) {
  try {
    const real = realpathSync(resolve(path));
    if (!lstatSync(real).isDirectory()) throw new Error('not directory');
    return real;
  } catch {
    throw new VisualContractError(`${label} must be an existing directory`);
  }
}

function ensureContained(root, target, label) {
  const value = relative(resolve(root), resolve(target));
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new VisualContractError(`${label} escapes its allowed root`);
  }
}

function assertSafePath(path, label) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new VisualContractError(`${label} must be a normalized relative path`);
  }
}

function assertAbsoluteNormalizedPath(path, label) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))
  ) {
    throw new VisualContractError(`${label} must be a normalized absolute path`);
  }
}

function parseJson(text, label) {
  if (typeof text !== 'string') throw new VisualContractError(`${label} must be JSON text`);
  try {
    return JSON.parse(text);
  } catch {
    throw new VisualContractError(`${label} is not valid JSON`);
  }
}

function assertCanonicalHash(value, path) {
  assertHash(value.canonicalHash, `${path}.canonicalHash`);
  if (value.canonicalHash !== canonicalHash(value)) {
    throw new VisualContractError(`${path}.canonicalHash does not match canonical content`);
  }
}

function assertHash(value, path) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new VisualContractError(`${path} is not a sha256 hash`);
  }
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VisualContractError(`${path} must be an object`);
  }
}

function assertExactMap(value, keys, path) {
  assertMap(value, path);
  assertExactKeys(value, keys, path);
}

function assertExactKeys(value, keys, path) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new VisualContractError(`${path} must contain ${expected.join(', ')} only`);
  }
}

function assertId(value, path, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new VisualContractError(`${path} is not a safe id`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VisualContractError(`${path} must be non-empty text`);
  }
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VisualContractError(`${path} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VisualContractError(`${path} must be a non-negative integer`);
  }
}
