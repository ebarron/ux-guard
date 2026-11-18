import {
  unavailableJourneyComparison,
  validateJourneyComparison,
} from './baselines.mjs';
import { validateJourneyPolicy } from './journey-policy.mjs';
import { validateJourneyReport } from './journeys.mjs';
import { canonicalize, policyDigest, validateRunEnvelope } from './run-contract.mjs';
import {
  unavailableTargetAttainment,
  validateTargetAttainment,
} from './targets.mjs';
import {
  unavailableVisualComparison,
  validateVisualComparison,
} from './visuals.mjs';

export const VERDICT_REPORT_KIND = 'ux-guard-verdict-report';
export const VERDICT_REPORT_VERSION = 6;

const QUALITY_VERDICTS = new Set([
  'incomplete',
  'needs-improvement',
  'acceptable',
]);
const DIMENSIONS = [
  'efficiency',
  'clarity',
  'feedback-and-recovery',
  'accessibility',
  'consistency',
];
const STATUS_ORDER = new Map([
  ['infrastructure-error', 0],
  ['failed', 1],
  ['skipped', 2],
  ['unexecutable', 3],
  ['unmeasured', 4],
  ['successful', 5],
]);

export class VerdictReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerdictReportError';
  }
}

export function createVerdictReport({
  catalog,
  policy,
  measurements,
  patterns,
  comparison = unavailableJourneyComparison('reviewed journey baseline is not configured'),
  targets = unavailableTargetAttainment(
    'not-configured',
    'owner targets are not configured',
  ),
  readinessEvidence = null,
  visuals = defaultVisualSummary(),
} = {}) {
  validateJourneyPolicy(policy);
  validateJourneyReport(measurements);
  validateJourneyComparison(comparison);
  validateTargetAttainment(targets);
  if (measurements.run.policy.digest !== policyDigest(policy)) {
    throw new VerdictReportError('measurement report policy digest does not match reviewed policy');
  }
  const catalogEntries = catalogUseCases(catalog);
  const catalogById = new Map(catalogEntries.map((useCase) => [useCase.id, useCase]));
  const definitions = new Map(
    policy.journeys.map((journey) => [`${journey.useCaseId}\0${journey.journeyId}`, journey]),
  );
  const measured = new Map(
    measurements.journeys.map((journey) => [
      `${journey.useCaseId}\0${journey.journeyId}`,
      journey,
    ]),
  );
  for (const finding of measurements.findings) {
    bindFinding(finding, catalogById, definitions, measurements.journeys);
  }

  const journeys = [];
  const useCases = [];
  const recommendations = [];
  for (const coverage of policy.coverage) {
    const catalogEntry = catalogById.get(coverage.useCaseId);
    if (!catalogEntry) {
      throw new VerdictReportError(
        `coverage policy names uncatalogued use case ${coverage.useCaseId}`,
      );
    }
    const useCaseJourneys = coverage.requiredVariants.map((variant) => {
      const definition = definitions.get(`${coverage.useCaseId}\0${variant.journeyId}`);
      if (!definition) {
        throw new VerdictReportError(
          `required variant has no definition: ${coverage.useCaseId}/${variant.journeyId}`,
        );
      }
      const measurement = measured.get(`${coverage.useCaseId}\0${variant.journeyId}`);
      const status = measurement?.status ?? 'unmeasured';
      const findingRefs = measurement?.findingRefs ?? [];
      const verdict =
        status !== 'successful'
          ? 'incomplete'
          : findingRefs.length
            ? 'needs-improvement'
            : 'acceptable';
      const record = {
        id: `journey.${coverage.useCaseId}.${variant.journeyId}`,
        useCaseId: coverage.useCaseId,
        variantId: variant.variantId,
        label: variant.label,
        journeyId: variant.journeyId,
        executionStatus: status,
        verdict,
        metrics: measurement?.metrics ?? null,
        findingRefs: [...findingRefs].sort(),
      };
      journeys.push(record);
      return record;
    });
    const successful = useCaseJourneys.filter(
      (journey) => journey.executionStatus === 'successful',
    ).length;
    const findingRefs = [
      ...new Set(useCaseJourneys.flatMap((journey) => journey.findingRefs)),
    ].sort();
    const complete = successful === useCaseJourneys.length;
    const verdict = complete
      ? findingRefs.length
        ? 'needs-improvement'
        : 'acceptable'
      : 'incomplete';
    const useCase = {
      useCaseId: coverage.useCaseId,
      title: catalogEntry.title,
      verdict,
      reason: useCaseReason(useCaseJourneys, findingRefs.length),
      coverage: {
        status: complete ? 'complete' : 'incomplete',
        requiredVariants: useCaseJourneys.length,
        measuredVariants: useCaseJourneys.filter(
          (journey) => journey.executionStatus !== 'unmeasured',
        ).length,
        successfulVariants: successful,
        statuses: Object.fromEntries(
          [...STATUS_ORDER.keys()].map((status) => [
            status,
            useCaseJourneys
              .filter((journey) => journey.executionStatus === status)
              .map((journey) => journey.variantId),
          ]),
        ),
      },
      journeyRefs: useCaseJourneys.map((journey) => journey.id),
      findingRefs,
      recommendationRefs: [],
      comparison: crossVariantComparison(useCaseJourneys),
    };
    for (const findingRef of findingRefs) {
      const finding = measurements.findings.find((candidate) => candidate.id === findingRef);
      const id = `recommendation.${finding.ruleId}`;
      recommendations.push({
        id,
        findingRef,
        targetRef: null,
        useCaseId: coverage.useCaseId,
        severity: finding.severity,
        type: finding.type,
        affectedJourneyRefs: [...finding.journeyRefs],
        text: finding.recommendation,
      });
      useCase.recommendationRefs.push(id);
    }
    for (const journey of useCaseJourneys.filter(
      (candidate) => candidate.executionStatus === 'unmeasured',
    )) {
      const id = `recommendation.coverage.${coverage.useCaseId}.${journey.variantId}`;
      recommendations.push({
        id,
        findingRef: null,
        targetRef: null,
        useCaseId: coverage.useCaseId,
        severity: 'high',
        type: 'coverage',
        affectedJourneyRefs: [journey.id],
        text: `Bind and measure the ${journey.label} required variant.`,
      });
      useCase.recommendationRefs.push(id);
    }
    useCases.push(useCase);
  }

  const staticPatterns = createStaticPatternReport(patterns);
  const requiredVariants = useCases.reduce(
    (total, useCase) => total + useCase.coverage.requiredVariants,
    0,
  );
  const measuredVariants = useCases.reduce(
    (total, useCase) => total + useCase.coverage.measuredVariants,
    0,
  );
  const successfulVariants = useCases.reduce(
    (total, useCase) => total + useCase.coverage.successfulVariants,
    0,
  );
  const complete =
    useCases.length === catalogEntries.length &&
    useCases.length > 0 &&
    useCases.every((useCase) => useCase.coverage.status === 'complete');
  const qualityVerdict = !complete
    ? 'incomplete'
    : useCases.some((useCase) => useCase.verdict === 'needs-improvement')
      ? 'needs-improvement'
      : 'acceptable';
  recommendations.push(
    ...targetRecommendations(targets),
  );
  const readiness = scoringReadiness({
    comparison,
    measurements,
    readinessEvidence,
  });
  const report = {
    kind: VERDICT_REPORT_KIND,
    version: VERDICT_REPORT_VERSION,
    run: structuredClone(measurements.run),
    rollout: 'advisory',
    coverage: {
      status: complete ? 'complete' : 'incomplete',
      cataloguedUseCases: catalogEntries.length,
      reportedUseCases: useCases.length,
      requiredVariants,
      measuredVariants,
      successfulVariants,
    },
    quality: {
      verdict: qualityVerdict,
      reason: qualityReason(qualityVerdict, useCases),
      dimensions: qualityDimensions(measurements.findings),
    },
    targetAttainment: structuredClone(targets),
    regression: regressionReport(comparison, staticPatterns),
    readiness,
    scoring: numericalScore(policy, targets),
    visuals: normalizeVisualSummary(visuals),
    staticPatterns,
    useCases,
    journeys: journeys.sort((left, right) => left.id.localeCompare(right.id)),
    findings: structuredClone(measurements.findings),
    recommendations: {
      status: recommendations.length ? 'available' : 'none',
      items: recommendations.sort(compareRecommendation),
    },
    details: structuredClone(measurements.details),
  };
  return validateVerdictReport(report);
}

