import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOURNEY_ARTIFACT_KIND,
  JOURNEY_POLICY_KIND,
  JourneyPolicyError,
  assertJourneyEnforcementReady,
  createJourneyArtifact,
  createJourneyPolicy,
  parseJourneyArtifact,
  parseJourneyPolicy,
  serializeJourneyArtifact,
  serializeJourneyPolicy,
  validateJourneyPolicy,
} from '../lib/journey-policy.mjs';
import {
  catalog,
  definition,
  journeyReport,
  measurement,
  observationRule,
  policy,
  runFor,
} from './contract-helpers.mjs';

test('readiness requires every reviewed required variant, not only the canonical journey', () => {
  const reviewed = policy(['standard', 'advanced']);
  const report = journeyReport(reviewed, [measurement('standard')]);
  const artifact = createJourneyArtifact({
    catalog: catalog(),
    policy: reviewed,
    report,
  });

  assert.equal(artifact.kind, JOURNEY_ARTIFACT_KIND);
  assert.equal(artifact.coverage.requiredVariants, 2);
  assert.equal(artifact.coverage.successfulVariants, 1);
  assert.deepEqual(
    artifact.coverage.findings.map(({ rule, journeyId }) => [rule, journeyId]),
    [['required-variant-measurement-missing', 'advanced']],
  );
  assert.throws(() => assertJourneyEnforcementReady(artifact), /advanced|required-variant/);
});

test('all required variants must be approved, bound, measured, and successful', () => {
  const draft = definition('advanced', 'alternative');
  draft.approval = { status: 'candidate', approvedBy: null };
  draft.automation = { status: 'missing', source: null };
  const reviewed = createJourneyPolicy([definition(), draft], {
    coverage: [
      {
        useCaseId: 'create-record',
        requiredVariants: [
          { variantId: 'standard', label: 'Standard', journeyId: 'standard' },
          { variantId: 'advanced', label: 'Advanced', journeyId: 'advanced' },
        ],
      },
    ],
    rules: [observationRule()],
  });
  const report = journeyReport(reviewed, [
    measurement('standard'),
    measurement('advanced', { status: 'unexecutable' }),
  ]);
  const artifact = createJourneyArtifact({ catalog: catalog(), policy: reviewed, report });
  const rules = artifact.coverage.findings.map(({ rule }) => rule);

  assert.ok(rules.includes('required-variant-owner-approval-required'));
  assert.ok(rules.includes('required-variant-executable-coverage-required'));
  assert.ok(rules.includes('required-variant-unexecutable'));
});

test('complete successful required coverage is enforcement-ready and round-trips', () => {
  const reviewed = policy(['standard', 'advanced']);
  const report = journeyReport(reviewed, [
    measurement('standard'),
    measurement('advanced'),
  ]);
  const artifact = createJourneyArtifact({ catalog: catalog(), policy: reviewed, report });

  assert.deepEqual(artifact.coverage.findings, []);
  assert.equal(assertJourneyEnforcementReady(artifact), artifact);
  assert.deepEqual(parseJourneyPolicy(serializeJourneyPolicy(reviewed)), reviewed);
  assert.deepEqual(parseJourneyArtifact(serializeJourneyArtifact(artifact)), artifact);
});

test('failed, skipped, unexecutable, and infrastructure-error required variants differ', () => {
  for (const status of ['failed', 'skipped', 'unexecutable', 'infrastructure-error']) {
    const reviewed = policy();
    let report;
    if (status === 'unexecutable') {
      report = journeyReport(reviewed, [measurement('standard', { status })]);
    } else {
      const lifecycle = {
        useCaseId: 'create-record',
        journeyId: 'standard',
        status,
        timing: null,
        metrics: null,
        steps: [],
        observations: [],
      };
      const run = runFor(reviewed, [status], {
        errors:
          status === 'skipped'
            ? []
            : [
                {
                  id: 'error.create-record.standard.1',
                  category: status === 'failed' ? 'assertion' : 'infrastructure',
                  message: status,
                  journeyRef: 'journey.create-record.standard',
                },
              ],
      });
      report = journeyReport(reviewed, [lifecycle], { run });
    }
    const artifact = createJourneyArtifact({ catalog: catalog(), policy: reviewed, report });
    assert.ok(
      artifact.coverage.findings.some(
        ({ rule }) => rule === `required-variant-${status}`,
      ),
    );
  }
});

test('unknown rule types and malformed lifecycle declarations fail closed', () => {
  const unknownRule = observationRule();
  unknownRule.observation.type = 'prose-verdict';
  assert.throws(
    () =>
      createJourneyPolicy([definition()], {
        rules: [unknownRule],
      }),
    /unknown/,
  );

  for (const mutate of [
    (journey) => (journey.intent.steps = []),
    (journey) => (journey.approval = { status: 'candidate', approvedBy: 'owner' }),
    (journey) => (journey.automation = { status: 'bound', source: null }),
    (journey) => (journey.measurements.explicit = ['unknown']),
  ]) {
    const knownBad = definition();
    mutate(knownBad);
    assert.throws(
      () =>
        validateJourneyPolicy({
          kind: JOURNEY_POLICY_KIND,
          version: 3,
          coverage: [
            {
              useCaseId: 'create-record',
              requiredVariants: [
                { variantId: 'standard', label: 'Standard', journeyId: 'standard' },
              ],
            },
          ],
          rules: [],
          journeys: [knownBad],
        }),
      JourneyPolicyError,
    );
  }
});

test('old policy versions produce explicit migration errors', () => {
  assert.throws(
    () =>
      parseJourneyPolicy(
        JSON.stringify({
          kind: JOURNEY_POLICY_KIND,
          version: 2,
          coverage: [],
          journeys: [],
        }),
      ),
    /migrate to version 3/,
  );
});

test('policy serialization is deterministic and records typed rules', () => {
  const reviewed = policy();
  assert.equal(reviewed.kind, JOURNEY_POLICY_KIND);
  assert.equal(reviewed.rules[0].observation.type, 'field-required');
  assert.equal(serializeJourneyPolicy(reviewed), serializeJourneyPolicy(reviewed));
});
