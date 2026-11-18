#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = '@edjbarron/ux-guard';
const PACKAGE_VERSION = '0.6.1';
const EXPORTS = [
  'authoritative',
  'baselines',
  'journey-policy',
  'journeys',
  'observations',
  'playwright',
  'run-contract',
  'shards',
  'targets',
  'visuals',
  'verdicts',
];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ux-guard-install-'));
const suppliedTarball = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : null;

try {
  const consumerDirectory = join(temporaryRoot, 'consumer');
  mkdirSync(consumerDirectory);

  let tarball = suppliedTarball;
  if (tarball === null) {
    const packageDirectory = join(temporaryRoot, 'package');
    mkdirSync(packageDirectory);
    const [packed] = JSON.parse(
      execFileSync(
        npm,
        [
          'pack',
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          packageDirectory,
        ],
        { cwd: ROOT, encoding: 'utf8' },
      ),
    );
    tarball = join(packageDirectory, packed.filename);
  }
  assert.ok(existsSync(tarball), 'npm pack did not create the tarball');

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
  execFileSync(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    { cwd: consumerDirectory, stdio: 'pipe' },
  );

  const installedRoot = join(
    consumerDirectory,
    'node_modules',
    '@edjbarron',
    'ux-guard',
  );
  const installed = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8'),
  );
  assert.equal(installed.name, PACKAGE_NAME);
  assert.equal(installed.version, PACKAGE_VERSION);
  for (const packagedPath of [
    'README.md',
    'docs/cli-reference.md',
    'skills/ux-guard/SKILL.md',
  ]) {
    assert.ok(
      existsSync(join(installedRoot, packagedPath)),
      `npm package is missing ${packagedPath}`,
    );
  }

  const importProgram = [
    ...EXPORTS.map(
      (name) => `await import('${PACKAGE_NAME}/${name}');`,
    ),
    "process.stdout.write('exports loaded\\n');",
  ].join('\n');
  assert.equal(
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', importProgram],
      { cwd: consumerDirectory, encoding: 'utf8' },
    ),
    'exports loaded\n',
  );

  mkdirSync(join(consumerDirectory, 'src'));
  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: { jsx: 'react-jsx' },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerDirectory, 'src/Page.tsx'),
    'export const Page = () => <main><p>Hello</p></main>;\n',
  );

  const setup = spawnSync(npx, ['ux-guard', 'setup'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(setup.error, undefined);
  assert.equal(setup.status, 0);
  assert.equal(setup.stderr, '');
  assert.match(setup.stdout, /^ux-guard setup/m);
  assert.match(setup.stdout, /Saved ux-guard\/setup-proposal\.json/);
  const setupProposal = JSON.parse(
    readFileSync(
      join(consumerDirectory, 'ux-guard/setup-proposal.json'),
      'utf8',
    ),
  );
  assert.equal(setupProposal.kind, 'ux-guard-setup-proposal');
  assert.equal(setupProposal.approval.status, 'unapproved');
  assert.equal(existsSync(join(consumerDirectory, '.uxguard.json')), false);

  const check = spawnSync(npx, ['ux-guard', 'check'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(check.error, undefined);
  assert.equal(check.status, 2);
  assert.match(check.stderr, /review and explicitly activate the setup proposal/);

  const report = spawnSync(npx, ['ux-guard', 'report'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(report.error, undefined);
  assert.equal(report.status, 2);
  assert.match(report.stderr, /Reporting remains unavailable/);

  const bin = join(
    consumerDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'ux-guard.cmd' : 'ux-guard',
  );
  assert.ok(existsSync(bin), 'npm did not install the ux-guard bin');
  const result = spawnSync(bin, [], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: ux-guard <command>/);
  process.stdout.write(
    'ux-guard packed install, bin, and clean Quickstart smoke test: passed\n',
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
