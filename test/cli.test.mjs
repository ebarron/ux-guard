import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../lib/cli.mjs';
import { createJourneyPolicy } from '../lib/journey-policy.mjs';
import { createJourneyRecorder, createJourneyReport } from '../lib/journeys.mjs';
import {
  REQUIREMENT,
  observationRule,
  ownerTargets,
  runFor,
} from './contract-helpers.mjs';
import { CATALOG, NAV, PAGE, capture, config, tempRepo } from './helpers.mjs';

function repo(extra = {}) {
  return tempRepo({
    '.uxguard.json': config(),
    'ux/use-cases.yml': CATALOG,
    'src/nav.tsx': NAV,
    'src/Page.tsx': PAGE,
    ...extra,
  });
}

async function run(root, ...args) {
  const output = capture();
  const code = await main(['--root', root, ...args], output.io);
  return { code, out: output.out, err: output.err };
}

function journeyPolicy({ rules = [] } = {}) {
  return createJourneyPolicy(
    [
      {
        useCaseId: 'create-record',
        journeyId: 'standard',
        variant: 'canonical',
        intent: {
          summary: 'Create a record.',
          steps: ['Open the form.', 'Enter the required details.', 'Create the record.'],
          success: 'The accepted record appears.',
        },
        approval: { status: 'owner-approved', approvedBy: 'product-owner' },
        automation: { status: 'bound', source: 'e2e/create-record.spec.ts' },
        measurements: { explicit: ['modalDepth'], elapsed: null },
      },
    ],
    { rules },
  );
}

function journeyReport(reviewed, { finding = false } = {}) {
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
    metrics: ['modalDepth'],
  });
  recorder.beginStep('add');
  recorder.observeModalDepth(1);
  if (finding) {
    recorder.observe('field-required', {
      concept: 'workspace',
      label: 'Workspace',
      required: true,
      edited: true,
    });
  }
  recorder.endStep();
  return createJourneyReport([recorder.finish({ status: 'successful' })], {
    catalog: ['create-record'],
    policy: reviewed,
    run: runFor(reviewed, ['successful'], {
      adapters: { playwright: '1', repetitions: '3' },
      artifacts: [
        {
          id: 'journey-shards',
          path: 'test-results/ux-guard/shards',
          sha256: 'a'.repeat(64),
        },
      ],
    }),
  });
}

test('init, clean scan, canary, and check pass on a fresh repository', async () => {
  const root = repo();
  assert.equal((await run(root, 'patterns', 'init')).code, 0);
  assert.equal((await run(root, 'patterns', 'init')).code, 2);
  assert.equal((await run(root, 'patterns', 'scan')).code, 0);
  assert.equal((await run(root, 'patterns', 'canary')).code, 0);
  assert.equal((await run(root, 'baseline', 'canary')).code, 0);
  const check = await run(root, 'check');
  assert.equal(check.code, 0);
  assert.match(check.out, /Unmapped:\n {2}- dashboard: Dashboard \/dashboard/);
});

test('growth fails the scan and update refuses it without explicit acceptance', async () => {
  const root = repo();
  await run(root, 'patterns', 'init');
  writeFileSync(join(root, 'src/Page.tsx'), PAGE.replace('size="xs"', 'size="xl"'));
  const scan = await run(root, 'patterns', 'scan', '--format', 'json');
  assert.equal(scan.code, 1);
  assert.deepEqual(
    JSON.parse(scan.out).patterns.findings.map((finding) => [finding.rule, finding.value]),
    [['new-control-value', 'xl']],
  );
  assert.equal((await run(root, 'patterns', 'update')).code, 1);
  assert.equal((await run(root, 'patterns', 'update', '--accept-growth')).code, 0);
  assert.equal((await run(root, 'patterns', 'scan')).code, 0);
});

