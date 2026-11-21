import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PREVIEW_MARKER } from '../lib/review.mjs';
import {
  DEFAULT_REVIEW_PATHS,
  adoptReview,
  evaluateReview,
  prepareCandidate,
  refreshContext,
  saveReview,
} from '../lib/review-store.mjs';
import { sha256 } from '../lib/run-contract.mjs';
import { tempRepo } from './helpers.mjs';
import { commitAll, context, draft, freshReview, listFiles, prepared, reviewRepo } from './review-helpers.mjs';

const APPROVAL = {
  reviewer: 'product-owner',
  reviewedAt: '2026-01-31T12:00:00Z',
  rationale: 'Reviewed with design and engineering.',
};

function decided(ctx) {
  return {
    ...freshReview(ctx),
    revision: ctx.review.revision,
    proposals: {
      'review-dashboard': { action: 'approve' },
      'archive-record': { action: 'reject', note: 'Archive is being removed.' },
      'export-records': { action: 'approve' },
    },
    mappings: {
      'workflow:archive': { disposition: 'excluded', useCaseIds: [], rationale: 'Archive is being removed.' },
      'workflow:bulk-import': { disposition: 'excluded', useCaseIds: [], rationale: 'Not offered in this product.' },
    },
  };
}

test('prepare stamps repository identity and input hashes without overwriting', () => {
  const root = reviewRepo({ git: true });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const result = prepareCandidate(root, {
    draftPath: DEFAULT_REVIEW_PATHS.draft,
    candidatePath: DEFAULT_REVIEW_PATHS.candidate,
  });
  const candidate = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.candidate), 'utf8'));
  assert.equal(candidate.kind, 'ux-guard-use-case-candidate');
  assert.equal(candidate.source.commit, head);
  assert.deepEqual(candidate.source.repository.rootCommits, [head]);
  assert.deepEqual(
    candidate.source.inputs.map(({ path }) => path),
    ['src/Debug.tsx', 'src/Records.tsx', 'src/nav.tsx'],
  );
  assert.equal(
    candidate.source.inputs.find(({ path }) => path === 'src/nav.tsx').sha256,
    sha256(readFileSync(join(root, 'src/nav.tsx'), 'utf8')),
  );
  assert.equal(result.inputs, 3);
  assert.deepEqual(result.notAssessed, []);
  assert.deepEqual(result.incompleteProposals, [
    {
      id: 'archive-record',
      missing: ['goal', 'success'],
      missingLabels: ['Goal', 'Success outcome'],
    },
  ]);

  const original = readFileSync(join(root, DEFAULT_REVIEW_PATHS.candidate), 'utf8');
  assert.throws(
    () => prepareCandidate(root, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate }),
    /already exists; refusing to overwrite/,
  );
  assert.equal(readFileSync(join(root, DEFAULT_REVIEW_PATHS.candidate), 'utf8'), original);
  assert.deepEqual(readdirSync(join(root, 'ux-guard')).filter((name) => name.endsWith('.tmp')), []);
});

test('prepare rejects forged identity, missing or escaping inputs, and policy destinations', () => {
  const forged = reviewRepo({ draftValue: { ...draft(), source: { ...draft().source, inputs: [] } } });
  assert.throws(
    () => prepareCandidate(forged, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate }),
    /computed by ux-guard review prepare/,
  );

  const missing = reviewRepo();
  writeFileSync(
    join(missing, DEFAULT_REVIEW_PATHS.draft),
    JSON.stringify({ ...draft(), workflows: [{ ...draft().workflows[0], sources: ['src/Gone.tsx'] }] }),
  );
  assert.throws(
    () => prepareCandidate(missing, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate }),
    /src\/Gone\.tsx does not exist/,
  );

  const escaping = reviewRepo();
  const outside = tempRepo({ 'secret.tsx': 'export const secret = 1;\n' });
  symlinkSync(outside, join(escaping, 'linked'));
  writeFileSync(
    join(escaping, DEFAULT_REVIEW_PATHS.draft),
    JSON.stringify({ ...draft(), workflows: [{ ...draft().workflows[0], sources: ['linked/secret.tsx'] }] }),
  );
  assert.throws(
    () => prepareCandidate(escaping, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate }),
    /symbolic link/,
  );

  const root = reviewRepo();
  for (const candidatePath of ['ux/use-cases.yml', '.uxguard.json', 'ux/patterns-baseline.json']) {
    assert.throws(
      () => prepareCandidate(root, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath }),
      /active policy path|cannot be \.uxguard\.json/,
    );
  }
  assert.deepEqual(listFiles(root).filter((path) => path.startsWith('ux-guard/')), [DEFAULT_REVIEW_PATHS.draft]);
});

