import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuthoritativeAdvisory } from '../lib/authoritative.mjs';
import { createJourneyPolicy } from '../lib/journey-policy.mjs';
import { createJourneyRecorder } from '../lib/journeys.mjs';
import { resolveRunIdentity } from '../lib/run-contract.mjs';
import { createJourneyShard, writeJourneyShard } from '../lib/shards.mjs';
import {
  canonicalHash,
  createVisualManifest,
  visualImageId,
  writeVisualCandidateBundle,
} from '../lib/visuals.mjs';
import { CATALOG, NAV, PAGE, config, tempRepo } from './helpers.mjs';

function commit(root, message) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'user.name=ux-guard-test',
      'commit',
      '-qm',
      message,
    ],
    { cwd: root },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

test('trusted authoritative regeneration owns aggregation, policy, and verdicts', () => {
  const visual = visualContracts();
  const policy = createJourneyPolicy([
    {
      useCaseId: 'create-record',
      journeyId: 'standard',
      variant: 'canonical',
      intent: {
        summary: 'Create a record.',
        steps: ['Open the form.', 'Create the record.'],
        success: 'The accepted record appears.',
      },
      approval: { status: 'owner-approved', approvedBy: 'product-owner' },
      automation: { status: 'bound', source: 'e2e/create-record.spec.ts' },
      measurements: { explicit: [], elapsed: null },
    },
  ], { rules: [] });
  const root = tempRepo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
        targets: 'ux/journey-targets.json',
        baseline: 'ux/journey-baseline.json',
      },
      visuals: {
        profiles: 'ux/visual-profiles.json',
        checkpoints: 'ux/visual-checkpoints.json',
        candidate: 'test-results/ux-guard/visual/candidate/manifest.json',
        baseline: 'ux/visual-baseline/manifest.json',
      },
    }),
    'ux/use-cases.yml': CATALOG,
    'ux/journey-policy.json': policy,
    'ux/patterns-baseline.json': {
      version: 1,
      controlValues: {
        'Button.size': ['xs'],
        'Button.variant': ['default'],
      },
      debt: {
        'inline-style': {},
        'px-literal': {},
        'raw-button': {},
        'icon-library': {},
        'hard-coded-color': {},
      },
    },
    'ux/visual-profiles.json': visual.profiles,
    'ux/visual-checkpoints.json': visual.policy,
    'src/nav.tsx': NAV,
    'src/Page.tsx': PAGE,
  });
  const base = commit(root, 'trusted base');
  const shards = join(root, 'candidate-shards');
  mkdirSync(shards);
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
  });
  recorder.beginStep('complete');
  recorder.endStep();
  const journey = recorder.finish({ status: 'successful' });
  const runIdentity = resolveRunIdentity(root, {
    policy,
    candidateCommit: base,
    baseCommit: base,
    browser: { name: 'chromium', profile: 'Reviewed desktop' },
    adapters: { playwright: '1', repetitions: '3' },
  });
  for (let repeatIndex = 0; repeatIndex < 3; repeatIndex += 1) {
    writeJourneyShard(
      shards,
      createJourneyShard({
        runIdentity,
        useCaseId: 'create-record',
        journeyId: 'standard',
        project: 'chromium',
        repeatIndex,
        status: 'successful',
        journey,
      }),
    );
  }
  const visualRoot = join(root, 'candidate-visuals');
  const rawRoot = join(root, 'raw-visuals');
  mkdirSync(rawRoot);
  const bytes = png(100, 40);
  const images = visual.profiles.profiles.map((profile) => {
    const image = {
      id: visualImageId({
        ...visual.policy.checkpoints[0],
        scheme: profile.colorScheme,
        profileId: profile.id,
      }),
      useCaseId: 'create-record',
      journeyId: 'standard',
      checkpointId: 'accepted-record',
      scheme: profile.colorScheme,
      profileId: profile.id,
      profileHash: profile.canonicalHash,
      tier: 'primary',
      purpose: 'success',
      path: '',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 100,
      height: 40,
      masks: [],
      tolerance: { mode: 'exact' },
    };
    image.path = `images/${image.id}.png`;
    writeFileSync(join(rawRoot, `${image.id}.png`), bytes);
    return image;
  });
  const visualManifest = createVisualManifest({
    profileSet: visual.profiles,
    checkpointPolicy: visual.policy,
    profilePath: 'ux/visual-profiles.json',
    policyPath: 'ux/visual-checkpoints.json',
    images,
  });
  writeVisualCandidateBundle({
    root,
    manifestPath: 'candidate-visuals/manifest.json',
    manifest: visualManifest,
    sourceImages: new Map(
      images.map((image) => [image.id, `raw-visuals/${image.id}.png`]),
    ),
  });

  const bundle = createAuthoritativeAdvisory({
    root,
    base,
    candidate: base,
    shards,
    visuals: visualRoot,
    profile: 'Reviewed desktop',
  });
  assert.equal(bundle.authority, 'trusted-base-advisory');
  assert.equal(bundle.journeys.run.completion.received, 1);
  assert.equal(bundle.verdict.rollout, 'advisory');
  assert.equal(bundle.verdict.readiness.trustedExecution, true);
  assert.equal(bundle.verdict.scoring.status, 'not-scored');
  assert.equal(bundle.verdict.visuals.status, 'not-evaluated');
  assert.equal(bundle.verdict.visuals.candidate.images, 2);
  assert.match(bundle.markdown, /trusted authoritative advisory report/);
  assert.doesNotMatch(bundle.markdown, /Candidate ux-guard code performed/);
});

function visualContracts() {
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
        useCaseId: 'create-record',
        journeyId: 'standard',
        checkpointId: 'accepted-record',
        tier: 'primary',
        purpose: 'success',
        profiles: profiles.profiles.map(({ id }) => id),
        masks: [],
        tolerance: { mode: 'exact' },
      },
    ],
    canonicalHash: '',
  };
  policy.canonicalHash = canonicalHash(policy);
  return { profiles, policy };
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
