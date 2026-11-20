import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navSurfaces, validateCatalog } from '../lib/catalog.mjs';
import {
  computeReview,
  emitCatalog,
  emptyReview,
  serializeReview,
  stampCandidate,
  subjectKey,
  unifiedDiff,
  validateUseCaseCandidate,
  validateUseCaseReview,
} from '../lib/review.mjs';
import { parseYamlSubset } from '../lib/yaml.mjs';
import { CATALOG, NAV, ts } from './helpers.mjs';
import { draft } from './review-helpers.mjs';

const SHA = 'c'.repeat(64);

function candidate(overrides = {}) {
  return stampCandidate(draft(overrides), {
    commit: null,
    rootCommits: [],
    inputs: [{ path: 'src/nav.tsx', sha256: SHA }],
  });
}

function scope(value) {
  return {
    proposalIds: value.proposals.map(({ id }) => id),
    subjectKeys: [
      ...value.surfaces.map(({ id }) => subjectKey('surface', id)),
      ...value.workflows.map(({ id }) => subjectKey('workflow', id)),
    ],
  };
}

function evaluate(value, decisions = {}, { catalog = CATALOG, discovered = [] } = {}) {
  const review = validateUseCaseReview({ ...emptyReview('ux-guard/use-case-candidate.json', SHA), ...decisions }, scope(value));
  return computeReview({
    candidate: value,
    review,
    activeCatalog: { path: 'ux/use-cases.yml', origin: 'config', text: catalog },
    discoveredSurfaces: discovered,
  });
}

function item(state, id) {
  return state.useCases.find((entry) => entry.id === id);
}

function subject(state, key) {
  return state.subjects.find((entry) => entry.key === key);
}

