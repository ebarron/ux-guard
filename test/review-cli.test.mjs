import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../lib/cli.mjs';
import { REVIEW_AGENT_PROMPTS } from '../lib/review-command.mjs';
import { DEFAULT_REVIEW_PATHS, saveReview } from '../lib/review-store.mjs';
import { capture, tempRepo } from './helpers.mjs';
import { context, freshReview, listFiles, prepared, reviewRepo } from './review-helpers.mjs';

async function run(args) {
  const output = capture();
  const code = await main(args, output.io);
  return { code, out: output.out, err: output.err };
}

test('review without a candidate explains what is missing, offers the agent prompt, and writes nothing', async () => {
  const root = tempRepo({ 'src/nav.tsx': 'export const nav = [];\n' });
  const before = listFiles(root);
  const text = await run(['--root', root, 'review']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /No use-case candidate was found at ux-guard\/use-case-candidate\.json/);
  assert.match(text.out, /ux-guard does not guess these/);
  assert.ok(text.out.includes(REVIEW_AGENT_PROMPTS[0]));
  assert.match(text.out, /npx ux-guard review prepare/);
  assert.match(text.out, /Nothing was written\./);

  const json = await run(['--root', root, 'review', '--format', 'json']);
  assert.equal(json.code, 0, json.err);
  const document = JSON.parse(json.out);
  assert.equal(document.status, 'no-candidate');
  assert.equal(document.agentPrompt, REVIEW_AGENT_PROMPTS[0]);
  assert.equal(document.draft.present, false);
  assert.deepEqual(document.safety, { approved: false, policyChanged: false, filesWritten: [] });
  assert.deepEqual(listFiles(root), before);

  const drafted = reviewRepo();
  const pending = await run(['--root', drafted, 'review']);
  assert.match(pending.out, /A draft exists at ux-guard\/use-case-draft\.json/);
  assert.doesNotMatch(pending.out, /copy this prompt/);
});

test('an explicit candidate path that does not exist is an input error with guidance', async () => {
  const root = reviewRepo();
  const result = await run(['--root', root, 'review', '--candidate', 'ux-guard/missing.json']);
  assert.equal(result.code, 2);
  assert.match(result.err, /candidate .*does not exist/);
  assert.match(result.err, /run ux-guard review without --candidate/);
});

test('review --format json reports status without starting the app or writing files', async () => {
  const root = prepared(reviewRepo()).root;
  const before = listFiles(root);
  const result = await run(['--root', root, 'review', '--format', 'json']);
  assert.equal(result.code, 0, result.err);
  const document = JSON.parse(result.out);
  assert.equal(document.status, 'review-in-progress');
  assert.equal(document.review.saved, false);
  assert.ok(document.summary.unresolvedDecisions > 0);
  assert.equal(document.safety.policyChanged, false);
  assert.match(document.adoptCommand, /review adopt/);
  assert.deepEqual(listFiles(root), before);
});

