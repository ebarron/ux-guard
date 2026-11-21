import { spawn } from 'node:child_process';
import { ConfigError } from './yaml.mjs';
import {
  DEFAULT_REVIEW_PATHS,
  adoptReview,
  adoptionCommand,
  evaluateReview,
  loadReviewContext,
  prepareCandidate,
} from './review-store.mjs';
import { LOOPBACK_HOST, startReviewServer } from './review-server.mjs';

export const REVIEW_AGENT_PROMPTS = Object.freeze([
  'Help me discover and review the important use cases in this repository. Open ux-guard’s local review experience, explain the proposals in plain language, and do not activate policy without my explicit approval.',
  'Continue my ux-guard use-case review.',
  'Open the ux-guard review app for this repository.',
  'Help me resolve the remaining unmapped workflows and exclusions. Do not approve or activate anything.',
]);

export const REVIEW_HELP = `usage: ux-guard review [prepare|adopt] [options]

Review proposed use cases in a local app bound to ${LOOPBACK_HOST}. Saving
records an unapproved review; it never changes active policy, baselines,
targets, waivers, or enforcement.

commands:
  review                open the local review app (default)
  review --format json  report review status without starting the app
  review prepare        validate an assessment draft and stamp it with
                        repository identity as an unapproved candidate
  review adopt          write the owner-approved catalog; requires a saved,
                        current, conflict-free review and approval details

options:
  --root <dir>          repository root (default: current directory)
  --candidate <path>    candidate (default: ${DEFAULT_REVIEW_PATHS.candidate})
  --review <path>       review decisions (default: ${DEFAULT_REVIEW_PATHS.review})
  --preview <path>      generated preview (default: ${DEFAULT_REVIEW_PATHS.preview})
  --draft <path>        prepare input (default: ${DEFAULT_REVIEW_PATHS.draft})
  --port <number>       loopback port (default: any free port)
  --no-open             print the address instead of opening a browser
  --format text|json    human-readable or machine-readable output

adopt options:
  --reviewer <id> --reviewed-at <UTC> --rationale <text>
                        required record of the owner's explicit approval
  --catalog <path>      catalog path when no active policy names one
  --replace-catalog-sha256 <hash>
                        confirm replacing exactly the current catalog
`;

// reviewCommand returns a promise because the default command keeps the local
// server running until the owner closes the review.
export async function reviewCommand(options, io, { openBrowser = openInBrowser, signals = process } = {}) {
  const [, sub, extra] = options.positional;
  if (extra) throw new ConfigError(`unexpected argument ${extra}`);
  if (options.base) throw new ConfigError('review uses the working tree; do not pass --base');
  if (options.format === 'markdown') throw new ConfigError('--format markdown is not valid with review; use text or json');
  if (
    options.strict ||
    options.acceptGrowth ||
    options.baseline ||
    options.typescript ||
    options.shards ||
    options.visuals ||
    options.candidateSha
  ) {
    throw new ConfigError('review accepts only review options; run ux-guard review --help');
  }
  const paths = {
    candidatePath: options.candidate ?? DEFAULT_REVIEW_PATHS.candidate,
    reviewPath: options.review ?? DEFAULT_REVIEW_PATHS.review,
    previewPath: options.preview ?? DEFAULT_REVIEW_PATHS.preview,
    explicitCandidate: options.candidate !== null,
  };
  const approvals = [options.reviewer, options.reviewedAt, options.rationale];
  if (sub === 'prepare') {
    rejectOptions(options, ['review', 'preview', 'catalog', 'replaceCatalogSha256', 'port', 'noOpen'], 'review prepare');
    if (approvals.some(Boolean)) throw new ConfigError('approval options are only valid with review adopt');
    return prepare(options, paths, io);
  }
  if (sub === 'adopt') {
    rejectOptions(options, ['draft', 'port', 'noOpen'], 'review adopt');
    return adopt(options, paths, io);
  }
  if (sub !== undefined) throw new ConfigError(`unknown review command ${sub}`);
  rejectOptions(options, ['draft', 'catalog', 'replaceCatalogSha256'], 'review');
  if (approvals.some(Boolean)) throw new ConfigError('approval options are only valid with review adopt');
  if (options.format === 'json') rejectOptions(options, ['port', 'noOpen'], 'review --format json');

  const context = loadReviewContext(options.root, paths);
  if (context.status === 'no-candidate') {
    writeNoCandidate(context, options.format, io);
    return 0;
  }
  const state = evaluateReview(context);
  if (options.format === 'json') {
    io.out.write(`${JSON.stringify(statusDocument(context, state), null, 2)}\n`);
    return 0;
  }

  const server = await startReviewServer(context, {
    port: options.port ?? 0,
    log: (message) => io.err.write(`${message}\n`),
  });
  const stop = () => server.close();
  signals.once?.('SIGINT', stop);
  signals.once?.('SIGTERM', stop);
  io.out.write(
    [
      'ux-guard review',
      '',
      `  Candidate         ${context.candidatePath} (${identityLabel(context.identity)})`,
      `  Review decisions  ${context.reviewPath} (${context.reviewSha256 ? `saved revision ${context.review.revision}` : 'not saved yet'})`,
      `  Catalog           ${state.catalog.path}${state.catalog.exists ? '' : ' (not created yet)'}`,
      `  Still to decide   ${state.summary.unresolvedDecisions} decisions, ${state.summary.blockingIssues} blocking issues`,
      '',
      `  Open ${server.url}`,
      '',
      `  Bound to ${server.address} only, with no external assets or telemetry. The link holds a private`,
      '  session token; do not share it. Saving records an unapproved review. Nothing is approved,',
      '  adopted, checked in, or enforced from the app.',
      '',
      '  Press Ctrl+C or choose Close review in the app to stop.',
      '',
    ].join('\n'),
  );
  if (!options.noOpen && !process.env.CI) openBrowser(server.url);
  await server.closed;
  signals.off?.('SIGINT', stop);
  signals.off?.('SIGTERM', stop);
  io.out.write('ux-guard review: closed. Saved decisions remain unapproved.\n');
  return 0;
}

