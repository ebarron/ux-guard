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
    'review use cases',
    'continue a use-case review',
    'open the ux-guard review app',
    'unmapped workflows and exclusions',
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
    'include pattern review only when pattern findings exist',
    'directly usable Agent Skill prompts',
    'supporting file only in the policy-and-baseline review step',
    'no policy, baseline, waiver, or enforcement was activated',
    'approved convention, tolerated existing debt to record in the baseline, or a non-approved pattern',
    'Never infer approval from frequency',
    'real browser harness',
    'leave it unknown; never fabricate',
    'never guess to make coverage look complete',
    'Never write repository identity or hashes yourself',
    'Do not edit `ux-guard/use-case-review.json`',
    'Never run `review adopt`',
    'Saving in the app is not approval',
  ]) {
    assert.match(normalized, new RegExp(guardrail, 'i'));
  }
  assert.doesNotMatch(source, new RegExp(['--no', 'install'].join('-')));
  assert.doesNotMatch(source, /discover write-candidate/);
  assert.match(
    source,
    /Show me where ux-guard scoring comes from and explain every score/,
  );
  assert.match(
    source,
    /Compare this branch with origin\/main and explain every backslide signal; do not change policy or baselines/,
  );
  for (const prompt of [
    'Help me define and review ux-guard use cases for this repo',
    "Inspect ux-guard's setup findings and ux-guard/setup-proposal.json",
    "Prepare ux-guard's baseline review work",
    'These exact ux-guard review artifacts and resulting files are approved',
    'Check my current work with ux-guard',
    "Compare this change with origin/main using ux-guard's trusted-base mode",
    'fix the actionable UI issues without weakening policy',
  ]) {
    assert.match(source, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('ux-guard skill is included by the npm package allowlist', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'));
});