test('stale candidates are detected from changed inputs and from a different repository', () => {
  const root = reviewRepo({ git: true });
  const ctx = prepared(root);
  assert.equal(ctx.identity.status, 'current');

  writeFileSync(join(root, 'README.md'), 'unrelated change\n');
  commitAll(root, 'unrelated');
  assert.equal(refreshContext(ctx).identity.status, 'moved');

  writeFileSync(join(root, 'src/Records.tsx'), 'export const Records = () => null;\n');
  const stale = refreshContext(ctx).identity;
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.reasons, ['src/Records.tsx changed after the assessment.']);
  assert.ok(evaluateReview(ctx).issues.some(({ message }) => /Candidate is stale/.test(message)));

  rmSync(join(root, 'src/Debug.tsx'));
  assert.ok(refreshContext(ctx).identity.reasons.includes('src/Debug.tsx no longer exists.'));

  const other = mkdtempSync(join(tmpdir(), 'ux-guard-other-'));
  const copy = join(other, 'repo');
  cpSync(prepared(reviewRepo({ git: true })).root, copy, { recursive: true, filter: (path) => !path.includes('.git') });
  commitAll(copy, 'a different history');
  const foreign = context(copy).identity;
  assert.equal(foreign.status, 'stale');
  assert.ok(foreign.reasons.includes('it was assessed in a different repository.'));
});

