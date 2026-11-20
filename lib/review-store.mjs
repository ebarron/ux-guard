import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { navSurfaces } from './catalog.mjs';
import {
  CONFIG_FILE,
  assertRepositoryRelativePath,
  ensureLocalDirectory,
  loadConfig,
  loadTypeScript,
  resolveExistingRepositoryPath,
  resolveRepositoryPath,
} from './config.mjs';
import {
  PREVIEW_MARKER,
  ReviewError,
  candidateInputPaths,
  computeReview,
  emptyReview,
  parseUseCaseCandidate,
  previewText,
  reviewSubjects,
  serializeReview,
  stampCandidate,
  validateUseCaseReview,
} from './review.mjs';
import { sha256 } from './run-contract.mjs';

export const DEFAULT_REVIEW_PATHS = Object.freeze({
  draft: 'ux-guard/use-case-draft.json',
  candidate: 'ux-guard/use-case-candidate.json',
  review: 'ux-guard/use-case-review.json',
  preview: 'ux-guard/use-case-catalog.preview.yml',
});

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export class ReviewConflictError extends ReviewError {
  constructor(message) {
    super(message);
    this.name = 'ReviewConflictError';
  }
}

export function repositoryIdentity(root) {
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const rootCommits = git(['rev-list', '--max-parents=0', 'HEAD']).split(/\s+/).filter(Boolean).sort();
    return { commit, rootCommits };
  } catch {
    return { commit: null, rootCommits: [] };
  }
}

export function hashInputs(root, paths) {
  return [...new Set(paths)].sort().map((path) => {
    const file = readRepositoryFile(root, path, `assessed input ${path}`);
    if (!file) throw new ReviewError(`assessed input ${path} does not exist`);
    return { path, sha256: file.sha256 };
  });
}

// candidateIdentity compares a stamped candidate with the current checkout.
// Changed or missing inputs make the candidate stale; a moved HEAD alone does
// not, because the assessed files are unchanged.
export function candidateIdentity(root, candidate) {
  const current = repositoryIdentity(root);
  const reasons = [];
  const recorded = candidate.source.repository.rootCommits;
  if (recorded.length && current.rootCommits.length && !recorded.some((id) => current.rootCommits.includes(id))) {
    reasons.push('it was assessed in a different repository.');
  }
  if (recorded.length && current.rootCommits.length === 0) {
    reasons.push('the repository identity it recorded cannot be verified here.');
  }
  for (const input of candidate.source.inputs) {
    let file;
    try {
      file = readRepositoryFile(root, input.path, `assessed input ${input.path}`);
    } catch (error) {
      reasons.push(`${input.path} cannot be read safely (${error.message}).`);
      continue;
    }
    if (!file) reasons.push(`${input.path} no longer exists.`);
    else if (file.sha256 !== input.sha256) reasons.push(`${input.path} changed after the assessment.`);
  }
  let status = 'current';
  if (reasons.length) status = 'stale';
  else if (!recorded.length && !current.rootCommits.length) status = 'unverified';
  else if (candidate.source.commit !== current.commit) status = 'moved';
  return {
    status,
    reasons,
    candidateCommit: candidate.source.commit,
    currentCommit: current.commit,
    inputs: candidate.source.inputs.length,
  };
}

// readRepositoryFile returns null for a missing file and rejects anything that
// is not a regular repository file reached through real directories.
export function readRepositoryFile(root, path, label) {
  const full = resolveRepositoryPath(root, path, label);
  if (!existsSync(full)) {
    try {
      lstatSync(full);
    } catch {
      return null;
    }
  }
  ensureLocalDirectory(root, dirname(full), label, false);
  const stats = lstatSync(full);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ReviewError(`${label} must be a regular repository file, not a symbolic link`);
  }
  if (stats.size > MAX_ARTIFACT_BYTES) throw new ReviewError(`${label} is larger than 16 MiB`);
  resolveExistingRepositoryPath(root, path, label);
  const bytes = readFileSync(full);
  return { text: bytes.toString('utf8'), sha256: sha256(bytes.toString('utf8')) };
}

