import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  AuthoritativeUpgradeError,
  createAuthoritativeAdvisory,
} from './authoritative.mjs';
import {
  JourneyBaselineError,
  compareJourneyBaseline,
  compareJourneyBaselineEnvelopes,
  createJourneyBaselineCandidate,
  parseJourneyBaseline,
  promoteJourneyBaseline,
  renderJourneyBaselineMarkdown,
  renderJourneyComparisonMarkdown,
  serializeJourneyBaseline,
  serializeJourneyComparison,
  unavailableJourneyComparison,
  runJourneyComparisonCanaries,
} from './baselines.mjs';
import { catalogPolicy, loadCatalog, loadSurfaces, renderCatalog, validateCatalog } from './catalog.mjs';
import {
  CONFIG_FILE,
  loadConfig,
  loadTypeScript,
  readTrusted,
  resolveRepositoryPath,
  resolveTrustedRevision,
  trustedFileExists,
  validateConfig,
} from './config.mjs';
import {
  candidateFromDiscovery,
  discoverProject,
  renderDiscovery,
  setupProposalFromDiscovery,
} from './discovery.mjs';
import {
  createJourneyArtifact,
  parseJourneyPolicy,
} from './journey-policy.mjs';
import {
  createJourneyReport,
  parseJourneyReport,
} from './journeys.mjs';
import {
  DEBT_RULES,
  baselineFromScan,
  compare,
  listSourceFiles,
  renderComparison,
  scanFiles,
  scanSource,
  validateBaseline,
} from './patterns.mjs';
import {
  createVerdictReport,
  renderVerdictMarkdown,
  serializeVerdictReport,
} from './verdicts.mjs';
import {
  createRunEnvelope,
  policyDigest,
  resolveRunIdentity,
  sha256,
} from './run-contract.mjs';
import {
  OwnerTargetsError,
  evaluateTargetAttainment,
  parseOwnerTargets,
  unavailableTargetAttainment,
} from './targets.mjs';
import {
  compareVisualManifests,
  parseVisualCheckpointPolicy,
  parseVisualManifest,
  parseVisualProfileSet,
  promoteVisualBundle,
  renderVisualComparisonMarkdown,
  renderVisualManifestMarkdown,
  runVisualComparisonCanaries,
  unavailableVisualComparison,
  VisualContractError,
} from './visuals.mjs';
import { ConfigError, parseYamlSubset } from './yaml.mjs';

const DEFAULT_SETUP_PROPOSAL = 'ux-guard/setup-proposal.json';

const USAGE = `usage: ux-guard <command> [options]

commands:
  setup                 inspect this repo and save an unapproved setup proposal
  check                 compare current UI code with reviewed UX policy
  report                explain UX evidence, gaps, and recommendations

help:
  ux-guard setup --help
  ux-guard check --help
  ux-guard report --help
  ux-guard help advanced

common options:
  --root <dir>          repository root (default: current directory)
  --base <ref>          use reviewed policy from a trusted Git revision
  --format text|json    human-readable or machine-readable output
`;

const SETUP_HELP = `usage: ux-guard setup [options]

Inspect UI source without approving it, then save a setup proposal for human
review. Setup never creates active policy, a reviewed baseline, a waiver, or
enforcement.

options:
  --root <dir>          repository root (default: current directory)
  --proposal <path>     proposal path (default: ${DEFAULT_SETUP_PROPOSAL})
  --format text|json    human-readable or machine-readable output
  --typescript <path>   advanced: explicit TypeScript package path
`;

const CHECK_HELP = `usage: ux-guard check [options]

Compare current UI code with reviewed policy. Findings use exit code 1;
missing, malformed, or unsafe inputs use exit code 2.

options:
  --root <dir>          repository root (default: current directory)
  --base <ref>          use reviewed policy from a trusted Git revision
  --strict              require every navigation surface to be catalogued
  --format text|json    human-readable or machine-readable output
`;

const REPORT_HELP = `usage: ux-guard report [options]

Explain configured journey evidence, UX quality, target attainment, regression,
and recommendations. Missing evidence stays unknown; it is never reported as
success.

options:
  --root <dir>          repository root (default: current directory)
  --base <ref>          compare with reviewed evidence from a trusted Git revision
  --format json|markdown
                        machine-readable output or a human review document
`;

const ADVANCED_USAGE = `usage: ux-guard <advanced-command> [options]

advanced policy and evidence lifecycle:
  authoritative         aggregate shards and regenerate trusted advisory artifacts
  discover              audit observed UI conventions and emit review candidates
  discover write-candidate --candidate <path>
                        write a new, explicitly unapproved review artifact
  discover promote --candidate <path>
                        install a human-approved candidate without overwriting
  baseline propose --candidate <path>
                        write an unapproved snapshot from the completed report
  baseline inspect --candidate <path>
                        validate and render a candidate for human review
  baseline diff --candidate <path> [--baseline <path>]
                        compare a candidate with a reviewed snapshot
  baseline promote --candidate <path> --reviewer <id> --reviewed-at <UTC> --rationale <text>
                        create the configured reviewed baseline without overwriting
  baseline canary       prove regression, improvement, compatibility, and known-bad behavior
  visual inspect --candidate <path>
                        validate and render an unapproved visual bundle
  visual diff --candidate <path> [--baseline <path>]
                        compare visual manifests checkpoint by checkpoint
  visual promote --candidate <path> --reviewer <id> --reviewed-at <UTC> --rationale <text>
                        create a reviewed visual baseline without overwriting
  visual canary         prove visual change and fail-closed behavior
  catalog [--strict]    validate the use-case catalog and list unmapped surfaces
  patterns scan         compare UI patterns with the baseline
  patterns update       rewrite the baseline; refuses growth without --accept-growth
  patterns init         create the baseline when none exists
  patterns canary       prove a known-bad file is rejected

options:
  --root <dir>          repository root (default: current directory)
  --base <ref>          load policy and baseline from a trusted git revision
  --typescript <path>   TypeScript package path for discovery only
  --shards <path>       candidate shard directory for authoritative regeneration
  --visuals <path>      candidate visual bundle for authoritative validation
  --candidate-sha <sha> candidate commit expected in authoritative shards
  --project <id>        expected journey project (default: chromium)
  --browser <name>      expected browser name (default: chromium)
  --profile <name>      expected browser profile (default: Desktop Chrome)
  --repetitions <count> expected stable repetitions (default: 3)
  --candidate <path>    discovery lifecycle artifact (repository-relative)
  --baseline <path>     reviewed baseline used by baseline diff
  --reviewer <id>       explicit baseline approval identity
  --reviewed-at <UTC>   explicit deterministic approval timestamp
  --rationale <text>    explicit baseline approval rationale
  --format json|markdown
                        machine-readable output, or Markdown for report
`;

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeCliError(error, argv, io);
    return 2;
  }
  try {
    return run(options, io);
  } catch (error) {
    if (error instanceof AuthoritativeUpgradeError) {
      io.err.write(`ux-guard: upgrade required: ${error.message}\n`);
      return 3;
    }
    if (
      error instanceof ConfigError ||
      error instanceof JourneyBaselineError ||
      error instanceof OwnerTargetsError ||
      error instanceof VisualContractError
    ) {
      writeCliError(error, argv, io);
      return 2;
    }
    throw error;
  }
}