test('saves are atomic, revisioned, and refuse concurrent or foreign overwrites', () => {
  const root = reviewRepo();
  const ctx = prepared(root);
  const before = listFiles(root);
  const first = saveReview(ctx, decided(ctx));
  assert.equal(first.revision, 1);
  assert.deepEqual(
    listFiles(root).filter((path) => !before.includes(path)),
    [DEFAULT_REVIEW_PATHS.preview, DEFAULT_REVIEW_PATHS.review],
  );
  const saved = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8'));
  assert.deepEqual(saved.approval, { status: 'unapproved', activatesCatalog: false });
  assert.equal(saved.revision, 1);
  assert.ok(readFileSync(join(root, DEFAULT_REVIEW_PATHS.preview), 'utf8').startsWith(`${PREVIEW_MARKER}\n`));

  assert.throws(() => saveReview(ctx, { ...decided(ctx), revision: 0 }), /not the loaded revision 1/);
  const resumed = context(root);
  assert.equal(resumed.review.revision, 1);
  assert.deepEqual(resumed.review.proposals, saved.proposals);

  writeFileSync(join(root, DEFAULT_REVIEW_PATHS.review), `${JSON.stringify({ ...saved, revision: 7 }, null, 2)}\n`);
  assert.throws(() => saveReview(ctx, { ...decided(ctx), revision: 1 }), /changed after it was loaded/);
  assert.equal(JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8')).revision, 7);

  const foreign = reviewRepo();
  const foreignContext = prepared(foreign);
  writeFileSync(join(foreign, DEFAULT_REVIEW_PATHS.preview), 'hand-written notes\n');
  assert.throws(() => saveReview(foreignContext, decided(foreignContext)), /not a generated ux-guard preview/);
  assert.equal(readFileSync(join(foreign, DEFAULT_REVIEW_PATHS.preview), 'utf8'), 'hand-written notes\n');
  for (const directory of [root, foreign]) {
    assert.deepEqual(readdirSync(join(directory, 'ux-guard')).filter((name) => name.endsWith('.tmp')), []);
  }
});

test('review artifact paths cannot target active policy, escape the repository, or follow symbolic links', () => {
  const root = reviewRepo();
  prepared(root);
  for (const [paths, pattern] of [
    [{ reviewPath: 'ux/use-cases.yml' }, /active policy path/],
    [{ previewPath: '.uxguard.json' }, /active policy path/],
    [{ previewPath: 'src/nav.tsx' }, /active policy path/],
    [{ reviewPath: '../review.json' }, /stay within the repository/],
    [{ reviewPath: DEFAULT_REVIEW_PATHS.candidate }, /must all be different/],
  ]) {
    assert.throws(() => context(root, paths), pattern);
  }
  const outside = tempRepo({});
  symlinkSync(outside, join(root, 'linked'));
  const ctx = context(root, { reviewPath: 'linked/review.json' });
  assert.throws(() => saveReview(ctx, decided(ctx)), /not a symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
});

test('a review recorded against another candidate is refused instead of silently reapplied', () => {
  const root = reviewRepo();
  const ctx = prepared(root);
  saveReview(ctx, decided(ctx));
  rmSync(join(root, DEFAULT_REVIEW_PATHS.candidate));
  writeFileSync(join(root, DEFAULT_REVIEW_PATHS.draft), JSON.stringify({ ...draft(), questions: [] }));
  prepareCandidate(root, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate });
  assert.throws(() => context(root), /recorded against a different candidate/);
  assert.equal(context(root, { reviewPath: 'ux-guard/second-review.json' }).review.revision, 0);
});

test('adoption requires approval details and a saved, current, conflict-free review with an exact preview', () => {
  const root = reviewRepo({ git: true });
  const unsaved = prepared(root);
  assert.throws(() => adoptReview(unsaved, APPROVAL), /has not been saved/);
  assert.throws(() => adoptReview(unsaved, { ...APPROVAL, reviewedAt: 'yesterday' }), /UTC timestamp/);
  assert.throws(() => adoptReview(unsaved, { ...APPROVAL, rationale: '' }), /single-line --rationale/);

  const pending = prepared(reviewRepo({ git: true }));
  assert.throws(
    () => saveReview(pending, { ...freshReview(pending), proposals: { 'archive-record': { action: 'approve' } } }),
    /cannot be approved as proposed until Goal, Success outcome/,
  );
  assert.equal(pending.reviewSha256, null);

  saveReview(unsaved, decided(unsaved));
  writeFileSync(join(root, DEFAULT_REVIEW_PATHS.preview), `${PREVIEW_MARKER}\nedited by hand\n`);
  assert.throws(() => adoptReview(context(root), APPROVAL), /does not match the saved review/);

  const ctx = context(root);
  saveReview(ctx, { ...ctx.review });
  writeFileSync(join(root, 'src/Records.tsx'), 'export const Records = () => null;\n');
  assert.throws(() => adoptReview(context(root), APPROVAL), /candidate is stale/);
  assert.equal(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8').includes('review-dashboard'), false);
});

test('adoption replaces an existing catalog only with its exact current hash and changes nothing else', () => {
  const root = reviewRepo({ git: true });
  const ctx = prepared(root);
  saveReview(ctx, decided(ctx));
  const protectedFiles = ['.uxguard.json', 'src/nav.tsx', DEFAULT_REVIEW_PATHS.candidate, DEFAULT_REVIEW_PATHS.review];
  const snapshot = Object.fromEntries(protectedFiles.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  const current = sha256(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8'));

  assert.throws(() => adoptReview(context(root), APPROVAL), new RegExp(`--replace-catalog-sha256 ${current}`));
  assert.throws(() => adoptReview(context(root), { ...APPROVAL, replaceSha256: 'f'.repeat(64) }), /changed after it was loaded/);
  assert.throws(() => adoptReview(context(root), { ...APPROVAL, catalogPath: 'ux/other.yml', replaceSha256: current }), /differs from active policy/);

  const expected = evaluateReview(context(root)).catalog.text;
  const record = adoptReview(context(root), { ...APPROVAL, replaceSha256: current });
  assert.equal(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8'), expected);
  assert.equal(record.status, 'adopted');
  assert.equal(record.catalog.previousSha256, current);
  assert.equal(record.catalog.inventory, 'partial');
  assert.deepEqual(record.approval, APPROVAL);
  assert.deepEqual(record.unchanged, { configuration: true, baselines: true, targets: true, waivers: true, enforcement: true });
  for (const path of protectedFiles) assert.equal(readFileSync(join(root, path), 'utf8'), snapshot[path]);

  const fresh = reviewRepo({ withConfig: false, catalog: null });
  const freshContext = prepared(fresh);
  saveReview(freshContext, decided(freshContext));
  assert.throws(() => adoptReview(context(fresh), APPROVAL), /Maps to unknown use case create-record/);
  const remapped = context(fresh);
  saveReview(remapped, {
    ...remapped.review,
    mappings: {
      ...remapped.review.mappings,
      'surface:records': { disposition: 'use-case', useCaseIds: ['export-records'], rationale: '' },
    },
  });
  assert.throws(() => adoptReview(context(fresh), APPROVAL), /pass --catalog <path>/);
  const created = adoptReview(context(fresh), { ...APPROVAL, catalogPath: 'ux/use-cases.yml' });
  assert.equal(created.catalog.previousSha256, null);
  assert.equal(created.status, 'adopted');
  assert.equal(listFiles(fresh).includes('.uxguard.json'), false);
});