function rejectOptions(options, names, command) {
  const flags = {
    review: '--review',
    preview: '--preview',
    draft: '--draft',
    catalog: '--catalog',
    replaceCatalogSha256: '--replace-catalog-sha256',
    port: '--port',
    noOpen: '--no-open',
  };
  for (const name of names) {
    if (options[name] !== null && options[name] !== false) {
      throw new ConfigError(`${flags[name]} is not valid with ${command}`);
    }
  }
}

function identityLabel(identity) {
  return {
    current: 'current',
    moved: 'assessed files unchanged since the assessment commit',
    stale: 'stale: assessed files changed',
    unverified: 'repository identity unverified',
  }[identity.status];
}

function statusDocument(context, state) {
  return {
    kind: 'ux-guard-review-result',
    version: 1,
    command: 'review',
    status: state.summary.readyForOwnerApproval ? 'ready-for-owner-approval' : 'review-in-progress',
    exitCode: 0,
    paths: {
      candidate: context.candidatePath,
      review: context.reviewPath,
      preview: context.previewPath,
      catalog: state.catalog.path,
    },
    review: { saved: context.reviewSha256 !== null, revision: context.review.revision },
    identity: state.identity,
    summary: state.summary,
    unresolved: state.unresolved,
    issues: state.issues,
    catalog: {
      path: state.catalog.path,
      exists: state.catalog.exists,
      activeSha256: state.catalog.activeSha256,
      inventory: state.catalog.inventory,
      entries: state.catalog.entries,
      unbound: state.catalog.unbound,
      omitted: state.catalog.omitted,
      diff: state.catalog.diff,
    },
    adoptCommand: adoptionCommand(context, state),
    safety: {
      approved: false,
      policyChanged: false,
      filesWritten: [],
    },
  };
}

