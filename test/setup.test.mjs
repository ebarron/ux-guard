import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../lib/cli.mjs';
import { PACKAGE_ROOT, TYPESCRIPT, capture, tempRepo } from './helpers.mjs';

function project(source = 'export const Page = () => <main><p>Hello</p></main>;\n') {
  return tempRepo({
    'package.json': {
      name: 'setup-fixture',
      private: true,
    },
    'tsconfig.json': {
      compilerOptions: { jsx: 'react-jsx' },
      include: ['src'],
    },
    'src/Page.tsx': source,
  });
}

async function run(root, ...args) {
  const output = capture();
  const code = await main(['--root', root, 'setup', '--typescript', TYPESCRIPT, ...args], output.io);
  return { code, out: output.out, err: output.err };
}

test('setup explains insufficient evidence in an empty repository without writing files', async () => {
  const root = tempRepo({});
  const result = await run(root);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /No executable UI source evidence was available/);
  assert.match(result.out, /Nothing can be confirmed/);
  assert.match(result.out, /^Next steps$/m);
  assert.match(result.out, /Add or point ux-guard to a TypeScript UI project/);
  assert.match(result.out, /No policy, baseline, waiver, or enforcement was activated/);
  assert.doesNotMatch(result.out, /setup-proposal\.json|styling and pattern issues/);
  assert.equal(existsSync(join(root, 'ux-guard/setup-proposal.json')), false);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
});

test('setup tailors next steps and keeps the README transcript exact', async () => {
  const root = project();
  const result = await run(root);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /^ux-guard setup/m);
  assert.match(result.out, /^Good$/m);
  assert.match(result.out, /^Needs attention$/m);
  assert.match(result.out, /^Unknown$/m);
  assert.match(result.out, /^Next steps$/m);
  assert.match(result.out, /No inline styles were observed/);
  assert.match(result.out, /Help me define ux-guard use cases for this repo/);
  assert.match(
    result.out,
    /Use ux-guard\/setup-proposal\.json as a supporting review file; it contains observed source roots, component and icon usage, pattern counts, and unresolved policy choices/,
  );
  assert.match(result.out, /Do not activate policy or baseline until a human explicitly approves them/);
  assert.match(
    result.out,
    /Help me review ux-guard\/setup-proposal\.json, decide what should become reviewed ux-guard policy, and prepare the initial baseline; do not activate anything until I explicitly approve it/,
  );
  assert.match(
    result.out,
    /Run ux-guard report after reviewed journey policy and a journey report path are configured/,
  );
  assert.match(result.out, /No policy, baseline, waiver, or enforcement was activated/);
  assert.doesNotMatch(result.out, /^Setup proposal$/m);
  assert.doesNotMatch(result.out, /styling and pattern issues|Review ux-guard's observed/);
  assert.doesNotMatch(result.out, /\bcandidate\b/i);

  const proposal = JSON.parse(
    readFileSync(join(root, 'ux-guard/setup-proposal.json'), 'utf8'),
  );
  assert.equal(proposal.kind, 'ux-guard-setup-proposal');
  assert.deepEqual(proposal.approval, {
    status: 'unapproved',
    reviewer: '',
    reviewedAt: '',
    patternPolicyReviewed: false,
  });
  assert.equal(proposal.observedBaseline.approved, false);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
  assert.equal(existsSync(join(root, 'ux/patterns-baseline.json')), false);

  const source = `const colors = ['#fff', '#123456', 'rgb(0, 0, 0)'];
export const Page = () => <main>{colors.join(',')}</main>;
`;
  const documented = await run(project(source));
  assert.equal(documented.code, 0);
  assert.equal(documented.err, '');
  const readmeSource = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
  const approvedOpener = readFileSync(
    join(PACKAGE_ROOT, 'test/fixtures/approved-readme-opener.md'),
    'utf8',
  );
  const sourceGettingStartedAt = readmeSource.indexOf('## Getting started');
  assert.equal(
    readmeSource.slice(0, sourceGettingStartedAt),
    approvedOpener,
    'README opener must stay byte-for-byte aligned with reviewed commit 2c9d257',
  );
  const readme = readmeSource.replaceAll('\r\n', '\n');
  const gettingStartedAt = readme.indexOf('## Getting started');
  const dailyUseAt = readme.indexOf('## Daily use');
  const safetyAt = readme.indexOf('## Safety and approval');
  const setupReferenceAt = readme.indexOf('## Setup output reference');
  assert.ok(
    gettingStartedAt >= 0 &&
      dailyUseAt > gettingStartedAt &&
      safetyAt > dailyUseAt &&
      setupReferenceAt > safetyAt,
    'README should complete onboarding before safety and setup internals',
  );
  const onboarding = readme.slice(gettingStartedAt, dailyUseAt);
  for (const stage of [
    'Define the user outcomes that matter',
    'Decide which UI patterns are allowed',
    'Prepare reviewed comparison evidence',
    'Run the first meaningful check',
  ]) {
    assert.match(onboarding, new RegExp(stage));
  }
  assert.match(
    onboarding,
    /approved convention, tolerated existing debt to\s+> record in the baseline/,
  );
  assert.match(onboarding, /product owner/);
  assert.doesNotMatch(onboarding, /discover write-candidate/);
  assert.ok(
    readme.indexOf('Check my current work with ux-guard', dailyUseAt) <
      readme.indexOf('npx ux-guard check', dailyUseAt),
    'Daily use should lead with Agent Skill prompts',
  );
  assert.match(
    readme,
    /\[Enumerated 155-test catalog and verification commands\]\(docs\/test-suite\.md\)/,
  );
  const introduction = '`setup` inspects non-test UI source and reports what it could establish:';
  const introductionAt = readme.indexOf(introduction);
  const fenceAt = readme.indexOf('```text\n', introductionAt);
  const fenceEnd = readme.indexOf('```\n', fenceAt + '```text\n'.length);
  assert.ok(introductionAt >= 0 && fenceAt >= 0 && fenceEnd >= 0, 'README needs the setup terminal transcript');
  assert.equal(
    documented.out,
    readme.slice(fenceAt + '```text\n'.length, fenceEnd),
  );
});

