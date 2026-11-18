import { createJourneyPolicy } from '../lib/journey-policy.mjs';
import { createJourneyRecorder, createJourneyReport } from '../lib/journeys.mjs';
import {
  createRunEnvelope,
  policyDigest,
  resolveRunIdentity,
} from '../lib/run-contract.mjs';
import { ownerTargetsHash } from '../lib/targets.mjs';
import { PACKAGE_ROOT } from './helpers.mjs';

export const REQUIREMENT = 'Workspace is optional.';

export function catalog(ids = ['create-record']) {
  return {
    useCases: ids.map((id) => ({
      id,
      title: id === 'create-record' ? 'Create a record' : id,
      requirements: id === 'create-record' ? [REQUIREMENT] : [],
    })),
  };
}

export function definition(journeyId = 'standard', variant = 'canonical') {
  return {
    useCaseId: 'create-record',
    journeyId,
    variant,
    intent: {
      summary: `Complete the ${journeyId} flow.`,
      steps: ['Open the form.', 'Submit the record.'],
      success: 'The accepted record appears.',
    },
    approval: { status: 'owner-approved', approvedBy: 'product-owner' },
    automation: { status: 'bound', source: `e2e/${journeyId}.spec.ts` },
    measurements: { explicit: [], elapsed: null },
  };
}

export function observationRule(overrides = {}) {
  return {
    ruleId: 'create-record.required-inputs',
    useCaseId: 'create-record',
    journeyIds: [],
    observation: {
      type: 'field-required',
      match: { concept: 'workspace', required: true },
    },
    finding: {
      severity: 'high',
      dimension: 'efficiency',
      type: 'requirement',
      summary: 'Workspace had to be edited.',
      recommendation: 'Allow Workspace to remain empty.',
    },
    policy: [
      {
        source: 'use-case-requirement',
        field: 'requirements',
        statement: REQUIREMENT,
      },
    ],
    ...overrides,
  };
}

export function policy(variants = ['standard'], { rules = [observationRule()] } = {}) {
  return createJourneyPolicy(
    variants.map((journeyId, index) =>
      definition(journeyId, index === 0 ? 'canonical' : 'alternative'),
    ),
    {
      coverage: [
        {
          useCaseId: 'create-record',
          requiredVariants: variants.map((journeyId) => ({
            variantId: journeyId,
            label: journeyId.toUpperCase(),
            journeyId,
          })),
        },
      ],
      rules,
    },
  );
}

export function measurement(
  journeyId = 'standard',
  { finding = false, status = 'successful', metrics = [] } = {},
) {
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId,
    metrics,
  });
  recorder.beginStep('complete');
  if (finding) {
    recorder.observe('field-required', {
      concept: 'workspace',
      label: 'Workspace',
      required: true,
      edited: true,
    });
  }
  recorder.endStep();
  return recorder.finish({ status });
}

export function runFor(policyValue, statuses, options = {}) {
  const identity = resolveRunIdentity(PACKAGE_ROOT, {
    policy: policyValue,
    browser: options.browser ?? { name: 'chromium', profile: 'Reviewed desktop' },
    adapters: options.adapters ?? { playwright: '1' },
  });
  return createRunEnvelope(identity, {
    statuses,
    errors: options.errors ?? [],
    artifacts: options.artifacts ?? [],
  });
}

export function journeyReport(
  policyValue,
  journeys,
  { catalogValue = catalog(), run } = {},
) {
  return createJourneyReport(journeys, {
    catalog: catalogValue,
    policy: policyValue,
    run: run ?? runFor(policyValue, journeys.map((journey) => journey.status)),
  });
}

export function ownerTargets(
  policyValue,
  {
    metrics = [],
    hardFloors = {},
    approvalStatus = 'reviewed',
  } = {},
) {
  const targets = {
    kind: 'ux-guard-owner-targets',
    version: 2,
    canonicalHash: '',
    approval:
      approvalStatus === 'reviewed'
        ? {
            status: 'reviewed',
            reviewer: 'product-owner',
            reviewedAt: '2026-11-17T16:00:00Z',
            rationale: 'Reviewed synthetic target policy.',
          }
        : {
            status: 'candidate',
            reviewer: null,
            reviewedAt: null,
            rationale: null,
          },
    policy: {
      algorithm: 'sha256',
      digest: policyDigest(policyValue),
    },
    requirements: [],
    metrics,
    metricPolicy: {
      nonRegressionAfterReview: [
        'clicks',
        'editedFields',
        'routeChanges',
        'modalDepth',
        'steps',
      ],
      reportOnlyUntilCalibrated: [
        'keystrokes',
        'scrollDistance',
        'decisions',
        'elapsedMs',
      ],
    },
    hardFloors: {
      minimumMeasuredVariants: 0,
      minimumSuccessfulVariants: 0,
      maximumUnexecutableVariants: 100,
      maximumFailedVariants: 100,
      maximumSkippedVariants: 100,
      maximumInfrastructureErrorVariants: 100,
      maximumCriticalFindings: 100,
      ...hardFloors,
    },
    sourceArtifacts: [],
  };
  targets.canonicalHash = ownerTargetsHash(targets);
  return targets;
}