test('check JSON is one deterministic document with explicit result and exit semantics', async () => {
  const failed = await run(repo(), 'check', '--format', 'json');
  assert.equal(failed.code, 2);
  assert.equal(failed.out, '');

  const root = repo();
  await run(root, 'patterns', 'init');

  const clean = await run(root, 'check', '--format', 'json');
  assert.equal(clean.code, 0);
  assert.equal(clean.err, '');
  assert.equal((await run(root, 'check', '--format', 'json')).out, clean.out);
  const cleanDocument = JSON.parse(clean.out);
  assert.deepEqual(
    {
      version: cleanDocument.version,
      command: cleanDocument.command,
      status: cleanDocument.status,
      exitCode: cleanDocument.exitCode,
      catalog: cleanDocument.catalog.status,
      patterns: cleanDocument.patterns.status,
    },
    {
      version: 2,
      command: 'check',
      status: 'clean',
      exitCode: 0,
      catalog: 'clean',
      patterns: 'clean',
    },
  );
  assert.ok(Array.isArray(cleanDocument.catalog.findings));
  assert.ok(Array.isArray(cleanDocument.patterns.findings));

  writeFileSync(join(root, 'src/Page.tsx'), PAGE.replace('size="xs"', 'size="xl"'));
  const findings = await run(root, 'check', '--format', 'json');
  assert.equal(findings.code, 1);
  const findingsDocument = JSON.parse(findings.out);
  assert.equal(findingsDocument.status, 'findings');
  assert.equal(findingsDocument.exitCode, 1);
  assert.equal(findingsDocument.catalog.status, 'clean');
  assert.equal(findingsDocument.patterns.status, 'findings');
  assert.deepEqual(
    findingsDocument.patterns.findings.map(({ rule, value }) => [rule, value]),
    [['new-control-value', 'xl']],
  );
});

test('check reports configured journey lifecycle and advisory verdicts in one JSON document', async () => {
  const reviewed = journeyPolicy();
  const root = repo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
      },
    }),
    'ux/journey-policy.json': reviewed,
    'test-results/ux-guard/journeys.json': journeyReport(reviewed),
  });
  await run(root, 'patterns', 'init');

  const result = await run(root, 'check', '--format', 'json');
  assert.equal(result.code, 0);
  const document = JSON.parse(result.out);
  assert.equal(document.status, 'clean');
  assert.equal(document.journeys.status, 'measurement-only');
  assert.equal(document.journeys.rollout, 'advisory');
  assert.equal(document.journeys.reportPresent, true);
  assert.equal(document.journeys.coverage.measuredVariants, 1);
  assert.deepEqual(document.journeys.coverage.findings, []);
  assert.equal(document.journeys.verdicts.rollout, 'advisory');
  assert.equal(document.journeys.verdicts.quality.verdict, 'acceptable');
  assert.equal(document.journeys.verdicts.useCases[0].verdict, 'acceptable');
  assert.equal(Object.hasOwn(document.journeys, 'passed'), false);
  assert.equal(Object.hasOwn(document.journeys, 'score'), false);
});

test('missing journey measurements stay advisory and malformed reports fail closed', async () => {
  const reviewed = journeyPolicy();
  const files = {
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
      },
    }),
    'ux/journey-policy.json': reviewed,
  };
  const root = repo(files);
  await run(root, 'patterns', 'init');

  const missing = await run(root, 'check', '--format', 'json');
  assert.equal(missing.code, 0);
  const document = JSON.parse(missing.out);
  assert.equal(document.journeys.reportPresent, false);
  assert.deepEqual(
    document.journeys.coverage.findings.map(({ rule }) => rule),
    ['required-variant-measurement-missing'],
  );

  mkdirSync(join(root, 'test-results/ux-guard'), { recursive: true });
  writeFileSync(join(root, 'test-results/ux-guard/journeys.json'), '{}\n');
  const malformed = await run(root, 'check', '--format', 'json');
  assert.equal(malformed.code, 2);
  assert.equal(malformed.out, '');
  assert.match(malformed.err, /journeys\.json/);
});