// writeNewFile never replaces an existing path: the content is written to a
// private temporary file and then hard-linked into place, which fails if the
// destination appeared in the meantime.
export function writeNewFile(root, path, text, label) {
  const full = resolveRepositoryPath(root, path, `${label} path`);
  ensureLocalDirectory(root, dirname(full), `${label} path`, true);
  const temporary = temporaryPath(full);
  writeFileSync(temporary, text, { flag: 'wx' });
  try {
    try {
      linkSync(temporary, full);
    } catch (error) {
      if (error?.code === 'EEXIST') throw error;
      copyFileSync(temporary, full, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ReviewConflictError(`${path} already exists; refusing to overwrite it`);
    throw new ReviewError(`${label} ${path} could not be written`);
  } finally {
    safeUnlink(temporary);
  }
}

// replaceFile swaps in new content only when the current file still has the
// content the caller last read.
export function replaceFile(root, path, text, expectedSha256, label) {
  const full = resolveRepositoryPath(root, path, `${label} path`);
  const current = readRepositoryFile(root, path, label);
  if (!current) throw new ReviewConflictError(`${path} was removed after it was loaded; nothing was written`);
  if (current.sha256 !== expectedSha256) {
    throw new ReviewConflictError(`${path} changed after it was loaded; reload before saving so no edits are lost`);
  }
  const temporary = temporaryPath(full);
  writeFileSync(temporary, text, { flag: 'wx' });
  try {
    const latest = readRepositoryFile(root, path, label);
    if (latest?.sha256 !== expectedSha256) {
      throw new ReviewConflictError(`${path} changed while saving; nothing was written`);
    }
    renameSync(temporary, full);
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError(`${label} ${path} could not be written`);
  } finally {
    safeUnlink(temporary);
  }
}

function temporaryPath(full) {
  return join(dirname(full), `.${basename(full)}.${randomBytes(6).toString('hex')}.tmp`);
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already renamed or never created.
  }
}

export function prepareCandidate(root, { draftPath, candidatePath }) {
  assertRepositoryRelativePath(draftPath, 'draft path');
  assertRepositoryRelativePath(candidatePath, 'candidate path');
  if (draftPath === candidatePath) throw new ReviewError('draft and candidate paths must differ');
  if (candidatePath === CONFIG_FILE) throw new ReviewError(`candidate path cannot be ${CONFIG_FILE}`);
  const draftFile = readRepositoryFile(root, draftPath, 'draft');
  if (!draftFile) throw new ReviewError(`draft ${draftPath} does not exist`);
  const draft = parseUseCaseCandidate(draftFile.text, { draft: true });
  const protectedPaths = policyPaths(root, draft.source.catalog);
  if (protectedPaths.has(candidatePath)) {
    throw new ReviewError(`candidate path ${candidatePath} is an active policy path`);
  }
  const identity = repositoryIdentity(root);
  const inputs = hashInputs(root, candidateInputPaths({ ...draft, source: { ...draft.source } }));
  const candidate = stampCandidate(draft, { ...identity, inputs });
  writeNewFile(root, candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'candidate');
  const subjects = reviewSubjects(candidate, discoverSurfaces(root, navigationFiles(root, candidate)));
  return {
    candidate,
    inputs: inputs.length,
    notAssessed: subjects.filter(({ origin }) => origin === 'discovered').map(({ id, route }) => ({ id, route })),
  };
}

// policyPaths lists files the review must never write: active configuration
// and every policy or evidence path it names.
function policyPaths(root, candidateCatalog) {
  const paths = new Set([CONFIG_FILE, candidateCatalog]);
  const config = activeConfig(root);
  if (!config) return paths;
  paths.add(config.catalog.path);
  for (const path of config.catalog.navigation) paths.add(path);
  paths.add(config.patterns.baseline);
  for (const value of Object.values(config.journeys ?? {})) paths.add(value);
  for (const value of Object.values(config.visuals ?? {})) paths.add(value);
  return paths;
}

function activeConfig(root) {
  return existsSync(join(root, CONFIG_FILE)) ? loadConfig(root, null) : null;
}

function navigationFiles(root, candidate) {
  return activeConfig(root)?.catalog.navigation ?? candidate.source.navigation;
}

function discoverSurfaces(root, files) {
  let ts;
  try {
    ts = loadTypeScript();
  } catch {
    return [];
  }
  const surfaces = [];
  for (const file of files) {
    const source = readRepositoryFile(root, file, `navigation source ${file}`);
    if (source) surfaces.push(...navSurfaces(ts, file, source.text));
  }
  return surfaces;
}

// loadReviewContext gathers everything the review needs from distinct paths.
// It returns { status: 'no-candidate' } only for the implicit default path.
export function loadReviewContext(root, { candidatePath, reviewPath, previewPath, explicitCandidate = false }) {
  for (const [label, path] of [
    ['candidate path', candidatePath],
    ['review path', reviewPath],
    ['preview path', previewPath],
  ]) {
    assertRepositoryRelativePath(path, label);
  }
  if (new Set([candidatePath, reviewPath, previewPath]).size !== 3) {
    throw new ReviewError('candidate, review, and preview paths must all be different');
  }
  const candidateFile = readRepositoryFile(root, candidatePath, 'candidate');
  if (!candidateFile) {
    if (explicitCandidate) throw new ReviewError(`candidate ${candidatePath} does not exist`);
    const draftFile = readRepositoryFile(root, DEFAULT_REVIEW_PATHS.draft, 'draft');
    return { status: 'no-candidate', candidatePath, draftPresent: Boolean(draftFile) };
  }
  const candidate = parseUseCaseCandidate(candidateFile.text);
  const config = activeConfig(root);
  const protectedPaths = policyPaths(root, candidate.source.catalog);
  for (const [label, path] of [
    ['candidate', candidatePath],
    ['review', reviewPath],
    ['preview', previewPath],
  ]) {
    if (protectedPaths.has(path)) throw new ReviewError(`${label} path ${path} is an active policy path`);
  }
  const activeCatalog = readActiveCatalog(root, config, candidate);
  const discoveredSurfaces = discoverSurfaces(root, navigationFiles(root, candidate));
  const subjects = reviewSubjects(candidate, discoveredSurfaces);
  const scope = {
    proposalIds: candidate.proposals.map(({ id }) => id),
    subjectKeys: subjects.map(({ key }) => key),
  };
  const reviewFile = readRepositoryFile(root, reviewPath, 'review');
  let review;
  if (reviewFile) {
    let value;
    try {
      value = JSON.parse(reviewFile.text);
    } catch {
      throw new ReviewError(`review ${reviewPath} is not valid JSON`);
    }
    review = validateUseCaseReview(value, scope);
    if (review.candidate.path !== candidatePath || review.candidate.sha256 !== candidateFile.sha256) {
      throw new ReviewError(
        `review ${reviewPath} was recorded against a different candidate; open it with its original candidate or choose a new --review path`,
      );
    }
  } else {
    review = emptyReview(candidatePath, candidateFile.sha256);
  }
  return {
    status: 'ready',
    root,
    candidatePath,
    reviewPath,
    previewPath,
    candidate,
    candidateSha256: candidateFile.sha256,
    review,
    reviewSha256: reviewFile?.sha256 ?? null,
    scope,
    activeCatalog,
    discoveredSurfaces,
    identity: candidateIdentity(root, candidate),
    configured: Boolean(config),
  };
}

function readActiveCatalog(root, config, candidate) {
  if (config) {
    const file = readRepositoryFile(root, config.catalog.path, `catalog ${config.catalog.path}`);
    return {
      path: config.catalog.path,
      origin: 'config',
      text: file?.text ?? null,
      mismatch:
        candidate.source.catalog === config.catalog.path
          ? null
          : `The candidate names ${candidate.source.catalog}, but active policy uses ${config.catalog.path}; the review uses active policy.`,
    };
  }
  const file = readRepositoryFile(root, candidate.source.catalog, `catalog ${candidate.source.catalog}`);
  return { path: candidate.source.catalog, origin: 'candidate', text: file?.text ?? null, mismatch: null };
}

// refreshContext re-reads the inputs that can change while the app is open so
// staleness and the catalog diff never reflect an earlier checkout.
export function refreshContext(context) {
  context.identity = candidateIdentity(context.root, context.candidate);
  context.activeCatalog = readActiveCatalog(
    context.root,
    context.configured ? loadConfig(context.root, null) : null,
    context.candidate,
  );
  return context;
}

export function evaluateReview(context, review = context.review) {
  return computeReview({
    candidate: context.candidate,
    review,
    activeCatalog: context.activeCatalog,
    discoveredSurfaces: context.discoveredSurfaces,
    identity: context.identity,
  });
}

export function parseReviewDraft(context, value) {
  const review = validateUseCaseReview(value, context.scope);
  if (review.candidate.path !== context.candidatePath || review.candidate.sha256 !== context.candidateSha256) {
    throw new ReviewError('review decisions belong to a different candidate');
  }
  return review;
}

// saveReview writes only the review artifact and its generated preview. The
// expected hash guards against overwriting a concurrent edit.
export function saveReview(context, value) {
  const review = parseReviewDraft(context, value);
  if (review.revision !== context.review.revision) {
    throw new ReviewConflictError(
      `review revision ${review.revision} is not the loaded revision ${context.review.revision}; reload before saving`,
    );
  }
  const next = { ...review, revision: review.revision + 1 };
  const state = evaluateReview(context, next);
  const text = serializeReview(next);
  if (context.reviewSha256 === null) writeNewFile(context.root, context.reviewPath, text, 'review');
  else replaceFile(context.root, context.reviewPath, text, context.reviewSha256, 'review');
  context.review = next;
  context.reviewSha256 = sha256(text);
  const preview =
    previewText(state) ??
    `${PREVIEW_MARKER}\n# No use cases can be generated yet; resolve the blocking review items.\n`;
  const existing = readRepositoryFile(context.root, context.previewPath, 'preview');
  if (!existing) writeNewFile(context.root, context.previewPath, preview, 'preview');
  else if (!existing.text.startsWith(`${PREVIEW_MARKER}\n`)) {
    throw new ReviewConflictError(
      `${context.previewPath} is not a generated ux-guard preview; the review was saved but the preview was not written`,
    );
  } else if (existing.text !== preview) {
    replaceFile(context.root, context.previewPath, preview, existing.sha256, 'preview');
  }
  return { state, revision: next.revision, reviewSha256: context.reviewSha256 };
}

// adoptionCommand is shown to the owner, never run by the app.
export function adoptionCommand(context, state) {
  const quote = (value) => (/^[A-Za-z0-9_./@-]+$/.test(value) ? value : `"${value}"`);
  const parts = ['npx ux-guard review adopt'];
  for (const [option, value, fallback] of [
    ['--candidate', context.candidatePath, DEFAULT_REVIEW_PATHS.candidate],
    ['--review', context.reviewPath, DEFAULT_REVIEW_PATHS.review],
    ['--preview', context.previewPath, DEFAULT_REVIEW_PATHS.preview],
  ]) {
    if (value !== fallback) parts.push(`${option} ${quote(value)}`);
  }
  if (!context.configured) parts.push(`--catalog ${quote(state.catalog.path)}`);
  if (state.catalog.exists) parts.push(`--replace-catalog-sha256 ${state.catalog.activeSha256}`);
  parts.push('--reviewer "<owner>"', '--reviewed-at "<UTC time>"', '--rationale "<why the owner approves>"');
  return parts.join(' ');
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// adoptReview is the only path that writes the active catalog. It requires a
// saved, current, conflict-free review whose saved preview matches exactly.
export function adoptReview(context, { reviewer, reviewedAt, rationale, catalogPath, replaceSha256 }) {
  for (const [name, value] of [
    ['--reviewer', reviewer],
    ['--reviewed-at', reviewedAt],
    ['--rationale', rationale],
  ]) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
      throw new ReviewError(`review adopt requires a single-line ${name}`);
    }
  }
  if (!UTC.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) {
    throw new ReviewError('--reviewed-at must be a UTC timestamp like 2026-01-31T12:00:00Z');
  }
  if (context.reviewSha256 === null) {
    throw new ReviewError(`review ${context.reviewPath} has not been saved; save the review before adoption`);
  }
  if (context.identity.status === 'stale') {
    throw new ReviewError(`candidate is stale: ${context.identity.reasons.join(' ')} Prepare a fresh candidate and review it.`);
  }
  const state = evaluateReview(context);
  if (state.summary.blockingIssues > 0) {
    const first = state.issues.find(({ severity }) => severity === 'error');
    throw new ReviewError(
      `review has ${state.summary.blockingIssues} blocking issue(s); resolve them before adoption. First: ${first.message}`,
    );
  }
  const expectedPreview = previewText(state);
  const preview = readRepositoryFile(context.root, context.previewPath, 'preview');
  if (!preview || preview.text !== expectedPreview) {
    throw new ReviewError(
      `${context.previewPath} does not match the saved review; reopen the review, check the diff, and save again`,
    );
  }
  let target;
  if (context.configured) {
    target = context.activeCatalog.path;
    if (catalogPath && catalogPath !== target) {
      throw new ReviewError(`--catalog ${catalogPath} differs from active policy catalog ${target}`);
    }
  } else {
    if (!catalogPath) {
      throw new ReviewError(
        `no active ux-guard policy names a catalog; pass --catalog <path> to choose where the owner-approved catalog is written`,
      );
    }
    target = assertRepositoryRelativePath(catalogPath, '--catalog');
  }
  if ([CONFIG_FILE, context.candidatePath, context.reviewPath, context.previewPath].includes(target)) {
    throw new ReviewError(`--catalog cannot be ${target}`);
  }
  const current = readRepositoryFile(context.root, target, `catalog ${target}`);
  if (current) {
    if (!replaceSha256) {
      throw new ReviewError(
        `${target} exists; pass --replace-catalog-sha256 ${current.sha256} to confirm replacing exactly this file`,
      );
    }
    replaceFile(context.root, target, state.catalog.text, replaceSha256, 'catalog');
  } else {
    if (replaceSha256) throw new ReviewError(`${target} does not exist; omit --replace-catalog-sha256`);
    writeNewFile(context.root, target, state.catalog.text, 'catalog');
  }
  return {
    kind: 'ux-guard-use-case-adoption',
    version: 1,
    status: state.summary.unresolvedDecisions ? 'adopted-with-unresolved-items' : 'adopted',
    catalog: {
      path: target,
      previousSha256: current?.sha256 ?? null,
      sha256: sha256(state.catalog.text),
      inventory: state.catalog.inventory,
      useCases: state.catalog.entries,
    },
    approval: { reviewer, reviewedAt, rationale },
    review: { path: context.reviewPath, sha256: context.reviewSha256, revision: context.review.revision },
    candidate: { path: context.candidatePath, sha256: context.candidateSha256, identity: context.identity.status },
    unresolved: state.unresolved,
    unchanged: {
      configuration: true,
      baselines: true,
      targets: true,
      waivers: true,
      enforcement: true,
    },
    nextAction:
      'Review the catalog change, then decide separately whether to check it in and whether to change enforcement.',
  };
}
