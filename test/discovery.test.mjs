import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../lib/cli.mjs';
import { CATALOG, NAV, TYPESCRIPT, capture, tempRepo } from './helpers.mjs';

function repository(extra = {}) {
  return tempRepo({
    'package.json': {
      name: 'discovery-fixture',
      dependencies: {
        '@acme/icons-react': '1.0.0',
        '@acme/ui': '1.0.0',
      },
      devDependencies: {
        typescript: '5.9.3',
      },
    },
    'tsconfig.json': {
      compilerOptions: { jsx: 'react-jsx' },
      include: ['src', 'test-utils'],
    },
    'src/Page.tsx': `import { Button as PrimaryButton, TextInput } from '@acme/ui';
import { IconAdd } from '@acme/icons-react';
import './theme.css';
export function Page({ active }) {
  return (
    <div className="page" style={{ width: '12px', color: '#fff' }}>
      <PrimaryButton size="sm" variant={active ? 'filled' : 'light'}><IconAdd /></PrimaryButton>
      <TextInput size="sm" />
      <button type="button">Raw</button>
    </div>
  );
}
`,
    'src/Page.test.tsx': `export const ignored = <button style={{ width: '99px' }} />;\n`,
    'test-utils/render.tsx': `export const Wrapper = ({ children }) => <section>{children}</section>;\n`,
    ...extra,
  });
}

async function run(root, ...args) {
  const output = capture();
  const code = await main(['--root', root, 'discover', '--typescript', TYPESCRIPT, ...args], output.io);
  return { code, out: output.out, err: output.err };
}

test('discover audits a project without policy and emits review-only JSON candidates', async () => {
  const root = repository();
  const result = await run(root, '--format', 'json');
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.equal((await run(root, '--format', 'json')).out, result.out);
  const report = JSON.parse(result.out).discovery;

  assert.deepEqual(report.approval, {
    status: 'review-required',
    observedUsageIsApprovedPolicy: false,
    filesWritten: false,
  });
  assert.equal(report.observed.files, 2);
  assert.deepEqual(
    report.observed.sourceRoots.map(({ path }) => path),
    ['src', 'test-utils'],
  );
  assert.deepEqual(report.observed.nativeControls, { button: 1 });
  assert.equal(report.observed.styling.classNameAttributes, 1);
  assert.equal(report.observed.styling.inlineStyleAttributes, 1);
  assert.deepEqual(report.observed.styling.stylesheetImports, { './theme.css': 1 });
  assert.equal(report.observed.debt['px-literal']['src/Page.tsx'], 1);
  assert.equal(report.observed.debt['hard-coded-color']['src/Page.tsx'], 1);
  assert.equal(report.observed.debt['icon-library']['src/Page.tsx'], 1);

  const ui = report.observed.componentLibraries.find(({ module }) => module === '@acme/ui');
  assert.deepEqual(
    ui.components.find(({ name }) => name === 'Button').aliases,
    [{ local: 'PrimaryButton', count: 1 }],
  );
  assert.deepEqual(
    report.observed.iconLibraries.map(({ module }) => module),
    ['@acme/icons-react'],
  );

  const patterns = report.candidate.configFragment.patterns;
  assert.equal(report.candidate.configIsComplete, false);
  assert.equal(patterns.components.module, '@acme/ui');
  assert.deepEqual(patterns.components.names, ['Button', 'TextInput']);
  assert.deepEqual(patterns.components.props, ['size', 'variant']);
  assert.deepEqual(patterns.icons, { modules: ['@acme/icons-react'], allowed: [] });
  assert.equal(report.candidate.baseline.approved, false);
  assert.deepEqual(report.candidate.baseline.value.controlValues, {
    'Button.size': ['sm'],
    'Button.variant': ['filled', 'light'],
    'TextInput.size': ['sm'],
  });
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
  assert.equal(existsSync(join(root, 'ux/patterns-baseline.json')), false);
});

test('discover text names the approval boundary and writes nothing', async () => {
  const root = repository();
  const result = await run(root);
  assert.equal(result.code, 0);
  assert.match(result.out, /Observed usage is inventory, not approved policy\. No files were written\./);
  assert.match(result.out, /Candidate pattern profile \(requires review\):/);
  assert.match(result.out, /allowed icon libraries: none selected/);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
});

test('discover rejects trusted-revision mode', async () => {
  const result = await run(repository(), '--base', 'HEAD');
  assert.equal(result.code, 2);
  assert.match(result.err, /discover audits the working tree/);
});