test('advisory journey findings render JSON and Markdown without changing exit status', async () => {
  const catalog = CATALOG.replace(
    '        route: /records\n',
    `        route: /records
    requirements:
      - "${REQUIREMENT}"
`,
  );
  const reviewed = journeyPolicy({ rules: [observationRule()] });
  const root = repo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
      },
    }),
    'ux/use-cases.yml': catalog,
    'ux/journey-policy.json': reviewed,
    'test-results/ux-guard/journeys.json': journeyReport(reviewed, { finding: true }),
  });
  await run(root, 'patterns', 'init');

  const json = await run(root, 'report', '--format', 'json');
  assert.equal(json.code, 0);
  const verdict = JSON.parse(json.out);
  assert.equal(verdict.useCases[0].verdict, 'needs-improvement');
  assert.deepEqual(verdict.useCases[0].recommendationRefs, [
    'recommendation.create-record.required-inputs',
  ]);
  assert.equal(
    verdict.recommendations.items[0].findingRef,
    'finding.create-record.required-inputs',
  );

  const markdown = await run(root, 'report', '--format', 'markdown');
  assert.equal(markdown.code, 0);
  assert.match(markdown.out, /Needs improvement/);
  assert.match(markdown.out, /Allow Workspace to remain empty/);

  const check = await run(root, 'check', '--format', 'json');
  assert.equal(check.code, 0);
  assert.equal(JSON.parse(check.out).exitCode, 0);
  assert.equal(
    JSON.parse(check.out).journeys.verdicts.useCases[0].verdict,
    'needs-improvement',
  );
});

test('journey baseline lifecycle is unapproved, inspectable, no-overwrite, and explicitly promoted', async () => {
  const reviewed = journeyPolicy();
  const root = repo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
        targets: 'ux/journey-targets.json',
        baseline: 'ux/journey-baseline.json',
      },
    }),
    'ux/journey-policy.json': reviewed,
    'test-results/ux-guard/journeys.json': journeyReport(reviewed),
  });
  const candidatePath = 'test-results/ux-guard/journey-baseline.candidate.json';
  const proposed = await run(
    root,
    'baseline',
    'propose',
    '--candidate',
    candidatePath,
    '--format',
    'json',
  );
  assert.equal(proposed.code, 0);
  assert.equal(JSON.parse(proposed.out).status, 'unapproved');
  assert.equal(
    JSON.parse(readFileSync(join(root, candidatePath), 'utf8')).approval.status,
    'candidate',
  );
  assert.equal(
    (await run(root, 'baseline', 'propose', '--candidate', candidatePath)).code,
    2,
  );

  const inspected = await run(
    root,
    'baseline',
    'inspect',
    '--candidate',
    candidatePath,
    '--format',
    'markdown',
  );
  assert.equal(inspected.code, 0);
  assert.match(inspected.out, /Unapproved candidate/);
  assert.match(inspected.out, /not approval of existing defects/);

  const unavailableDiff = await run(
    root,
    'baseline',
    'diff',
    '--candidate',
    candidatePath,
    '--format',
    'json',
  );
  assert.equal(unavailableDiff.code, 0);
  assert.equal(JSON.parse(unavailableDiff.out).status, 'unavailable');

  const missingApproval = await run(
    root,
    'baseline',
    'promote',
    '--candidate',
    candidatePath,
  );
  assert.equal(missingApproval.code, 2);
  const promoted = await run(
    root,
    'baseline',
    'promote',
    '--candidate',
    candidatePath,
    '--reviewer',
    'product-owner',
    '--reviewed-at',
    '2026-11-16T18:00:00Z',
    '--rationale',
    'Reviewed current-state evidence without accepting existing defects.',
    '--format',
    'json',
  );
  assert.equal(promoted.code, 0);
  assert.equal(
    JSON.parse(readFileSync(join(root, 'ux/journey-baseline.json'), 'utf8'))
      .approval.status,
    'reviewed',
  );
  assert.equal(
    (
      await run(
        root,
        'baseline',
        'promote',
        '--candidate',
        candidatePath,
        '--reviewer',
        'product-owner',
        '--reviewed-at',
        '2026-11-16T18:00:00Z',
        '--rationale',
        'Second promotion must not overwrite.',
      )
    ).code,
    2,
  );
});

test('journey baseline lifecycle rejects traversal, symlinks, and malformed candidates', async () => {
  const reviewed = journeyPolicy();
  const root = repo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
        baseline: 'ux/journey-baseline.json',
      },
    }),
    'ux/journey-policy.json': reviewed,
    'test-results/ux-guard/journeys.json': journeyReport(reviewed),
    'test-results/ux-guard/malformed.json': '{}\n',
  });
  assert.equal(
    (
      await run(
        root,
        'baseline',
        'propose',
        '--candidate',
        '../outside.json',
      )
    ).code,
    2,
  );
  assert.equal(
    (
      await run(
        root,
        'baseline',
        'inspect',
        '--candidate',
        'test-results/ux-guard/malformed.json',
      )
    ).code,
    2,
  );

  const outside = tempRepo({ 'candidate.json': '{}\n' });
  symlinkSync(
    join(outside, 'candidate.json'),
    join(root, 'test-results/ux-guard/linked.json'),
  );
  const linked = await run(
    root,
    'baseline',
    'inspect',
    '--candidate',
    'test-results/ux-guard/linked.json',
  );
  assert.equal(linked.code, 2);
  assert.match(linked.err, /symbolic link/);
});

