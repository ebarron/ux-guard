import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CATALOG, NAV, config, tempRepo } from './helpers.mjs';
import { emptyReview } from '../lib/review.mjs';
import {
  DEFAULT_REVIEW_PATHS,
  loadReviewContext,
  prepareCandidate,
} from '../lib/review-store.mjs';

export const RECORDS = `export function Records() {
  return <main><h1>Records</h1></main>;
}
`;

export const DEBUG = `export function Debug() {
  return <pre>debug</pre>;
}
`;

export function draft(overrides = {}) {
  return {
    kind: 'ux-guard-use-case-draft',
    version: 1,
    approval: { status: 'unapproved', activatesCatalog: false },
    source: { catalog: 'ux/use-cases.yml', navigation: ['src/nav.tsx'] },
    outcomes: [
      { id: 'monitor-activity', title: 'Monitor activity' },
      { id: 'manage-records', title: 'Manage records', summary: 'Keep the record list accurate.' },
    ],
    proposals: [
      {
        id: 'review-dashboard',
        outcome: 'monitor-activity',
        title: 'Review the dashboard',
        persona: 'Operator',
        tier: 'secondary',
        effect: 'read',
        owner: 'product-owner',
        goal: 'See current activity at a glance.',
        success: 'The activity summary is visible.',
        rationale: 'The dashboard is a top-level destination with no use case.',
        capability: 'present',
      },
      {
        id: 'archive-record',
        outcome: 'manage-records',
        title: 'Archive a record',
        persona: 'Operator',
        tier: 'tertiary',
        effect: 'change',
        rationale: 'Archive is offered from the record list.',
      },
      {
        id: 'export-records',
        outcome: 'manage-records',
        title: 'Export records',
        persona: 'Analyst',
        tier: 'tertiary',
        effect: 'read',
        owner: 'product-owner',
        goal: 'Export the record list.',
        success: 'A file with the visible records downloads.',
        starts: [{ nav_id: 'records', route: '/records/export' }],
      },
    ],
    surfaces: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        route: '/dashboard',
        sources: ['src/nav.tsx'],
        classification: {
          disposition: 'proposed-use-case',
          useCaseIds: ['review-dashboard'],
          rationale: 'Top-level destination.',
        },
      },
      {
        id: 'records',
        label: 'Records',
        route: '/records',
        sources: ['src/nav.tsx'],
        classification: {
          disposition: 'existing-use-case',
          useCaseIds: ['create-record'],
          rationale: 'Already catalogued.',
        },
      },
    ],
    workflows: [
      {
        id: 'archive',
        title: 'Archive from the list',
        entry: '/records',
        sources: ['src/Records.tsx'],
        capability: 'present',
        classification: { disposition: 'proposed-use-case', useCaseIds: ['archive-record'] },
      },
      {
        id: 'debug-panel',
        title: 'Developer debug panel',
        sources: ['src/Debug.tsx'],
        capability: 'not-applicable',
        classification: { disposition: 'excluded', useCaseIds: [], rationale: 'Developer-only diagnostics.' },
      },
      {
        id: 'bulk-import',
        title: 'Bulk import',
        sources: ['src/Records.tsx'],
        capability: 'absent',
        classification: { disposition: 'unresolved', useCaseIds: [], rationale: 'Ownership is unclear.' },
      },
    ],
    questions: [{ id: 'export-scope', question: 'Is export in scope for this release?', impact: 'Changes the tertiary tier list.' }],
    ...overrides,
  };
}

export function reviewRepo({ withConfig = true, catalog = CATALOG, nav = NAV, git = false, draftValue = draft(), extra = {} } = {}) {
  const files = {
    'src/nav.tsx': nav,
    'src/Records.tsx': RECORDS,
    'src/Debug.tsx': DEBUG,
    [DEFAULT_REVIEW_PATHS.draft]: draftValue,
    ...extra,
  };
  if (withConfig) files['.uxguard.json'] = config();
  if (catalog !== null) files['ux/use-cases.yml'] = catalog;
  const root = tempRepo(files);
  if (git) commitAll(root, 'initial');
  return root;
}

export function commitAll(root, message) {
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=ux-guard-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, stdio: 'pipe' },
    );
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'pipe' });
    if (!statSync(join(root, '.git')).isDirectory()) throw new Error('nested');
  } catch {
    git('init', '-q', '-b', 'main');
  }
  git('add', '-A');
  git('commit', '-q', '-m', message, '--allow-empty');
}

export function prepared(root) {
  prepareCandidate(root, { draftPath: DEFAULT_REVIEW_PATHS.draft, candidatePath: DEFAULT_REVIEW_PATHS.candidate });
  return context(root);
}

export function context(root, paths = {}) {
  return loadReviewContext(root, {
    candidatePath: DEFAULT_REVIEW_PATHS.candidate,
    reviewPath: DEFAULT_REVIEW_PATHS.review,
    previewPath: DEFAULT_REVIEW_PATHS.preview,
    explicitCandidate: true,
    ...paths,
  });
}

export function freshReview(ctx) {
  return emptyReview(ctx.candidatePath, ctx.candidateSha256);
}

// listFiles returns every repository file except Git internals.
export function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}
