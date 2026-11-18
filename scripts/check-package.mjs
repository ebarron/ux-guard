#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITATIVE_BUNDLE_VERSION,
} from '../lib/authoritative.mjs';
import {
  JOURNEY_BASELINE_VERSION,
  JOURNEY_COMPARISON_VERSION,
} from '../lib/baselines.mjs';
import {
  JOURNEY_ARTIFACT_VERSION,
  JOURNEY_POLICY_VERSION,
} from '../lib/journey-policy.mjs';
import { JOURNEY_REPORT_VERSION } from '../lib/journeys.mjs';
import { OBSERVATION_VERSION } from '../lib/observations.mjs';
import {
  RUN_ENVELOPE_VERSION,
  UX_GUARD_TOOL_VERSION,
} from '../lib/run-contract.mjs';
import { JOURNEY_SHARD_VERSION } from '../lib/shards.mjs';
import {
  OWNER_TARGETS_VERSION,
  TARGET_ATTAINMENT_VERSION,
} from '../lib/targets.mjs';
import { VERDICT_REPORT_VERSION } from '../lib/verdicts.mjs';
import {
  VISUAL_CHECKPOINT_POLICY_VERSION,
  VISUAL_COMPARISON_VERSION,
  VISUAL_MANIFEST_VERSION,
  VISUAL_PROFILE_SET_VERSION,
} from '../lib/visuals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@edjbarron/ux-guard';
const PACKAGE_VERSION = '0.6.0';
const TYPESCRIPT_VERSION = '5.9.3';
const EXPORTS = {
  './authoritative': './lib/authoritative.mjs',
  './baselines': './lib/baselines.mjs',
  './journey-policy': './lib/journey-policy.mjs',
  './journeys': './lib/journeys.mjs',
  './observations': './lib/observations.mjs',
  './playwright': './lib/playwright.mjs',
  './run-contract': './lib/run-contract.mjs',
  './shards': './lib/shards.mjs',
  './targets': './lib/targets.mjs',
  './visuals': './lib/visuals.mjs',
  './verdicts': './lib/verdicts.mjs',
};
const LIBRARY_FILES = [
  'authoritative.mjs',
  'baselines.mjs',
  'catalog.mjs',
  'cli.mjs',
  'config.mjs',
  'discovery.mjs',
  'journey-policy.mjs',
  'journeys.mjs',
  'observations.mjs',
  'patterns.mjs',
  'playwright.mjs',
  'run-contract.mjs',
  'shards.mjs',
  'targets.mjs',
  'verdicts.mjs',
  'visuals.mjs',
  'yaml.mjs',
];
const PACKED_FILES = [
  'LICENSE',
  'NOTICE',
  'README.md',
  'bin/ux-guard.mjs',
  ...LIBRARY_FILES.map((name) => `lib/${name}`),
  'package.json',
].sort();
const ROOT_FILES = new Set([
  '.github',
  '.gitignore',
  '.npmrc',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'docs',
  'LICENSE',
  'NOTICE',
  'PROVENANCE.md',
  'README.md',
  'SECURITY.md',
  'bin',
  'lib',
  'package-lock.json',
  'package.json',
  'scripts',
  'test',
]);

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function verifyMetadata() {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, PACKAGE_VERSION);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.bin, { 'ux-guard': 'bin/ux-guard.mjs' });
  assert.deepEqual(pkg.files, ['bin', 'lib', 'README.md', 'LICENSE', 'NOTICE']);
  assert.deepEqual(pkg.exports, EXPORTS);
  assert.deepEqual(pkg.dependencies, { typescript: TYPESCRIPT_VERSION });
  assert.equal(Object.hasOwn(pkg, 'publishConfig'), false);

  const lock = readJson('package-lock.json');
  assert.equal(lock.name, PACKAGE_NAME);
  assert.equal(lock.version, PACKAGE_VERSION);
  assert.equal(lock.packages[''].name, PACKAGE_NAME);
  assert.equal(lock.packages[''].version, PACKAGE_VERSION);
  assert.deepEqual(lock.packages[''].dependencies, {
    typescript: TYPESCRIPT_VERSION,
  });
  assert.equal(
    lock.packages['node_modules/typescript'].version,
    TYPESCRIPT_VERSION,
  );
}

function verifyVersions() {
  assert.equal(UX_GUARD_TOOL_VERSION, PACKAGE_VERSION);
  assert.deepEqual(
    {
      authoritativeBundle: AUTHORITATIVE_BUNDLE_VERSION,
      journeyArtifact: JOURNEY_ARTIFACT_VERSION,
      journeyBaseline: JOURNEY_BASELINE_VERSION,
      journeyComparison: JOURNEY_COMPARISON_VERSION,
      journeyPolicy: JOURNEY_POLICY_VERSION,
      journeyReport: JOURNEY_REPORT_VERSION,
      journeyShard: JOURNEY_SHARD_VERSION,
      observation: OBSERVATION_VERSION,
      ownerTargets: OWNER_TARGETS_VERSION,
      runEnvelope: RUN_ENVELOPE_VERSION,
      targetAttainment: TARGET_ATTAINMENT_VERSION,
      verdictReport: VERDICT_REPORT_VERSION,
      visualCheckpointPolicy: VISUAL_CHECKPOINT_POLICY_VERSION,
      visualComparison: VISUAL_COMPARISON_VERSION,
      visualManifest: VISUAL_MANIFEST_VERSION,
      visualProfileSet: VISUAL_PROFILE_SET_VERSION,
    },
    {
      authoritativeBundle: 1,
      journeyArtifact: 2,
      journeyBaseline: 1,
      journeyComparison: 2,
      journeyPolicy: 3,
      journeyReport: 5,
      journeyShard: 1,
      observation: 1,
      ownerTargets: 2,
      runEnvelope: 1,
      targetAttainment: 1,
      verdictReport: 6,
      visualCheckpointPolicy: 1,
      visualComparison: 1,
      visualManifest: 1,
      visualProfileSet: 1,
    },
  );
}

function verifyRepositoryBoundary() {
  const tracked = execFileSync(
    'git',
    ['ls-files', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const path of tracked) {
    const [top] = path.split('/');
    assert.ok(ROOT_FILES.has(top), `unexpected tracked path: ${path}`);
  }
  assert.ok(!tracked.includes('action.yml'), 'action.yml must remain excluded');
  assert.ok(
    !tracked.some(
      (path) =>
        path === '.uxguard.json' ||
        path.startsWith('ux/') ||
        path.includes('playwright.config'),
    ),
    'consumer configuration must remain excluded',
  );
  assert.deepEqual(readdirSync(join(ROOT, 'lib')).sort(), LIBRARY_FILES);

  const testFiles = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
  const testCount = testFiles.reduce((count, name) => {
    const source = readFileSync(join(ROOT, 'test', name), 'utf8');
    return count + [...source.matchAll(/\btest\(/g)].length;
  }, 0);
  assert.equal(testCount, 100);
}

function verifyPackedBoundary() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const output = execFileSync(
    npm,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const [packed] = JSON.parse(output);
  assert.equal(packed.name, PACKAGE_NAME);
  assert.equal(packed.version, PACKAGE_VERSION);
  assert.deepEqual(
    packed.files.map(({ path }) => path).sort(),
    PACKED_FILES,
  );
}

verifyMetadata();
verifyVersions();
verifyRepositoryBoundary();
verifyPackedBoundary();
process.stdout.write('ux-guard package boundary: clean\n');