test('update removes stale entries without needing acceptance', async () => {
  const root = repo({ 'src/Styled.tsx': 'export const S = () => <div style={{}} />;\n' });
  await run(root, 'patterns', 'init');
  writeFileSync(join(root, 'src/Styled.tsx'), 'export const S = () => <div />;\n');
  assert.equal((await run(root, 'patterns', 'update')).code, 0);
  const baseline = JSON.parse(readFileSync(join(root, 'ux/patterns-baseline.json'), 'utf8'));
  assert.deepEqual(baseline.debt['inline-style'], {});
});

test('a complete inventory with an unmapped surface fails, and strict mode fails a partial one', async () => {
  const root = repo();
  await run(root, 'patterns', 'init');
  assert.equal((await run(root, 'catalog', '--strict')).code, 1);
  writeFileSync(join(root, 'ux/use-cases.yml'), CATALOG.replace('inventory: partial', 'inventory: complete'));
  assert.equal((await run(root, 'catalog')).code, 1);
});

test('missing policy, missing baseline, bad options, and unknown commands are errors', async () => {
  assert.equal((await run(tempRepo({ 'x.txt': '' }), 'check')).code, 2);
  const root = repo();
  assert.equal((await run(root, 'patterns', 'scan')).code, 2);
  assert.equal((await run(root, 'bogus')).code, 2);
  assert.equal((await run(root, '--format', 'xml', 'check')).code, 2);
  assert.equal((await run(root, '--base')).code, 2);
  assert.equal((await run(root, 'check', 'extra')).code, 2);
  assert.equal((await run(root, 'patterns', 'scan', '--strict')).code, 2);
  const jsonError = await run(root, 'patterns', 'scan', '--format', 'json');
  assert.equal(jsonError.code, 2);
  assert.equal(jsonError.out, '');
});

test('--base trusts committed policy while auditing working-tree source inputs', async () => {
  const root = repo();
  await run(root, 'patterns', 'init');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base');
  writeFileSync(join(root, 'src/Page.tsx'), PAGE.replace('size="xs"', 'size="xl"'));
  await run(root, 'patterns', 'update', '--accept-growth');
  assert.equal((await run(root, 'patterns', 'scan')).code, 0);
  writeFileSync(join(root, '.uxguard.json'), '{ candidate policy is intentionally invalid\n');
  writeFileSync(join(root, 'ux/patterns-baseline.json'), '{"version":1}\n');
  const trusted = await run(root, 'patterns', 'scan', '--base', 'HEAD', '--format', 'json');
  assert.equal(trusted.code, 1);
  assert.deepEqual(
    JSON.parse(trusted.out).patterns.findings.map(({ rule, value }) => [rule, value]),
    [['new-control-value', 'xl']],
  );
  assert.equal((await run(root, 'patterns', 'scan', '--base', 'no-such-ref')).code, 2);
  assert.equal((await run(root, 'patterns', 'scan', '--base', '-h')).code, 2);
  assert.equal((await run(root, 'patterns', 'init', '--base', 'HEAD')).code, 2);
  assert.equal((await run(root, 'patterns', 'update', '--base', 'HEAD')).code, 2);
});