function writeCliError(error, argv, io) {
  const command = ['setup', 'check', 'report'].find((name) => argv.includes(name));
  const guidance = errorGuidance(command, error.message);
  if (
    command === 'setup' &&
    argv.some((value, index) => value === '--format' && argv[index + 1] === 'json')
  ) {
    io.err.write(
      `${JSON.stringify(
        {
          kind: 'ux-guard-setup-error',
          version: 1,
          command: 'setup',
          status: 'error',
          exitCode: 2,
          error: error.message,
          nextAction: guidance,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  io.err.write(`ux-guard: ${error.message}\n${guidance}\n`);
}

function errorGuidance(command, message) {
  if (command === 'setup') {
    if (message.includes(`${CONFIG_FILE} already exists`)) {
      return 'Next: run ux-guard check. Setup will not replace the repository’s active policy.';
    }
    if (message.includes('already exists; refusing to overwrite')) {
      return 'Next: review the existing setup proposal, or deliberately choose a different repository-local proposal path.';
    }
    return 'Next: fix the reported input or choose a new proposal path, then run ux-guard setup again. Setup never overwrites files.';
  }
  if (command === 'check') {
    if (message.includes(CONFIG_FILE)) {
      return 'Next: review and explicitly activate the setup proposal. If no proposal exists, run ux-guard setup to create one safely.';
    }
    return 'Next: run ux-guard check --help, correct the reported input, and retry.';
  }
  if (command === 'report') {
    if (message.includes(CONFIG_FILE)) {
      return 'Next: review and activate a setup proposal, then configure reviewed journey evidence. If no proposal exists, run ux-guard setup. Reporting remains unavailable until those reviews are complete.';
    }
    if (message.includes('journey reporting is not configured')) {
      return 'Next: keep using ux-guard check, and configure reviewed journey evidence before asking for a report.';
    }
    return 'Next: run ux-guard report --help, correct the reported evidence or policy input, and retry.';
  }
  return 'Next: run ux-guard --help for the primary workflow or ux-guard help advanced for reference commands.';
}

function parseArgs(argv) {
  const options = {
    positional: [],
    root: process.cwd(),
    base: null,
    typescript: null,
    format: 'text',
    strict: false,
    acceptGrowth: false,
    candidate: null,
    baseline: null,
    reviewer: null,
    reviewedAt: null,
    rationale: null,
    proposal: DEFAULT_SETUP_PROPOSAL,
    proposalExplicit: false,
    shards: null,
    visuals: null,
    candidateSha: null,
    project: 'chromium',
    browser: 'chromium',
    profile: 'Desktop Chrome',
    repetitions: 3,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === '--root') options.root = resolve(value());
    else if (arg === '--base') options.base = value();
    else if (arg === '--typescript') options.typescript = value();
    else if (arg === '--candidate') options.candidate = value();
    else if (arg === '--baseline') options.baseline = value();
    else if (arg === '--reviewer') options.reviewer = value();
    else if (arg === '--reviewed-at') options.reviewedAt = value();
    else if (arg === '--rationale') options.rationale = value();
    else if (arg === '--proposal') {
      options.proposal = value();
      options.proposalExplicit = true;
    }
    else if (arg === '--shards') options.shards = value();
    else if (arg === '--visuals') options.visuals = value();
    else if (arg === '--candidate-sha') options.candidateSha = value();
    else if (arg === '--project') options.project = value();
    else if (arg === '--browser') options.browser = value();
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--repetitions') {
      const parsed = Number(value());
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error('--repetitions must be a positive integer');
      }
      options.repetitions = parsed;
    }
    else if (arg === '--format') options.format = value();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--accept-growth') options.acceptGrowth = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  if (!['text', 'json', 'markdown'].includes(options.format)) {
    throw new Error('--format must be text, json, or markdown');
  }
  return options;
}

function run(options, io) {
  const [command, sub, ...extra] = options.positional;
  if (extra.length) throw new ConfigError(`unexpected argument ${extra[0]}`);
  if (command === 'help') {
    if (sub === 'advanced') io.out.write(ADVANCED_USAGE);
    else if (sub === 'setup') io.out.write(SETUP_HELP);
    else if (sub === 'check') io.out.write(CHECK_HELP);
    else if (sub === 'report') io.out.write(REPORT_HELP);
    else if (sub) throw new ConfigError(`unknown help topic ${sub}`);
    else io.out.write(USAGE);
    return 0;
  }
  if (options.help) {
    if (!command) io.out.write(USAGE);
    else if (command === 'setup') io.out.write(SETUP_HELP);
    else if (command === 'check') io.out.write(CHECK_HELP);
    else if (command === 'report') io.out.write(REPORT_HELP);
    else io.out.write(ADVANCED_USAGE);
    return 0;
  }
  if (command === 'setup') return setupCommand(options, io);
  if (options.proposalExplicit) {
    throw new ConfigError('--proposal is only valid with setup');
  }
  if (command === 'discover') return discoverCommand(options, io);
  if (command === 'baseline') return baselineCommand(options, io);
  if (command === 'visual') return visualCommand(options, io);
  if (command === 'authoritative') return authoritativeCommand(options, io);
  if (!['catalog', 'patterns', 'check', 'report'].includes(command)) {
    throw new ConfigError(`unknown command ${command ?? '(none)'}\n${USAGE}`);
  }
  if ((command === 'catalog' || command === 'check' || command === 'report') && sub) {
    throw new ConfigError(`unexpected argument ${sub}`);
  }
  if (options.typescript) {
    throw new ConfigError('--typescript is only valid with discover');
  }
  if (options.format === 'markdown' && command !== 'report') {
    throw new ConfigError('--format markdown is only valid with report or baseline inspect/diff');
  }
  if (options.candidate) throw new ConfigError('--candidate is only valid with discover');
  if (options.baseline) throw new ConfigError('--baseline is only valid with baseline diff');
  if (options.reviewer || options.reviewedAt || options.rationale) {
    throw new ConfigError('approval options are only valid with baseline promote');
  }
  if (options.strict && command !== 'catalog' && command !== 'check') {
    throw new ConfigError('--strict is only valid with catalog or check');
  }
  if (options.acceptGrowth && !(command === 'patterns' && sub === 'update')) {
    throw new ConfigError('--accept-growth is only valid with patterns update');
  }
  if (
    options.shards ||
    options.visuals ||
    options.candidateSha ||
    options.project !== 'chromium' ||
    options.browser !== 'chromium' ||
    options.profile !== 'Desktop Chrome' ||
    options.repetitions !== 3
  ) {
    throw new ConfigError('authoritative run options are only valid with authoritative');
  }
  const trust = resolveTrustedRevision(options.root, options.base);
  const config = loadConfig(options.root, trust);
  const ts = loadTypeScript();
  switch (command) {
    case 'catalog':
      return catalogCommand(ts, config, trust, options, io);
    case 'patterns':
      return patternsCommand(sub, ts, config, trust, options, io);
    case 'check':
      return checkCommand(ts, config, trust, options, io);
    case 'report':
      return reportCommand(ts, config, trust, options, io);
  }
  throw new ConfigError(`unknown command ${command}`);
}

function authoritativeCommand(options, io) {
  const [, sub] = options.positional;
  if (sub) throw new ConfigError(`unexpected argument ${sub}`);
  if (options.format !== 'json') {
    throw new ConfigError('authoritative requires --format json');
  }
  if (
    options.typescript ||
    options.strict ||
    options.acceptGrowth ||
    options.candidate ||
    options.baseline ||
    options.reviewer ||
    options.reviewedAt ||
    options.rationale
  ) {
    throw new ConfigError('authoritative accepts only trusted run options');
  }
  try {
    const bundle = createAuthoritativeAdvisory({
      root: options.root,
      base: options.base,
      candidate: options.candidateSha,
      shards: options.shards,
      visuals: options.visuals,
      project: options.project,
      browser: options.browser,
      profile: options.profile,
      repetitions: options.repetitions,
    });
    io.out.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AuthoritativeUpgradeError) throw error;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`authoritative advisory: ${error.message}`);
  }
}

function setupCommand(options, io) {
  const [, sub] = options.positional;
  if (sub) throw new ConfigError(`unexpected argument ${sub}`);
  if (options.base) throw new ConfigError('setup inspects the working tree; do not pass --base');
  if (options.format === 'markdown') {
    throw new ConfigError('--format markdown is not valid with setup; use text or json');
  }
  if (
    options.strict ||
    options.acceptGrowth ||
    options.candidate ||
    options.baseline ||
    options.reviewer ||
    options.reviewedAt ||
    options.rationale ||
    options.shards ||
    options.visuals ||
    options.candidateSha ||
    options.project !== 'chromium' ||
    options.browser !== 'chromium' ||
    options.profile !== 'Desktop Chrome' ||
    options.repetitions !== 3
  ) {
    throw new ConfigError('setup accepts only --root, --proposal, --format, and --typescript');
  }
  if (existsSync(join(options.root, CONFIG_FILE))) {
    throw new ConfigError(
      `${CONFIG_FILE} already exists; setup never replaces active policy. Run ux-guard check instead`,
    );
  }

  let report;
  try {
    report = discoverProject(options.root, options.typescript);
  } catch (error) {
    if (
      error instanceof ConfigError &&
      [
        'discover found no tsconfig files',
        'discover found no non-test JSX or TSX source files',
      ].includes(error.message)
    ) {
      const result = setupEvidenceGap(options.proposal, error.message);
      writeSetupResult(result, options.format, io);
      return 0;
    }
    throw error;
  }

  const proposal = setupProposalFromDiscovery(report);
  writeCandidate(options.root, options.proposal, proposal, 'setup proposal');
  const result = setupResult(report, options.proposal);
  writeSetupResult(result, options.format, io);
  return 0;
}

function setupResult(report, proposalPath) {
  const assessment = assessSetup(report);
  return {
    kind: 'ux-guard-setup-result',
    version: 1,
    command: 'setup',
    status: 'review-required',
    exitCode: 0,
    inspected: {
      status: 'complete',
      uiSourceFiles: report.observed.files,
      sourceRoots: report.observed.sourceRoots.map(
        ({ path, productionFiles }) => ({ path, uiSourceFiles: productionFiles }),
      ),
      tsconfigs: report.inputs.tsconfigs,
      componentLibraries: report.observed.componentLibraries.map(({ module }) => module),
      iconLibraries: report.observed.iconLibraries.map(({ module }) => module),
      signals: ['component use', 'control props', 'icons', 'styling', 'pattern debt'],
    },
    results: assessment,
    proposal: {
      status: 'unapproved',
      path: proposalPath,
      written: true,
    },
    safety: {
      observedUsageApproved: false,
      policyCreated: false,
      baselineCreated: false,
      waiversCreated: false,
      enforcementEnabled: false,
      filesWritten: [proposalPath],
    },
    nextAction:
      `Review ${proposalPath} with the people responsible for product, design, and engineering. ` +
      'Choose the missing policy and catalog decisions, then require explicit human approval before activation.',
  };
}

function setupEvidenceGap(proposalPath, reason) {
  return {
    kind: 'ux-guard-setup-result',
    version: 1,
    command: 'setup',
    status: 'insufficient-evidence',
    exitCode: 0,
    inspected: {
      status: 'incomplete',
      uiSourceFiles: 0,
      sourceRoots: [],
      tsconfigs: [],
      componentLibraries: [],
      iconLibraries: [],
      signals: [],
    },
    results: {
      good: [],
      needsAttention: [],
      unknown: [
        reason,
        'UX conventions, workflow coverage, and regression from main could not be evaluated.',
      ],
    },
    proposal: {
      status: 'not-created',
      path: proposalPath,
      written: false,
    },
    safety: {
      observedUsageApproved: false,
      policyCreated: false,
      baselineCreated: false,
      waiversCreated: false,
      enforcementEnabled: false,
      filesWritten: [],
    },
    nextAction:
      'Add or point ux-guard to a TypeScript UI project with non-test JSX or TSX source, then run ux-guard setup again.',
  };
}

function assessSetup(report) {
  const labels = {
    'inline-style': 'inline styles',
    'hard-coded-color': 'hard-coded colors',
    'px-literal': 'pixel literals',
    'raw-button': 'raw button elements',
    'icon-library': 'icon-library uses',
  };
  const good = [`Inspected ${report.observed.files} non-test UI source files.`];
  const needsAttention = [];
  for (const rule of DEBT_RULES) {
    const locations = Object.entries(report.observed.debt[rule])
      .map(([path, count]) => ({ path, count }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const count = locations.reduce((sum, item) => sum + item.count, 0);
    if (count === 0) {
      good.push(`No ${labels[rule]} were observed in the inspected files.`);
    } else {
      needsAttention.push({
        signal: rule,
        summary: `${count} ${labels[rule]} observed; review before deciding policy.`,
        count,
        locations,
      });
    }
  }
  const unknown = [
    'Observed conventions have not been approved as policy.',
    'No use-case catalog was inspected, so workflow coverage is unknown.',
    'No trusted baseline was used, so regression from main is unknown.',
    'Enforcement is not enabled.',
  ];
  for (const diagnostic of report.inputs.diagnostics) {
    unknown.push(`${diagnostic.tsconfig}: ${diagnostic.message}`);
  }
  return { good, needsAttention, unknown };
}

function writeSetupResult(result, format, io) {
  if (format === 'json') {
    io.out.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = ['ux-guard setup', '', 'Inspected'];
  if (result.inspected.status === 'complete') {
    lines.push(
      `  ${result.inspected.uiSourceFiles} non-test UI source files across ${result.inspected.sourceRoots.length} source roots.`,
      `  TypeScript projects: ${result.inspected.tsconfigs.join(', ') || '(none)'}.`,
      `  Component libraries: ${result.inspected.componentLibraries.join(', ') || '(none observed)'}.`,
      `  Icon libraries: ${result.inspected.iconLibraries.join(', ') || '(none observed)'}.`,
      `  Signals: ${result.inspected.signals.join(', ')}.`,
    );
  } else {
    lines.push('  No executable UI source evidence was available.');
  }
  lines.push('', 'Good');
  if (result.results.good.length === 0) {
    lines.push('  Nothing can be confirmed from the available evidence.');
  } else {
    for (const item of result.results.good) lines.push(`  - ${item}`);
  }
  lines.push('', 'Needs attention');
  if (result.results.needsAttention.length === 0) {
    lines.push('  No potential pattern problems were observed in the inspected files.');
  } else {
    for (const item of result.results.needsAttention) {
      lines.push(`  - ${item.summary}`);
      for (const location of item.locations) {
        lines.push(`    ${location.path}: ${location.count}`);
      }
    }
  }
  lines.push('', 'Unknown');
  for (const item of result.results.unknown) lines.push(`  - ${item}`);
  lines.push('', 'Setup proposal');
  if (result.proposal.written) {
    lines.push(
      `  Saved ${result.proposal.path}.`,
      '  Status: unapproved. It records observations and decisions still needing human review.',
    );
  } else {
    lines.push(`  Not created at ${result.proposal.path}; there was not enough UI evidence.`);
  }
  lines.push(
    '',
    'Safety',
    '  No active policy, reviewed baseline, waiver, or enforcement was created.',
    '',
    'Next safe action',
    `  ${result.nextAction}`,
  );
  io.out.write(`${lines.join('\n')}\n`);
}

function discoverCommand(options, io) {
  if (options.base) throw new ConfigError('discover audits the working tree; do not pass --base');
  if (options.strict || options.acceptGrowth) throw new ConfigError('--strict and --accept-growth are not valid with discover');
  if (options.baseline || options.reviewer || options.reviewedAt || options.rationale) {
    throw new ConfigError('baseline approval options are not valid with discover');
  }
  if (options.format === 'markdown') {
    throw new ConfigError('--format markdown is only valid with report');
  }
  const [, sub] = options.positional;
  if (!sub) {
    if (options.candidate) throw new ConfigError('--candidate requires discover write-candidate or discover promote');
    const report = discoverProject(options.root, options.typescript);
    if (options.format === 'json') io.out.write(`${JSON.stringify({ discovery: report }, null, 2)}\n`);
    else io.out.write(renderDiscovery(report));
    return 0;
  }
  if (sub === 'write-candidate') {
    if (!options.candidate) throw new ConfigError('discover write-candidate requires --candidate <path>');
    const report = discoverProject(options.root, options.typescript);
    const artifact = candidateFromDiscovery(report);
    writeCandidate(options.root, options.candidate, artifact);
    const emitted = structuredClone(report);
    emitted.approval.filesWritten = true;
    emitted.approval.writtenArtifacts = [options.candidate];
    if (options.format === 'json') {
      io.out.write(
        `${JSON.stringify(
          {
            discovery: emitted,
            lifecycle: {
              action: 'write-candidate',
              status: 'unapproved',
              candidate: options.candidate,
            },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out.write(renderDiscovery(emitted));
      io.out.write(`ux-guard: wrote unapproved candidate ${options.candidate}; human review is required before promotion\n`);
    }
    return 0;
  }
  if (sub === 'promote') {
    if (!options.candidate) throw new ConfigError('discover promote requires --candidate <path>');
    if (options.typescript) throw new ConfigError('discover promote uses the TypeScript path in the reviewed candidate');
    return promoteCandidate(options, io);
  }
  throw new ConfigError(`unknown discover command ${sub}`);
}

function baselineCommand(options, io) {
  const [, sub] = options.positional;
  if (!['propose', 'inspect', 'diff', 'promote', 'canary'].includes(sub)) {
    throw new ConfigError(`unknown baseline command ${sub ?? '(none)'}`);
  }
  if (options.base) {
    throw new ConfigError('baseline lifecycle commands use explicit artifacts; do not pass --base');
  }
  if (options.typescript || options.strict || options.acceptGrowth) {
    throw new ConfigError('baseline commands do not accept TypeScript, strict, or growth options');
  }
  if (sub === 'canary') {
    if (
      options.candidate ||
      options.baseline ||
      options.reviewer ||
      options.reviewedAt ||
      options.rationale ||
      options.format === 'markdown'
    ) {
      throw new ConfigError('baseline canary does not accept artifact or approval options');
    }
    const canaries = runJourneyComparisonCanaries();
    if (options.format === 'json') {
      io.out.write(
        `${JSON.stringify(
          {
            version: 1,
            command: 'baseline canary',
            status: 'passed',
            exitCode: 0,
            canaries,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out.write(
        'ux-guard: regression, improvement, compatibility, and known-bad comparison canaries passed\n',
      );
    }
    return 0;
  }
  if (!options.candidate) {
    throw new ConfigError(`baseline ${sub} requires --candidate <path>`);
  }
  if (options.format === 'markdown' && !['inspect', 'diff'].includes(sub)) {
    throw new ConfigError('--format markdown is only valid with baseline inspect or diff');
  }
  if (options.baseline && sub !== 'diff') {
    throw new ConfigError('--baseline is only valid with baseline diff');
  }
  const approvalOptions = [options.reviewer, options.reviewedAt, options.rationale];
  if (sub === 'promote') {
    if (approvalOptions.some((value) => !value)) {
      throw new ConfigError(
        'baseline promote requires --reviewer, --reviewed-at, and --rationale',
      );
    }
  } else if (approvalOptions.some(Boolean)) {
    throw new ConfigError('approval options are only valid with baseline promote');
  }

  const config = loadConfig(options.root, null);
  if (!config.journeys?.baseline || !config.journeys?.report) {
    throw new ConfigError('journey baseline and report paths are not configured');
  }
  if (options.candidate === config.journeys.baseline) {
    throw new ConfigError('candidate path must differ from the reviewed baseline path');
  }

  if (sub === 'propose') {
    const policy = parseJourneyPolicy(
      readTrusted(options.root, config.journeys.policy, null),
    );
    const reportText = readTrusted(options.root, config.journeys.report, null);
    const report = parseJourneyReport(reportText);
    const candidate = createJourneyBaselineCandidate({
      report,
      policy,
      reportPath: config.journeys.report,
      reportSha256: sha256(reportText),
      canaries: runJourneyComparisonCanaries(),
    });
    writeLifecycleArtifact(
      options.root,
      options.candidate,
      serializeJourneyBaseline(candidate),
      'baseline candidate',
    );
    if (options.format === 'json') {
      io.out.write(
        `${JSON.stringify(
          {
            version: 1,
            command: 'baseline propose',
            status: 'unapproved',
            exitCode: 0,
            candidate: options.candidate,
            canonicalHash: candidate.canonicalHash,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out.write(
        `ux-guard: wrote unapproved journey baseline candidate ${options.candidate}; owner review is required before promotion\n`,
      );
    }
    return 0;
  }

  const candidate = readLifecycleBaseline(
    options.root,
    options.candidate,
    'baseline candidate',
  );
  if (sub === 'inspect') {
    if (options.format === 'json') io.out.write(serializeJourneyBaseline(candidate));
    else io.out.write(renderJourneyBaselineMarkdown(candidate));
    return 0;
  }
  if (sub === 'diff') {
    const baselinePath = options.baseline ?? config.journeys.baseline;
    let comparison;
    if (!trustedFileExists(options.root, baselinePath, null)) {
      comparison = unavailableJourneyComparison(
        `reviewed baseline ${baselinePath} is not available`,
      );
    } else {
      const reviewed = readLifecycleBaseline(
        options.root,
        baselinePath,
        'reviewed baseline',
      );
      if (reviewed.approval.status !== 'reviewed') {
        throw new ConfigError(`${baselinePath} is not a reviewed baseline`);
      }
      comparison = compareJourneyBaselineEnvelopes(reviewed, candidate);
    }
    if (options.format === 'json') io.out.write(serializeJourneyComparison(comparison));
    else io.out.write(renderJourneyComparisonMarkdown(comparison));
    return 0;
  }

  const reviewed = promoteJourneyBaseline(candidate, {
    reviewer: options.reviewer,
    reviewedAt: options.reviewedAt,
    rationale: options.rationale,
  });
  if (existsSync(join(options.root, config.journeys.baseline))) {
    throw new ConfigError(
      `${config.journeys.baseline} already exists; promotion never overwrites a reviewed baseline`,
    );
  }
  writeLifecycleArtifact(
    options.root,
    config.journeys.baseline,
    serializeJourneyBaseline(reviewed),
    'reviewed baseline',
  );
  if (options.format === 'json') {
    io.out.write(
      `${JSON.stringify(
        {
          version: 1,
          command: 'baseline promote',
          status: 'reviewed',
          exitCode: 0,
          source: options.candidate,
          baseline: config.journeys.baseline,
          canonicalHash: reviewed.canonicalHash,
          reviewer: reviewed.approval.reviewer,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out.write(
      `ux-guard: promoted ${options.candidate}; created reviewed baseline ${config.journeys.baseline}\n`,
    );
  }
  return 0;
}

function visualCommand(options, io) {
  const [, sub] = options.positional;
  if (!['inspect', 'diff', 'promote', 'canary'].includes(sub)) {
    throw new ConfigError(`unknown visual command ${sub ?? '(none)'}`);
  }
  if (options.base || options.typescript || options.strict || options.acceptGrowth) {
    throw new ConfigError('visual lifecycle commands use explicit local artifacts');
  }
  if (sub === 'canary') {
    if (
      options.candidate ||
      options.baseline ||
      options.reviewer ||
      options.reviewedAt ||
      options.rationale ||
      options.format === 'markdown'
    ) {
      throw new ConfigError('visual canary does not accept artifact or approval options');
    }
    const canaries = runVisualComparisonCanaries();
    if (options.format === 'json') {
      io.out.write(
        `${JSON.stringify(
          {
            version: 1,
            command: 'visual canary',
            status: 'passed',
            exitCode: 0,
            canaries,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out.write(
        'ux-guard: one-pixel, missing-checkpoint, profile-mismatch, and fail-closed visual canaries passed\n',
      );
    }
    return 0;
  }
  if (!options.candidate) {
    throw new ConfigError(`visual ${sub} requires --candidate <manifest>`);
  }
  if (options.format === 'markdown' && !['inspect', 'diff'].includes(sub)) {
    throw new ConfigError('--format markdown is only valid with visual inspect or diff');
  }
  if (options.baseline && sub !== 'diff') {
    throw new ConfigError('--baseline is only valid with visual diff');
  }
  const approvals = [options.reviewer, options.reviewedAt, options.rationale];
  if (sub === 'promote') {
    if (approvals.some((value) => !value)) {
      throw new ConfigError(
        'visual promote requires --reviewer, --reviewed-at, and --rationale',
      );
    }
  } else if (approvals.some(Boolean)) {
    throw new ConfigError('approval options are only valid with visual promote');
  }
  const config = loadConfig(options.root, null);
  if (!config.visuals) throw new ConfigError('visual policy is not configured');
  const profileSet = parseVisualProfileSet(
    readTrusted(options.root, config.visuals.profiles, null),
  );
  const checkpointPolicy = parseVisualCheckpointPolicy(
    readTrusted(options.root, config.visuals.checkpoints, null),
  );
  const candidate = readLocalVisualManifest(
    options.root,
    options.candidate,
    profileSet,
    checkpointPolicy,
  );
  if (sub === 'inspect') {
    if (options.format === 'json') {
      io.out.write(`${JSON.stringify(candidate, null, 2)}\n`);
    } else {
      io.out.write(renderVisualManifestMarkdown(candidate));
    }
    return 0;
  }
  if (sub === 'diff') {
    const baselinePath = options.baseline ?? config.visuals.baseline;
    let comparison;
    if (!existsSync(join(options.root, baselinePath))) {
      comparison = unavailableVisualComparison(
        `reviewed visual baseline ${baselinePath} is not available`,
        candidate,
      );
    } else {
      const baseline = readLocalVisualManifest(
        options.root,
        baselinePath,
        profileSet,
        checkpointPolicy,
      );
      comparison = compareVisualManifests(baseline, candidate);
    }
    if (options.format === 'json') {
      io.out.write(`${JSON.stringify(comparison, null, 2)}\n`);
    } else {
      io.out.write(renderVisualComparisonMarkdown(comparison));
    }
    return 0;
  }
  const promoted = promoteVisualBundle({
    root: options.root,
    candidatePath: options.candidate,
    baselinePath: config.visuals.baseline,
    reviewer: options.reviewer,
    reviewedAt: options.reviewedAt,
    rationale: options.rationale,
    profileSet,
    checkpointPolicy,
  });
  if (options.format === 'json') {
    io.out.write(
      `${JSON.stringify(
        {
          version: 1,
          command: 'visual promote',
          status: 'reviewed',
          exitCode: 0,
          source: options.candidate,
          baseline: config.visuals.baseline,
          canonicalHash: promoted.canonicalHash,
          reviewer: promoted.approval.reviewer,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out.write(
      `ux-guard: promoted ${options.candidate}; created reviewed visual baseline ${config.visuals.baseline}\n`,
    );
  }
  return 0;
}

function readLocalVisualManifest(root, path, profileSet, checkpointPolicy) {
  const full = resolveRepositoryPath(root, path, 'visual manifest path');
  ensureLocalDirectory(root, dirname(full), 'visual manifest path', false);
  let stats;
  try {
    stats = lstatSync(full);
  } catch {
    throw new ConfigError(`visual manifest ${path} does not exist`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ConfigError('visual manifest must be a regular file, not a symbolic link');
  }
  return parseVisualManifest(readFileSync(full, 'utf8'), {
    profileSet,
    checkpointPolicy,
    bundleRoot: dirname(full),
    requireFiles: true,
  });
}

function readLifecycleBaseline(root, path, label) {
  const full = resolveRepositoryPath(root, path, `${label} path`);
  ensureLocalDirectory(root, dirname(full), `${label} path`, false);
  try {
    const stats = lstatSync(full);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ConfigError(`${label} must be a regular repository file, not a symbolic link`);
    }
    return parseJourneyBaseline(readFileSync(full, 'utf8'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error?.code === 'ENOENT') throw new ConfigError(`${label} ${path} does not exist`);
    throw new ConfigError(`${label} ${path}: ${error.message}`);
  }
}

function writeLifecycleArtifact(root, path, text, label) {
  const full = resolveRepositoryPath(root, path, `${label} path`);
  ensureLocalDirectory(root, dirname(full), `${label} path`, true);
  try {
    writeFileSync(full, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ConfigError(`${path} already exists; refusing to overwrite it`);
    }
    throw new ConfigError(`${label} ${path} could not be written`);
  }
}

function writeCandidate(root, path, artifact, label = 'candidate') {
  if (path === CONFIG_FILE) throw new ConfigError(`${label} path cannot be ${CONFIG_FILE}`);
  const full = resolveRepositoryPath(root, path, `${label} path`);
  ensureLocalDirectory(root, dirname(full), `${label} path`, true);
  try {
    writeFileSync(full, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ConfigError(`${label} ${path} already exists; refusing to overwrite it`);
    throw new ConfigError(`${label} ${path} could not be written`);
  }
}

function promoteCandidate(options, io) {
  const artifact = readCandidate(options.root, options.candidate);
  validateCandidateApproval(artifact);
  const config = validateConfig(artifact.config);
  const baselinePath = config.patterns.baseline;
  if (existsSync(join(options.root, CONFIG_FILE))) {
    throw new ConfigError(`${CONFIG_FILE} already exists; promotion never overwrites policy`);
  }
  if (existsSync(join(options.root, baselinePath))) {
    throw new ConfigError(`${baselinePath} already exists; promotion never overwrites a baseline`);
  }

  const ts = loadTypeScript(options.root, config);
  const catalog = validateCatalog(loadCatalog(options.root, config), loadSurfaces(ts, options.root, config));
  if (catalog.inventory === 'complete' && catalog.unmapped.length > 0) {
    throw new ConfigError('candidate policy has a complete catalog with unmapped navigation surfaces');
  }
  const scan = scanFiles(ts, options.root, config, listSourceFiles(options.root, config));
  const baseline = baselineFromScan(scan);
  writePromotedPolicy(options.root, config, baseline);

  const result = {
    candidate: options.candidate,
    reviewer: artifact.approval.reviewer,
    files: [CONFIG_FILE, baselinePath],
  };
  if (options.format === 'json') {
    io.out.write(
      `${JSON.stringify(
        {
          version: 1,
          command: 'discover promote',
          status: 'promoted',
          exitCode: 0,
          promotion: result,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out.write(`ux-guard: promoted ${options.candidate}; created ${CONFIG_FILE} and ${baselinePath}\n`);
  }
  return 0;
}

function readCandidate(root, path) {
  const full = resolveRepositoryPath(root, path, 'candidate path');
  ensureLocalDirectory(root, dirname(full), 'candidate path', false);
  try {
    if (lstatSync(full).isSymbolicLink()) throw new ConfigError('candidate path cannot be a symbolic link');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`candidate ${path} could not be read`);
  }
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`candidate ${path} is not valid JSON`);
    throw new ConfigError(`candidate ${path} could not be read`);
  }
  if (
    artifact?.version !== 1 ||
    !['ux-guard-policy-candidate', 'ux-guard-setup-proposal'].includes(artifact.kind)
  ) {
    throw new ConfigError(`candidate ${path} is not a ux-guard policy candidate`);
  }
  return artifact;
}

function validateCandidateApproval(artifact) {
  const approval = artifact.approval;
  if (
    approval?.status !== 'approved' ||
    typeof approval.reviewer !== 'string' ||
    !approval.reviewer.trim() ||
    typeof approval.reviewedAt !== 'string' ||
    !approval.reviewedAt.trim() ||
    approval.patternPolicyReviewed !== true
  ) {
    throw new ConfigError(
      'candidate is unapproved; a human must set status, reviewer, reviewedAt, and patternPolicyReviewed before promotion',
    );
  }
}

function writePromotedPolicy(root, config, baseline) {
  const baselinePath = config.patterns.baseline;
  const baselineFull = join(root, baselinePath);
  const configFull = join(root, CONFIG_FILE);
  ensureLocalDirectory(root, dirname(baselineFull), 'patterns.baseline', true);
  let baselineWritten = false;
  try {
    writeFileSync(baselineFull, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    baselineWritten = true;
    writeFileSync(configFull, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (baselineWritten) {
      try {
        unlinkSync(baselineFull);
      } catch {
        // The original write error remains the actionable failure.
      }
    }
    if (error?.code === 'EEXIST') throw new ConfigError('promotion target appeared during promotion; nothing was overwritten');
    throw new ConfigError('promoted policy could not be written');
  }
}

function ensureLocalDirectory(root, directory, label, create) {
  const path = relative(root, directory);
  if (!path) return;
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!create) throw new ConfigError(`${label} parent does not exist`);
      try {
        mkdirSync(current);
      } catch {
        throw new ConfigError(`${label} parent could not be created safely`);
      }
    }
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      throw new ConfigError(`${label} parent could not be inspected`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ConfigError(`${label} parent must be a repository directory, not a symbolic link`);
    }
  }
}

function catalogCommand(ts, config, trust, options, io) {
  const evaluation = evaluateCatalog(ts, config, trust, options);
  if (options.format === 'json') {
    io.out.write(`${JSON.stringify(resultDocument('catalog', evaluation.code, { catalog: evaluation.summary }), null, 2)}\n`);
  } else {
    io.out.write(renderCatalog(evaluation.report));
  }
  emitCatalogDiagnostics(evaluation.findings, io);
  return evaluation.code;
}

function evaluateCatalog(ts, config, trust, options) {
  const report = validateCatalog(loadCatalog(options.root, config), loadSurfaces(ts, options.root, config));
  let policyInventory = report.inventory;
  if (trust) {
    policyInventory = catalogPolicy(parseYamlSubset(readTrusted(options.root, config.catalog.path, trust))).inventory;
  }
  const findings = [];
  if (policyInventory === 'complete' && report.inventory !== 'complete') {
    findings.push({
      rule: 'catalog-policy-downgrade',
      message: 'trusted catalog inventory is complete and the candidate cannot downgrade it to partial',
    });
  }
  const effectiveComplete = policyInventory === 'complete' || report.inventory === 'complete';
  if (effectiveComplete && report.unmapped.length > 0) {
    findings.push({
      rule: 'unmapped-complete-inventory',
      count: report.unmapped.length,
      message: 'a complete inventory cannot leave a navigation surface unmapped',
    });
  }
  if (options.strict && report.unmapped.length > 0) {
    findings.push({
      rule: 'unmapped-strict',
      count: report.unmapped.length,
      message: 'strict mode rejects unmapped navigation surfaces',
    });
  }
  const code = findings.length ? 1 : 0;
  return {
    code,
    findings,
    report,
    summary: summarizeCatalog(report, policyInventory, findings),
  };
}

function emitCatalogDiagnostics(findings, io) {
  for (const finding of findings) io.err.write(`ux-guard: ${finding.message}\n`);
}

function checkCommand(ts, config, trust, options, io) {
  const catalog = evaluateCatalog(ts, config, trust, options);
  const patterns = evaluatePatternScan(ts, config, trust, options);
  const journeyEvaluation = evaluateJourneys(config, trust, options, catalog.report);
  const visuals = evaluateVisuals(config, trust, options);
  const journeys = journeyEvaluation.summary;
  if (journeyEvaluation.policy) {
    journeys.verdicts = evaluateVerdicts(
      catalog.report,
      journeyEvaluation,
      patterns.summary,
      visuals,
    );
  }
  const code = Math.max(catalog.code, patterns.code);
  if (options.format === 'json') {
    io.out.write(
      `${JSON.stringify(
        resultDocument('check', code, {
          catalog: catalog.summary,
          patterns: patterns.summary,
          journeys,
          visuals,
        }),
        null,
        2,
      )}\n`,
    );
  } else {
    io.out.write(renderCatalog(catalog.report));
    io.out.write(renderComparison(patterns.scan, patterns.result));
    io.out.write(renderJourneySummary(journeys));
  }
  emitCatalogDiagnostics(catalog.findings, io);
  return code;
}

function reportCommand(ts, config, trust, options, io) {
  if (options.strict || options.acceptGrowth || options.candidate) {
    throw new ConfigError('report does not accept strict, growth, or candidate options');
  }
  const catalog = evaluateCatalog(ts, config, trust, { ...options, strict: false });
  const patterns = evaluatePatternScan(ts, config, trust, options);
  const journeys = evaluateJourneys(config, trust, options, catalog.report);
  const visuals = evaluateVisuals(config, trust, options);
  if (!journeys.policy) {
    throw new ConfigError('journey reporting is not configured');
  }
  const report = evaluateVerdicts(
    catalog.report,
    journeys,
    patterns.summary,
    visuals,
  );
  if (options.format === 'json') io.out.write(serializeVerdictReport(report));
  else io.out.write(renderVerdictMarkdown(report));
  return 0;
}

function evaluateVerdicts(catalog, journeys, patterns, visuals) {
  try {
    return createVerdictReport({
      catalog,
      policy: journeys.policy,
      measurements: journeys.measurements,
      patterns,
      comparison: journeys.comparison,
      targets: journeys.targets,
      readinessEvidence: journeys.readinessEvidence,
      visuals,
    });
  } catch (error) {
    throw new ConfigError(`journey verdict report: ${error.message}`);
  }
}

function evaluateJourneys(config, trust, options, catalog) {
  if (!config.journeys) {
    return {
      summary: {
        status: 'unconfigured',
        rollout: 'measurement-only',
      },
      policy: null,
      measurements: null,
      comparison: unavailableJourneyComparison('journey reporting is not configured'),
      targets: unavailableTargetAttainment(
        'not-configured',
        'owner targets are not configured',
      ),
      readinessEvidence: null,
    };
  }

  const { policy: policyPath, report: reportPath } = config.journeys;
  let policy;
  try {
    policy = parseJourneyPolicy(readTrusted(options.root, policyPath, trust));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${policyPath}: ${error.message}`);
  }

  const reportPresent = existsSync(join(options.root, reportPath));
  let report = null;
  if (reportPresent) {
    try {
      report = parseJourneyReport(readTrusted(options.root, reportPath, null));
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`${reportPath}: ${error.message}`);
    }
  } else {
    const identity = resolveRunIdentity(options.root, {
      policy,
      baseCommit: trust?.commit,
      browser: { name: 'none', profile: 'not-run' },
      adapters: { journey: '1' },
    });
    report = createJourneyReport([], {
      catalog,
      policy,
      run: createRunEnvelope(identity, { statuses: [] }),
    });
  }

  let artifact;
  try {
    artifact = createJourneyArtifact({ catalog, policy, report });
  } catch (error) {
    throw new ConfigError(`journey measurement: ${error.message}`);
  }
  const comparisonEvaluation = evaluateJourneyComparison({
    config,
    trust,
    root: options.root,
    report,
    reportPresent,
    policy,
  });
  const targets = evaluateOwnerTargets(
    config,
    trust,
    options.root,
    policy,
    report,
  );
  return {
    summary: {
      status: 'measurement-only',
      policyPath,
      reportPath,
      reportPresent,
      ...artifact,
      comparison: comparisonEvaluation.comparison,
      targets,
    },
    policy,
    measurements: report,
    comparison: comparisonEvaluation.comparison,
    targets,
    readinessEvidence: comparisonEvaluation.readinessEvidence,
  };
}

function evaluateJourneyComparison({
  config,
  trust,
  root,
  report,
  reportPresent,
  policy,
}) {
  const baselinePath = config.journeys.baseline;
  if (!baselinePath) {
    return {
      comparison: unavailableJourneyComparison('reviewed journey baseline is not configured'),
      readinessEvidence: null,
    };
  }
  if (!trust) {
    return {
      comparison: unavailableJourneyComparison(
        'reviewed journey baseline was not evaluated; pass --base with an explicit trusted revision',
      ),
      readinessEvidence: null,
    };
  }
  if (!trustedFileExists(root, baselinePath, trust)) {
    return {
      comparison: unavailableJourneyComparison(
        `reviewed journey baseline is not present at trusted revision ${trust.ref}`,
      ),
      readinessEvidence: null,
    };
  }
  if (!reportPresent) {
    return {
      comparison: unavailableJourneyComparison(
        'current deterministic journey report is not available',
      ),
      readinessEvidence: null,
    };
  }
  let baseline;
  try {
    baseline = parseJourneyBaseline(readTrusted(root, baselinePath, trust));
  } catch (error) {
    throw new ConfigError(`${baselinePath}: ${error.message}`);
  }
  return {
    comparison: compareJourneyBaseline({
      baseline,
      report,
      policy,
      trusted: true,
    }),
    readinessEvidence: structuredClone(baseline.readinessEvidence),
  };
}

function evaluateOwnerTargets(config, trust, root, policy, report) {
  const targetsPath = config.journeys.targets;
  if (!targetsPath) {
    return unavailableTargetAttainment(
      'not-configured',
      'owner targets are not configured',
    );
  }
  if (!trust) {
    return unavailableTargetAttainment(
      'not-evaluated',
      'owner targets require an explicit trusted --base revision',
    );
  }
  if (!trustedFileExists(root, targetsPath, trust)) {
    return unavailableTargetAttainment(
      'not-configured',
      `owner targets are not present at trusted revision ${trust.ref}`,
    );
  }
  let targets;
  try {
    targets = parseOwnerTargets(readTrusted(root, targetsPath, trust));
  } catch (error) {
    throw new ConfigError(`${targetsPath}: ${error.message}`);
  }
  if (targets.approval.status !== 'reviewed') {
    return unavailableTargetAttainment(
      'not-evaluated',
      'owner targets at the trusted revision are not reviewed',
      targets.canonicalHash,
    );
  }
  if (targets.policy.digest !== policyDigest(policy)) {
    return unavailableTargetAttainment(
      'incompatible',
      'owner target policy digest differs from the trusted journey policy',
      targets.canonicalHash,
    );
  }
  return evaluateTargetAttainment({ targets, report });
}

function evaluateVisuals(config, trust, options) {
  if (!config.visuals) {
    return visualSummary({
      candidatePath: null,
      baselinePath: null,
      candidate: null,
      baseline: null,
      comparison: unavailableVisualComparison('visual policy is not configured'),
    });
  }
  const { profiles, checkpoints, candidate: candidatePath, baseline: baselinePath } =
    config.visuals;
  const profileSet = parseVisualProfileSet(
    readTrusted(options.root, profiles, trust),
  );
  const checkpointPolicy = parseVisualCheckpointPolicy(
    readTrusted(options.root, checkpoints, trust),
  );
  let candidate = null;
  const candidateFull = join(options.root, candidatePath);
  if (existsSync(candidateFull)) {
    candidate = readLocalVisualManifest(
      options.root,
      candidatePath,
      profileSet,
      checkpointPolicy,
    );
    if (candidate.approval.status !== 'unapproved') {
      throw new VisualContractError('working visual candidate must remain unapproved');
    }
  }
  if (!candidate) {
    return visualSummary({
      candidatePath,
      baselinePath,
      candidate: null,
      baseline: null,
      comparison: unavailableVisualComparison(
        `visual candidate ${candidatePath} is not available`,
      ),
    });
  }
  if (!trust) {
    return visualSummary({
      candidatePath,
      baselinePath,
      candidate,
      baseline: null,
      comparison: unavailableVisualComparison(
        'visual comparison requires an explicit trusted --base revision',
        candidate,
      ),
    });
  }
  if (!trustedFileExists(options.root, baselinePath, trust)) {
    return visualSummary({
      candidatePath,
      baselinePath,
      candidate,
      baseline: null,
      comparison: unavailableVisualComparison(
        `reviewed visual baseline is not present at trusted revision ${trust.ref}`,
        candidate,
      ),
    });
  }
  const baseline = parseVisualManifest(
    readTrusted(options.root, baselinePath, trust),
    {
      profileSet,
      checkpointPolicy,
      readImage: trustedVisualImageReader(
        options.root,
        trust,
        dirname(baselinePath),
      ),
      requireFiles: true,
    },
  );
  return visualSummary({
    candidatePath,
    baselinePath,
    candidate,
    baseline,
    comparison: compareVisualManifests(baseline, candidate),
  });
}

function trustedVisualImageReader(root, trust, manifestDirectory) {
  return (imagePath) => {
    const repositoryPath = `${manifestDirectory}/${imagePath}`.replace(/^\.\//, '');
    resolveRepositoryPath(root, repositoryPath, 'trusted visual image path');
    const record = execFileSync(
      'git',
      ['ls-tree', trust.commit, '--', repositoryPath],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!record.startsWith('100644 blob ') || !record.endsWith(`\t${repositoryPath}`)) {
      throw new VisualContractError(
        `trusted visual image ${repositoryPath} is missing or not a regular file`,
      );
    }
    return execFileSync(
      'git',
      ['show', `${trust.commit}:${repositoryPath}`],
      {
        cwd: root,
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  };
}

function visualSummary({
  candidatePath,
  baselinePath,
  candidate,
  baseline,
  comparison,
}) {
  return {
    rollout: 'advisory',
    status: comparison.status,
    candidate: {
      status: candidate ? 'available-unapproved' : 'unavailable',
      manifestPath: candidatePath,
      canonicalHash: candidate?.canonicalHash ?? null,
      images: candidate?.images.length ?? 0,
      repetitions: candidate?.capture.repetitions ?? 0,
    },
    baseline: {
      status: baseline ? 'reviewed' : 'not-reviewed',
      manifestPath: baselinePath,
      canonicalHash: baseline?.canonicalHash ?? null,
    },
    comparison: {
      ...comparison,
      checkpoints: comparison.checkpoints.filter(
        (checkpoint) => checkpoint.status !== 'unchanged',
      ),
    },
  };
}

function renderJourneySummary(journeys) {
  if (journeys.status === 'unconfigured') {
    return 'Journey measurement: unconfigured (advisory)\n';
  }
  const { coverage } = journeys;
  const lines = [
    `Journey measurement: ${coverage.measuredVariants}/${coverage.requiredVariants} required variants measured; ${coverage.successfulVariants} successful across ${coverage.cataloguedUseCases} catalogued use cases (advisory)`,
    `  Policy: ${journeys.policyPath}`,
    `  Report: ${journeys.reportPath}${journeys.reportPresent ? '' : ' (not generated)'}`,
  ];
  if (coverage.findings.length === 0) {
    lines.push('  Lifecycle and measurement coverage: complete');
  } else {
    lines.push('  Lifecycle and measurement coverage:');
    for (const finding of coverage.findings) {
      lines.push(
        `    - ${finding.useCaseId}${finding.journeyId ? `/${finding.journeyId}` : ''}: ${finding.rule}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function summarizeCatalog(report, policyInventory, findings) {
  return {
    status: findings.length ? 'findings' : 'clean',
    inventory: report.inventory,
    policyInventory,
    useCases: report.useCases.map(({ id, title, tier, effect }) => ({ id, title, tier, effect })),
    surfaces: report.surfaces.length,
    unmapped: report.unmapped.map(({ id, label, route }) => ({ id, label, route })),
    findings,
  };
}

function patternsCommand(sub, ts, config, trust, options, io) {
  if (!['init', 'scan', 'update', 'canary'].includes(sub)) {
    throw new ConfigError(`unknown patterns command ${sub ?? '(none)'}`);
  }
  if (trust && (sub === 'init' || sub === 'update')) {
    throw new ConfigError(`patterns ${sub} writes the working tree; do not pass --base`);
  }
  const scan = scanFiles(ts, options.root, config, listSourceFiles(options.root, config));
  const baselinePath = config.patterns.baseline;
  if (sub === 'init') {
    if (existsSync(join(options.root, baselinePath))) {
      throw new ConfigError(`${baselinePath} already exists; use patterns update`);
    }
    writeBaseline(options.root, baselinePath, baselineFromScan(scan), true);
    io.out.write(`ux-guard: created ${baselinePath}\n`);
    return 0;
  }
  const baseline = loadBaseline(options.root, baselinePath, trust);
  if (sub === 'scan') {
    const evaluation = patternEvaluation(scan, baseline);
    if (options.format === 'json') {
      io.out.write(`${JSON.stringify(resultDocument('patterns scan', evaluation.code, { patterns: evaluation.summary }), null, 2)}\n`);
    } else {
      io.out.write(renderComparison(scan, evaluation.result));
    }
    return evaluation.code;
  }
  if (sub === 'update') {
    const result = compare(scan, baseline);
    if (result.findings.length && !options.acceptGrowth) {
      io.out.write(renderComparison(scan, result));
      io.err.write('ux-guard: baseline growth requires an explicit --accept-growth\n');
      return 1;
    }
    writeBaseline(options.root, baselinePath, baselineFromScan(scan));
    io.out.write(`ux-guard: updated ${baselinePath} (${result.stale.length} stale entries removed, ${result.findings.length} accepted)\n`);
    return 0;
  }
  if (sub === 'canary') return canary(ts, config, scan, baseline, io);
  throw new ConfigError(`unknown patterns command ${sub}`);
}

function evaluatePatternScan(ts, config, trust, options) {
  const scan = scanFiles(ts, options.root, config, listSourceFiles(options.root, config));
  const baseline = loadBaseline(options.root, config.patterns.baseline, trust);
  return patternEvaluation(scan, baseline);
}

function patternEvaluation(scan, baseline) {
  const result = compare(scan, baseline);
  const code = result.findings.length ? 1 : 0;
  return {
    code,
    result,
    scan,
    summary: {
      status: code ? 'findings' : 'clean',
      files: scan.files.length,
      inventory: sortedInventory(scan.inventory),
      findings: result.findings,
      stale: result.stale,
    },
  };
}

function sortedInventory(inventory) {
  return Object.fromEntries(
    Object.entries(inventory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, counts]) => [
        key,
        Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

function resultDocument(command, code, results) {
  return {
    kind: 'ux-guard-command-result',
    version: 2,
    command,
    status: code === 0 ? 'clean' : 'findings',
    exitCode: code,
    ...results,
  };
}

function loadBaseline(root, path, trust) {
  let parsed;
  try {
    parsed = JSON.parse(readTrusted(root, path, trust));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${path} is not valid JSON`);
  }
  return validateBaseline(parsed);
}

function writeBaseline(root, path, baseline, exclusive = false) {
  const full = join(root, path);
  ensureLocalDirectory(root, dirname(full), 'patterns.baseline', true);
  if (!exclusive && existsSync(full) && lstatSync(full).isSymbolicLink()) {
    throw new ConfigError(`${path} is a symbolic link; refusing to overwrite it`);
  }
  try {
    writeFileSync(full, `${JSON.stringify(baseline, null, 2)}\n`, exclusive ? { flag: 'wx' } : undefined);
  } catch (error) {
    if (exclusive && error?.code === 'EEXIST') throw new ConfigError(`${path} already exists; use patterns update`);
    throw new ConfigError(`${path} could not be written`);
  }
}

export const CANARY_FILE = '__ux-guard-canary__/KnownBad.tsx';
export const CANARY_VALUE = 'ux-guard-canary';

export function canarySource(config) {
  const { components, icons } = config.patterns;
  const component = components.names[0];
  const prop = components.props[0];
  const icon = icons.modules.find((module) => !icons.allowed.includes(module));
  if (!icon) throw new ConfigError('canary needs at least one icon module that is not allowed');
  return [
    `import { ${component} } from '${components.module}';`,
    `import { Canary } from '${icon}';`,
    'export function KnownBad() {',
    '  return (',
    `    <div style={{ width: '13px', color: '#abcdef' }}>`,
    `      <${component} ${prop}="${CANARY_VALUE}">x</${component}>`,
    '      <button type="button"><Canary /></button>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function canary(ts, config, scan, baseline, io) {
  const injected = scanSource(ts, CANARY_FILE, canarySource(config), config);
  const combined = structuredClone(scan);
  for (const { key, value } of injected.controls) {
    combined.inventory[key] ??= {};
    combined.inventory[key][value] = (combined.inventory[key][value] ?? 0) + 1;
  }
  for (const rule of DEBT_RULES) {
    if (injected.debt[rule] > 0) combined.debt[rule][CANARY_FILE] = injected.debt[rule];
  }
  const { findings } = compare(combined, baseline);
  const expectedKey = `${config.patterns.components.names[0]}.${config.patterns.components.props[0]}`;
  const missing = [];
  if (!findings.some((f) => f.rule === 'new-control-value' && f.key === expectedKey && f.value === CANARY_VALUE)) {
    missing.push('new-control-value');
  }
  for (const rule of DEBT_RULES) {
    if (!findings.some((f) => f.rule === rule && f.file === CANARY_FILE)) missing.push(rule);
  }
  if (missing.length) {
    io.err.write(`ux-guard: known-bad canary was not rejected for ${missing.join(', ')}\n`);
    return 1;
  }
  io.out.write('ux-guard: known-bad pattern canary was rejected by every rule\n');
  return 0;
}
