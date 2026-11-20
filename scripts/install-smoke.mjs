#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function listConsumerFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listConsumerFiles(directory, path) : [path];
    })
    .sort();
}

// smokeReviewApp proves the installed package serves its bundled review app
// from node_modules on loopback and stops when the app closes.
async function smokeReviewApp(consumerDirectory) {
  writeFileSync(
    join(consumerDirectory, 'ux-guard/use-case-draft.json'),
    `${JSON.stringify(
      {
        kind: 'ux-guard-use-case-draft',
        version: 1,
        approval: { status: 'unapproved', activatesCatalog: false },
        source: { catalog: 'ux/use-cases.yml', navigation: ['src/Page.tsx'] },
        workflows: [
          {
            id: 'view-page',
            title: 'View the page',
            sources: ['src/Page.tsx'],
            classification: { disposition: 'unresolved' },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const prepare = spawnSync(npx, ['ux-guard', 'review', 'prepare'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.ok(existsSync(join(consumerDirectory, 'ux-guard/use-case-candidate.json')));

  const bin = join(
    consumerDirectory,
    'node_modules',
    '@edjbarron',
    'ux-guard',
    'bin',
    'ux-guard.mjs',
  );
  const child = spawn(process.execPath, [bin, 'review', '--no-open'], {
    cwd: consumerDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolveExit) => child.on('exit', resolveExit));
  try {
    let url = null;
    for (let attempt = 0; attempt < 200 && url === null; attempt += 1) {
      url = /Open (http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]+)/.exec(output);
      if (url === null) await new Promise((wait) => setTimeout(wait, 50));
    }
    assert.ok(url, `review did not print its address:\n${output}`);
    const [, origin, token] = url;
    for (const [path, type] of [
      ['/', /text\/html/],
      ['/app.js', /text\/javascript/],
      ['/app.css', /text\/css/],
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), type);
    }
    const state = await fetch(`${origin}/api/state`, {
      headers: { 'X-UX-Guard-Token': token },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).state.summary.unresolved, 1);
    const closed = await fetch(`${origin}/api/close`, {
      method: 'POST',
      headers: { 'X-UX-Guard-Token': token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(closed.status, 200);
    assert.equal(await exited, 0);
  } finally {
    child.kill();
  }
  assert.equal(existsSync(join(consumerDirectory, 'ux-guard/use-case-review.json')), false);
  assert.equal(existsSync(join(consumerDirectory, 'ux/use-cases.yml')), false);
}

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
    'docs/scoring-and-backslide.md',
    'docs/use-case-review.md',
    'lib/review-app/index.html',
    'lib/review-app/app.js',
    'lib/review-app/app.css',
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
  assert.match(setup.stdout, /^Good$/m);
  assert.match(setup.stdout, /^Needs attention$/m);
  assert.match(setup.stdout, /^Unknown$/m);
  assert.match(setup.stdout, /^Next steps$/m);
  assert.match(setup.stdout, /Help me define ux-guard use cases for this repo/);
  assert.match(
    setup.stdout,
    /Use ux-guard\/setup-proposal\.json as a supporting review file; it contains observed source roots, component and icon usage, pattern counts, and unresolved policy choices/,
  );
  assert.match(setup.stdout, /No policy, baseline, waiver, or enforcement was activated/);
  assert.doesNotMatch(setup.stdout, /^Setup proposal$/m);
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
  assert.match(check.stderr, /review its findings and supporting file/);
  assert.match(check.stderr, /explicit human approval/);

  const report = spawnSync(npx, ['ux-guard', 'report'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(report.error, undefined);
  assert.equal(report.status, 2);
  assert.match(report.stderr, /Reporting remains unavailable/);

  const beforeReview = listConsumerFiles(consumerDirectory);
  const review = spawnSync(npx, ['ux-guard', 'review'], {
    cwd: consumerDirectory,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(review.error, undefined);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /No use-case candidate was found/);
  assert.match(review.stdout, /Help me discover and review the important use cases in this repository\./);
  assert.match(review.stdout, /Nothing was written\./);
  assert.deepEqual(listConsumerFiles(consumerDirectory), beforeReview);
  await smokeReviewApp(consumerDirectory);

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
    'ux-guard packed install, bin, Quickstart, and review app smoke test: passed\n',
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
