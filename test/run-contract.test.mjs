import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RunContractError,
  canonicalJson,
  createRunEnvelope,
  policyDigest,
  validateRunEnvelope,
} from '../lib/run-contract.mjs';
import { policy, runFor } from './contract-helpers.mjs';

test('policy digests use canonicalized content and Node cryptographic hashes', () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(policyDigest(left), policyDigest(right));
  assert.match(policyDigest(left), /^sha256:[a-f0-9]{64}$/);
});

test('run envelope records provenance, versions, profile, completion, errors, and hashes', () => {
  const reviewed = policy();
  const run = runFor(reviewed, ['failed'], {
    errors: [
      {
        id: 'error.create-record.standard.1',
        category: 'assertion',
        message: 'expected visible',
        journeyRef: 'journey.create-record.standard',
      },
    ],
    artifacts: [
      {
        id: 'journey-shards',
        path: 'test-results/ux-guard/shards',
        sha256: 'a'.repeat(64),
      },
    ],
  });

  assert.equal(run.completion.status, 'completed');
  assert.equal(run.completion.result, 'failed');
  assert.equal(run.completion.failed, 1);
  assert.equal(run.policy.algorithm, 'sha256');
  assert.equal(run.browser.name, 'chromium');
  assert.equal(run.artifacts[0].sha256.length, 64);
  assert.equal(Object.hasOwn(run, 'timestamp'), false);
});

test('unexecutable product paths are completion evidence, not infrastructure errors', () => {
  const run = runFor(policy(), ['unexecutable']);
  assert.equal(run.completion.result, 'successful');
  assert.equal(run.completion.unexecutable, 1);
  assert.equal(run.completion.infrastructureError, 0);
});

test('tampered completion, traversal artifacts, and bad digests fail closed', () => {
  const valid = runFor(policy(), ['successful']);
  for (const mutate of [
    (value) => (value.completion.successful = 0),
    (value) => (value.policy.digest = 'sha256:not-a-hash'),
    (value) =>
      value.artifacts.push({
        id: 'bad',
        path: '../escape',
        sha256: 'a'.repeat(64),
      }),
  ]) {
    const knownBad = structuredClone(valid);
    mutate(knownBad);
    assert.throws(() => validateRunEnvelope(knownBad), RunContractError);
  }
});

test('completion result is derived rather than journey-authored', () => {
  const reviewed = policy();
  const identity = {
    ...runFor(reviewed, []).provenance,
  };
  assert.throws(
    () => createRunEnvelope(identity, { statuses: ['successful'] }),
    /run identity/,
  );
});
