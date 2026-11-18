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
const PACKAGE_VERSION = '0.6.0';
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
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ux-guard-install-'));

try {
  const packageDirectory = join(temporaryRoot, 'package');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  mkdirSync(packageDirectory);
  mkdirSync(consumerDirectory);

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
  const tarball = join(packageDirectory, packed.filename);
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
  process.stdout.write('ux-guard packed install and bin smoke test: passed\n');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