export function validateVerdictReport(report) {
  assertMap(report, 'report');
  assertExactKeys(
    report,
    [
      'kind',
      'version',
      'run',
      'rollout',
      'coverage',
      'quality',
      'targetAttainment',
      'regression',
      'readiness',
      'scoring',
      'visuals',
      'staticPatterns',
      'useCases',
      'journeys',
      'findings',
      'recommendations',
      'details',
    ],
    'report',
  );
  if (report.kind !== VERDICT_REPORT_KIND) {
    throw new VerdictReportError(`report.kind must be ${VERDICT_REPORT_KIND}`);
  }
  if (report.version !== VERDICT_REPORT_VERSION) {
    throw new VerdictReportError(
      `unsupported verdict report version ${String(report.version)}; migrate to version ${VERDICT_REPORT_VERSION}`,
    );
  }
  validateRunEnvelope(report.run);
  if (report.rollout !== 'advisory') {
    throw new VerdictReportError('report.rollout must be advisory');
  }
  validateQuality(report.quality);
  validateTargetAttainment(report.targetAttainment);
  validateRegression(report.regression);
  validateReadiness(report.readiness);
  validateVisualSummary(report.visuals);
  validateCoverage(report.coverage);
  validateNumericalScore(report.scoring);
  validateStaticPatterns(report.staticPatterns);
  for (const field of ['useCases', 'journeys', 'findings']) {
    if (!Array.isArray(report[field])) {
      throw new VerdictReportError(`report.${field} must be an array`);
    }
  }
  assertMap(report.details, 'report.details');
  assertExactKeys(report.details, ['steps', 'observations'], 'report.details');
  if (!Array.isArray(report.details.steps) || !Array.isArray(report.details.observations)) {
    throw new VerdictReportError('report.details is invalid');
  }
  const journeyIds = uniqueIds(report.journeys, 'report.journeys');
  const findingIds = uniqueIds(report.findings, 'report.findings');
  assertMap(report.recommendations, 'report.recommendations');
  assertExactKeys(
    report.recommendations,
    ['status', 'items'],
    'report.recommendations',
  );
  if (
    !['available', 'none'].includes(report.recommendations.status) ||
    !Array.isArray(report.recommendations.items) ||
    (report.recommendations.items.length > 0) !==
      (report.recommendations.status === 'available')
  ) {
    throw new VerdictReportError('report.recommendations is invalid');
  }
  const recommendationIds = uniqueIds(
    report.recommendations.items,
    'report.recommendations.items',
  );
  const useCaseIds = new Set();
  for (const [index, journey] of report.journeys.entries()) {
    validateJourney(journey, `report.journeys[${index}]`, findingIds);
  }
  for (const [index, useCase] of report.useCases.entries()) {
    validateUseCase(
      useCase,
      `report.useCases[${index}]`,
      journeyIds,
      findingIds,
      recommendationIds,
    );
    if (useCaseIds.has(useCase.useCaseId)) {
      throw new VerdictReportError(`report.useCases repeats ${useCase.useCaseId}`);
    }
    useCaseIds.add(useCase.useCaseId);
  }
  for (const [index, recommendation] of report.recommendations.items.entries()) {
    const path = `report.recommendations.items[${index}]`;
    assertMap(recommendation, path);
    assertExactKeys(
      recommendation,
      [
        'id',
        'findingRef',
        'targetRef',
        'useCaseId',
        'severity',
        'type',
        'affectedJourneyRefs',
        'text',
      ],
      path,
    );
    if (recommendation.findingRef !== null && !findingIds.has(recommendation.findingRef)) {
      throw new VerdictReportError(`${path}.findingRef is invalid`);
    }
    if (recommendation.targetRef !== null) {
      assertText(recommendation.targetRef, `${path}.targetRef`);
    }
    if (
      recommendation.findingRef !== null &&
      recommendation.targetRef !== null
    ) {
      throw new VerdictReportError(
        `${path} cannot reference a finding and target together`,
      );
    }
    if (recommendation.useCaseId !== null) {
      assertText(recommendation.useCaseId, `${path}.useCaseId`);
    }
    if (
      !Array.isArray(recommendation.affectedJourneyRefs) ||
      recommendation.affectedJourneyRefs.some((id) => !journeyIds.has(id))
    ) {
      throw new VerdictReportError(`${path}.affectedJourneyRefs is invalid`);
    }
    assertText(recommendation.text, `${path}.text`);
  }
  return report;
}

export function serializeVerdictReport(report) {
  validateVerdictReport(report);
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}

export function parseVerdictReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new VerdictReportError('verdict report is not valid JSON');
  }
  if (report?.kind === VERDICT_REPORT_KIND && report.version !== VERDICT_REPORT_VERSION) {
    throw new VerdictReportError(
      `unsupported verdict report version ${String(report.version)}; migrate to version ${VERDICT_REPORT_VERSION}`,
    );
  }
  return validateVerdictReport(report);
}