function writeNoCandidate(context, format, io) {
  const prepareStep = 'npx ux-guard review prepare';
  const nextAction = context.draftPresent
    ? `A draft exists at ${DEFAULT_REVIEW_PATHS.draft}. Validate and stamp it with: ${prepareStep}`
    : 'Ask your agent to draft the assessment with the prompt below, or write a draft by hand using docs/use-case-review.md in the installed package, then run: ' +
      prepareStep;
  if (format === 'json') {
    io.out.write(
      `${JSON.stringify(
        {
          kind: 'ux-guard-review-result',
          version: 1,
          command: 'review',
          status: 'no-candidate',
          exitCode: 0,
          candidate: { path: context.candidatePath, present: false },
          draft: { path: DEFAULT_REVIEW_PATHS.draft, present: context.draftPresent },
          missing: [
            'navigation surfaces and workflows discovered in this repository',
            'proposed use cases grouped by user outcome',
            'proposed mappings and exclusions with rationale',
          ],
          agentPrompt: REVIEW_AGENT_PROMPTS[0],
          nextAction,
          safety: { approved: false, policyChanged: false, filesWritten: [] },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const lines = [
    'ux-guard review',
    '',
    `No use-case candidate was found at ${context.candidatePath}.`,
    '',
    'The review app needs an assessment of this repository: its navigation surfaces and',
    'workflows, proposed use cases grouped by user outcome, and proposed mappings or',
    'exclusions. ux-guard does not guess these; an agent or a person drafts them, and',
    'ux-guard validates the draft and stamps it with repository identity.',
    '',
  ];
  if (context.draftPresent) {
    lines.push('Next safe action', `  A draft exists at ${DEFAULT_REVIEW_PATHS.draft}. Validate and stamp it with:`, `    ${prepareStep}`);
  } else {
    lines.push(
      'Next safe action',
      '  Ask your agent (copy this prompt):',
      '',
      `    ${REVIEW_AGENT_PROMPTS[0]}`,
      '',
      `  Or write ${DEFAULT_REVIEW_PATHS.draft} by hand using docs/use-case-review.md in the`,
      '  installed package, then run:',
      `    ${prepareStep}`,
    );
  }
  lines.push('', 'Nothing was written.');
  io.out.write(`${lines.join('\n')}\n`);
}

function prepare(options, paths, io) {
  const draftPath = options.draft ?? DEFAULT_REVIEW_PATHS.draft;
  const result = prepareCandidate(options.root, { draftPath, candidatePath: paths.candidatePath });
  const { candidate } = result;
  if (options.format === 'json') {
    io.out.write(
      `${JSON.stringify(
        {
          kind: 'ux-guard-review-prepare-result',
          version: 1,
          command: 'review prepare',
          status: 'unapproved',
          exitCode: 0,
          draft: draftPath,
          candidate: paths.candidatePath,
          counts: {
            outcomes: candidate.outcomes.length,
            proposals: candidate.proposals.length,
            surfaces: candidate.surfaces.length,
            workflows: candidate.workflows.length,
            inputs: result.inputs,
          },
          identity: { commit: candidate.source.commit, rootCommits: candidate.source.repository.rootCommits },
          incompleteProposals: result.incompleteProposals,
          notAssessed: result.notAssessed,
          safety: { approved: false, policyChanged: false, filesWritten: [paths.candidatePath] },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines = [
    'ux-guard review prepare',
    '',
    `  Stamped ${paths.candidatePath} from ${draftPath}.`,
    `  ${candidate.proposals.length} proposed use cases, ${candidate.surfaces.length} surfaces, ${candidate.workflows.length} workflows, ${result.inputs} assessed input files.`,
    `  Repository identity: ${candidate.source.commit ? `commit ${candidate.source.commit.slice(0, 12)}` : 'unavailable (no Git history)'}.`,
  ];
  if (result.notAssessed.length) {
    lines.push(
      `  ${result.notAssessed.length} navigation surfaces were found in source but not in the draft; they will appear as unresolved:`,
      ...result.notAssessed.map(({ id, route }) => `    - ${id} ${route}`),
    );
  }
  if (result.incompleteProposals.length) {
    lines.push(
      `  ${result.incompleteProposals.length} proposals need definition fields before they can be approved:`,
      ...result.incompleteProposals.map(
        ({ id, missingLabels }) => `    - ${id}: ${missingLabels.join(', ')}`,
      ),
      '  Add only content supported by repository evidence; leave unknowns for draft-first review.',
    );
  }
  lines.push('', '  Status: unapproved. Nothing else was written.', '', 'Next safe action', '  npx ux-guard review');
  io.out.write(`${lines.join('\n')}\n`);
  return 0;
}

function adopt(options, paths, io) {
  const context = loadReviewContext(options.root, { ...paths, explicitCandidate: true });
  const record = adoptReview(context, {
    reviewer: options.reviewer,
    reviewedAt: options.reviewedAt,
    rationale: options.rationale,
    catalogPath: options.catalog,
    replaceSha256: options.replaceCatalogSha256,
  });
  if (options.format === 'json') {
    io.out.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  io.out.write(
    [
      'ux-guard review adopt',
      '',
      `  ${record.catalog.previousSha256 ? 'Replaced' : 'Created'} ${record.catalog.path} with ${record.catalog.useCases} use cases (inventory ${record.catalog.inventory}).`,
      `  Approved by ${record.approval.reviewer} at ${record.approval.reviewedAt}.`,
      record.unresolved.length
        ? `  ${record.unresolved.length} items are still unresolved and remain unknown; they were not reported as covered.`
        : '  No unresolved review items remain.',
      '  Configuration, baselines, targets, waivers, and enforcement were not changed.',
      '',
      'Next safe action',
      `  ${record.nextAction}`,
      '',
    ].join('\n'),
  );
  return 0;
}

export function reviewErrorGuidance(message) {
  if (message.includes('does not exist') && message.includes('candidate')) {
    return 'Next: run ux-guard review without --candidate for guidance, or correct the candidate path.';
  }
  if (message.includes('stale')) {
    return 'Next: refresh the assessment draft, run ux-guard review prepare with a new candidate path, and review it.';
  }
  if (message.includes('different candidate')) {
    return 'Next: reopen the review with its original candidate, or pass a new --review path to start a fresh review.';
  }
  if (message.includes('draft')) {
    return 'Next: correct the draft (see docs/use-case-review.md in the installed package) and run ux-guard review prepare again.';
  }
  return 'Next: run ux-guard review --help, correct the reported input, and retry. The review never changes active policy on its own.';
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The printed address remains the fallback.
  }
}