test('use-case candidates validate strictly and reject approval, forged identity, and unsafe paths', () => {
  const value = candidate();
  assert.equal(value.kind, 'ux-guard-use-case-candidate');
  assert.deepEqual(value.approval, { status: 'unapproved', activatesCatalog: false });
  assert.equal(validateUseCaseCandidate(structuredClone(value)).proposals.length, 3);

  const cases = [
    [{ approval: { status: 'approved', activatesCatalog: true } }, /must be unapproved/],
    [{ source: { catalog: 'ux/use-cases.yml', navigation: ['src/nav.tsx'], commit: 'a'.repeat(40) } }, /computed by ux-guard review prepare/],
    [{ source: { catalog: '../outside.yml', navigation: ['src/nav.tsx'] } }, /stay within the repository/],
    [{ source: { catalog: 'ux/use-cases.yml', navigation: ['C:/nav.tsx'] } }, /repository-relative/],
    [{ proposals: [{ id: 'Bad Id', title: 'x' }] }, /kebab-case/],
    [{ proposals: [{ id: 'a', title: 'x', tier: 'urgent' }] }, /tier must be one of/],
    [{ proposals: [{ id: 'a', title: 'x', outcome: 'nowhere' }] }, /unknown outcome/],
    [{ proposals: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }, /repeats id a/],
    [{ proposals: [{ id: 'a', title: 'x', surprise: true }] }, /not a recognized field/],
    [{ proposals: [], surfaces: [], workflows: [] }, /at least one proposal/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.throws(() => validateUseCaseCandidate(draft(overrides), { draft: true }), pattern);
  }
  const forged = structuredClone(value);
  forged.source.inputs = [{ path: 'b.tsx', sha256: SHA }, { path: 'a.tsx', sha256: SHA }];
  assert.throws(() => validateUseCaseCandidate(forged), /unique and sorted/);
  assert.throws(() => validateUseCaseCandidate({ ...value, kind: 'ux-guard-use-case-draft' }), /kind must be/);
});

test('review decisions round-trip canonically and reject unknown proposals, subjects, and actions', () => {
  const value = candidate();
  const review = validateUseCaseReview(
    {
      ...emptyReview('ux-guard/use-case-candidate.json', SHA),
      proposals: { 'review-dashboard': { action: 'approve', note: 'Matches the roadmap.' } },
      mappings: { 'workflow:bulk-import': { disposition: 'excluded', useCaseIds: [], rationale: 'Not offered.' } },
    },
    scope(value),
  );
  const text = serializeReview(review);
  assert.deepEqual(validateUseCaseReview(JSON.parse(text), scope(value)), review);
  assert.equal(serializeReview(JSON.parse(text)), text);

  const bad = [
    [{ proposals: { ghost: { action: 'approve' } } }, /unknown proposal/],
    [{ proposals: { 'review-dashboard': { action: 'ship-it' } } }, /action must be one of/],
    [{ proposals: { 'review-dashboard': { action: 'approve', fields: { title: 'x' } } } }, /fields is not a recognized field/],
    [{ proposals: { 'review-dashboard': { action: 'merge', into: 'review-dashboard' } } }, /into itself/],
    [{ mappings: { 'surface:ghost': { disposition: 'excluded', useCaseIds: [], rationale: 'x' } } }, /unknown surface or workflow/],
    [{ approval: { status: 'approved', activatesCatalog: true } }, /must be unapproved/],
    [{ added: [{ id: 'review-dashboard', origin: 'added', title: 'Dup' }] }, /duplicates proposal/],
    [{ added: [{ id: 'piece', origin: 'split', title: 'Piece', from: 'ghost' }] }, /unknown proposal/],
    [{ revision: -1 }, /non-negative integer/],
  ];
  for (const [patch, pattern] of bad) {
    assert.throws(
      () => validateUseCaseReview({ ...emptyReview('ux-guard/use-case-candidate.json', SHA), ...patch }, scope(value)),
      pattern,
    );
  }
});

test('approve and revise add complete entries while incomplete proposals stay out with reasons', () => {
  const value = candidate();
  const state = evaluate(value, {
    proposals: {
      'review-dashboard': { action: 'approve' },
      'archive-record': { action: 'revise', fields: { title: 'Archive an old record' } },
    },
  });
  assert.equal(item(state, 'review-dashboard').catalogEntry.title, 'Review the dashboard');
  assert.deepEqual(item(state, 'review-dashboard').catalogEntry.starts, [{ nav_id: 'dashboard', route: '/dashboard' }]);
  const archive = item(state, 'archive-record');
  assert.equal(archive.effective.title, 'Archive an old record');
  assert.equal(archive.catalogEntry, null);
  assert.match(archive.omitted[0], /missing owner, goal, success, starts/);
  assert.ok(state.issues.some(({ severity, message }) => severity === 'error' && /archive-record cannot enter the catalog/.test(message)));

  const revised = evaluate(value, {
    proposals: {
      'archive-record': {
        action: 'revise',
        fields: {
          owner: 'records-owner',
          goal: 'Hide records that are no longer used.',
          success: 'The record leaves the active list.',
          starts: [{ nav_id: 'records', route: '/records' }],
        },
      },
    },
  });
  assert.equal(item(revised, 'archive-record').catalogEntry.owner, 'records-owner');
  assert.equal(revised.summary.proposals.revise, 1);
  assert.equal(revised.summary.proposals.pending, 2);
});

test('reject and split leave dependent mappings unresolved until they are remapped', () => {
  const value = candidate();
  const rejected = evaluate(value, { proposals: { 'review-dashboard': { action: 'reject', note: 'Not a goal.' } } });
  const dashboard = subject(rejected, 'surface:dashboard');
  assert.equal(dashboard.status, 'unresolved');
  assert.match(dashboard.issues[0], /review-dashboard was rejected/);
  assert.equal(item(rejected, 'review-dashboard').catalogEntry, null);

  const parts = ['review-dashboard-alerts', 'review-dashboard-trends'].map((id) => ({
    id,
    origin: 'split',
    from: 'review-dashboard',
    title: id,
    persona: 'Operator',
    tier: 'secondary',
    effect: 'read',
    owner: 'product-owner',
    goal: 'Watch one signal.',
    success: 'The signal is visible.',
    starts: [{ nav_id: 'dashboard', route: '/dashboard' }],
  }));
  const split = evaluate(value, {
    proposals: { 'review-dashboard': { action: 'split', parts: parts.map(({ id }) => id) } },
    added: parts,
  });
  assert.equal(subject(split, 'surface:dashboard').status, 'unresolved');
  assert.match(subject(split, 'surface:dashboard').issues[0], /was split; choose one of its parts/);
  assert.deepEqual(
    split.useCases.filter(({ catalogEntry }) => catalogEntry && catalogEntry.id.startsWith('review-dashboard')).map(({ id }) => id),
    parts.map(({ id }) => id),
  );

  const remapped = evaluate(value, {
    proposals: { 'review-dashboard': { action: 'split', parts: parts.map(({ id }) => id) } },
    added: parts,
    mappings: { 'surface:dashboard': { disposition: 'use-case', useCaseIds: ['review-dashboard-alerts'], rationale: '' } },
  });
  assert.equal(subject(remapped, 'surface:dashboard').status, 'mapped');

  const lonely = evaluate(value, {
    proposals: { 'review-dashboard': { action: 'split', parts: [parts[0].id] } },
    added: [parts[0]],
  });
  assert.ok(lonely.issues.some(({ message }) => /needs at least two parts/.test(message)));
});

test('merge folds starts and mappings into an accepted target and rejects unaccepted targets', () => {
  const value = candidate();
  const pendingTarget = evaluate(value, { proposals: { 'archive-record': { action: 'merge', into: 'export-records' } } });
  assert.ok(pendingTarget.issues.some(({ message }) => /export-records, which is not accepted/.test(message)));
  assert.equal(subject(pendingTarget, 'workflow:archive').status, 'unresolved');

  const merged = evaluate(value, {
    proposals: {
      'export-records': { action: 'approve' },
      'archive-record': { action: 'merge', into: 'export-records' },
    },
  });
  assert.equal(subject(merged, 'workflow:archive').status, 'mapped');
  assert.deepEqual(subject(merged, 'workflow:archive').resolvedUseCaseIds, ['export-records']);
  assert.equal(item(merged, 'archive-record').catalogEntry, null);

  const intoExisting = evaluate(value, {
    proposals: {
      'export-records': {
        action: 'merge',
        into: 'create-record',
      },
    },
  });
  const existing = intoExisting.catalog.text;
  assert.match(existing, /- nav_id: records\n {8}route: \/records\/export/);
  assert.equal(intoExisting.useCases.find(({ id }) => id === 'export-records').catalogEntry, null);
});

test('added use cases and split parts must be complete and cannot collide with the catalog', () => {
  const value = candidate();
  const state = evaluate(value, {
    added: [
      { id: 'create-record', origin: 'added', title: 'Duplicate of the active catalog' },
      { id: 'audit-history', origin: 'added', title: 'Audit history', persona: 'Auditor' },
    ],
  });
  assert.ok(state.issues.some(({ message }) => /create-record duplicates an active catalog use case/.test(message)));
  assert.match(item(state, 'audit-history').omitted[0], /missing tier, effect, owner, goal, success, starts/);
  assert.equal(state.summary.proposals.added, 2);

  const orphan = evaluate(value, {
    added: [{ id: 'orphan-part', origin: 'split', from: 'export-records', title: 'Orphan' }],
  });
  assert.ok(orphan.issues.some(({ message }) => /export-records is not split into it/.test(message)));
});

test('unresolved and exclusion accounting keeps unknowns visible instead of reporting success', () => {
  const value = candidate();
  const state = evaluate(value, {}, { discovered: navSurfaces(ts, 'src/nav.tsx', `${NAV.trim().slice(0, -2)}  { id: 'settings', label: 'Settings', route: '/settings' },\n];\n`) });
  assert.equal(state.summary.discovered, 6);
  assert.equal(state.summary.mapped, 1);
  assert.equal(state.summary.proposed, 2);
  assert.equal(state.summary.excluded, 1);
  assert.equal(state.summary.unresolved, 2);
  assert.equal(subject(state, 'surface:settings').origin, 'discovered');
  assert.equal(subject(state, 'surface:settings').status, 'unresolved');
  assert.equal(state.summary.readyForOwnerApproval, false);
  assert.ok(state.unresolved.some(({ scope: where }) => where === 'use-case:review-dashboard'));
  assert.ok(state.unresolved.some(({ scope: where }) => where === 'workflow:bulk-import'));

  const noRationale = evaluate(value, {
    mappings: { 'workflow:bulk-import': { disposition: 'excluded', useCaseIds: [], rationale: '   ' } },
  });
  assert.equal(subject(noRationale, 'workflow:bulk-import').status, 'unresolved');
  assert.match(subject(noRationale, 'workflow:bulk-import').issues[0], /exclusion needs a rationale/);

  const emptyMapping = evaluate(value, {
    mappings: { 'workflow:bulk-import': { disposition: 'use-case', useCaseIds: [], rationale: '' } },
  });
  assert.equal(subject(emptyMapping, 'workflow:bulk-import').status, 'unresolved');
});

test('mapped surfaces become catalog starts that the catalog check accepts', () => {
  const value = candidate();
  const state = evaluate(value, {
    proposals: { 'review-dashboard': { action: 'approve' }, 'export-records': { action: 'approve' } },
  });
  const catalog = parseYamlSubset(state.catalog.text);
  const surfaces = navSurfaces(ts, 'src/nav.tsx', NAV);
  const report = validateCatalog(catalog, surfaces);
  assert.deepEqual(report.unmapped, []);
  assert.deepEqual(
    catalog.use_cases.map(({ id }) => id),
    ['create-record', 'review-dashboard', 'export-records'],
  );
  assert.equal(catalog.inventory, 'partial');
});

test('the generated catalog diff is exact, deterministic, and keeps the active entries', () => {
  const value = candidate();
  const decisions = { proposals: { 'review-dashboard': { action: 'approve' } } };
  const first = evaluate(value, decisions);
  const second = evaluate(value, decisions);
  assert.equal(first.catalog.diff, second.catalog.diff);
  assert.match(first.catalog.diff, /^--- a\/ux\/use-cases\.yml\n\+\+\+ b\/ux\/use-cases\.yml\n@@ /);
  assert.match(first.catalog.diff, /\n\+  - id: review-dashboard\n/);
  assert.doesNotMatch(first.catalog.diff, /^-  - id: create-record$/m);
  assert.equal(first.catalog.activeSha256.length, 64);
  assert.equal(first.catalog.changed, true);

  const created = evaluate(value, decisions, { catalog: null });
  assert.match(created.catalog.diff, /^--- \/dev\/null\n/);
  assert.equal(created.catalog.exists, false);

  const commented = evaluate(value, decisions, { catalog: `# Owned by product.\n${CATALOG}` });
  assert.ok(commented.issues.some(({ message }) => /Comments in ux\/use-cases\.yml are not preserved/.test(message)));
  assert.match(commented.catalog.diff, /^-# Owned by product\.$/m);

  const nothing = evaluate(value, {}, { catalog: null });
  assert.equal(nothing.catalog.text, null);
  assert.ok(nothing.issues.some(({ message }) => /no use cases yet/.test(message)));
});

test('catalog YAML emission round-trips through the strict parser or refuses to write', () => {
  const entry = {
    id: 'tricky',
    title: 'Create: a "quoted" record',
    persona: "Owner's delegate",
    tier: 'primary',
    effect: 'create',
    owner: 'true',
    goal: 'Keep # inside text',
    success: '42',
    starts: [{ entry: 'assistant', prompt: 'Create a record for me' }],
  };
  const text = emitCatalog({ version: 1, inventory: 'partial', use_cases: [entry] });
  assert.deepEqual(parseYamlSubset(text).use_cases[0], entry);
  assert.throws(
    () => emitCatalog({ version: 1, inventory: 'partial', use_cases: [{ ...entry, title: `It's "both"` }] }),
    /both single and double quotes/,
  );
  assert.throws(
    () => emitCatalog({ version: 1, inventory: 'partial', use_cases: [{ ...entry, goal: 'two\nlines' }] }),
    /line breaks/,
  );
});

test('unified diffs use minimal hunks with three lines of context', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const after = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
  assert.equal(
    unifiedDiff(before, after, 'x.yml'),
    [
      '--- a/x.yml',
      '+++ b/x.yml',
      '@@ -1,5 +1,5 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      ' e',
      '@@ -8,3 +8,4 @@',
      ' h',
      ' i',
      ' j',
      '+k',
      '',
    ].join('\n'),
  );
  assert.equal(unifiedDiff(before, before, 'x.yml'), '');
  assert.equal(unifiedDiff('', 'x\n', 'x.yml', true), '--- /dev/null\n+++ b/x.yml\n@@ -0,0 +1,1 @@\n+x\n');
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n', 'x.yml'), '');
});
