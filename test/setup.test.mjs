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
import { TYPESCRIPT, capture, tempRepo } from './helpers.mjs';

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
  assert.match(result.out, /Not created at ux-guard\/setup-proposal\.json/);
  assert.match(result.out, /No active policy, reviewed baseline, waiver, or enforcement was created/);
  assert.equal(existsSync(join(root, 'ux-guard/setup-proposal.json')), false);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
});

test('setup gives neutral projects human-readable first results and an unapproved proposal', async () => {
  const root = project();
  const result = await run(root);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /^ux-guard setup/m);
  assert.match(result.out, /^Good$/m);
  assert.match(result.out, /^Needs attention$/m);
  assert.match(result.out, /^Unknown$/m);
  assert.match(result.out, /No inline styles were observed/);
  assert.match(result.out, /Saved ux-guard\/setup-proposal\.json/);
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
  assert.equal(JSON.stringify(document).includes('candidate'), false);
});

test('setup never overwrites an existing proposal or active policy', async () => {
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

test('setup proposal paths reject traversal and symlink escapes', async () => {
  const traversal = await run(project(), '--proposal', '../proposal.json');
  assert.equal(traversal.code, 2);
  assert.match(traversal.err, /setup proposal path must stay within the repository/);

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
  assert.match(setupHelp.out, /never creates active policy/);
  assert.match(setupHelp.out, /--proposal <path>/);
});

test('check and report errors point unconfigured repositories to the safe first step', async () => {
  const root = project();
  const check = capture();
  assert.equal(await main(['--root', root, 'check'], check.io), 2);
  assert.match(check.err, /review and explicitly activate the setup proposal/);
  assert.match(check.err, /If no proposal exists, run ux-guard setup/);

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
