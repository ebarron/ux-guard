import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  canonicalHash,
  compareVisualManifests,
  createVisualManifest,
  parseVisualManifest,
  promoteVisualBundle,
  runVisualComparisonCanaries,
  validateVisualCheckpointPolicy,
  validateVisualProfileSet,
  VisualContractError,
  visualImageId,
  writeVisualCandidateBundle,
} from '../lib/visuals.mjs';

test('strict visual profiles and checkpoint policies are canonical and versioned', () => {
  const { profiles, policy } = contracts();
  assert.equal(validateVisualProfileSet(profiles), profiles);
  assert.equal(validateVisualCheckpointPolicy(policy), policy);

  const extra = structuredClone(profiles);
  extra.profiles[0].unexpected = true;
  assert.throws(
    () => validateVisualProfileSet(extra),
    /must contain .* only/,
  );
  const tampered = structuredClone(policy);
  tampered.checkpoints[0].purpose = 'success';
  assert.throws(
    () => validateVisualCheckpointPolicy(tampered),
    /canonicalHash does not match/,
  );
});

test('manifest validation fails closed for missing checkpoints and profile mismatch', () => {
  const { profiles, policy } = contracts();
  assert.throws(
    () =>
      createVisualManifest({
        profileSet: profiles,
        checkpointPolicy: policy,
        profilePath: 'ux/visual-profiles.json',
        policyPath: 'ux/visual-checkpoints.json',
        images: [],
      }),
    /missing 1 required checkpoint/,
  );
  const image = visualImage(profiles, policy);
  image.profileHash = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () =>
      createVisualManifest({
        profileSet: profiles,
        checkpointPolicy: policy,
        profilePath: 'ux/visual-profiles.json',
        policyPath: 'ux/visual-checkpoints.json',
        images: [image],
      }),
    /profile mismatch/,
  );
  const override = visualImage(profiles, policy);
  override.masks = ['candidate-mask'];
  assert.throws(
    () =>
      createVisualManifest({
        profileSet: profiles,
        checkpointPolicy: policy,
        profilePath: 'ux/visual-profiles.json',
        policyPath: 'ux/visual-checkpoints.json',
        images: [override],
      }),
    /override trusted checkpoint policy/,
  );
});

test('image path, symlink, hash, and dimensions are validated', () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-guard-visual-'));
  const { profiles, policy } = contracts();
  const bytes = png(100, 40);
  const image = visualImage(profiles, policy, bytes);
  const manifest = createVisualManifest({
    profileSet: profiles,
    checkpointPolicy: policy,
    profilePath: 'ux/visual-profiles.json',
    policyPath: 'ux/visual-checkpoints.json',
    images: [image],
  });
  mkdirSync(join(root, 'images'));
  writeFileSync(join(root, image.path), bytes);
  parseVisualManifest(JSON.stringify(manifest), {
    profileSet: profiles,
    checkpointPolicy: policy,
    bundleRoot: root,
    requireFiles: true,
  });

  writeFileSync(join(root, image.path), png(101, 40));
  assert.throws(
    () =>
      parseVisualManifest(JSON.stringify(manifest), {
        profileSet: profiles,
        checkpointPolicy: policy,
        bundleRoot: root,
        requireFiles: true,
      }),
    /image hash does not match/,
  );
  writeFileSync(join(root, 'real.png'), bytes);
  symlinkSync(join(root, 'real.png'), join(root, 'images', 'linked.png'));
  const linked = structuredClone(manifest);
  linked.images[0].path = 'images/linked.png';
  linked.canonicalHash = canonicalHash(linked);
  assert.throws(
    () =>
      parseVisualManifest(JSON.stringify(linked), {
        bundleRoot: root,
        requireFiles: true,
      }),
    /symbolic link/,
  );
});

test('candidate write and owner promotion never overwrite artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ux-guard-visual-lifecycle-'));
  const { profiles, policy } = contracts();
  const bytes = png(100, 40);
  const image = visualImage(profiles, policy, bytes);
  mkdirSync(join(root, 'raw'));
  writeFileSync(join(root, 'raw', 'source.png'), bytes);
  const manifest = createVisualManifest({
    profileSet: profiles,
    checkpointPolicy: policy,
    profilePath: 'ux/visual-profiles.json',
    policyPath: 'ux/visual-checkpoints.json',
    images: [image],
  });
  const options = {
    root,
    manifestPath: 'candidate/manifest.json',
    manifest,
    sourceImages: new Map([[image.id, 'raw/source.png']]),
  };
  writeVisualCandidateBundle(options);
  assert.throws(() => writeVisualCandidateBundle(options), /refusing to overwrite/);
  assert.throws(
    () =>
      promoteVisualBundle({
        root,
        candidatePath: 'candidate/manifest.json',
        baselinePath: 'baseline/manifest.json',
        reviewer: '',
        reviewedAt: '2026-11-16T18:00:00Z',
        rationale: 'Reviewed every checkpoint.',
        profileSet: profiles,
        checkpointPolicy: policy,
      }),
    /reviewer/,
  );
  const promoted = promoteVisualBundle({
    root,
    candidatePath: 'candidate/manifest.json',
    baselinePath: 'baseline/manifest.json',
    reviewer: 'visual-owner',
    reviewedAt: '2026-11-16T18:00:00Z',
    rationale: 'Reviewed every checkpoint.',
    profileSet: profiles,
    checkpointPolicy: policy,
  });
  assert.equal(promoted.approval.status, 'reviewed');
  assert.throws(
    () =>
      promoteVisualBundle({
        root,
        candidatePath: 'candidate/manifest.json',
        baselinePath: 'baseline/manifest.json',
        reviewer: 'visual-owner',
        reviewedAt: '2026-11-16T18:00:00Z',
        rationale: 'Reviewed every checkpoint.',
        profileSet: profiles,
        checkpointPolicy: policy,
      }),
    /never overwrites/,
  );
  assert.match(
    readFileSync(join(root, 'baseline/manifest.json'), 'utf8'),
    /"status": "reviewed"/,
  );
});

