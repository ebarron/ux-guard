import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.mjs';

const path = join(PACKAGE_ROOT, 'skills/ux-guard/SKILL.md');
const source = readFileSync(path, 'utf8');
const portableSource = source.replaceAll('\r\n', '\n');

test('ux-guard skill metadata is concise, valid, and trigger-rich', () => {
  const frontmatter = portableSource.match(/^---\n(?<body>[\s\S]+?)\n---\n/);
  assert.ok(frontmatter, 'skill needs YAML frontmatter');
  assert.match(frontmatter.groups.body, /^name: ux-guard$/m);
  const description = frontmatter.groups.body.match(/^description: (?<value>.+)$/m);
  assert.ok(description);
  for (const trigger of [
    'set up ux-guard',
    'audit UX',
    'explain ux-guard results',
    'regression from main',
    'recommend UX improvements',
    'policy or baseline',
  ]) {
    assert.match(description.groups.value, new RegExp(trigger, 'i'));
  }
  assert.ok(source.split(/\r?\n/).length < 500);
});

test('ux-guard skill preserves approval, evidence, and production-UI guardrails', () => {
  const normalized = source.replace(/\s+/g, ' ');
  for (const guardrail of [
    'must stop before adoption or promotion',
    'explicit human approval',
    'Never add a waiver or baseline entry merely to make results green',
    'Never describe baseline equality',
    'Do not alter production UI merely to pass',
    'could not be found or executed',
    'missing or unexecutable evidence',
  ]) {
    assert.match(normalized, new RegExp(guardrail, 'i'));
  }
  assert.doesNotMatch(source, new RegExp(['--no', 'install'].join('-')));
  assert.doesNotMatch(source, /discover write-candidate/);
});

test('ux-guard skill is included by the npm package allowlist', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'));
});
