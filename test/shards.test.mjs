import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  JourneyShardError,
  JourneyShardUpgradeError,
  aggregateJourneyShards,
  createJourneyShard,
  shardFileName,
  writeJourneyShard,
} from '../lib/shards.mjs';
import {
  catalog,
  measurement,
  policy,
  runFor,
} from './contract-helpers.mjs';

function directory() {
  const root = mkdtempSync(join(tmpdir(), 'ux-guard-shards-'));
  const shards = join(root, 'shards');
  mkdirSync(shards);
  return { root, shards };
}

function identity(reviewed) {
  const run = runFor(reviewed, []);
  return {
    provenance: run.provenance,
    tool: run.tool,
    policy: run.policy,
    browser: run.browser,
    adapters: run.adapters,
  };
}

function shard(reviewed, journeyId, repeatIndex = 0, overrides = {}) {
  const journey = measurement(journeyId, overrides.measurement ?? {});
  return createJourneyShard({
    runIdentity: identity(reviewed),
    useCaseId: 'create-record',
    journeyId,
    project: 'chromium',
    repeatIndex,
    status: journey.status,
    journey,
    ...overrides,
  });
}

test('immutable per-test shards aggregate deterministically independent of file order', () => {
  const reviewed = policy(['standard', 'advanced']);
  const first = directory();
  const second = directory();
  const shards = [
    shard(reviewed, 'standard', 0),
    shard(reviewed, 'standard', 1),
    shard(reviewed, 'advanced', 0),
    shard(reviewed, 'advanced', 1),
  ];
  for (const value of shards) writeJourneyShard(first.shards, value);
  for (const value of [...shards].reverse()) writeJourneyShard(second.shards, value);
  const options = {
    policy: reviewed,
    catalog: catalog(),
    runIdentity: identity(reviewed),
    repetitions: 2,
  };
  const left = aggregateJourneyShards({ ...options, directory: first.shards });
  const right = aggregateJourneyShards({ ...options, directory: second.shards });

  assert.deepEqual(left, right);
  assert.equal(left.journeys.length, 2);
  assert.equal(left.run.artifacts[0].id, 'journey-shards');
});

test('aggregation records a consumer-neutral default artifact path', () => {
  const reviewed = policy();
  const { shards } = directory();
  writeJourneyShard(shards, shard(reviewed, 'standard'));
  const report = aggregateJourneyShards({
    directory: shards,
    policy: reviewed,
    catalog: catalog(),
    runIdentity: identity(reviewed),
  });

  assert.equal(report.run.artifacts[0].path, 'test-results/ux-guard/shards');
});

test('parallel shard paths are safe and collision-resistant from policy ids', () => {
  const reviewed = policy();
  const value = shard(reviewed, 'standard');
  const file = shardFileName(value);
  assert.match(file, /^create-record--standard--[a-f0-9]{24}\.json$/);
  assert.equal(file.includes('..'), false);
});

test('immutable writes reject duplicate expected shard output', () => {
  const reviewed = policy();
  const { shards } = directory();
  const value = shard(reviewed, 'standard');
  writeJourneyShard(shards, value);
  assert.throws(() => writeJourneyShard(shards, value), /already exists/);
});

test('aggregation fails closed on missing, malformed, and unstable shards', () => {
  const reviewed = policy();
  const options = {
    policy: reviewed,
    catalog: catalog(),
    runIdentity: identity(reviewed),
    repetitions: 2,
  };
  const missing = directory();
  writeJourneyShard(missing.shards, shard(reviewed, 'standard', 0));
  assert.throws(
    () => aggregateJourneyShards({ ...options, directory: missing.shards }),
    /missing expected shards/,
  );

  const malformed = directory();
  writeFileSync(join(malformed.shards, 'bad.json'), '{');
  assert.throws(
    () => aggregateJourneyShards({ ...options, directory: malformed.shards }),
    /not valid JSON/,
  );

  const unstable = directory();
  writeJourneyShard(unstable.shards, shard(reviewed, 'standard', 0));
  const changed = measurement('standard');
  changed.steps[0].metrics.clicks = 1;
  changed.metrics.clicks = 1;
  writeJourneyShard(
    unstable.shards,
    createJourneyShard({
      runIdentity: identity(reviewed),
      useCaseId: 'create-record',
      journeyId: 'standard',
      project: 'chromium',
      repeatIndex: 1,
      status: 'successful',
      journey: changed,
    }),
  );
  assert.throws(
    () => aggregateJourneyShards({ ...options, directory: unstable.shards }),
    /unstable repeated measurement/,
  );
});

test('aggregation rejects symlinks and filename/content mismatches', () => {
  const reviewed = policy();
  const options = {
    policy: reviewed,
    catalog: catalog(),
    runIdentity: identity(reviewed),
    repetitions: 1,
  };
  const linked = directory();
  const value = shard(reviewed, 'standard');
  const outside = join(linked.root, 'outside.json');
  writeFileSync(outside, JSON.stringify(value));
  symlinkSync(outside, join(linked.shards, shardFileName(value)));
  assert.throws(
    () => aggregateJourneyShards({ ...options, directory: linked.shards }),
    /symlink/,
  );

  const mismatch = directory();
  writeFileSync(join(mismatch.shards, 'forged.json'), JSON.stringify(value));
  assert.throws(
    () => aggregateJourneyShards({ ...options, directory: mismatch.shards }),
    /does not match/,
  );
});

test('corruption canary detects a duplicate shard id under another path', () => {
  const reviewed = policy();
  const { shards } = directory();
  const value = shard(reviewed, 'standard');
  const path = writeJourneyShard(shards, value);
  writeFileSync(join(shards, 'duplicate.json'), readFileSync(path));
  assert.throws(
    () =>
      aggregateJourneyShards({
        directory: shards,
        policy: reviewed,
        catalog: catalog(),
        runIdentity: identity(reviewed),
      }),
    JourneyShardError,
  );
});

test('aggregation distinguishes forged run identity from a tool or policy upgrade', () => {
  const reviewed = policy();
  const expectedIdentity = identity(reviewed);

  const forged = directory();
  const forgedShard = structuredClone(shard(reviewed, 'standard'));
  forgedShard.runIdentity.browser.profile = 'Candidate-controlled profile';
  writeFileSync(
    join(forged.shards, shardFileName(forgedShard)),
    `${JSON.stringify(forgedShard)}\n`,
  );
  assert.throws(
    () =>
      aggregateJourneyShards({
        directory: forged.shards,
        policy: reviewed,
        catalog: catalog(),
        runIdentity: expectedIdentity,
      }),
    /browser\/profile.*does not match/,
  );

  const upgraded = directory();
  const upgradedShard = structuredClone(shard(reviewed, 'standard'));
  upgradedShard.runIdentity.tool.version = '9.0.0';
  writeFileSync(
    join(upgraded.shards, shardFileName(upgradedShard)),
    `${JSON.stringify(upgradedShard)}\n`,
  );
  assert.throws(
    () =>
      aggregateJourneyShards({
        directory: upgraded.shards,
        policy: reviewed,
        catalog: catalog(),
        runIdentity: expectedIdentity,
      }),
    JourneyShardUpgradeError,
  );
});