test('comparison reports individual changes without aggregate masking', () => {
  const { profiles, policy } = contracts();
  const image = visualImage(profiles, policy);
  const candidate = createVisualManifest({
    profileSet: profiles,
    checkpointPolicy: policy,
    profilePath: 'ux/visual-profiles.json',
    policyPath: 'ux/visual-checkpoints.json',
    images: [image],
  });
  const baseline = structuredClone(candidate);
  baseline.approval = {
    status: 'reviewed',
    reviewer: 'visual-owner',
    reviewedAt: '2026-11-16T18:00:00Z',
    rationale: 'Reviewed checkpoint.',
  };
  baseline.canonicalHash = canonicalHash(baseline);
  const changed = structuredClone(candidate);
  changed.images[0].sha256 = 'f'.repeat(64);
  changed.canonicalHash = canonicalHash(changed);
  const comparison = compareVisualManifests(baseline, changed);
  assert.equal(comparison.status, 'changed');
  assert.equal(comparison.counts.changed, 1);
  assert.equal(comparison.checkpoints[0].status, 'changed');
  assert.deepEqual(runVisualComparisonCanaries(), {
    onePixelSystemicChange: 'passed',
    missingCheckpoint: 'passed',
    profileMismatch: 'passed',
    failClosed: 'passed',
  });
});

function contracts() {
  const profile = {
    id: 'chromium.desktop.light.linux-amd64.v1',
    version: 1,
    browser: {
      engine: 'chromium',
      version: '123.0.0.0',
      revision: '1234',
      channel: 'chrome-for-testing',
    },
    runtime: {
      os: 'linux',
      distribution: 'ubuntu',
      release: '24.04.4',
      architecture: 'x86_64',
      container: {
        image: 'registry.example.invalid/browser/runtime:1',
        digest: `sha256:${'1'.repeat(64)}`,
        indexDigest: `sha256:${'2'.repeat(64)}`,
      },
    },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    fonts: [
      {
        family: 'Example Sans',
        style: 'normal',
        weight: 400,
        path: '/fonts/example-sans-regular.ttf',
        sha256: `sha256:${'3'.repeat(64)}`,
      },
    ],
    locale: 'en-US',
    timezone: 'UTC',
    colorScheme: 'light',
    clock: '2026-11-16T12:00:00.000Z',
    reducedMotion: 'reduce',
    rendering: {
      animations: 'disabled',
      transitions: 'disabled',
      carets: 'hidden',
    },
    network: { mode: 'mocked-only' },
    screenshot: {
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      omitBackground: false,
      maskColor: '#ff00ff',
    },
    adapters: {
      uxGuard: '0.6.0',
      visual: '1',
      playwright: '1',
      schema: '1',
    },
    canonicalHash: '',
  };
  profile.canonicalHash = canonicalHash(profile);
  const dark = structuredClone(profile);
  dark.id = 'chromium.desktop.dark.linux-amd64.v1';
  dark.colorScheme = 'dark';
  dark.canonicalHash = canonicalHash(dark);
  const profiles = {
    kind: 'ux-guard-visual-profile-set',
    version: 1,
    profiles: [profile, dark],
    canonicalHash: '',
  };
  profiles.canonicalHash = canonicalHash(profiles);
  const policy = {
    kind: 'ux-guard-visual-checkpoint-policy',
    version: 1,
    checkpoints: [
      {
        useCaseId: 'example',
        journeyId: 'journey',
        checkpointId: 'detail',
        tier: 'primary',
        purpose: 'detail',
        profiles: [profile.id],
        masks: [],
        tolerance: { mode: 'exact' },
      },
    ],
    canonicalHash: '',
  };
  policy.canonicalHash = canonicalHash(policy);
  return { profiles, policy };
}

function visualImage(profiles, policy, bytes = png(100, 40)) {
  const profile = profiles.profiles[0];
  const checkpoint = policy.checkpoints[0];
  const image = {
    id: visualImageId({
      ...checkpoint,
      scheme: profile.colorScheme,
      profileId: profile.id,
    }),
    useCaseId: checkpoint.useCaseId,
    journeyId: checkpoint.journeyId,
    checkpointId: checkpoint.checkpointId,
    scheme: profile.colorScheme,
    profileId: profile.id,
    profileHash: profile.canonicalHash,
    tier: checkpoint.tier,
    purpose: checkpoint.purpose,
    path: 'images/example.png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 100,
    height: 40,
    masks: [],
    tolerance: { mode: 'exact' },
  };
  return image;
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