export function renderVerdictMarkdown(report) {
  validateVerdictReport(report);
  const lines = [
    '# ux-guard advisory verdict report',
    '',
    '> Advisory evidence only. Journey and visual results do not change the command exit status.',
    '',
    '## Run and evidence status',
    '',
    `- **Run result:** ${capitalize(report.run.completion.result)} (${report.run.completion.received}/${report.run.completion.expected} required variants aggregated)`,
    `- **Candidate commit:** ${report.run.provenance.candidate.commit ?? 'Unavailable locally'}`,
    `- **Trusted/base commit:** ${report.run.provenance.base.commit ?? 'Not supplied'}`,
    `- **Policy digest:** \`${report.run.policy.digest}\``,
    `- **Browser/profile:** ${report.run.browser.name} / ${report.run.browser.profile}`,
    `- **Quality verdict:** ${verdictLabel(report.quality.verdict)} — ${report.quality.reason}`,
    `- **Target attainment:** ${targetAttainmentLabel(report.targetAttainment)}`,
    `- **Regression/backslide:** ${comparisonLabel(report.regression.journeyComparison)}`,
    `- **Visual evidence:** ${visualLabel(report.visuals)}`,
    `- **Scoring readiness:** ${capitalize(report.readiness.state)} — ${report.readiness.reasons.join('; ')}`,
    '- **Execution trust:** Candidate ux-guard code produced this diagnostic; only pinned-base authoritative regeneration may create the authoritative advisory artifact.',
    `- **Numerical scoring:** ${scoreLabel(report.scoring)}`,
    `- **Accessibility:** ${report.quality.dimensions.find(({ dimension }) => dimension === 'accessibility').reason}`,
    `- **Pattern debt:** ${report.staticPatterns.meaning}`,
  ];
  if (report.run.errors.length) {
    lines.push('- **Run errors:**');
    for (const error of report.run.errors) {
      lines.push(`  - \`${error.journeyRef}\` (${error.category}): ${error.message}`);
    }
  } else {
    lines.push('- **Run errors:** None.');
  }
  if (report.staticPatterns.findings.length) {
    lines.push('- **Observed pattern-debt growth:**');
    for (const finding of report.staticPatterns.findings) {
      lines.push(`  - **${finding.ruleId}:** ${finding.summary}`);
    }
  } else {
    lines.push('- **Observed pattern-debt growth:** None detected.');
  }
  lines.push(
    '',
    '## Target attainment',
    '',
    `**${targetAttainmentLabel(report.targetAttainment)}**`,
    '',
  );
  if (report.targetAttainment.hardFloors.length === 0) {
    lines.push('No reviewed target values were evaluated.', '');
  } else {
    for (const floor of report.targetAttainment.hardFloors) {
      lines.push(
        `- \`${floor.id}\`: **${floor.status}** (actual ${floor.actual}; ${operatorLabel(floor.operator)} ${floor.target})`,
      );
    }
    for (const journey of report.targetAttainment.journeys) {
      for (const metric of journey.metrics) {
        lines.push(
          `- \`${journey.journeyRef}/${metric.metric}\`: **${metric.status}** (actual ${metric.actual ?? 'unavailable'}; ${operatorLabel(metric.operator)} ${metric.target})`,
        );
      }
    }
    lines.push('');
  }

  lines.push(
    '## Regression and backslide',
    '',
    `- **Journey comparison:** ${comparisonLabel(report.regression.journeyComparison)}`,
    `- **Metric comparison completeness:** ${report.regression.journeyComparison.completeness.status} (${report.regression.journeyComparison.completeness.metrics.notEvaluated} not evaluated)`,
    `- **Pattern comparison:** ${report.regression.patternDebt.reason}`,
    '- **Interpretation:** Equality with a reviewed baseline means no observed backslide; it does not mean the UX is good or that known defects are acceptable.',
    '',
    '## Numerical scores',
    '',
    `${scoreLabel(report.scoring)} Scores are based only on reviewed owner metric targets; baselines never produce scores.`,
    '',
  );
  const scoredUseCases = report.scoring.useCases.filter(
    ({ score }) => score !== null,
  );
  if (scoredUseCases.length === 0) {
    lines.push('No use case has a target-backed numerical score.', '');
  } else {
    for (const useCase of scoredUseCases) {
      lines.push(
        `- \`${useCase.useCaseId}\`: **${useCase.score}** (${useCase.status}; minimum of ${useCase.scoredJourneys} scored required journey${useCase.scoredJourneys === 1 ? '' : 's'})`,
      );
    }
    lines.push('');
  }

  lines.push('## Recommendations', '');
  if (report.recommendations.items.length === 0) {
    lines.push('No policy-bound recommendation was generated.', '');
  } else {
    for (const recommendation of report.recommendations.items) {
      lines.push(
        `- **${capitalize(recommendation.severity)} — ${recommendation.id}:** ${recommendation.text}`,
      );
    }
    lines.push('');
  }

  const groups = [
    ['Incomplete and missing product paths', ['incomplete']],
    ['Needs-improvement findings', ['needs-improvement']],
    ['Acceptable cases', ['acceptable']],
  ];
  for (const [heading, verdicts] of groups) {
    lines.push(`## ${heading}`, '');
    const selected = report.useCases.filter((useCase) => verdicts.includes(useCase.verdict));
    if (selected.length === 0) {
      lines.push('None.', '');
      continue;
    }
    for (const useCase of selected) renderUseCase(lines, report, useCase);
  }

  lines.push('## Evidence details', '');
  if (report.findings.length === 0) {
    lines.push('No policy findings generated evidence records.', '');
  } else {
    for (const finding of report.findings) {
      lines.push(`### ${finding.ruleId}`, '');
      for (const evidence of finding.evidence) {
        lines.push(
          `- \`${evidence.id}\` — ${variantLabel(report, evidence.journeyRef)} / step \`${evidence.stepId}\`: ${renderFacts(evidence.facts)}`,
        );
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderUseCase(lines, report, useCase) {
  lines.push(
    `### ${useCase.title} (\`${useCase.useCaseId}\`)`,
    '',
    `- **Verdict:** ${verdictLabel(useCase.verdict)}`,
    `- **Coverage:** ${useCase.coverage.successfulVariants}/${useCase.coverage.requiredVariants} successful; ${useCase.coverage.measuredVariants}/${useCase.coverage.requiredVariants} measured`,
    `- **Reason:** ${useCase.reason}`,
  );
  const affected = report.journeys
    .filter((journey) => useCase.journeyRefs.includes(journey.id))
    .sort(
      (left, right) =>
        STATUS_ORDER.get(left.executionStatus) - STATUS_ORDER.get(right.executionStatus) ||
        left.label.localeCompare(right.label),
    );
  for (const journey of affected) {
    lines.push(
      `  - **${journey.label}:** ${statusLabel(journey.executionStatus)}${
        journey.metrics ? `; ${renderMetrics(journey.metrics)}` : ''
      }`,
    );
  }
  if (useCase.findingRefs.length) {
    lines.push('- **Findings:**');
    for (const findingRef of useCase.findingRefs) {
      const finding = report.findings.find((candidate) => candidate.id === findingRef);
      const labels = finding.journeyRefs.map((journeyRef) => variantLabel(report, journeyRef));
      lines.push(
        `  - **${finding.ruleId}** — ${capitalize(finding.severity)} ${finding.type}; ${finding.dimension}; affects ${labels.join(', ')}`,
        `    - ${finding.summary}`,
        `    - Recommendation: ${finding.recommendation}`,
        `    - Evidence: ${finding.evidence.map((evidence) => `\`${evidence.id}\``).join(', ')}`,
      );
    }
  }
  lines.push('');
}

function bindFinding(finding, catalogById, definitions, journeys) {
  const affected = finding.journeyRefs.map((journeyRef) =>
    journeys.find((journey) => journey.id === journeyRef),
  );
  if (affected.some((journey) => !journey)) {
    throw new VerdictReportError(`${finding.ruleId} names an unknown journey`);
  }
  const useCases = new Set(affected.map((journey) => journey.useCaseId));
  if (useCases.size !== 1) {
    throw new VerdictReportError(`${finding.ruleId} spans multiple use cases`);
  }
  const useCaseId = [...useCases][0];
  const useCase = catalogById.get(useCaseId);
  for (const reference of finding.policy) {
    if (reference.source === 'use-case-requirement') {
      if (!useCase.requirements.includes(reference.statement)) {
        throw new VerdictReportError(
          `${finding.ruleId} does not match an owner requirement for ${useCaseId}`,
        );
      }
      continue;
    }
    if (
      !affected.some((journey) => {
        const definition = definitions.get(`${journey.useCaseId}\0${journey.journeyId}`);
        if (definition.approval.status !== 'owner-approved') return false;
        const values =
          reference.field === 'intent.steps'
            ? definition.intent.steps
            : reference.field === 'intent.summary'
              ? [definition.intent.summary]
              : [definition.intent.success];
        return values.includes(reference.statement);
      })
    ) {
      throw new VerdictReportError(
        `${finding.ruleId} does not match approved journey ${reference.field}`,
      );
    }
  }
}

function crossVariantComparison(journeys) {
  const occurrence = new Map();
  for (const journey of journeys.filter((candidate) => candidate.executionStatus !== 'unmeasured')) {
    for (const findingRef of journey.findingRefs) {
      const refs = occurrence.get(findingRef) ?? [];
      refs.push(journey.id);
      occurrence.set(findingRef, refs);
    }
  }
  return {
    status: journeys.every((journey) => journey.executionStatus !== 'unmeasured')
      ? 'complete'
      : 'partial',
    sharedFindingRefs: [...occurrence.entries()]
      .filter(([, refs]) => refs.length === journeys.length)
      .map(([findingRef]) => findingRef)
      .sort(),
    differingFindingRefs: [...occurrence.entries()]
      .filter(([, refs]) => refs.length < journeys.length)
      .map(([findingRef, journeyRefs]) => ({
        findingRef,
        journeyRefs: [...journeyRefs].sort(),
      }))
      .sort((left, right) => left.findingRef.localeCompare(right.findingRef)),
  };
}

function createStaticPatternReport(patterns) {
  const raw = patterns?.findings ?? [];
  if (!Array.isArray(raw)) throw new VerdictReportError('patterns.findings must be an array');
  const findings = [...raw]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((finding) => ({
      id: `finding.pattern.${finding.rule}.${finding.key ?? finding.file ?? 'global'}`,
      ruleId: `pattern.${finding.rule}`,
      severity: 'medium',
      dimension: 'consistency',
      type: 'regression',
      summary:
        finding.rule === 'new-control-value'
          ? `${finding.key} introduces value ${finding.value} beyond the reviewed pattern baseline.`
          : `${finding.rule} grew beyond the reviewed pattern baseline${finding.file ? ` in ${finding.file}` : ''}.`,
      evidence: structuredClone(finding),
      recommendation:
        finding.rule === 'new-control-value'
          ? 'Use a reviewed existing control value, or obtain explicit pattern-policy review.'
          : 'Remove the new pattern debt, or obtain explicit review before changing the baseline.',
    }));
  return {
    status: findings.length ? 'growth' : 'no-growth',
    baseline: {
      status: 'reviewed',
      regressionStatus: findings.length ? 'regression' : 'unchanged',
    },
    meaning: findings.length
      ? 'Observed pattern debt grew beyond the reviewed non-growth baseline; preferred-pattern alignment was not evaluated.'
      : 'No observed pattern-debt growth; preferred-pattern alignment was not evaluated.',
    findings,
  };
}

function catalogUseCases(catalog) {
  const entries = Array.isArray(catalog?.useCases)
    ? catalog.useCases
    : Array.isArray(catalog?.use_cases)
      ? catalog.use_cases
      : null;
  if (!entries) throw new VerdictReportError('catalog must contain use cases');
  return entries.map((entry) => {
    if (
      typeof entry?.id !== 'string' ||
      typeof entry?.title !== 'string' ||
      !Array.isArray(entry.requirements ?? [])
    ) {
      throw new VerdictReportError('catalog contains an invalid use case');
    }
    return { ...entry, requirements: entry.requirements ?? [] };
  });
}

function useCaseReason(journeys, findingCount) {
  const incomplete = journeys.filter((journey) => journey.executionStatus !== 'successful');
  if (incomplete.length) {
    return `Coverage is incomplete: ${incomplete
      .map((journey) => `${journey.label} is ${journey.executionStatus}`)
      .join('; ')}.`;
  }
  if (findingCount) {
    return `Coverage is complete, and ${findingCount} policy-evaluated finding${findingCount === 1 ? '' : 's'} remain.`;
  }
  return 'Coverage is complete and no policy-evaluated finding was generated.';
}

function validateCoverage(coverage) {
  assertMap(coverage, 'report.coverage');
  assertExactKeys(
    coverage,
    [
      'status',
      'cataloguedUseCases',
      'reportedUseCases',
      'requiredVariants',
      'measuredVariants',
      'successfulVariants',
    ],
    'report.coverage',
  );
  if (!['complete', 'incomplete'].includes(coverage.status)) {
    throw new VerdictReportError('report.coverage.status is invalid');
  }
  for (const field of [
    'cataloguedUseCases',
    'reportedUseCases',
    'requiredVariants',
    'measuredVariants',
    'successfulVariants',
  ]) {
    if (!Number.isSafeInteger(coverage[field]) || coverage[field] < 0) {
      throw new VerdictReportError(`report.coverage.${field} is invalid`);
    }
  }
}

function validateUseCase(useCase, path, journeyIds, findingIds, recommendationIds) {
  assertMap(useCase, path);
  assertExactKeys(
    useCase,
    [
      'useCaseId',
      'title',
      'verdict',
      'reason',
      'coverage',
      'journeyRefs',
      'findingRefs',
      'recommendationRefs',
      'comparison',
    ],
    path,
  );
  assertText(useCase.useCaseId, `${path}.useCaseId`);
  assertText(useCase.title, `${path}.title`);
  assertText(useCase.reason, `${path}.reason`);
  assertVerdict(useCase.verdict, `${path}.verdict`);
  validateRefs(useCase.journeyRefs, journeyIds, `${path}.journeyRefs`);
  validateRefs(useCase.findingRefs, findingIds, `${path}.findingRefs`);
  validateRefs(useCase.recommendationRefs, recommendationIds, `${path}.recommendationRefs`);
  assertMap(useCase.coverage, `${path}.coverage`);
  assertMap(useCase.comparison, `${path}.comparison`);
}

function validateJourney(journey, path, findingIds) {
  assertMap(journey, path);
  assertExactKeys(
    journey,
    [
      'id',
      'useCaseId',
      'variantId',
      'label',
      'journeyId',
      'executionStatus',
      'verdict',
      'metrics',
      'findingRefs',
    ],
    path,
  );
  for (const field of ['id', 'useCaseId', 'variantId', 'label', 'journeyId']) {
    assertText(journey[field], `${path}.${field}`);
  }
  if (!STATUS_ORDER.has(journey.executionStatus)) {
    throw new VerdictReportError(`${path}.executionStatus is invalid`);
  }
  assertVerdict(journey.verdict, `${path}.verdict`);
  validateRefs(journey.findingRefs, findingIds, `${path}.findingRefs`);
}

function validateStaticPatterns(patterns) {
  assertMap(patterns, 'report.staticPatterns');
  assertExactKeys(
    patterns,
    ['status', 'baseline', 'meaning', 'findings'],
    'report.staticPatterns',
  );
  if (!['growth', 'no-growth'].includes(patterns.status)) {
    throw new VerdictReportError('report.staticPatterns.status is invalid');
  }
  assertText(patterns.meaning, 'report.staticPatterns.meaning');
  validateBaseline(patterns.baseline, 'report.staticPatterns.baseline');
  if (
    patterns.baseline.status !== 'reviewed' ||
    patterns.baseline.regressionStatus !==
      (patterns.status === 'growth' ? 'regression' : 'unchanged')
  ) {
    throw new VerdictReportError('report.staticPatterns.baseline is invalid');
  }
  if (!Array.isArray(patterns.findings)) {
    throw new VerdictReportError('report.staticPatterns.findings must be an array');
  }
}

function reportBaseline(comparison) {
  const reviewed = comparison.baselineHash !== null;
  return {
    status: reviewed ? 'reviewed' : 'not-reviewed',
    regressionStatus:
      comparison.status === 'unavailable' && !reviewed
        ? 'not-evaluated'
        : comparison.status,
  };
}

function validateBaseline(baseline, path) {
  assertMap(baseline, path);
  assertExactKeys(baseline, ['status', 'regressionStatus'], path);
  if (!['not-reviewed', 'reviewed'].includes(baseline.status)) {
    throw new VerdictReportError(`${path}.status is invalid`);
  }
  if (
    ![
      'not-evaluated',
      'regression',
      'improvement',
      'unchanged',
      'incompatible',
      'unavailable',
    ].includes(baseline.regressionStatus)
  ) {
    throw new VerdictReportError(`${path}.regressionStatus is invalid`);
  }
  if (baseline.status === 'not-reviewed' && baseline.regressionStatus !== 'not-evaluated') {
    throw new VerdictReportError(`${path} cannot evaluate an unreviewed baseline`);
  }
}

function qualityReason(verdict, useCases) {
  if (verdict === 'incomplete') {
    const incomplete = useCases.filter(
      (useCase) => useCase.verdict === 'incomplete',
    ).length;
    return `${incomplete} use case${incomplete === 1 ? ' is' : 's are'} incomplete; baseline equality cannot make missing product paths acceptable.`;
  }
  if (verdict === 'needs-improvement') {
    return 'Required journeys completed, but policy-evaluated findings remain.';
  }
  return 'Required journeys completed and no configured policy finding was generated; this is not a claim of universally good UX.';
}

function qualityDimensions(findings) {
  return DIMENSIONS.map((dimension) => {
    const findingRefs = findings
      .filter((finding) => finding.dimension === dimension)
      .map(({ id }) => id)
      .sort();
    if (findingRefs.length) {
      return {
        dimension,
        status: 'findings',
        findingRefs,
        reason: `${findingRefs.length} policy-evaluated finding${findingRefs.length === 1 ? '' : 's'} remain.`,
      };
    }
    if (dimension === 'accessibility') {
      return {
        dimension,
        status: 'not-measured',
        findingRefs: [],
        reason:
          'Not comprehensively measured; zero accessibility findings is not evidence of good accessibility.',
      };
    }
    return {
      dimension,
      status: 'no-policy-findings',
      findingRefs: [],
      reason:
        'No configured policy finding was generated; this is not a measured-good claim.',
    };
  });
}

function validateQuality(quality) {
  assertMap(quality, 'report.quality');
  assertExactKeys(
    quality,
    ['verdict', 'reason', 'dimensions'],
    'report.quality',
  );
  assertVerdict(quality.verdict, 'report.quality.verdict');
  assertText(quality.reason, 'report.quality.reason');
  if (
    !Array.isArray(quality.dimensions) ||
    quality.dimensions.length !== DIMENSIONS.length
  ) {
    throw new VerdictReportError('report.quality.dimensions is invalid');
  }
  const dimensions = new Set();
  for (const [index, dimension] of quality.dimensions.entries()) {
    const path = `report.quality.dimensions[${index}]`;
    assertMap(dimension, path);
    assertExactKeys(
      dimension,
      ['dimension', 'status', 'findingRefs', 'reason'],
      path,
    );
    if (!DIMENSIONS.includes(dimension.dimension) || dimensions.has(dimension.dimension)) {
      throw new VerdictReportError(`${path}.dimension is invalid`);
    }
    dimensions.add(dimension.dimension);
    if (
      !['findings', 'no-policy-findings', 'not-measured'].includes(
        dimension.status,
      ) ||
      !Array.isArray(dimension.findingRefs) ||
      new Set(dimension.findingRefs).size !== dimension.findingRefs.length
    ) {
      throw new VerdictReportError(`${path} is invalid`);
    }
    assertText(dimension.reason, `${path}.reason`);
    if (
      dimension.dimension === 'accessibility' &&
      dimension.findingRefs.length === 0 &&
      dimension.status !== 'not-measured'
    ) {
      throw new VerdictReportError(
        `${path} cannot claim measured-good accessibility from zero findings`,
      );
    }
  }
}

function regressionReport(comparison, staticPatterns) {
  const patternRegression = staticPatterns.status === 'growth';
  return {
    status: patternRegression ? 'regression' : comparison.status,
    reason: patternRegression
      ? 'Observed pattern debt grew beyond the reviewed non-growth baseline.'
      : comparison.reason,
    baseline: reportBaseline(comparison),
    journeyComparison: structuredClone(comparison),
    patternDebt: {
      status: patternRegression ? 'regression' : 'no-growth',
      reason: staticPatterns.meaning,
    },
  };
}

function validateRegression(regression) {
  assertMap(regression, 'report.regression');
  assertExactKeys(
    regression,
    ['status', 'reason', 'baseline', 'journeyComparison', 'patternDebt'],
    'report.regression',
  );
  if (
    ![
      'regression',
      'improvement',
      'unchanged',
      'incompatible',
      'unavailable',
    ].includes(regression.status)
  ) {
    throw new VerdictReportError('report.regression.status is invalid');
  }
  assertText(regression.reason, 'report.regression.reason');
  validateBaseline(regression.baseline, 'report.regression.baseline');
  validateJourneyComparison(regression.journeyComparison);
  assertMap(regression.patternDebt, 'report.regression.patternDebt');
  assertExactKeys(
    regression.patternDebt,
    ['status', 'reason'],
    'report.regression.patternDebt',
  );
  if (!['regression', 'no-growth'].includes(regression.patternDebt.status)) {
    throw new VerdictReportError('report.regression.patternDebt.status is invalid');
  }
  assertText(regression.patternDebt.reason, 'report.regression.patternDebt.reason');
  const expected =
    regression.patternDebt.status === 'regression'
      ? 'regression'
      : regression.journeyComparison.status;
  if (regression.status !== expected) {
    throw new VerdictReportError(
      'report.regression.status does not match its independent comparisons',
    );
  }
  const expectedBaseline = reportBaseline(regression.journeyComparison);
  if (
    regression.baseline.status !== expectedBaseline.status ||
    regression.baseline.regressionStatus !== expectedBaseline.regressionStatus
  ) {
    throw new VerdictReportError(
      'report.regression.baseline does not match its journey comparison',
    );
  }
}

function numericalScore(policy, attainment) {
  const targetBacked = ['met', 'breached', 'partial'].includes(
    attainment.status,
  );
  const targetJourneys = new Map(
    attainment.journeys.map((journey) => [journey.journeyRef, journey]),
  );
  const journeys = policy.coverage.flatMap((coverage) =>
    coverage.requiredVariants.map((variant) => {
      const journeyRef = `journey.${coverage.useCaseId}.${variant.journeyId}`;
      const target = targetJourneys.get(journeyRef);
      if (!target) {
        return {
          journeyRef,
          useCaseId: coverage.useCaseId,
          status: 'not-targeted',
          score: null,
          configuredMetrics: 0,
          scoredMetrics: 0,
          reason: 'No reviewed metric target is configured for this journey.',
          metrics: [],
        };
      }
      const metrics = target.metrics.map((metric) => {
        if (metric.operator !== 'at-most') {
          return {
            metric: metric.metric,
            status: 'not-scored',
            target: metric.target,
            actual: metric.actual,
            score: null,
            reason: `${metric.operator} targets do not have an approved numerical scoring formula.`,
          };
        }
        if (metric.actual === null || target.executionStatus !== 'successful') {
          return {
            metric: metric.metric,
            status: 'not-scored',
            target: metric.target,
            actual: metric.actual,
            score: null,
            reason: `${target.executionStatus} journey evidence is not scoreable.`,
          };
        }
        return {
          metric: metric.metric,
          status: 'scored',
          target: metric.target,
          actual: metric.actual,
          score: atMostScore(metric.actual, metric.target),
          reason:
            metric.actual <= metric.target
              ? 'The measured value attained the reviewed at-most target.'
              : 'The measured value exceeded the reviewed at-most target.',
        };
      });
      const metricScores = metrics
        .map(({ score }) => score)
        .filter((score) => score !== null);
      const score = metricScores.length ? Math.min(...metricScores) : null;
      const status =
        metricScores.length === 0
          ? 'not-scored'
          : metricScores.length === metrics.length
            ? 'scored'
            : 'partially-scored';
      return {
        journeyRef,
        useCaseId: coverage.useCaseId,
        status,
        score,
        configuredMetrics: metrics.length,
        scoredMetrics: metricScores.length,
        reason:
          status === 'scored'
            ? 'Score is the minimum configured metric score; stronger metrics cannot compensate for the weakest metric.'
            : status === 'partially-scored'
              ? 'Score uses the available configured metric scores; at least one configured metric was not scoreable.'
              : 'Configured target metrics were unavailable or had no approved scoring formula.',
        metrics,
      };
    }),
  );
  const byJourney = new Map(
    journeys.map((journey) => [journey.journeyRef, journey]),
  );
  const useCases = policy.coverage.map((coverage) => {
    const journeyRefs = coverage.requiredVariants.map(
      (variant) => `journey.${coverage.useCaseId}.${variant.journeyId}`,
    );
    const required = journeyRefs.map((journeyRef) => byJourney.get(journeyRef));
    const configuredJourneys = required.filter(
      ({ status }) => status !== 'not-targeted',
    ).length;
    const scores = required
      .map(({ score }) => score)
      .filter((score) => score !== null);
    const status =
      scores.length === 0
        ? 'not-scored'
        : scores.length === required.length &&
            required.every(({ status: journeyStatus }) => journeyStatus === 'scored')
          ? 'scored'
          : 'partially-scored';
    return {
      useCaseId: coverage.useCaseId,
      status,
      score: scores.length ? Math.min(...scores) : null,
      requiredJourneys: required.length,
      configuredJourneys,
      scoredJourneys: scores.length,
      journeyRefs,
      reason:
        scores.length === 0
          ? 'No required journey has a target-backed numerical score.'
          : 'Score is the minimum required scored journey; stronger journeys cannot compensate for the weakest scored journey.',
    };
  });
  const scoredUseCases = useCases.filter(({ score }) => score !== null).length;
  const status =
    scoredUseCases === 0
      ? 'not-scored'
      : useCases.every(({ status: useCaseStatus }) => useCaseStatus === 'scored')
        ? 'scored'
        : 'partially-scored';
  return {
    kind: 'ux-guard-numerical-score',
    version: 1,
    status,
    reason:
      status === 'not-scored'
        ? 'No reviewed at-most metric target produced a score.'
        : status === 'scored'
          ? 'Every required journey has a target-backed score.'
          : 'Only part of the required journey set has target-backed scores.',
    aggregation: 'minimum',
    basis: {
      type: targetBacked ? 'reviewed-owner-targets' : 'none',
      targetHash: targetBacked ? attainment.canonicalHash : null,
    },
    useCases,
    journeys,
  };
}

function atMostScore(actual, target) {
  if (actual <= target) return 100;
  if (target === 0) return 0;
  return Math.round((100 * target) / actual);
}

function validateNumericalScore(scoring) {
  assertMap(scoring, 'report.scoring');
  assertExactKeys(
    scoring,
    [
      'kind',
      'version',
      'status',
      'reason',
      'aggregation',
      'basis',
      'useCases',
      'journeys',
    ],
    'report.scoring',
  );
  if (
    scoring.kind !== 'ux-guard-numerical-score' ||
    scoring.version !== 1 ||
    !['scored', 'partially-scored', 'not-scored'].includes(scoring.status) ||
    scoring.aggregation !== 'minimum'
  ) {
    throw new VerdictReportError('report.scoring has an unsupported contract');
  }
  assertText(scoring.reason, 'report.scoring.reason');
  assertMap(scoring.basis, 'report.scoring.basis');
  assertExactKeys(
    scoring.basis,
    ['type', 'targetHash'],
    'report.scoring.basis',
  );
  if (!['reviewed-owner-targets', 'none'].includes(scoring.basis.type)) {
    throw new VerdictReportError('report.scoring.basis.type is invalid');
  }
  if (
    scoring.basis.targetHash !== null &&
    !/^sha256:[a-f0-9]{64}$/.test(scoring.basis.targetHash)
  ) {
    throw new VerdictReportError('report.scoring.basis.targetHash is invalid');
  }
  if (
    (scoring.basis.type === 'none') !==
    (scoring.basis.targetHash === null)
  ) {
    throw new VerdictReportError('report.scoring.basis is inconsistent');
  }
  if (!Array.isArray(scoring.journeys) || !Array.isArray(scoring.useCases)) {
    throw new VerdictReportError(
      'report.scoring useCases and journeys must be arrays',
    );
  }
  const journeys = new Map();
  for (const [index, journey] of scoring.journeys.entries()) {
    const path = `report.scoring.journeys[${index}]`;
    assertMap(journey, path);
    assertExactKeys(
      journey,
      [
        'journeyRef',
        'useCaseId',
        'status',
        'score',
        'configuredMetrics',
        'scoredMetrics',
        'reason',
        'metrics',
      ],
      path,
    );
    for (const field of ['journeyRef', 'useCaseId', 'reason']) {
      assertText(journey[field], `${path}.${field}`);
    }
    if (
      !['scored', 'partially-scored', 'not-scored', 'not-targeted'].includes(
        journey.status,
      ) ||
      journeys.has(journey.journeyRef) ||
      !Array.isArray(journey.metrics)
    ) {
      throw new VerdictReportError(`${path} is invalid`);
    }
    for (const field of ['configuredMetrics', 'scoredMetrics']) {
      if (!Number.isSafeInteger(journey[field]) || journey[field] < 0) {
        throw new VerdictReportError(`${path}.${field} is invalid`);
      }
    }
    const metricScores = [];
    const metricNames = new Set();
    for (const [metricIndex, metric] of journey.metrics.entries()) {
      const metricPath = `${path}.metrics[${metricIndex}]`;
      assertMap(metric, metricPath);
      assertExactKeys(
        metric,
        ['metric', 'status', 'target', 'actual', 'score', 'reason'],
        metricPath,
      );
      assertText(metric.metric, `${metricPath}.metric`);
      assertText(metric.reason, `${metricPath}.reason`);
      if (
        metricNames.has(metric.metric) ||
        !['scored', 'not-scored'].includes(metric.status)
      ) {
        throw new VerdictReportError(`${metricPath} is invalid`);
      }
      metricNames.add(metric.metric);
      if (!Number.isSafeInteger(metric.target) || metric.target < 0) {
        throw new VerdictReportError(`${metricPath}.target is invalid`);
      }
      if (
        metric.actual !== null &&
        (!Number.isSafeInteger(metric.actual) || metric.actual < 0)
      ) {
        throw new VerdictReportError(`${metricPath}.actual is invalid`);
      }
      if (metric.status === 'scored') {
        if (
          metric.actual === null ||
          metric.score !== atMostScore(metric.actual, metric.target)
        ) {
          throw new VerdictReportError(`${metricPath}.score is invalid`);
        }
        metricScores.push(metric.score);
      } else if (metric.score !== null) {
        throw new VerdictReportError(`${metricPath}.score must be null`);
      }
    }
    const expectedScore = metricScores.length ? Math.min(...metricScores) : null;
    const expectedStatus =
      journey.metrics.length === 0
        ? 'not-targeted'
        : metricScores.length === 0
          ? 'not-scored'
          : metricScores.length === journey.metrics.length
            ? 'scored'
            : 'partially-scored';
    if (
      journey.configuredMetrics !== journey.metrics.length ||
      journey.scoredMetrics !== metricScores.length ||
      journey.score !== expectedScore ||
      journey.status !== expectedStatus
    ) {
      throw new VerdictReportError(`${path} does not match its metric scores`);
    }
    journeys.set(journey.journeyRef, journey);
  }
  for (const [index, useCase] of scoring.useCases.entries()) {
    const path = `report.scoring.useCases[${index}]`;
    assertMap(useCase, path);
    assertExactKeys(
      useCase,
      [
        'useCaseId',
        'status',
        'score',
        'requiredJourneys',
        'configuredJourneys',
        'scoredJourneys',
        'journeyRefs',
        'reason',
      ],
      path,
    );
    assertText(useCase.useCaseId, `${path}.useCaseId`);
    assertText(useCase.reason, `${path}.reason`);
    if (
      !['scored', 'partially-scored', 'not-scored'].includes(useCase.status) ||
      !Array.isArray(useCase.journeyRefs) ||
      useCase.journeyRefs.some((journeyRef) => !journeys.has(journeyRef))
    ) {
      throw new VerdictReportError(`${path} is invalid`);
    }
    const required = useCase.journeyRefs.map((journeyRef) =>
      journeys.get(journeyRef),
    );
    const scores = required
      .map(({ score }) => score)
      .filter((score) => score !== null);
    const configured = required.filter(
      ({ status }) => status !== 'not-targeted',
    ).length;
    const expectedStatus =
      scores.length === 0
        ? 'not-scored'
        : scores.length === required.length &&
            required.every(({ status }) => status === 'scored')
          ? 'scored'
          : 'partially-scored';
    if (
      useCase.requiredJourneys !== required.length ||
      useCase.configuredJourneys !== configured ||
      useCase.scoredJourneys !== scores.length ||
      useCase.score !== (scores.length ? Math.min(...scores) : null) ||
      useCase.status !== expectedStatus
    ) {
      throw new VerdictReportError(`${path} does not match its journey scores`);
    }
  }
  const scored = scoring.useCases.filter(({ score }) => score !== null).length;
  const expectedStatus =
    scored === 0
      ? 'not-scored'
      : scoring.useCases.every(({ status }) => status === 'scored')
        ? 'scored'
        : 'partially-scored';
  if (scoring.status !== expectedStatus) {
    throw new VerdictReportError('report.scoring.status is inconsistent');
  }
}

function targetRecommendations(attainment) {
  const recommendations = [];
  for (const floor of attainment.hardFloors.filter(
    ({ status }) => status === 'breached',
  )) {
    const targetRef = `hard-floor.${kebab(floor.id)}`;
    recommendations.push({
      id: `recommendation.target.${targetRef}`,
      findingRef: null,
      targetRef,
      useCaseId: null,
      severity: 'high',
      type: 'target',
      affectedJourneyRefs: [],
      text: floorRecommendation(floor),
    });
  }
  for (const journey of attainment.journeys) {
    for (const metric of journey.metrics.filter(
      ({ status }) => status === 'breached',
    )) {
      const targetRef = `${journey.journeyRef}.${metric.metric}`;
      recommendations.push({
        id: `recommendation.target.${targetRef}`,
        findingRef: null,
        targetRef,
        useCaseId: journey.useCaseId,
        severity: 'medium',
        type: 'target',
        affectedJourneyRefs: [journey.journeyRef],
        text: `${metric.operator === 'at-most' ? 'Reduce' : 'Adjust'} ${metric.metric} for ${journey.journeyRef} to ${operatorLabel(metric.operator)} ${metric.target}; the measured value is ${metric.actual}.`,
      });
    }
  }
  return recommendations;
}

function floorRecommendation(floor) {
  if (floor.operator === 'at-least') {
    return `Increase ${floor.id} to at least ${floor.target}; the measured value is ${floor.actual}.`;
  }
  return `Reduce ${floor.id} to at most ${floor.target}; the measured value is ${floor.actual}.`;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function defaultVisualSummary() {
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
    comparison: unavailableVisualComparison('visual evidence was not supplied'),
  };
}

function normalizeVisualSummary(visuals) {
  const normalized = structuredClone(visuals);
  validateVisualSummary(normalized);
  return normalized;
}

function validateVisualSummary(visuals) {
  assertMap(visuals, 'report.visuals');
  assertExactKeys(
    visuals,
    ['rollout', 'status', 'candidate', 'baseline', 'comparison'],
    'report.visuals',
  );
  if (visuals.rollout !== 'advisory') {
    throw new VerdictReportError('report.visuals.rollout must be advisory');
  }
  if (
    ![
      'not-evaluated',
      'unchanged',
      'added',
      'missing',
      'changed',
      'incompatible',
      'error',
    ].includes(visuals.status)
  ) {
    throw new VerdictReportError('report.visuals.status is invalid');
  }
  assertMap(visuals.candidate, 'report.visuals.candidate');
  assertExactKeys(
    visuals.candidate,
    ['status', 'manifestPath', 'canonicalHash', 'images', 'repetitions'],
    'report.visuals.candidate',
  );
  if (!['unavailable', 'available-unapproved'].includes(visuals.candidate.status)) {
    throw new VerdictReportError('report.visuals.candidate.status is invalid');
  }
  for (const field of ['images', 'repetitions']) {
    if (
      !Number.isSafeInteger(visuals.candidate[field]) ||
      visuals.candidate[field] < 0
    ) {
      throw new VerdictReportError(`report.visuals.candidate.${field} is invalid`);
    }
  }
  validateOptionalPathAndHash(visuals.candidate, 'report.visuals.candidate');
  assertMap(visuals.baseline, 'report.visuals.baseline');
  assertExactKeys(
    visuals.baseline,
    ['status', 'manifestPath', 'canonicalHash'],
    'report.visuals.baseline',
  );
  if (!['not-reviewed', 'reviewed'].includes(visuals.baseline.status)) {
    throw new VerdictReportError('report.visuals.baseline.status is invalid');
  }
  validateOptionalPathAndHash(visuals.baseline, 'report.visuals.baseline');
  validateVisualComparison(visuals.comparison);
  if (visuals.status !== visuals.comparison.status) {
    throw new VerdictReportError('report.visuals status does not match comparison');
  }
}

function validateOptionalPathAndHash(value, path) {
  if (value.manifestPath !== null) assertText(value.manifestPath, `${path}.manifestPath`);
  if (
    value.canonicalHash !== null &&
    !/^sha256:[a-f0-9]{64}$/.test(value.canonicalHash)
  ) {
    throw new VerdictReportError(`${path}.canonicalHash is invalid`);
  }
}

function scoringReadiness({ comparison, measurements, readinessEvidence }) {
  const repetitionsText = measurements.run.adapters.repetitions;
  const repetitions =
    typeof repetitionsText === 'string' && /^[1-9]\d*$/.test(repetitionsText)
      ? Number(repetitionsText)
      : 1;
  const canaries = readinessEvidence?.canaries ?? {
    regression: 'not-recorded',
    improvement: 'not-recorded',
    compatibility: 'not-recorded',
    knownBad: 'not-recorded',
  };
  const reviewedBaseline = comparison.compatibility.status === 'compatible';
  const stableRepetitions =
    Number.isSafeInteger(repetitions) &&
    repetitions >= 3 &&
    (readinessEvidence?.stableRepetitions ?? 0) >= 3;
  const evidenceComplete =
    measurements.run.completion.received === measurements.run.completion.expected &&
    (readinessEvidence?.evidenceComplete ?? false);
  const canariesPassed = Object.values(canaries).every((status) => status === 'passed');
  const trustedExecution = readinessEvidence?.trustedExecution === true;
  const enforcementApproved = readinessEvidence?.enforcementApproved === true;
  const stable =
    reviewedBaseline &&
    stableRepetitions &&
    evidenceComplete &&
    canariesPassed &&
    readinessEvidence?.deterministicRun === true;
  const state =
    stable && trustedExecution && enforcementApproved
      ? 'gate-ready'
      : stable
        ? 'stable'
        : 'provisional';
  const reasons = [];
  if (!reviewedBaseline) reasons.push('no compatible reviewed baseline');
  if (!stableRepetitions) reasons.push('fewer than three attested stable repetitions');
  if (!evidenceComplete) reasons.push('required evidence is incomplete or unattested');
  if (!canariesPassed) reasons.push('comparison canaries are not attested in the reviewed artifact');
  if (!trustedExecution) reasons.push('candidate execution is not pinned/trusted');
  if (!enforcementApproved) reasons.push('enforcement is not owner-approved');
  if (reasons.length === 0) reasons.push('all reviewed readiness evidence is present');
  return {
    state,
    reviewedBaseline,
    stableRepetitions,
    evidenceComplete,
    canaries,
    trustedExecution,
    enforcementApproved,
    reasons,
  };
}

function validateReadiness(readiness) {
  assertMap(readiness, 'report.readiness');
  assertExactKeys(
    readiness,
    [
      'state',
      'reviewedBaseline',
      'stableRepetitions',
      'evidenceComplete',
      'canaries',
      'trustedExecution',
      'enforcementApproved',
      'reasons',
    ],
    'report.readiness',
  );
  if (!['provisional', 'stable', 'gate-ready'].includes(readiness.state)) {
    throw new VerdictReportError('report.readiness.state is invalid');
  }
  for (const field of [
    'reviewedBaseline',
    'stableRepetitions',
    'evidenceComplete',
    'trustedExecution',
    'enforcementApproved',
  ]) {
    if (typeof readiness[field] !== 'boolean') {
      throw new VerdictReportError(`report.readiness.${field} must be boolean`);
    }
  }
  assertMap(readiness.canaries, 'report.readiness.canaries');
  assertExactKeys(
    readiness.canaries,
    ['regression', 'improvement', 'compatibility', 'knownBad'],
    'report.readiness.canaries',
  );
  if (
    Object.values(readiness.canaries).some(
      (status) => !['passed', 'not-recorded'].includes(status),
    )
  ) {
    throw new VerdictReportError('report.readiness.canaries is invalid');
  }
  if (
    !Array.isArray(readiness.reasons) ||
    readiness.reasons.length === 0 ||
    readiness.reasons.some((reason) => typeof reason !== 'string' || !reason)
  ) {
    throw new VerdictReportError('report.readiness.reasons is invalid');
  }
}

function uniqueIds(records, path) {
  const ids = new Set();
  records.forEach((record, index) => {
    assertMap(record, `${path}[${index}]`);
    assertText(record.id, `${path}[${index}].id`);
    if (ids.has(record.id)) throw new VerdictReportError(`${path} repeats ${record.id}`);
    ids.add(record.id);
  });
  return ids;
}

function validateRefs(refs, available, path) {
  if (
    !Array.isArray(refs) ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => !available.has(ref))
  ) {
    throw new VerdictReportError(`${path} is invalid`);
  }
}

function compareRecommendation(left, right) {
  const severity = new Map([
    ['critical', 0],
    ['high', 1],
    ['medium', 2],
    ['low', 3],
  ]);
  return severity.get(left.severity) - severity.get(right.severity) ||
    (left.useCaseId ?? '').localeCompare(right.useCaseId ?? '') ||
    left.id.localeCompare(right.id);
}

function variantLabel(report, journeyRef) {
  return report.journeys.find((journey) => journey.id === journeyRef)?.label ?? journeyRef;
}

function renderFacts(facts) {
  return facts.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join(', ');
}

function renderMetrics(metrics) {
  return Object.entries(metrics)
    .map(([metric, value]) => `${metric}=${value}`)
    .join(', ');
}

function comparisonLabel(comparison) {
  if (comparison.status === 'unavailable') {
    return `Not evaluated — ${comparison.reason}`;
  }
  return `${capitalize(comparison.status)} — ${comparison.reason}`;
}

function targetAttainmentLabel(attainment) {
  return `${capitalize(attainment.status)} — ${attainment.reason}`;
}

function scoreLabel(scoring) {
  return `${capitalize(scoring.status)} — ${scoring.reason}`;
}

function operatorLabel(operator) {
  return {
    'at-most': 'at most',
    'at-least': 'at least',
    exactly: 'exactly',
  }[operator];
}

function visualLabel(visuals) {
  const candidate =
    visuals.candidate.status === 'available-unapproved'
      ? `${visuals.candidate.images} candidate images / ${visuals.candidate.repetitions} stable repetitions`
      : 'candidate unavailable';
  return `${capitalize(visuals.status)} — ${candidate}; ${visuals.comparison.reason}`;
}

function statusLabel(status) {
  return {
    successful: 'Successful',
    failed: 'Failed assertion',
    skipped: 'Skipped',
    unexecutable: 'Missing product path',
    'infrastructure-error': 'Infrastructure error',
    unmeasured: 'Unmeasured',
  }[status];
}

function verdictLabel(verdict) {
  return {
    incomplete: 'Incomplete',
    'needs-improvement': 'Needs improvement',
    acceptable: 'Acceptable',
  }[verdict];
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function assertVerdict(value, path) {
  if (!QUALITY_VERDICTS.has(value)) {
    throw new VerdictReportError(`${path} is invalid`);
  }
}

function assertMap(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VerdictReportError(`${path} must be an object`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new VerdictReportError(`${path} must contain ${wanted.join(', ')} only`);
  }
}

function assertText(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VerdictReportError(`${path} must be non-empty text`);
  }
}