test('setup JSON is deterministic, noninteractive, and keeps approval boundaries explicit', async () => {
  const source = `export const Page = () => (
  <div style={{ color: '#fff', width: '12px' }}><button type="button">Save</button></div>
);
`;
  const first = await run(project(source), '--format', 'json');
  const second = await run(project(source), '--format', 'json');
  assert.equal(first.code, 0);
  assert.equal(first.err, '');
  assert.equal(first.out, second.out);
  const document = JSON.parse(first.out);
  assert.equal(document.kind, 'ux-guard-setup-result');
  assert.equal(document.status, 'review-required');
  assert.equal(document.proposal.status, 'unapproved');
  assert.equal(document.proposal.written, true);
  assert.deepEqual(document.safety, {
    observedUsageApproved: false,
    policyCreated: false,
    baselineCreated: false,
    waiversCreated: false,
    enforcementEnabled: false,
    filesWritten: ['ux-guard/setup-proposal.json'],
  });
  assert.deepEqual(
    document.results.needsAttention.map(({ signal }) => signal),
    ['inline-style', 'px-literal', 'raw-button', 'hard-coded-color'],
  );
  assert.ok(document.results.unknown.some((item) => item.includes('regression from main')));
  assert.equal(
    document.nextAction,
    [
      '1. Define the important user workflows and use cases. Agent Skill prompt: "Help me define ux-guard use cases for this repo"',
      '2. Review the observed styling and pattern issues (inline styles, pixel literals, raw button elements, and hard-coded colors) and decide which are intentional conventions versus UX debt. Agent Skill prompt: "Review ux-guard\'s observed inline styles, pixel literals, raw button elements, and hard-coded colors in this repo and help me decide which are intentional conventions versus UX debt; do not change policy or baselines"',
      '3. Decide what should become reviewed policy and prepare the initial baseline. Use ux-guard/setup-proposal.json as a supporting review file; it contains observed source roots, component and icon usage, pattern counts, and unresolved policy choices. Do not activate policy or baseline until a human explicitly approves them. Agent Skill prompt: "Help me review ux-guard/setup-proposal.json, decide what should become reviewed ux-guard policy, and prepare the initial baseline; do not activate anything until I explicitly approve it"',
      '4. After human approval and activation, run ux-guard check. Run ux-guard report after reviewed journey policy and a journey report path are configured.',
      'No policy, baseline, waiver, or enforcement was activated.',
    ].join('\n'),
  );
  assert.equal(JSON.stringify(document).includes('candidate'), false);
});

