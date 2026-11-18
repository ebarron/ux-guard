import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolve } from 'node:path';
import {
  compareJourneyBaseline,
  parseJourneyBaseline,
  unavailableJourneyComparison,
} from './baselines.mjs';
import {
  catalogPolicy,
  loadCatalog,
  loadSurfaces,
  validateCatalog,
} from './catalog.mjs';
import {
  loadConfig,
  loadTypeScript,
  readTrusted,
  resolveTrustedRevision,
  trustedFileExists,
} from './config.mjs';
import { parseJourneyPolicy } from './journey-policy.mjs';
import { compare, listSourceFiles, scanFiles, validateBaseline } from './patterns.mjs';
import { canonicalize, policyDigest, resolveRunIdentity } from './run-contract.mjs';
import {
  aggregateJourneyShards,
  JourneyShardUpgradeError,
} from './shards.mjs';
import {
  evaluateTargetAttainment,
  parseOwnerTargets,
  unavailableTargetAttainment,
} from './targets.mjs';
import {
  createVerdictReport,
  renderVerdictMarkdown,
} from './verdicts.mjs';
import {
  compareVisualManifests,
  parseVisualCheckpointPolicy,
  parseVisualManifest,
  parseVisualProfileSet,
  unavailableVisualComparison,
  VisualContractError,
} from './visuals.mjs';
import { ConfigError, parseYamlSubset } from './yaml.mjs';

export const AUTHORITATIVE_BUNDLE_KIND = 'ux-guard-authoritative-advisory';
export const AUTHORITATIVE_BUNDLE_VERSION = 1;

export class AuthoritativeUpgradeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthoritativeUpgradeError';
  }
}