test('candidate writing is explicit, unapproved, repository-local, and never overwrites', async () => {
  const root = repository();
  assert.equal((await run(root, 'write-candidate')).code, 2);
  const traversal = await run(root, 'write-candidate', '--candidate', '../candidate.json');
  assert.equal(traversal.code, 2);
  assert.match(traversal.err, /candidate path must stay within the repository/);
  const outside = tempRepo({});
  symlinkSync(outside, join(root, 'linked'));
  const linked = await run(root, 'write-candidate', '--candidate', 'linked/candidate.json');
  assert.equal(linked.code, 2);
  assert.match(linked.err, /not a symbolic link/);
  assert.equal(existsSync(join(outside, 'candidate.json')), false);

  const first = await run(root, 'write-candidate', '--candidate', 'review/ux-guard-candidate.json', '--format', 'json');
  assert.equal(first.code, 0);
  assert.equal(first.err, '');
  const response = JSON.parse(first.out);
  assert.equal(response.lifecycle.status, 'unapproved');
  assert.deepEqual(response.discovery.approval.writtenArtifacts, ['review/ux-guard-candidate.json']);

  const path = join(root, 'review/ux-guard-candidate.json');
  const artifactText = readFileSync(path, 'utf8');
  const artifact = JSON.parse(artifactText);
  assert.deepEqual(artifact.approval, {
    status: 'unapproved',
    reviewer: '',
    reviewedAt: '',
    patternPolicyReviewed: false,
  });
  assert.equal(artifact.observedBaseline.status, 'unapproved-observation-only');
  assert.equal(artifact.observedBaseline.approved, false);
  assert.equal(artifact.config.patterns.baseline, '');

  const second = await run(root, 'write-candidate', '--candidate', 'review/ux-guard-candidate.json');
  assert.equal(second.code, 2);
  assert.match(second.err, /refusing to overwrite/);
  assert.equal(readFileSync(path, 'utf8'), artifactText);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);
});

test('promotion requires recorded human review and regenerates the approved baseline', async () => {
  const root = repository({ 'src/nav.tsx': NAV, 'ux/use-cases.yml': CATALOG });
  const candidatePath = 'review/ux-guard-candidate.json';
  assert.equal((await run(root, 'write-candidate', '--candidate', candidatePath)).code, 0);

  const unapproved = capture();
  assert.equal(await main(['--root', root, 'discover', 'promote', '--candidate', candidatePath], unapproved.io), 2);
  assert.match(unapproved.err, /candidate is unapproved/);
  assert.equal(existsSync(join(root, '.uxguard.json')), false);

  const fullPath = join(root, candidatePath);
  const artifact = JSON.parse(readFileSync(fullPath, 'utf8'));
  artifact.approval = {
    status: 'approved',
    reviewer: 'human-reviewer',
    reviewedAt: '2026-11-16',
    patternPolicyReviewed: true,
  };
  artifact.config.catalog = { path: 'ux/use-cases.yml', navigation: ['src/nav.tsx'] };
  artifact.config.patterns.baseline = 'review/approved-baseline.json';
  artifact.observedBaseline.value.controlValues = { 'Button.size': ['unreviewed-tampering'] };
  writeFileSync(fullPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const output = capture();
  const code = await main(
    ['--root', root, 'discover', 'promote', '--candidate', candidatePath, '--format', 'json'],
    output.io,
  );
  assert.equal(code, 0);
  assert.equal(output.err, '');
  const response = JSON.parse(output.out);
  assert.equal(response.status, 'promoted');
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.promotion.files, ['.uxguard.json', 'review/approved-baseline.json']);

  const baseline = JSON.parse(readFileSync(join(root, 'review/approved-baseline.json'), 'utf8'));
  assert.deepEqual(baseline.controlValues['Button.size'], ['sm']);
  assert.equal(
    Object.values(baseline.controlValues).flat().includes('unreviewed-tampering'),
    false,
  );
  const installedConfig = readFileSync(join(root, '.uxguard.json'), 'utf8');
  const installedBaseline = readFileSync(join(root, 'review/approved-baseline.json'), 'utf8');

  const repeated = capture();
  assert.equal(await main(['--root', root, 'discover', 'promote', '--candidate', candidatePath], repeated.io), 2);
  assert.match(repeated.err, /promotion never overwrites policy/);
  assert.equal(readFileSync(join(root, '.uxguard.json'), 'utf8'), installedConfig);
  assert.equal(readFileSync(join(root, 'review/approved-baseline.json'), 'utf8'), installedBaseline);
});