test('setup never overwrites an existing supporting review file or active policy', async () => {
  const root = project();
  assert.equal((await run(root)).code, 0);
  const path = join(root, 'ux-guard/setup-proposal.json');
  const original = readFileSync(path, 'utf8');
  const repeated = await run(root, '--format', 'json');
  assert.equal(repeated.code, 2);
  assert.equal(repeated.out, '');
  const error = JSON.parse(repeated.err);
  assert.equal(error.status, 'error');
  assert.match(error.error, /refusing to overwrite/);
  assert.equal(readFileSync(path, 'utf8'), original);

  const configured = project();
  writeFileSync(join(configured, '.uxguard.json'), '{}\n');
  const active = await run(configured);
  assert.equal(active.code, 2);
  assert.match(active.err, /setup never replaces active policy/);
  assert.equal(existsSync(join(configured, 'ux-guard/setup-proposal.json')), false);
});

test('setup supporting review paths reject traversal and symlink escapes', async () => {
  const traversal = await run(project(), '--proposal', '../proposal.json');
  assert.equal(traversal.code, 2);
  assert.match(traversal.err, /setup review file path must stay within the repository/);

  const root = project();
  const outside = tempRepo({});
  symlinkSync(outside, join(root, 'linked'));
  const linked = await run(root, '--proposal', 'linked/proposal.json');
  assert.equal(linked.code, 2);
  assert.match(linked.err, /not a symbolic link/);
  assert.equal(existsSync(join(outside, 'proposal.json')), false);
});

test('primary help leads with setup, check, and report while advanced help preserves reference commands', async () => {
  const primary = capture();
  assert.equal(await main(['--help'], primary.io), 0);
  assert.match(primary.out, /setup\s+inspect this repo/);
  assert.match(primary.out, /check\s+compare current UI code/);
  assert.match(primary.out, /report\s+explain UX evidence/);
  assert.doesNotMatch(primary.out, /write-candidate|authoritative|canary/);

  const advanced = capture();
  assert.equal(await main(['help', 'advanced'], advanced.io), 0);
  assert.match(advanced.out, /discover write-candidate/);
  assert.match(advanced.out, /authoritative/);
  assert.match(advanced.out, /baseline canary/);

  const setupHelp = capture();
  assert.equal(await main(['setup', '--help'], setupHelp.io), 0);
  assert.match(setupHelp.out, /suggest tailored next steps/);
  assert.match(setupHelp.out, /supporting review\s+file records the observed source roots/);
  assert.match(setupHelp.out, /never creates active policy/);
  assert.match(setupHelp.out, /--proposal <path>/);

  const reportHelp = capture();
  assert.equal(await main(['report', '--help'], reportHelp.io), 0);
  assert.match(reportHelp.out, /successfully rendered report exits 0/);
  assert.match(reportHelp.out, /report does not enforce merges/);
});

test('check and report errors point unconfigured repositories to the safe first step', async () => {
  const root = project();
  const check = capture();
  assert.equal(await main(['--root', root, 'check'], check.io), 2);
  assert.match(check.err, /run ux-guard setup, review its findings and supporting file/);
  assert.match(check.err, /explicit human approval/);

  const report = capture();
  assert.equal(await main(['--root', root, 'report'], report.io), 2);
  assert.match(report.err, /Reporting remains unavailable/);
  assert.match(report.err, /configure reviewed journey evidence/);
});

test('legacy discovery output and schema remain backward compatible', async () => {
  const root = project();
  const output = capture();
  const code = await main(
    [
      '--root',
      root,
      'discover',
      '--typescript',
      TYPESCRIPT,
      'write-candidate',
      '--candidate',
      'review/legacy.json',
      '--format',
      'json',
    ],
    output.io,
  );
  assert.equal(code, 0);
  const response = JSON.parse(output.out);
  assert.equal(response.lifecycle.action, 'write-candidate');
  assert.equal(response.lifecycle.status, 'unapproved');
  assert.equal(
    JSON.parse(readFileSync(join(root, 'review/legacy.json'), 'utf8')).kind,
    'ux-guard-policy-candidate',
  );
});