export function createAuthoritativeAdvisory({
  root,
  base,
  candidate,
  shards,
  visuals,
  project = 'chromium',
  browser = 'chromium',
  profile = 'Desktop Chrome',
  repetitions = 3,
} = {}) {
  if (!base) throw new ConfigError('authoritative advisory requires --base');
  if (!candidate) throw new ConfigError('authoritative advisory requires --candidate');
  if (!shards) throw new ConfigError('authoritative advisory requires --shards');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new ConfigError('authoritative advisory repetitions must be a positive integer');
  }

  const trust = resolveTrustedRevision(root, base);
  const config = loadConfig(root, trust);
  if (config.visuals && !visuals) {
    throw new ConfigError('authoritative advisory requires --visuals');
  }
  const ts = loadTypeScript();
  const candidateCatalog = validateCatalog(
    loadCatalog(root, config),
    loadSurfaces(ts, root, config),
  );
  const trustedCatalog = catalogPolicy(
    parseYamlSubset(readTrusted(root, config.catalog.path, trust)),
  );
  const catalogFindings = evaluateCatalogBoundary(
    candidateCatalog,
    trustedCatalog.inventory,
  );
  if (catalogFindings.length) {
    throw new ConfigError(
      `candidate catalog violates trusted policy: ${catalogFindings
        .map((finding) => finding.rule)
        .join(', ')}`,
    );
  }

  const scan = scanFiles(ts, root, config, listSourceFiles(root, config));
  const patternBaseline = parsePatternBaseline(
    readTrusted(root, config.patterns.baseline, trust),
    config.patterns.baseline,
  );
  const patternComparison = compare(scan, patternBaseline);
  const patternSummary = {
    status: patternComparison.findings.length ? 'findings' : 'clean',
    files: scan.files.length,
    findings: patternComparison.findings,
    stale: patternComparison.stale,
  };

  if (!config.journeys) {
    throw new ConfigError('trusted policy does not configure journey reporting');
  }
  const policy = parseJourneyPolicy(
    readTrusted(root, config.journeys.policy, trust),
  );
  const runIdentity = resolveRunIdentity(root, {
    policy,
    candidateCommit: candidate,
    baseCommit: trust.commit,
    browser: { name: browser, profile },
    adapters: { playwright: '1', repetitions: String(repetitions) },
  });

  let measurements;
  try {
    measurements = aggregateJourneyShards({
      directory: resolve(shards),
      policy,
      catalog: candidateCatalog,
      runIdentity,
      project,
      repetitions,
      artifactPath: 'candidate-evidence/journey-shards',
    });
  } catch (error) {
    if (error instanceof JourneyShardUpgradeError) {
      throw new AuthoritativeUpgradeError(error.message);
    }
    throw error;
  }

  const comparisonEvaluation = evaluateComparison({
    root,
    trust,
    config,
    policy,
    report: measurements,
  });
  const targets = evaluateTargets({
    root,
    trust,
    config,
    policy,
    report: measurements,
  });
  const visualSummary = config.visuals
    ? evaluateVisuals({
        root,
        trust,
        config,
        candidateRoot: resolve(visuals),
      })
    : unconfiguredVisuals();
  const readinessEvidence = {
    ...(comparisonEvaluation.readinessEvidence ?? {}),
    trustedExecution: true,
    enforcementApproved:
      comparisonEvaluation.readinessEvidence?.enforcementApproved === true,
  };
  const verdict = createVerdictReport({
    catalog: candidateCatalog,
    policy,
    measurements,
    patterns: patternSummary,
    comparison: comparisonEvaluation.comparison,
    targets,
    readinessEvidence,
    visuals: visualSummary,
  });

  return canonicalize({
    kind: AUTHORITATIVE_BUNDLE_KIND,
    version: AUTHORITATIVE_BUNDLE_VERSION,
    authority: 'trusted-base-advisory',
    rollout: 'advisory',
    baseCommit: trust.commit,
    candidateCommit: measurements.run.provenance.candidate.commit,
    audit: {
      candidateCatalog: {
        inventory: candidateCatalog.inventory,
        trustedInventory: trustedCatalog.inventory,
        useCases: candidateCatalog.useCases.length,
        surfaces: candidateCatalog.surfaces.length,
        unmapped: candidateCatalog.unmapped.length,
        findings: catalogFindings,
      },
      candidateSource: {
        files: scan.files.length,
        patternFindings: patternComparison.findings,
        stalePatternEntries: patternComparison.stale,
      },
      candidateVisuals: {
        manifest: visualSummary.candidate.manifestPath,
        canonicalHash: visualSummary.candidate.canonicalHash,
        images: visualSummary.candidate.images,
        comparison: visualSummary.status,
      },
    },
    journeys: measurements,
    verdict,
    markdown: renderAuthoritativeMarkdown(verdict),
  });
}

function evaluateCatalogBoundary(catalog, trustedInventory) {
  const findings = [];
  if (trustedInventory === 'complete' && catalog.inventory !== 'complete') {
    findings.push({ rule: 'catalog-policy-downgrade' });
  }
  if (
    (trustedInventory === 'complete' || catalog.inventory === 'complete') &&
    catalog.unmapped.length > 0
  ) {
    findings.push({
      rule: 'unmapped-complete-inventory',
      count: catalog.unmapped.length,
    });
  }
  return findings;
}

function parsePatternBaseline(text, path) {
  try {
    return validateBaseline(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`${path} is not valid JSON`);
    }
    throw error;
  }
}