test('--base audits candidate catalogs and navigation without allowing policy downgrades', async () => {
  const completeCatalog = CATALOG.replace('inventory: partial', 'inventory: complete').replace(
    '      - nav_id: records\n        route: /records\n',
    '      - nav_id: records\n        route: /records\n      - nav_id: dashboard\n        route: /dashboard\n',
  );
  const root = repo({ 'ux/use-cases.yml': completeCatalog });
  await run(root, 'patterns', 'init');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base');

  writeFileSync(join(root, 'ux/use-cases.yml'), completeCatalog.replace('inventory: complete', 'inventory: partial'));
  const downgrade = await run(root, 'catalog', '--base', 'HEAD', '--format', 'json');
  assert.equal(downgrade.code, 1);
  assert.deepEqual(
    JSON.parse(downgrade.out).catalog.findings.map(({ rule }) => rule),
    ['catalog-policy-downgrade'],
  );

  writeFileSync(join(root, 'ux/use-cases.yml'), 'version: 1\ninventory: complete\n');
  const malformedCandidate = await run(root, 'catalog', '--base', 'HEAD', '--format', 'json');
  assert.equal(malformedCandidate.code, 2);
  assert.equal(malformedCandidate.out, '');

  writeFileSync(join(root, 'ux/use-cases.yml'), completeCatalog);
  writeFileSync(
    join(root, 'src/nav.tsx'),
    NAV.replace('];', "  { id: 'settings', label: 'Settings', route: '/settings' },\n];"),
  );
  const candidateNavigation = await run(root, 'catalog', '--base', 'HEAD', '--format', 'json');
  assert.equal(candidateNavigation.code, 1);
  assert.deepEqual(
    JSON.parse(candidateNavigation.out).catalog.unmapped.map(({ id }) => id),
    ['settings'],
  );
});

test('--base uses only the reviewed baseline from the trusted commit', async () => {
  const reviewed = journeyPolicy();
  const root = repo({
    '.uxguard.json': config({
      journeys: {
        policy: 'ux/journey-policy.json',
        report: 'test-results/ux-guard/journeys.json',
        targets: 'ux/journey-targets.json',
        baseline: 'ux/journey-baseline.json',
      },
    }),
    'ux/journey-policy.json': reviewed,
    'ux/journey-targets.json': ownerTargets(reviewed, {
      hardFloors: { minimumSuccessfulVariants: 2 },
      metrics: [
        {
          journeyRef: 'journey.create-record.standard',
          metric: 'clicks',
          operator: 'at-most',
          value: 0,
        },
      ],
    }),
    'test-results/ux-guard/journeys.json': journeyReport(reviewed),
  });
  await run(root, 'patterns', 'init');
  const candidatePath = 'test-results/ux-guard/journey-baseline.candidate.json';
  assert.equal(
    (
      await run(
        root,
        'baseline',
        'propose',
        '--candidate',
        candidatePath,
      )
    ).code,
    0,
  );
  assert.equal(
    (
      await run(
        root,
        'baseline',
        'promote',
        '--candidate',
        candidatePath,
        '--reviewer',
        'product-owner',
        '--reviewed-at',
        '2026-11-16T18:00:00Z',
        '--rationale',
        'Reviewed synthetic evidence.',
      )
    ).code,
    0,
  );
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base');

  writeFileSync(
    join(root, 'ux/journey-baseline.json'),
    '{"kind":"candidate baseline in PR must not be trusted"}\n',
  );
  writeFileSync(
    join(root, 'ux/journey-targets.json'),
    '{"kind":"candidate targets in PR must not be trusted"}\n',
  );
  const result = await run(root, 'report', '--base', 'HEAD', '--format', 'json');
  assert.equal(result.code, 0);
  const document = JSON.parse(result.out);
  assert.equal(document.regression.baseline.status, 'reviewed');
  assert.equal(document.regression.journeyComparison.status, 'unavailable');
  assert.equal(document.targetAttainment.status, 'breached');
  assert.equal(document.scoring.journeys[0].score, 100);
  assert.equal(document.readiness.state, 'stable');
  assert.equal(document.readiness.trustedExecution, false);
  assert.equal(document.readiness.enforcementApproved, false);
  assert.equal(document.rollout, 'advisory');
});

test('policy paths cannot escape the repository', async () => {
  const root = repo({
    '.uxguard.json': config({
      catalog: { path: '../outside.yml', navigation: ['src/nav.tsx'] },
    }),
  });
  const result = await run(root, 'catalog');
  assert.equal(result.code, 2);
  assert.match(result.err, /catalog\.path must stay within the repository/);
});

test('working-tree input symlinks cannot escape the repository', async () => {
  const root = repo();
  const outside = tempRepo({ 'Outside.tsx': 'export const Outside = () => <button />;\n' });
  symlinkSync(join(outside, 'Outside.tsx'), join(root, 'src/Linked.tsx'));
  const result = await run(root, 'patterns', 'init');
  assert.equal(result.code, 2);
  assert.match(result.err, /pattern source src\/Linked\.tsx resolves outside the repository/);
});