test('prepare and adopt run end to end and leave configuration and baselines unchanged', async () => {
  const root = reviewRepo({ extra: { 'ux/patterns-baseline.json': { version: 1, findings: [] } } });
  const protectedFiles = ['.uxguard.json', 'ux/patterns-baseline.json'];
  const snapshot = () => protectedFiles.map((path) => readFileSync(join(root, path), 'utf8'));
  const before = snapshot();

  const prepare = await run(['--root', root, 'review', 'prepare']);
  assert.equal(prepare.code, 0, prepare.err);
  assert.match(prepare.out, /Stamped ux-guard\/use-case-candidate\.json/);
  assert.match(prepare.out, /Status: unapproved\. Nothing else was written\./);
  const again = await run(['--root', root, 'review', 'prepare']);
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists/);

  const ctx = context(root);
  saveReview(ctx, {
    ...freshReview(ctx),
    proposals: {
      'review-dashboard': { action: 'approve' },
      'archive-record': { action: 'reject' },
      'export-records': { action: 'approve' },
    },
    mappings: {
      'workflow:archive': { disposition: 'excluded', useCaseIds: [], rationale: 'Archive is being removed.' },
      'workflow:bulk-import': { disposition: 'excluded', useCaseIds: [], rationale: 'Not offered.' },
    },
  });
  const catalogBefore = readFileSync(join(root, 'ux/use-cases.yml'), 'utf8');
  const status = JSON.parse((await run(['--root', root, 'review', '--format', 'json'])).out);
  assert.equal(status.status, 'ready-for-owner-approval');

  const unapproved = await run(['--root', root, 'review', 'adopt']);
  assert.equal(unapproved.code, 2);
  assert.match(unapproved.err, /--reviewer/);
  assert.equal(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8'), catalogBefore);

  const approval = ['--reviewer', 'product-owner', '--reviewed-at', '2026-01-31T12:00:00Z', '--rationale', 'Reviewed.'];
  const noHash = await run(['--root', root, 'review', 'adopt', ...approval]);
  assert.equal(noHash.code, 2);
  assert.match(noHash.err, /--replace-catalog-sha256/);

  const adopted = await run([
    '--root',
    root,
    '--format',
    'json',
    'review',
    'adopt',
    ...approval,
    '--replace-catalog-sha256',
    status.catalog.activeSha256,
  ]);
  assert.equal(adopted.code, 0, adopted.err);
  const record = JSON.parse(adopted.out);
  assert.equal(record.kind, 'ux-guard-use-case-adoption');
  assert.deepEqual(record.unchanged, { configuration: true, baselines: true, targets: true, waivers: true, enforcement: true });
  assert.notEqual(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8'), catalogBefore);
  assert.match(readFileSync(join(root, 'ux/use-cases.yml'), 'utf8'), /id: review-dashboard/);
  assert.deepEqual(snapshot(), before);
});

test('review options are rejected outside review and incompatible options are rejected inside it', async () => {
  const root = reviewRepo();
  for (const [args, pattern] of [
    [['check', '--port', '0'], /--port is only valid with review/],
    [['check', '--no-open'], /--no-open is only valid with review/],
    [['report', '--review', 'x.json'], /--review is only valid with review/],
    [['review', '--base', 'HEAD'], /do not pass --base/],
    [['review', '--format', 'markdown'], /not valid with review/],
    [['review', 'adopt', '--port', '0'], /--port is not valid with review adopt/],
    [['review', 'prepare', '--catalog', 'x.yml'], /--catalog is not valid with review prepare/],
    [['review', '--catalog', 'x.yml'], /--catalog is not valid with review/],
    [['review', 'prepare', '--reviewer', 'someone'], /approval options are only valid with review adopt/],
    [['review', '--format', 'json', '--no-open'], /--no-open is not valid with review --format json/],
    [['review', 'publish'], /unknown review command publish/],
    [['review', '--port', '70000'], /--port/],
  ]) {
    const result = await run(['--root', root, ...args]);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.out}`);
    assert.match(result.err, pattern, args.join(' '));
  }
  assert.deepEqual(
    listFiles(root).filter((path) => path.startsWith('ux-guard/') && path !== DEFAULT_REVIEW_PATHS.draft),
    [],
  );
});

test('review help and documentation describe the unapproved workflow with the exact agent prompts', async () => {
  const prose = (path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
      .replace(/^> ?/gm, '')
      .replace(/\s+/g, ' ');
  for (const path of ['README.md', 'docs/use-case-review.md']) {
    const text = prose(path);
    for (const prompt of REVIEW_AGENT_PROMPTS) assert.ok(text.includes(prompt), `${path} is missing: ${prompt}`);
  }
  const result = await run(['review', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /usage: ux-guard review \[prepare\|adopt\]/);
  assert.match(result.out, /bound to 127\.0\.0\.1/);
  assert.match(result.out, /never changes active policy, baselines,\s+targets, waivers, or enforcement/);
  const general = await run(['--help']);
  assert.match(general.out, /review\s+review proposed use cases in a local app/);
});