function evaluateComparison({ root, trust, config, policy, report }) {
  const path = config.journeys.baseline;
  if (!path) {
    return {
      comparison: unavailableJourneyComparison(
        'reviewed journey baseline is not configured',
      ),
      readinessEvidence: null,
    };
  }
  if (!trustedFileExists(root, path, trust)) {
    return {
      comparison: unavailableJourneyComparison(
        `reviewed journey baseline is not present at trusted revision ${trust.ref}`,
      ),
      readinessEvidence: null,
    };
  }
  let baseline;
  try {
    baseline = parseJourneyBaseline(readTrusted(root, path, trust));
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
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

function evaluateTargets({ root, trust, config, policy, report }) {
  const path = config.journeys.targets;
  if (!path) {
    return unavailableTargetAttainment(
      'not-configured',
      'owner targets are not configured',
    );
  }
  if (!trustedFileExists(root, path, trust)) {
    return unavailableTargetAttainment(
      'not-configured',
      `owner targets are not present at trusted revision ${trust.ref}`,
    );
  }
  let targets;
  try {
    targets = parseOwnerTargets(readTrusted(root, path, trust));
  } catch (error) {
    throw new ConfigError(`${path}: ${error.message}`);
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

function evaluateVisuals({ root, trust, config, candidateRoot }) {
  if (!config.visuals) {
    throw new AuthoritativeUpgradeError(
      'trusted generation does not configure visual policy',
    );
  }
  const profileSet = parseVisualProfileSet(
    readTrusted(root, config.visuals.profiles, trust),
  );
  const checkpointPolicy = parseVisualCheckpointPolicy(
    readTrusted(root, config.visuals.checkpoints, trust),
  );
  const candidatePath = join(candidateRoot, 'manifest.json');
  let stats;
  try {
    stats = lstatSync(candidatePath);
  } catch {
    throw new VisualContractError('candidate visual manifest is missing');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new VisualContractError(
      'candidate visual manifest must be a regular file, not a symbolic link',
    );
  }
  const candidate = parseVisualManifest(readFileSync(candidatePath, 'utf8'), {
    profileSet,
    checkpointPolicy,
    bundleRoot: candidateRoot,
    requireFiles: true,
  });
  if (candidate.approval.status !== 'unapproved') {
    throw new VisualContractError('candidate visual manifest cannot claim approval');
  }
  let baseline = null;
  let comparison;
  if (!trustedFileExists(root, config.visuals.baseline, trust)) {
    comparison = unavailableVisualComparison(
      `reviewed visual baseline is not present at trusted revision ${trust.ref}`,
      candidate,
    );
  } else {
    baseline = parseVisualManifest(
      readTrusted(root, config.visuals.baseline, trust),
      {
        profileSet,
        checkpointPolicy,
        readImage: trustedVisualImageReader(
          root,
          trust,
          dirname(config.visuals.baseline),
        ),
        requireFiles: true,
      },
    );
    comparison = compareVisualManifests(baseline, candidate);
    if (comparison.status === 'error') {
      throw new VisualContractError(comparison.reason);
    }
  }
  return {
    rollout: 'advisory',
    status: comparison.status,
    candidate: {
      status: 'available-unapproved',
      manifestPath: 'candidate-visuals/manifest.json',
      canonicalHash: candidate.canonicalHash,
      images: candidate.images.length,
      repetitions: candidate.capture.repetitions,
    },
    baseline: {
      status: baseline ? 'reviewed' : 'not-reviewed',
      manifestPath: config.visuals.baseline,
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

function unconfiguredVisuals() {
  return {
    rollout: 'advisory',
    status: 'not-evaluated',
    candidate: {
      status: 'unavailable',
      manifestPath: null,
      canonicalHash: null,
      images: 0,
      repetitions: 0,
    },
    baseline: {
      status: 'not-reviewed',
      manifestPath: null,
      canonicalHash: null,
    },
    comparison: unavailableVisualComparison('visual policy is not configured'),
  };
}

function trustedVisualImageReader(root, trust, manifestDirectory) {
  return (imagePath) => {
    const repositoryPath = `${manifestDirectory}/${imagePath}`.replace(/^\.\//, '');
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

function renderAuthoritativeMarkdown(verdict) {
  return renderVerdictMarkdown(verdict)
    .replace(
      '# ux-guard advisory verdict report',
      '# ux-guard trusted authoritative advisory report',
    )
    .replace(
      '> Advisory evidence only. Journey and visual results do not change the command exit status.',
      '> Authoritative regeneration used code, policy, baselines, and targets from the immutable trusted base. This remains advisory and is not a required gate.',
    )
    .replace(
      '- **Execution trust:** Candidate ux-guard code produced this diagnostic; only pinned-base authoritative regeneration may create the authoritative advisory artifact.',
      '- **Execution trust:** Trusted-base ux-guard code aggregated candidate shards and regenerated this advisory result.',
    );
}
