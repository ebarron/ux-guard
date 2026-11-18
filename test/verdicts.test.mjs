import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createVerdictReport,
  parseVerdictReport,
  renderVerdictMarkdown,
  serializeVerdictReport,
  validateVerdictReport,
} from '../lib/verdicts.mjs';
import {
  catalog,
  journeyReport,
  measurement,
  policy,
} from './contract-helpers.mjs';

function report({
  variants = ['standard'],
  journeys,
  patternFindings = [],
  targets,
} = {}) {
  const reviewed = policy(variants);
  const measurements = journeyReport(
    reviewed,
    journeys ?? variants.map((journeyId) => measurement(journeyId)),
  );
  return createVerdictReport({
    catalog: catalog(),
    policy: reviewed,
    measurements,
    patterns: { findings: patternFindings },
    targets,
  });
}

test('policy-evaluated observations change verdicts and emit one recommendation', () => {
  const clean = report();
  const knownBad = report({
    journeys: [measurement('standard', { finding: true })],
  });

  assert.equal(clean.quality.verdict, 'acceptable');
  assert.equal(knownBad.quality.verdict, 'needs-improvement');
  assert.equal(knownBad.findings.length, 1);
  assert.equal(knownBad.recommendations.items.length, 1);
  assert.equal(knownBad.useCases[0].findingRefs[0], knownBad.findings[0].id);
  assert.equal(
    knownBad.recommendations.items[0].text,
    'Allow Workspace to remain empty.',
  );
});

test('shared cross-variant findings render once with per-variant evidence', () => {
  const shared = report({
    variants: ['standard', 'advanced', 'guided', 'batch'],
    journeys: ['standard', 'advanced', 'guided', 'batch'].map((journeyId) =>
      measurement(journeyId, { finding: true }),
    ),
  });

  assert.equal(shared.findings.length, 1);
  assert.equal(shared.findings[0].journeyRefs.length, 4);
  assert.equal(shared.findings[0].evidence.length, 4);
  assert.deepEqual(shared.useCases[0].comparison.sharedFindingRefs, [
    shared.findings[0].id,
  ]);
  const markdown = renderVerdictMarkdown(shared);
  assert.equal(markdown.match(/### create-record\.required-inputs/g)?.length, 1);
});

test('missing and unexecutable required variants stay incomplete, not unmeasured success', () => {
  const reviewed = policy(['standard', 'guided']);
  const measurements = journeyReport(reviewed, [
    measurement('standard'),
    measurement('guided', { status: 'unexecutable' }),
  ]);
  const result = createVerdictReport({
    catalog: catalog(),
    policy: reviewed,
    measurements,
    patterns: { findings: [] },
  });

  assert.equal(result.quality.verdict, 'incomplete');
  assert.equal(result.coverage.measuredVariants, 2);
  assert.equal(result.coverage.successfulVariants, 1);
  assert.equal(
    result.journeys.find((journey) => journey.journeyId === 'guided')
      .executionStatus,
    'unexecutable',
  );
  assert.match(renderVerdictMarkdown(result), /Missing product path/);
});

test('normalized output uses references rather than repeated findings', () => {
  const normalized = report({
    variants: ['standard', 'advanced'],
    journeys: [
      measurement('standard', { finding: true }),
      measurement('advanced', { finding: true }),
    ],
  });

  assert.equal(normalized.findings.length, 1);
  assert.ok(normalized.useCases[0].findingRefs.every((ref) => typeof ref === 'string'));
  assert.ok(normalized.journeys.every((journey) => !Object.hasOwn(journey, 'findings')));
  assert.ok(
    normalized.useCases.every((useCase) => !Object.hasOwn(useCase, 'recommendations')),
  );
});

test('Markdown orders run errors, incomplete, needs improvement, then acceptable', () => {
  const incomplete = report({
    variants: ['standard', 'advanced'],
    journeys: [measurement('standard')],
  });
  const markdown = renderVerdictMarkdown(incomplete);
  const run = markdown.indexOf('## Run and evidence status');
  const missing = markdown.indexOf('## Incomplete and missing product paths');
  const improvement = markdown.indexOf('## Needs-improvement findings');
  const acceptable = markdown.indexOf('## Acceptable cases');

  assert.ok(run < missing && missing < improvement && improvement < acceptable);
  assert.match(markdown, /Not evaluated/);
});

test('JSON and Markdown preserve no-score and advisory semantics', () => {
  const acceptable = report();
  const text = serializeVerdictReport(acceptable);

  assert.deepEqual(parseVerdictReport(text), acceptable);
  assert.equal(acceptable.rollout, 'advisory');
  assert.equal(acceptable.scoring.status, 'not-scored');
  assert.equal(Object.hasOwn(acceptable, 'score'), false);
  assert.equal(Object.hasOwn(acceptable.scoring, 'score'), false);
  assert.match(renderVerdictMarkdown(acceptable), /Advisory evidence only/);
});

test('pattern growth is regression evidence without changing the quality verdict', () => {
  const regression = report({
    patternFindings: [
      { rule: 'new-control-value', key: 'Button.size', value: 'huge' },
    ],
  });

  assert.equal(regression.quality.verdict, 'acceptable');
  assert.equal(regression.regression.status, 'regression');
  assert.equal(regression.staticPatterns.status, 'growth');
  assert.equal(regression.regression.baseline.regressionStatus, 'not-evaluated');
});

test('human wording separates quality, unknown evidence, and recommendations', () => {
  const knownBad = report({
    journeys: [measurement('standard', { finding: true })],
  });
  const markdown = renderVerdictMarkdown(knownBad);

  assert.match(markdown, /## Target attainment/);
  assert.match(markdown, /## Regression and backslide/);
  assert.match(markdown, /## Numerical scores/);
  assert.match(markdown, /## Recommendations/);
  assert.match(
    markdown,
    /zero accessibility findings is not evidence of good accessibility/i,
  );
  assert.match(markdown, /preferred-pattern alignment was not evaluated/i);
  assert.match(markdown, /Allow Workspace to remain empty/);
});

test('unknown references and old report versions fail closed', () => {
  const valid = report();
  const badReference = structuredClone(valid);
  badReference.useCases[0].journeyRefs = ['journey.unknown'];
  assert.throws(() => validateVerdictReport(badReference), /journeyRefs/);

  assert.throws(
    () =>
      parseVerdictReport(
        JSON.stringify({ kind: 'ux-guard-verdict-report', version: 2 }),
      ),
    /migrate to version 6/,
  );
});
