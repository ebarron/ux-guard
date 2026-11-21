import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../lib/cli.mjs';
import { DEFAULT_REVIEW_PATHS } from '../lib/review-store.mjs';
import { startReviewServer } from '../lib/review-server.mjs';
import { capture } from './helpers.mjs';
import { listFiles, prepared, reviewRepo } from './review-helpers.mjs';

function call(server, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path,
        headers: { host: `127.0.0.1:${server.port}`, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Static assets are not JSON.
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    outgoing.on('error', reject);
    if (body !== undefined) outgoing.write(typeof body === 'string' ? body : JSON.stringify(body));
    outgoing.end();
  });
}

function api(server, path, body) {
  return call(server, {
    method: body === undefined ? 'GET' : 'POST',
    path,
    headers: {
      'x-ux-guard-token': server.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body,
  });
}

async function started() {
  const ctx = prepared(reviewRepo());
  const server = await startReviewServer(ctx);
  return { ctx, server };
}

test('the review server binds only to loopback and serves self-contained assets with strict headers', async (t) => {
  const { server } = await started();
  t.after(() => server.close());
  assert.equal(server.address, '127.0.0.1');
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}$/);

  for (const [path, type] of [
    ['/', /text\/html/],
    ['/app.js', /text\/javascript/],
    ['/app.css', /text\/css/],
  ]) {
    const response = await call(server, { path });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], type);
    assert.match(response.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.text, /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i);
  }

  // A VPN or proxy may accept any TCP connection on a non-loopback address, so
  // the check is that the review app itself never answers there.
  const external = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map(({ address }) => address);
  for (const address of external.slice(0, 3)) {
    const answer = await new Promise((resolve) => {
      const outgoing = request({ host: address, port: server.port, path: '/', timeout: 2000 }, (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => resolve(text));
        response.on('error', () => resolve(''));
      });
      outgoing.on('timeout', () => {
        outgoing.destroy();
        resolve('');
      });
      outgoing.on('error', () => resolve(''));
      outgoing.end();
    });
    assert.doesNotMatch(answer, /ux-guard use-case review/, `review app answered on ${address}`);
  }
});

test('the review API requires the session token and a loopback Host header', async (t) => {
  const { server } = await started();
  t.after(() => server.close());
  assert.equal((await call(server, { path: '/api/state' })).status, 401);
  assert.equal(
    (await call(server, { path: '/api/state', headers: { 'x-ux-guard-token': 'f'.repeat(64) } })).status,
    401,
  );
  const rebound = await call(server, {
    path: '/api/state',
    headers: { host: `attacker.invalid:${server.port}`, 'x-ux-guard-token': server.token },
  });
  assert.equal(rebound.status, 403);
  assert.match(rebound.json.error, /loopback review address/);
  assert.equal((await call(server, { path: '/', headers: { host: 'attacker.invalid' } })).status, 403);

  const state = await api(server, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.state.approval.status, 'unapproved');
  assert.equal(state.json.paths.review, DEFAULT_REVIEW_PATHS.review);
  assert.match(state.json.adoptCommand, /^npx ux-guard review adopt .*--reviewer "<owner>"/);
  const local = await call(server, {
    path: '/api/state',
    headers: { host: `localhost:${server.port}`, 'x-ux-guard-token': server.token },
  });
  assert.equal(local.status, 200);
});

