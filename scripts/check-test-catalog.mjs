#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = join(ROOT, 'test');
const CATALOG_PATH = join(ROOT, 'docs', 'test-suite.md');
const EXPECTED_COUNT = 154;
const GROUP_PATTERN = /^## `(?<path>test\/[^`]+\.test\.mjs)` \((?<count>\d+) tests?\)$/;
const ENTRY_PATTERN = /^- `(?<name>.+)` — (?<description>.+)$/;

function discoverTests() {
  return readdirSync(TEST_ROOT)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => {
      const path = `test/${name}`;
      const source = readFileSync(join(TEST_ROOT, name), 'utf8');
      const file = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const tests = [];
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'test'
        ) {
          const [title] = node.arguments;
          assert.ok(
            title && ts.isStringLiteralLike(title),
            `${path}: every test must have a static string name`,
          );
          tests.push(title.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return { path, tests };
    });
}

function readCatalog() {
  const groups = [];
  let current = null;
  for (const line of readFileSync(CATALOG_PATH, 'utf8').split(/\r?\n/)) {
    const heading = line.match(GROUP_PATTERN);
    if (heading) {
      current = {
        path: heading.groups.path,
        declaredCount: Number(heading.groups.count),
        tests: [],
      };
      groups.push(current);
      continue;
    }
    const entry = line.match(ENTRY_PATTERN);
    if (!entry) continue;
    assert.ok(current, `catalog entry appears before a test-file heading: ${line}`);
    assert.ok(
      entry.groups.description.trim().length >= 12,
      `${current.path}: "${entry.groups.name}" needs a meaningful description`,
    );
    current.tests.push(entry.groups.name);
  }
  return groups;
}

const discovered = discoverTests();
const catalogued = readCatalog();
const discoveredCount = discovered.reduce(
  (count, group) => count + group.tests.length,
  0,
);
const cataloguedCount = catalogued.reduce(
  (count, group) => count + group.tests.length,
  0,
);

assert.equal(
  discoveredCount,
  EXPECTED_COUNT,
  `expected ${EXPECTED_COUNT} discovered tests; update the explicit suite count with the catalog`,
);
assert.equal(cataloguedCount, EXPECTED_COUNT, 'test catalog entry count drifted');
assert.deepEqual(
  catalogued.map(({ path, tests }) => ({ path, tests })),
  discovered,
  'docs/test-suite.md does not match the discovered test files and names',
);
for (const group of catalogued) {
  assert.equal(
    group.declaredCount,
    group.tests.length,
    `${group.path}: heading count does not match its entries`,
  );
}

process.stdout.write(
  `ux-guard test catalog: ${cataloguedCount} discovered tests documented and in sync\n`,
);
