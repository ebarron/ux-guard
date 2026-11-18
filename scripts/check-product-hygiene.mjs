#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_SOURCE_PATHS = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'package.json',
  'package-lock.json',
  'bin',
  'lib',
  'scripts',
  'test',
];
const REQUIRED_NOTICE_ATTRIBUTION =
  `Copyright 2026 ${['Net', 'App'].join('')}, Inc.`;
const DISALLOWED_STRINGS = [
  ['brand-company', token(['net', 'app'].join(''))],
  ['storage-os', token(['on', 'tap'].join(''))],
  ['object-store', token(['storage', 'grid'].join(''))],
  ['array-family', token(['e', 'series'].join('[- ]?'))],
  ['ui-framework', token(['man', 'tine'].join(''))],
  ['icon-framework', token(['tab', 'ler'].join(''))],
  ['consumer-ui-path', token(['admin', 'ui'].join('-'))],
  ['host-project-alias', token(['har', 'vest'].join(''))],
  ['fixed-font-family', prefixedToken(['liber', 'ation'].join(''))],
  ['dashboard-brand', token(['gra', 'fana'].join(''))],
];
const ALLOWED_LINK_HOSTS = new Set([
  'json-schema.org',
  'registry.npmjs.org',
  'www.apache.org',
]);
const REAL_HASH = /\b[a-f0-9]{40}(?:[a-f0-9]{24})?\b/g;
const URL_PATTERN = /https?:\/\/[^\s"'`)]+/g;
const RUN_LINK = /actions\/runs\/\d+/g;

export function scanProductStrings(root = PACKAGE_ROOT) {
  const findings = [];
  for (const path of sourceFiles(root)) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const [rule, pattern] of DISALLOWED_STRINGS) {
        if (
          pattern.test(line) &&
          !isRequiredNoticeAttribution(root, path, line, rule)
        ) {
          findings.push(finding(root, path, index, rule));
        }
      }
      for (const match of line.matchAll(URL_PATTERN)) {
        const host = new URL(match[0]).hostname;
        if (!ALLOWED_LINK_HOSTS.has(host) && !host.endsWith('.invalid')) {
          findings.push(finding(root, path, index, 'non-public-link'));
        }
      }
      if (REAL_HASH.test(line)) {
        findings.push(finding(root, path, index, 'literal-artifact-hash'));
      }
      REAL_HASH.lastIndex = 0;
      if (RUN_LINK.test(line)) {
        findings.push(finding(root, path, index, 'ci-run-link'));
      }
      RUN_LINK.lastIndex = 0;
    }
  }
  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

function sourceFiles(root) {
  const files = [];
  for (const path of PUBLIC_SOURCE_PATHS.map((name) => join(root, name))) {
    if (!existsSync(path)) continue;
    if (statSync(path).isFile()) {
      files.push(path);
      continue;
    }
    collect(path, files);
  }
  return files.sort();
}

function collect(directory, files) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) collect(path, files);
    else if (stats.isFile()) files.push(path);
  }
}

function finding(root, path, index, rule) {
  return {
    path: relative(root, path).replaceAll('\\', '/'),
    line: index + 1,
    rule,
  };
}

function isRequiredNoticeAttribution(root, path, line, rule) {
  return (
    relative(root, path).replaceAll('\\', '/') === 'NOTICE' &&
    rule === 'brand-company' &&
    line === REQUIRED_NOTICE_ATTRIBUTION
  );
}

function token(value) {
  return new RegExp(`(?:^|[^a-z0-9])${value}(?=$|[^a-z0-9])`, 'i');
}

function prefixedToken(value) {
  return new RegExp(`(?:^|[^a-z0-9])${value}`, 'i');
}

function main() {
  const findings = scanProductStrings();
  if (findings.length === 0) {
    process.stdout.write('ux-guard public-source hygiene: clean\n');
    return;
  }
  for (const item of findings) {
    process.stderr.write(`${item.path}:${item.line}: ${item.rule}\n`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