test('the review API rejects cross-origin, cross-site, non-JSON, and oversized requests', async (t) => {
  const { ctx, server } = await started();
  t.after(() => server.close());
  const review = ctx.review;
  const post = (headers, body = { review }) =>
    call(server, {
      method: 'POST',
      path: '/api/evaluate',
      headers: { 'x-ux-guard-token': server.token, 'content-type': 'application/json', ...headers },
      body,
    });
  assert.equal((await post({ origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({}, `{"review":"${'x'.repeat(5 * 1024 * 1024)}"}`)).status, 413);
  assert.equal((await post({}, '{not json')).status, 400);
  assert.equal((await post({ origin: server.origin, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await call(server, { method: 'DELETE', path: '/api/state', headers: { 'x-ux-guard-token': server.token } })).status, 405);
  assert.equal((await call(server, { path: '/../.uxguard.json' })).status, 404);
  const invalid = await post({}, { review: { ...review, approval: { status: 'approved', activatesCatalog: true } } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /must be unapproved/);
});

test('the review API preserves undecided drafts and rejects stale incomplete approval choices', async (t) => {
  const { ctx, server } = await started();
  t.after(() => server.close());
  const draft = {
    ...ctx.review,
    proposals: {
      'archive-record': {
        action: 'pending',
        fields: {
          goal: 'Remove an old record from active work.',
          success: 'The record is archived.',
        },
      },
    },
  };
  const evaluated = await api(server, '/api/evaluate', { review: draft });
  assert.equal(evaluated.status, 200);
  const archive = evaluated.json.state.useCases.find(({ id }) => id === 'archive-record');
  assert.equal(archive.action, 'pending');
  assert.equal(archive.draftCompleteness.complete, true);
  assert.deepEqual(archive.changedFields, ['goal', 'success']);

  const invalidOriginal = await api(server, '/api/evaluate', {
    review: { ...ctx.review, proposals: { 'archive-record': { action: 'approve' } } },
  });
  assert.equal(invalidOriginal.status, 400);
  assert.match(invalidOriginal.json.error, /cannot be approved as proposed until Goal, Success outcome/);

  const invalidRevision = await api(server, '/api/save', {
    review: {
      ...ctx.review,
      proposals: { 'archive-record': { action: 'revise', fields: { goal: 'Archive it.' } } },
    },
  });
  assert.equal(invalidRevision.status, 400);
  assert.match(invalidRevision.json.error, /cannot approve the revised proposal until Success outcome/);
  assert.equal(ctx.reviewSha256, null);
});

test('evaluate never writes files and save writes only the review and its preview', async (t) => {
  const { ctx, server } = await started();
  t.after(() => server.close());
  const before = listFiles(ctx.root);
  const decisions = { ...ctx.review, proposals: { 'review-dashboard': { action: 'approve' } } };
  const evaluated = await api(server, '/api/evaluate', { review: decisions });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.json.state.summary.proposals.approve, 1);
  assert.equal(evaluated.json.saved, false);
  assert.deepEqual(listFiles(ctx.root), before);

  const saved = await api(server, '/api/save', { review: decisions });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved.revision, 1);
  assert.match(saved.json.saved.savedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(saved.json.saved.path, DEFAULT_REVIEW_PATHS.review);
  assert.deepEqual(
    listFiles(ctx.root).filter((path) => !before.includes(path)),
    [DEFAULT_REVIEW_PATHS.preview, DEFAULT_REVIEW_PATHS.review],
  );
  assert.equal(JSON.parse(readFileSync(join(ctx.root, DEFAULT_REVIEW_PATHS.review), 'utf8')).approval.status, 'unapproved');
  const replay = await api(server, '/api/save', { review: decisions });
  assert.equal(replay.status, 409);
  assert.match(replay.json.error, /reload before saving/);
});

test('closing from the app stops the server and the review command exits cleanly', async () => {
  const root = prepared(reviewRepo()).root;
  const output = capture();
  const running = main(['--root', root, 'review', '--no-open'], output.io);
  let url = null;
  for (let attempt = 0; attempt < 200 && !url; attempt += 1) {
    url = /Open (http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+)/.exec(output.out)?.[1] ?? null;
    if (!url) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(url, output.out + output.err);
  assert.match(output.out, /Bound to 127\.0\.0\.1 only/);
  assert.match(output.out, /Nothing is approved,\s+adopted, checked in, or enforced from the app/);
  const { port } = new URL(url);
  const token = url.split('#token=')[1];
  const closed = await call({ port: Number(port), token }, {
    method: 'POST',
    path: '/api/close',
    headers: { 'x-ux-guard-token': token, 'content-type': 'application/json' },
    body: {},
  });
  assert.equal(closed.status, 200);
  assert.equal(await running, 0);
  assert.match(output.out, /closed\. Saved decisions remain unapproved/);
});
