import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ConfigError } from './yaml.mjs';
import {
  ReviewConflictError,
  adoptionCommand,
  evaluateReview,
  parseReviewDraft,
  refreshContext,
  saveReview,
} from './review-store.mjs';

export const LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

// startReviewServer serves the review app on the loopback interface only.
// Every API call needs the per-session token, a loopback Host header, and a
// same-origin request, which blocks other local sites and DNS rebinding.
export async function startReviewServer(context, { port = 0, token = randomBytes(32).toString('hex'), log = () => {} } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('--port must be an integer from 0 to 65535');
  }
  const assets = Object.fromEntries(
    Object.entries(ASSETS).map(([path, [file, type]]) => [
      path,
      { type, body: readFileSync(new URL(`./review-app/${file}`, import.meta.url)) },
    ]),
  );
  const expectedToken = Buffer.from(token, 'utf8');
  let origin = '';
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      if (error instanceof ReviewConflictError) send(response, 409, { error: error.message });
      else if (error instanceof ConfigError) send(response, 400, { error: error.message });
      else if (error instanceof RequestError) send(response, error.status, { error: error.message });
      else {
        log(`ux-guard review: internal error: ${error?.message ?? error}`);
        send(response, 500, { error: 'internal error; see the terminal running ux-guard review' });
      }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('close', () => resolveClosed());

  async function handle(request, response) {
    if (!allowedHosts.has(request.headers.host ?? '')) {
      throw new RequestError(403, 'requests must use the loopback review address');
    }
    const { pathname } = new URL(request.url ?? '/', origin);
    const asset = assets[pathname];
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, 'method not allowed');
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Content-Length': asset.body.length });
      response.end(request.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    if (!pathname.startsWith('/api/')) throw new RequestError(404, 'not found');
    authorize(request);
    if (pathname === '/api/state' && request.method === 'GET') {
      refreshContext(context);
      send(response, 200, payload(evaluateReview(context)));
      return;
    }
    if (request.method !== 'POST') throw new RequestError(405, 'method not allowed');
    if (pathname === '/api/evaluate') {
      const body = await readJson(request);
      refreshContext(context);
      send(response, 200, payload(evaluateReview(context, parseReviewDraft(context, body.review))));
      return;
    }
    if (pathname === '/api/save') {
      const body = await readJson(request);
      refreshContext(context);
      const saved = saveReview(context, body.review);
      send(response, 200, {
        ...payload(saved.state),
        saved: { revision: saved.revision, savedAt: new Date().toISOString(), path: context.reviewPath },
      });
      return;
    }
    if (pathname === '/api/close') {
      await readJson(request);
      send(response, 200, { closed: true });
      setImmediate(() => server.close());
      server.closeIdleConnections?.();
      return;
    }
    throw new RequestError(404, 'not found');
  }

  function authorize(request) {
    const supplied = Buffer.from(String(request.headers['x-ux-guard-token'] ?? ''), 'utf8');
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) {
      throw new RequestError(401, 'missing or invalid review session token');
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && !allowedOrigins.has(requestOrigin)) {
      throw new RequestError(403, 'cross-origin requests are not allowed');
    }
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new RequestError(403, 'cross-site requests are not allowed');
    }
  }

  function payload(state) {
    return {
      paths: {
        candidate: context.candidatePath,
        review: context.reviewPath,
        preview: context.previewPath,
        catalog: state.catalog.path,
      },
      review: context.review,
      saved: context.reviewSha256 !== null,
      configured: context.configured,
      adoptCommand: adoptionCommand(context, state),
      state,
    };
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new ConfigError('review server did not bind to the loopback interface');
  }
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  allowedHosts = new Set([`${LOOPBACK_HOST}:${address.port}`, `localhost:${address.port}`]);
  allowedOrigins = new Set([origin, `http://localhost:${address.port}`]);
  return {
    address: address.address,
    port: address.port,
    origin,
    url: `${origin}/#token=${token}`,
    token,
    closed,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

// readJson drains an oversized body before rejecting it so the client receives
// the 413 instead of a reset; a body far past the limit is cut off.
function readJson(request) {
  const type = String(request.headers['content-type'] ?? '');
  if (!/^application\/json(?:;|$)/i.test(type)) {
    request.resume();
    return Promise.reject(new RequestError(415, 'requests must be application/json'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (size > MAX_BODY_BYTES * 4) request.destroy();
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (tooLarge) {
        reject(new RequestError(413, 'request body is too large'));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch {
        reject(new RequestError(400, 'request body must be a JSON object'));
      }
    });
  });
}
