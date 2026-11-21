import { validateCatalog } from './catalog.mjs';
import { assertRepositoryRelativePath } from './config.mjs';
import { canonicalize, sha256 } from './run-contract.mjs';
import { ConfigError, parseYamlSubset } from './yaml.mjs';

export const USE_CASE_DRAFT_KIND = 'ux-guard-use-case-draft';
export const USE_CASE_CANDIDATE_KIND = 'ux-guard-use-case-candidate';
export const USE_CASE_REVIEW_KIND = 'ux-guard-use-case-review';
export const USE_CASE_REVIEW_VERSION = 1;
export const PREVIEW_MARKER =
  '# ux-guard use-case catalog preview: generated, unapproved, and not active policy.';

const USE_CASE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIERS = ['primary', 'secondary', 'tertiary'];
const EFFECTS = ['read', 'create', 'change'];
const CAPABILITIES = [
  'present',
  'partial',
  'absent',
  'deployment-dependent',
  'not-applicable',
  'unknown',
];
const DISPOSITIONS = ['existing-use-case', 'proposed-use-case', 'excluded', 'unresolved'];
const SURFACE_KINDS = ['destination', 'group', 'subtree', 'hidden', 'other'];
const ACTIONS = ['pending', 'approve', 'revise', 'reject', 'merge', 'split'];
const MAPPING_DISPOSITIONS = ['use-case', 'excluded', 'unresolved'];
const TEXT_FIELDS = ['title', 'persona', 'goal', 'success', 'rationale'];
const EDITABLE_FIELDS = [...TEXT_FIELDS, 'tier', 'effect', 'outcome', 'starts', 'requirements', 'gaps'];
// Accept legacy owner metadata in existing candidates and reviews without
// making it part of use-case definition or exposing it as a review field.
const ACCEPTED_USE_CASE_FIELDS = [...EDITABLE_FIELDS, 'owner'];
const CATALOG_ORDER = [
  'id',
  'title',
  'persona',
  'tier',
  'effect',
  'owner',
  'goal',
  'success',
  'starts',
  'requirements',
  'gaps',
];
const REQUIRED_FOR_CATALOG = ['title', 'persona', 'tier', 'effect', 'goal', 'success'];
const DEFINITION_LABELS = {
  title: 'Title',
  persona: 'Persona',
  tier: 'Tier',
  effect: 'Effect',
  goal: 'Goal',
  success: 'Success outcome',
};
const MAX_TEXT = 4000;
const MAX_ITEMS = 5000;

export class ReviewError extends ConfigError {
  constructor(message) {
    super(message);
    this.name = 'ReviewError';
  }
}

// validateUseCaseCandidate accepts an agent-authored draft or a stamped
// candidate. Only the CLI stamps repository identity, so a draft may not carry
// identity fields and a candidate must carry all of them.
export function validateUseCaseCandidate(value, { draft = false } = {}) {
  const path = draft ? 'draft' : 'candidate';
  assertMap(value, path);
  assertKeys(
    value,
    ['kind', 'version', 'approval', 'source', 'outcomes', 'proposals', 'surfaces', 'workflows', 'questions'],
    ['kind', 'version', 'approval', 'source'],
    path,
  );
  const kind = draft ? USE_CASE_DRAFT_KIND : USE_CASE_CANDIDATE_KIND;
  if (value.kind !== kind) throw new ReviewError(`${path}.kind must be ${kind}`);
  if (value.version !== USE_CASE_REVIEW_VERSION) {
    throw new ReviewError(`${path}.version must be ${USE_CASE_REVIEW_VERSION}`);
  }
  assertUnapproved(value.approval, `${path}.approval`);
  const source = validateSource(value.source, `${path}.source`, draft);
  const outcomes = list(value.outcomes, `${path}.outcomes`).map((item, index) =>
    validateOutcome(item, `${path}.outcomes[${index}]`),
  );
  uniqueIds(outcomes, `${path}.outcomes`);
  const outcomeIds = new Set(outcomes.map(({ id }) => id));
  const proposals = list(value.proposals, `${path}.proposals`).map((item, index) => {
    const itemPath = `${path}.proposals[${index}]`;
    assertMap(item, itemPath);
    assertKeys(item, ['id', ...ACCEPTED_USE_CASE_FIELDS, 'capability'], ['id', 'title'], itemPath);
    const proposal = {
      id: useCaseId(item.id, `${itemPath}.id`),
      ...validateUseCaseFields(omit(item, ['id', 'capability']), itemPath),
    };
    if (item.capability !== undefined) proposal.capability = oneOf(item.capability, CAPABILITIES, `${itemPath}.capability`);
    if (proposal.outcome && !outcomeIds.has(proposal.outcome)) {
      throw new ReviewError(`${itemPath}.outcome names unknown outcome ${proposal.outcome}`);
    }
    return proposal;
  });
  uniqueIds(proposals, `${path}.proposals`);
  const surfaces = list(value.surfaces, `${path}.surfaces`).map((item, index) =>
    validateSubject(item, `${path}.surfaces[${index}]`, 'surface'),
  );
  uniqueIds(surfaces, `${path}.surfaces`);
  const workflows = list(value.workflows, `${path}.workflows`).map((item, index) =>
    validateSubject(item, `${path}.workflows[${index}]`, 'workflow'),
  );
  uniqueIds(workflows, `${path}.workflows`);
  const questions = list(value.questions, `${path}.questions`).map((item, index) => {
    const itemPath = `${path}.questions[${index}]`;
    assertMap(item, itemPath);
    assertKeys(item, ['id', 'question', 'impact'], ['id', 'question'], itemPath);
    const question = { id: subjectId(item.id, `${itemPath}.id`), question: text(item.question, `${itemPath}.question`) };
    if (item.impact !== undefined) question.impact = text(item.impact, `${itemPath}.impact`, true);
    return question;
  });
  uniqueIds(questions, `${path}.questions`);
  if (proposals.length + surfaces.length + workflows.length === 0) {
    throw new ReviewError(`${path} needs at least one proposal, surface, or workflow`);
  }
  return {
    kind,
    version: USE_CASE_REVIEW_VERSION,
    approval: { status: 'unapproved', activatesCatalog: false },
    source,
    outcomes,
    proposals,
    surfaces,
    workflows,
    questions,
  };
}

export function parseUseCaseCandidate(text, options = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReviewError(`${options.draft ? 'draft' : 'candidate'} is not valid JSON`);
  }
  return validateUseCaseCandidate(value, options);
}

// The stamped candidate keeps the draft's assessment and adds identity that
// only the CLI computes.
export function stampCandidate(draft, identity) {
  const validated = validateUseCaseCandidate(draft, { draft: true });
  return validateUseCaseCandidate({
    ...validated,
    kind: USE_CASE_CANDIDATE_KIND,
    source: {
      repository: { rootCommits: identity.rootCommits },
      commit: identity.commit,
      catalog: validated.source.catalog,
      navigation: validated.source.navigation,
      inputs: identity.inputs,
    },
  });
}

export function candidateInputPaths(candidate) {
  const paths = new Set(candidate.source.navigation);
  for (const subject of [...candidate.surfaces, ...candidate.workflows]) {
    for (const path of subject.sources) paths.add(path);
  }
  return [...paths].sort();
}

export function emptyReview(candidatePath, candidateSha256) {
  return {
    kind: USE_CASE_REVIEW_KIND,
    version: USE_CASE_REVIEW_VERSION,
    approval: { status: 'unapproved', activatesCatalog: false },
    candidate: { path: candidatePath, sha256: candidateSha256 },
    revision: 0,
    proposals: {},
    added: [],
    mappings: {},
  };
}

export function subjectKey(type, id) {
  return `${type}:${id}`;
}

export function useCaseCompleteness(value) {
  const missing = REQUIRED_FOR_CATALOG.filter((field) => isBlank(value[field]));
  return {
    complete: missing.length === 0,
    missing,
    missingLabels: missing.map((field) => DEFINITION_LABELS[field]),
  };
}

// validateUseCaseReview checks structure strictly. Incomplete decisions are
// not errors here; computeReview reports them as unresolved.
export function validateUseCaseReview(value, { proposalIds, subjectKeys }) {
  assertMap(value, 'review');
  assertKeys(
    value,
    ['kind', 'version', 'approval', 'candidate', 'revision', 'proposals', 'added', 'mappings'],
    ['kind', 'version', 'approval', 'candidate', 'revision', 'proposals', 'added', 'mappings'],
    'review',
  );
  if (value.kind !== USE_CASE_REVIEW_KIND) throw new ReviewError(`review.kind must be ${USE_CASE_REVIEW_KIND}`);
  if (value.version !== USE_CASE_REVIEW_VERSION) {
    throw new ReviewError(`review.version must be ${USE_CASE_REVIEW_VERSION}`);
  }
  assertUnapproved(value.approval, 'review.approval');
  assertMap(value.candidate, 'review.candidate');
  assertKeys(value.candidate, ['path', 'sha256'], ['path', 'sha256'], 'review.candidate');
  const candidate = {
    path: repositoryPath(value.candidate.path, 'review.candidate.path'),
    sha256: hash(value.candidate.sha256, 'review.candidate.sha256'),
  };
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new ReviewError('review.revision must be a non-negative integer');
  }
  const known = new Set(proposalIds);
  const added = list(value.added, 'review.added').map((item, index) => {
    const path = `review.added[${index}]`;
    assertMap(item, path);
    assertKeys(item, ['id', 'origin', 'from', ...ACCEPTED_USE_CASE_FIELDS], ['id', 'origin', 'title'], path);
    const entry = {
      id: useCaseId(item.id, `${path}.id`),
      origin: oneOf(item.origin, ['added', 'split'], `${path}.origin`),
      ...validateUseCaseFields(omit(item, ['id', 'origin', 'from']), path),
    };
    if (entry.origin === 'split') {
      entry.from = useCaseId(item.from, `${path}.from`);
      if (!known.has(entry.from)) throw new ReviewError(`${path}.from names unknown proposal ${entry.from}`);
    } else if (item.from !== undefined) {
      throw new ReviewError(`${path}.from is only valid for split parts`);
    }
    if (known.has(entry.id)) throw new ReviewError(`${path}.id duplicates proposal ${entry.id}`);
    return entry;
  });
  uniqueIds(added, 'review.added');

  assertMap(value.proposals, 'review.proposals');
  const proposals = {};
  for (const id of Object.keys(value.proposals).sort()) {
    const path = `review.proposals.${id}`;
    if (!known.has(id)) throw new ReviewError(`${path} names an unknown proposal`);
    const decision = value.proposals[id];
    assertMap(decision, path);
    const action = oneOf(decision.action, ACTIONS, `${path}.action`);
    const allowed = {
      pending: ['action', 'fields', 'note'],
      approve: ['action', 'note'],
      revise: ['action', 'fields', 'note'],
      reject: ['action', 'note'],
      merge: ['action', 'into', 'note'],
      split: ['action', 'parts', 'note'],
    }[action];
    const required = {
      pending: ['action'],
      approve: ['action'],
      revise: ['action', 'fields'],
      reject: ['action'],
      merge: ['action', 'into'],
      split: ['action', 'parts'],
    }[action];
    assertKeys(decision, allowed, required, path);
    const normalized = { action };
    if (decision.note !== undefined) normalized.note = text(decision.note, `${path}.note`, true);
    if (decision.fields !== undefined) {
      assertMap(decision.fields, `${path}.fields`);
      assertKeys(decision.fields, ACCEPTED_USE_CASE_FIELDS, [], `${path}.fields`);
      normalized.fields = validateUseCaseFields(decision.fields, `${path}.fields`);
    }
    if (action === 'merge') {
      normalized.into = useCaseId(decision.into, `${path}.into`);
      if (normalized.into === id) throw new ReviewError(`${path}.into cannot merge a proposal into itself`);
    }
    if (action === 'split') {
      normalized.parts = list(decision.parts, `${path}.parts`).map((part, index) =>
        useCaseId(part, `${path}.parts[${index}]`),
      );
      if (new Set(normalized.parts).size !== normalized.parts.length) {
        throw new ReviewError(`${path}.parts must be different use cases`);
      }
    }
    proposals[id] = normalized;
  }

  assertMap(value.mappings, 'review.mappings');
  const subjects = new Set(subjectKeys);
  const mappings = {};
  for (const key of Object.keys(value.mappings).sort()) {
    const path = `review.mappings.${key}`;
    if (!subjects.has(key)) throw new ReviewError(`${path} names an unknown surface or workflow`);
    const mapping = value.mappings[key];
    assertMap(mapping, path);
    assertKeys(mapping, ['disposition', 'useCaseIds', 'rationale'], ['disposition', 'useCaseIds', 'rationale'], path);
    const useCaseIds = list(mapping.useCaseIds, `${path}.useCaseIds`).map((id, index) =>
      useCaseId(id, `${path}.useCaseIds[${index}]`),
    );
    if (new Set(useCaseIds).size !== useCaseIds.length) {
      throw new ReviewError(`${path}.useCaseIds must not repeat a use case`);
    }
    mappings[key] = {
      disposition: oneOf(mapping.disposition, MAPPING_DISPOSITIONS, `${path}.disposition`),
      useCaseIds,
      rationale: text(mapping.rationale, `${path}.rationale`, true),
    };
  }
  return {
    kind: USE_CASE_REVIEW_KIND,
    version: USE_CASE_REVIEW_VERSION,
    approval: { status: 'unapproved', activatesCatalog: false },
    candidate,
    revision: value.revision,
    proposals,
    added,
    mappings,
  };
}

export function validateReviewDecisionCompleteness(candidate, review) {
  const proposals = new Map(candidate.proposals.map((proposal) => [proposal.id, proposal]));
  for (const [id, decision] of Object.entries(review.proposals)) {
    const proposal = proposals.get(id);
    if (!proposal) continue;
    if (decision.action === 'approve') {
      const completeness = useCaseCompleteness(proposal);
      if (!completeness.complete) {
        throw new ReviewError(
          `${id} cannot be approved as proposed until ${completeness.missingLabels.join(', ')} ${
            completeness.missingLabels.length === 1 ? 'is' : 'are'
          } provided`,
        );
      }
    }
    if (decision.action === 'revise') {
      const changedFields = actualChangedFields(proposal, decision.fields ?? {});
      if (changedFields.length === 0) {
        throw new ReviewError(`${id} cannot approve a revised proposal until at least one field is changed`);
      }
      const completeness = useCaseCompleteness({ ...proposal, ...decision.fields });
      if (!completeness.complete) {
        throw new ReviewError(
          `${id} cannot approve the revised proposal until ${completeness.missingLabels.join(', ')} ${
            completeness.missingLabels.length === 1 ? 'is' : 'are'
          } provided`,
        );
      }
    }
  }
  return review;
}

export function serializeReview(review) {
  return `${JSON.stringify(canonicalize(review), null, 2)}\n`;
}

export function reviewSubjects(candidate, discoveredSurfaces = []) {
  const subjects = [];
  for (const surface of candidate.surfaces) subjects.push({ type: 'surface', origin: 'candidate', ...surface });
  for (const workflow of candidate.workflows) subjects.push({ type: 'workflow', origin: 'candidate', ...workflow });
  const known = new Set(candidate.surfaces.map(({ id }) => id));
  for (const surface of [...discoveredSurfaces].sort((a, b) => a.id.localeCompare(b.id))) {
    if (known.has(surface.id)) continue;
    known.add(surface.id);
    subjects.push({
      type: 'surface',
      origin: 'discovered',
      id: surface.id,
      label: surface.label || surface.id,
      route: surface.route,
      kind: surface.hidden ? 'hidden' : 'destination',
      sources: [surface.file],
      classification: {
        disposition: 'unresolved',
        useCaseIds: [],
        rationale: 'Found in configured navigation source but missing from the candidate.',
      },
    });
  }
  return subjects.map((subject) => ({ ...subject, key: subjectKey(subject.type, subject.id) }));
}

// computeReview is the single source of review semantics for the CLI, the
// local app, and adoption. It never mutates its inputs.
export function computeReview({
  candidate,
  review,
  activeCatalog = { path: candidate.source.catalog, origin: 'candidate', text: null },
  discoveredSurfaces = [],
  identity = { status: 'unverified', reasons: [] },
}) {
  const issues = [];
  const issue = (severity, scope, message) => issues.push({ severity, scope, message });
  const subjects = reviewSubjects(candidate, discoveredSurfaces);
  const decisions = review.proposals;

  let existingCatalog = null;
  if (activeCatalog.text !== null) {
    try {
      const parsed = parseYamlSubset(activeCatalog.text);
      if (!isMap(parsed) || parsed.version !== 1 || !Array.isArray(parsed.use_cases)) {
        throw new ConfigError('catalog must be a version 1 mapping with use_cases');
      }
      if (!['partial', 'complete'].includes(parsed.inventory)) {
        throw new ConfigError('catalog inventory must be partial or complete');
      }
      existingCatalog = parsed;
    } catch (error) {
      issue('error', 'catalog', `The active catalog ${activeCatalog.path} could not be read: ${error.message}`);
    }
    if (/^\s*#/m.test(activeCatalog.text)) {
      issue(
        'warning',
        'catalog',
        `Comments in ${activeCatalog.path} are not preserved by the generated catalog; the diff shows their removal.`,
      );
    }
  }
  const existing = (existingCatalog?.use_cases ?? []).filter((entry) => isMap(entry) && typeof entry.id === 'string');
  const existingIds = new Set(existing.map(({ id }) => id));
  const candidateIds = new Set(candidate.proposals.map(({ id }) => id));
  const addedById = new Map(review.added.map((entry) => [entry.id, entry]));

  for (const entry of review.added) {
    if (existingIds.has(entry.id)) issue('error', `use-case:${entry.id}`, `${entry.id} duplicates an active catalog use case.`);
  }
  for (const proposal of candidate.proposals) {
    if (existingIds.has(proposal.id)) {
      issue('error', `use-case:${proposal.id}`, `Proposal ${proposal.id} duplicates an active catalog use case; merge or rename it.`);
    }
  }

  const proposals = candidate.proposals.map((proposal) => {
    const decision = decisions[proposal.id] ?? { action: 'pending' };
    const effective = { ...omit(proposal, ['capability']), ...(decision.fields ?? {}) };
    const proposedCompleteness = useCaseCompleteness(proposal);
    const draftCompleteness = useCaseCompleteness(effective);
    const changedFields = actualChangedFields(proposal, decision.fields ?? {});
    let action = decision.action;
    let invalidDecision = null;
    if (action === 'approve' && !proposedCompleteness.complete) {
      invalidDecision = `Approve as proposed is unavailable until ${proposedCompleteness.missingLabels.join(', ')} ${
        proposedCompleteness.missingLabels.length === 1 ? 'is' : 'are'
      } provided.`;
      action = 'pending';
    } else if (action === 'revise' && (changedFields.length === 0 || !draftCompleteness.complete)) {
      invalidDecision =
        changedFields.length === 0
          ? 'A revised proposal needs at least one changed field.'
          : `The revised proposal still needs ${draftCompleteness.missingLabels.join(', ')}.`;
      action = 'pending';
    }
    return {
      id: proposal.id,
      origin: 'candidate',
      action,
      recordedAction: decision.action,
      note: decision.note ?? '',
      into: decision.into ?? null,
      parts: decision.parts ?? [],
      capability: proposal.capability ?? 'unknown',
      proposed: proposal,
      effective,
      proposedCompleteness,
      draftCompleteness,
      changedFields,
      invalidDecision,
      issues: [],
    };
  });
  const added = review.added.map((entry) => ({
    id: entry.id,
    origin: entry.origin,
    from: entry.from ?? null,
    action: 'add',
    note: '',
    into: null,
    parts: [],
    capability: 'unknown',
    proposed: null,
    effective: omit(entry, ['origin', 'from']),
    proposedCompleteness: null,
    draftCompleteness: useCaseCompleteness(entry),
    changedFields: [],
    invalidDecision: null,
    issues: [],
  }));
  const byId = new Map([...proposals, ...added].map((item) => [item.id, item]));
  const accepted = (item) => item && ['approve', 'revise', 'add'].includes(item.action);

  for (const item of proposals) {
    const scope = `use-case:${item.id}`;
    if (item.invalidDecision) {
      item.issues.push({ severity: 'error', message: item.invalidDecision });
      issue('error', scope, `${item.id}: ${item.invalidDecision}`);
    }
    if (item.action === 'merge') {
      const target = byId.get(item.into);
      if (!existingIds.has(item.into) && !accepted(target)) {
        const message = target
          ? `${item.id} is merged into ${item.into}, which is not accepted; approve ${item.into} or choose another target.`
          : `${item.id} is merged into unknown use case ${item.into}.`;
        item.issues.push({ severity: 'error', message });
        issue('error', scope, message);
      }
    }
    if (item.action === 'split') {
      if (item.parts.length < 2) {
        const message = `${item.id} is split but needs at least two parts.`;
        item.issues.push({ severity: 'error', message });
        issue('error', scope, message);
      }
      for (const part of item.parts) {
        const entry = addedById.get(part);
        if (!entry || entry.origin !== 'split' || entry.from !== item.id) {
          const message = `${item.id} names split part ${part}, which is not a split part of this proposal.`;
          item.issues.push({ severity: 'error', message });
          issue('error', scope, message);
        }
      }
    }
  }
  for (const entry of added) {
    if (entry.origin !== 'split') continue;
    const parent = byId.get(entry.from);
    if (parent?.action !== 'split' || !parent.parts.includes(entry.id)) {
      const message = `${entry.id} is a split part of ${entry.from}, but ${entry.from} is not split into it.`;
      entry.issues.push({ severity: 'error', message });
      issue('error', `use-case:${entry.id}`, message);
    }
  }

  // Resolution follows one merge hop; a merge target must itself be accepted.
  const resolve = (id) => {
    if (existingIds.has(id)) return { state: 'accepted', id };
    const item = byId.get(id);
    if (!item) return { state: 'broken', id, reason: `unknown use case ${id}` };
    if (accepted(item)) return { state: 'accepted', id };
    if (item.action === 'pending') return { state: 'pending', id };
    if (item.action === 'merge') {
      const target = byId.get(item.into);
      if (existingIds.has(item.into) || accepted(target)) return { state: 'accepted', id: item.into, via: id };
      return { state: 'broken', id, reason: `${id} is merged into ${item.into}, which is not accepted` };
    }
    if (item.action === 'split') return { state: 'broken', id, reason: `${id} was split; choose one of its parts` };
    return { state: 'broken', id, reason: `${id} was rejected` };
  };

  const subjectResults = subjects.map((subject) => {
    const override = review.mappings[subject.key];
    const effective = override ?? fromClassification(subject.classification);
    const result = {
      key: subject.key,
      type: subject.type,
      id: subject.id,
      label: subject.label ?? subject.title ?? subject.id,
      route: subject.route ?? null,
      entry: subject.entry ?? null,
      kind: subject.kind ?? null,
      capability: subject.capability ?? null,
      sources: subject.sources,
      origin: subject.origin,
      proposed: subject.classification,
      effective,
      decided: Boolean(override),
      resolvedUseCaseIds: [],
      status: 'unresolved',
      issues: [],
    };
    if (effective.disposition === 'excluded') {
      if (effective.rationale.trim()) result.status = 'excluded';
      else result.issues.push('An exclusion needs a rationale.');
    } else if (effective.disposition === 'use-case') {
      if (effective.useCaseIds.length === 0) {
        result.issues.push('Choose at least one use case, exclude it with a rationale, or leave it unresolved.');
      } else {
        const resolutions = effective.useCaseIds.map(resolve);
        const broken = resolutions.filter(({ state }) => state === 'broken');
        for (const item of broken) result.issues.push(`Maps to ${item.reason}.`);
        result.resolvedUseCaseIds = [...new Set(resolutions.filter(({ state }) => state === 'accepted').map(({ id }) => id))];
        if (broken.length) result.status = 'unresolved';
        else if (resolutions.some(({ state }) => state === 'pending')) result.status = 'proposed';
        else result.status = 'mapped';
      }
    } else if (subject.origin === 'discovered') {
      result.issues.push('Found in navigation source but not assessed by the candidate.');
    }
    return result;
  });

  const surfaceRoutes = new Map();
  for (const subject of subjects) {
    if (subject.type === 'surface' && typeof subject.route === 'string' && subject.route.startsWith('/')) {
      surfaceRoutes.set(subject.id, subject.route);
    }
  }
  const validationSurfaces = [...surfaceRoutes].map(([id, route]) => ({ id, route }));

  // Mapped surfaces become catalog entry-point bindings so `ux-guard check`
  // sees the same navigation mapping recorded by the review.
  const extraStarts = new Map();
  for (const subject of subjectResults) {
    if (subject.type !== 'surface' || subject.status !== 'mapped' || !surfaceRoutes.has(subject.id)) continue;
    for (const id of subject.resolvedUseCaseIds) {
      const starts = extraStarts.get(id) ?? [];
      starts.push({ nav_id: subject.id, route: surfaceRoutes.get(subject.id) });
      extraStarts.set(id, starts);
    }
  }
  const merged = new Map();
  for (const item of proposals) {
    if (item.action !== 'merge') continue;
    const resolution = resolve(item.id);
    if (resolution.state !== 'accepted') continue;
    const sources = merged.get(resolution.id) ?? [];
    sources.push(item.effective);
    merged.set(resolution.id, sources);
  }

  const entries = [];
  const omitted = [];
  const pushEntry = (id, base, existingEntry) => {
    const entry = existingEntry ? structuredClone(existingEntry) : catalogFields(id, base);
    for (const source of merged.get(id) ?? []) {
      entry.starts = unionStarts(entry.starts, source.starts);
      entry.requirements = unionText(entry.requirements, source.requirements);
      entry.gaps = unionText(entry.gaps, source.gaps);
    }
    entry.starts = unionStarts(entry.starts, extraStarts.get(id));
    for (const field of ['starts', 'requirements', 'gaps']) {
      if (Array.isArray(entry[field]) && entry[field].length === 0) delete entry[field];
    }
    const missing = existingEntry ? [] : REQUIRED_FOR_CATALOG.filter((field) => isBlank(entry[field]));
    if (missing.length) {
      omitted.push({ id, reasons: [`missing ${missing.join(', ')}`] });
      issue('error', `use-case:${id}`, `${id} cannot enter the catalog until ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} filled in.`);
      return;
    }
    try {
      validateCatalog({ version: 1, inventory: 'partial', use_cases: [entry] }, validationSurfaces);
    } catch (error) {
      issue('error', `use-case:${id}`, `${id}: ${error.message}.`);
      if (!existingEntry) {
        omitted.push({ id, reasons: [error.message] });
        return;
      }
    }
    entries.push(orderEntry(entry));
  };
  for (const entry of existing) pushEntry(entry.id, null, entry);
  for (const item of [...proposals, ...added]) {
    if (accepted(item) && !existingIds.has(item.id)) pushEntry(item.id, item.effective, null);
  }

  for (const item of [...proposals, ...added]) {
    item.catalogEntry = entries.find((entry) => entry.id === item.id) ?? null;
    item.omitted = omitted.find((entry) => entry.id === item.id)?.reasons ?? [];
    item.subjects = subjectResults
      .filter((subject) => subject.effective.useCaseIds.includes(item.id))
      .map(({ key }) => key);
    if (!item.effective.outcome && candidate.outcomes.length) {
      item.issues.push({ severity: 'warning', message: 'No user outcome is assigned.' });
    }
    const starts = Array.isArray(item.catalogEntry?.starts) ? item.catalogEntry.starts : [];
    item.implementationCoverage = {
      status: starts.length ? 'bound' : 'unknown',
      entryPoints: starts.length,
    };
    if (item.catalogEntry && starts.length === 0) {
      const message = 'No entry points are bound; implementation coverage is unknown.';
      item.issues.push({ severity: 'warning', message });
      issue('warning', `use-case:${item.id}`, `${item.id}: ${message}`);
    }
  }

  for (const subject of subjectResults) {
    for (const message of subject.issues) issue(subject.status === 'unresolved' ? 'error' : 'warning', subject.key, message);
  }
  if (identity.status === 'stale') {
    for (const reason of identity.reasons) issue('error', 'candidate', `Candidate is stale: ${reason}`);
  }
  if (activeCatalog.origin === 'candidate') {
    issue(
      'warning',
      'catalog',
      `No active ux-guard policy is configured. The candidate suggests ${activeCatalog.path}; adoption requires an explicit --catalog choice.`,
    );
  }
  if (activeCatalog.mismatch) {
    issue('warning', 'catalog', activeCatalog.mismatch);
  }

  const inventory = existingCatalog?.inventory ?? 'partial';
  let catalogText = null;
  if (entries.length === 0) {
    issue('error', 'catalog', 'The generated catalog has no use cases yet; approve, revise, or add at least one.');
  } else {
    catalogText = emitCatalog({ version: 1, inventory, use_cases: entries });
  }
  const activeText = activeCatalog.text ?? '';
  const diff = catalogText === null ? '' : unifiedDiff(activeText, catalogText, activeCatalog.path, activeCatalog.text === null);

  const counts = (values, statuses) =>
    Object.fromEntries(statuses.map((status) => [status, values.filter((value) => value === status).length]));
  const subjectStatuses = ['mapped', 'proposed', 'excluded', 'unresolved'];
  const pendingProposals = proposals.filter(({ action }) => action === 'pending');
  const unresolved = [
    ...pendingProposals.map(({ id, effective }) => ({
      scope: `use-case:${id}`,
      message: `Decide whether to approve, revise, reject, merge, or split “${effective.title}”.`,
    })),
    ...subjectResults
      .filter(({ status }) => status === 'unresolved')
      .map(({ key, label, issues: subjectIssues }) => ({
        scope: key,
        message: subjectIssues[0] ? `${label}: ${subjectIssues[0]}` : `${label}: map it to a use case or exclude it with a rationale.`,
      })),
  ];
  const blocking = issues.filter(({ severity }) => severity === 'error');
  return {
    kind: 'ux-guard-use-case-review-state',
    version: USE_CASE_REVIEW_VERSION,
    approval: {
      status: 'unapproved',
      activatesCatalog: false,
      notice: 'Saving records review decisions only. It does not approve, adopt, check in, or enforce anything.',
    },
    identity,
    summary: {
      discovered: subjectResults.length,
      ...counts(subjectResults.map(({ status }) => status), subjectStatuses),
      surfaces: {
        total: subjectResults.filter(({ type }) => type === 'surface').length,
        ...counts(subjectResults.filter(({ type }) => type === 'surface').map(({ status }) => status), subjectStatuses),
      },
      workflows: {
        total: subjectResults.filter(({ type }) => type === 'workflow').length,
        ...counts(subjectResults.filter(({ type }) => type === 'workflow').map(({ status }) => status), subjectStatuses),
      },
      proposals: {
        total: proposals.length,
        decided: proposals.length - pendingProposals.length,
        ...counts(proposals.map(({ action }) => action), ACTIONS),
        added: added.filter(({ origin }) => origin === 'added').length,
        splitParts: added.filter(({ origin }) => origin === 'split').length,
      },
      unresolvedDecisions: unresolved.length,
      blockingIssues: blocking.length,
      readyForOwnerApproval: unresolved.length === 0 && blocking.length === 0,
    },
    outcomes: groupOutcomes(candidate.outcomes, [...proposals, ...added]),
    useCases: [...proposals, ...added],
    existingUseCases: existing.map((entry) => {
      const subjectMatches = subjectResults.filter((subject) => subject.resolvedUseCaseIds.includes(entry.id));
      return {
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : entry.id,
        goal: typeof entry.goal === 'string' ? entry.goal : '',
        success: typeof entry.success === 'string' ? entry.success : '',
        tier: entry.tier ?? null,
        effect: entry.effect ?? null,
        starts: Array.isArray(entry.starts) ? structuredClone(entry.starts) : [],
        entryPoints: Array.isArray(entry.starts) ? entry.starts.length : 0,
        surfaces: subjectMatches.filter(({ type }) => type === 'surface').length,
        workflows: subjectMatches.filter(({ type }) => type === 'workflow').length,
      };
    }),
    subjects: subjectResults,
    questions: candidate.questions,
    unresolved,
    issues,
    catalog: {
      path: activeCatalog.path,
      origin: activeCatalog.origin,
      exists: activeCatalog.text !== null,
      activeSha256: activeCatalog.text === null ? null : sha256(activeCatalog.text),
      inventory,
      text: catalogText,
      sha256: catalogText === null ? null : sha256(catalogText),
      entries: entries.length,
      unbound: entries.filter((entry) => !Array.isArray(entry.starts) || entry.starts.length === 0).map(({ id }) => id),
      omitted,
      diff,
      changed: catalogText !== null && catalogText !== activeText,
    },
  };
}

export function previewText(state) {
  return state.catalog.text === null ? null : `${PREVIEW_MARKER}\n${state.catalog.text}`;
}

function fromClassification(classification) {
  if (classification.disposition === 'excluded') {
    return { disposition: 'excluded', useCaseIds: [], rationale: classification.rationale };
  }
  if (classification.disposition === 'unresolved') {
    return { disposition: 'unresolved', useCaseIds: [...classification.useCaseIds], rationale: classification.rationale };
  }
  return { disposition: 'use-case', useCaseIds: [...classification.useCaseIds], rationale: classification.rationale };
}

function groupOutcomes(outcomes, items) {
  const groups = outcomes.map((outcome) => ({ ...outcome, useCaseIds: [] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const other = { id: '', title: 'No outcome assigned', summary: '', useCaseIds: [] };
  for (const item of items) {
    (byId.get(item.effective.outcome) ?? other).useCaseIds.push(item.id);
  }
  return other.useCaseIds.length ? [...groups, other] : groups;
}

function catalogFields(id, base) {
  const entry = { id };
  for (const field of CATALOG_ORDER.slice(1)) {
    if (base[field] !== undefined) entry[field] = structuredClone(base[field]);
  }
  return entry;
}

function orderEntry(entry) {
  const ordered = {};
  for (const field of CATALOG_ORDER) if (entry[field] !== undefined) ordered[field] = entry[field];
  for (const field of Object.keys(entry)) if (!CATALOG_ORDER.includes(field)) ordered[field] = entry[field];
  return ordered;
}

function unionStarts(current = [], extra = []) {
  const starts = Array.isArray(current) ? [...current] : [];
  const seen = new Set(starts.map((start) => JSON.stringify(canonicalize(start))));
  for (const start of extra ?? []) {
    const key = JSON.stringify(canonicalize(start));
    if (seen.has(key)) continue;
    seen.add(key);
    starts.push(structuredClone(start));
  }
  return starts;
}

function unionText(current = [], extra = []) {
  const values = Array.isArray(current) ? [...current] : [];
  for (const value of extra ?? []) if (!values.includes(value)) values.push(value);
  return values;
}

function actualChangedFields(proposal, fields) {
  return Object.keys(fields).filter(
    (field) => JSON.stringify(canonicalize(proposal[field] ?? null)) !== JSON.stringify(canonicalize(fields[field] ?? null)),
  );
}

function isBlank(value) {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value !== 'string' || !value.trim();
}

// emitCatalog writes the strict YAML subset and proves the result parses back
// to the same value.
export function emitCatalog(catalog) {
  const lines = emitMap(catalog, 0);
  const text = `${lines.join('\n')}\n`;
  let parsed;
  try {
    parsed = parseYamlSubset(text);
  } catch (error) {
    throw new ReviewError(`generated catalog is not valid YAML: ${error.message}`);
  }
  if (JSON.stringify(canonicalize(parsed)) !== JSON.stringify(canonicalize(catalog))) {
    throw new ReviewError('generated catalog does not round-trip through the catalog parser');
  }
  return text;
}

function emitMap(map, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(map)) {
    if (!/^[^\s:"'#]+$/.test(key)) throw new ReviewError(`catalog key ${JSON.stringify(key)} cannot be written`);
    if (isScalar(value)) lines.push(`${pad}${key}: ${scalar(value)}`);
    else if (Array.isArray(value) && value.length === 0) continue;
    else lines.push(`${pad}${key}:`, ...emitNode(value, indent + 2));
  }
  return lines;
}

function emitNode(value, indent) {
  if (Array.isArray(value)) return emitList(value, indent);
  if (isMap(value)) return emitMap(value, indent);
  throw new ReviewError('catalog values must be text, numbers, booleans, lists, or mappings');
}

function emitList(items, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const item of items) {
    if (isScalar(item)) {
      lines.push(`${pad}- ${scalar(item)}`);
    } else if (isMap(item)) {
      const [first, ...rest] = Object.entries(item);
      if (!first) throw new ReviewError('catalog lists cannot contain empty mappings');
      const [key, value] = first;
      if (isScalar(value)) lines.push(`${pad}- ${key}: ${scalar(value)}`);
      else lines.push(`${pad}- ${key}:`, ...emitNode(value, indent + 4));
      lines.push(...emitMap(Object.fromEntries(rest), indent + 2));
    } else {
      throw new ReviewError('catalog lists cannot contain nested lists');
    }
  }
  return lines;
}

function isScalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0);
}

function scalar(value) {
  if (typeof value !== 'string') return String(value);
  if (/[\r\n\t]/.test(value)) throw new ReviewError('catalog text cannot contain line breaks or tabs');
  const plain =
    /^[A-Za-z0-9_/.@][A-Za-z0-9 _/.@()&,+-]*$/.test(value) &&
    !value.endsWith(' ') &&
    !['true', 'false'].includes(value) &&
    !/^\d+$/.test(value);
  if (plain) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new ReviewError('catalog text cannot contain both single and double quotes');
}

// unifiedDiff produces a deterministic line diff with three lines of context.
export function unifiedDiff(before, after, path, created = false) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  let oldPosition = 0;
  let newPosition = 0;
  for (const op of ops) {
    op.old = oldPosition;
    op.new = newPosition;
    if (op.type !== 'add') oldPosition += 1;
    if (op.type !== 'remove') newPosition += 1;
  }
  const changes = ops.flatMap((op, index) => (op.type === 'same' ? [] : [index]));
  if (changes.length === 0) return '';
  const context = 3;
  const lines = [created ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`];
  let cursor = 0;
  while (cursor < changes.length) {
    const start = Math.max(0, changes[cursor] - context);
    let end = Math.min(ops.length, changes[cursor] + context + 1);
    cursor += 1;
    while (cursor < changes.length && changes[cursor] - context <= end) {
      end = Math.min(ops.length, changes[cursor] + context + 1);
      cursor += 1;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter(({ type }) => type !== 'add').length;
    const newCount = slice.filter(({ type }) => type !== 'remove').length;
    const oldStart = oldCount ? slice[0].old + 1 : slice[0].old;
    const newStart = newCount ? slice[0].new + 1 : slice[0].new;
    lines.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...slice.map(({ type, text }) => `${type === 'add' ? '+' : type === 'remove' ? '-' : ' '}${text}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ type: 'add', text }));
  if (m === 0) return a.map((text) => ({ type: 'remove', text }));
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : previous[offset + prevK];
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'same', text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ type: 'add', text: b[y - 1] });
    else ops.push({ type: 'remove', text: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function validateSource(value, path, draft) {
  assertMap(value, path);
  if (draft) {
    for (const field of ['repository', 'commit', 'inputs']) {
      if (Object.hasOwn(value, field)) {
        throw new ReviewError(`${path}.${field} is computed by ux-guard review prepare; remove it from the draft`);
      }
    }
    assertKeys(value, ['catalog', 'navigation'], ['catalog', 'navigation'], path);
  } else {
    assertKeys(
      value,
      ['repository', 'commit', 'catalog', 'navigation', 'inputs'],
      ['repository', 'commit', 'catalog', 'navigation', 'inputs'],
      path,
    );
  }
  const source = {
    catalog: repositoryPath(value.catalog, `${path}.catalog`),
    navigation: list(value.navigation, `${path}.navigation`).map((item, index) =>
      repositoryPath(item, `${path}.navigation[${index}]`),
    ),
  };
  if (new Set(source.navigation).size !== source.navigation.length) {
    throw new ReviewError(`${path}.navigation must not repeat a file`);
  }
  if (draft) return source;
  assertMap(value.repository, `${path}.repository`);
  assertKeys(value.repository, ['rootCommits'], ['rootCommits'], `${path}.repository`);
  const rootCommits = list(value.repository.rootCommits, `${path}.repository.rootCommits`).map((item, index) =>
    commit(item, `${path}.repository.rootCommits[${index}]`),
  );
  if (value.commit !== null) commit(value.commit, `${path}.commit`);
  const inputs = list(value.inputs, `${path}.inputs`).map((item, index) => {
    const itemPath = `${path}.inputs[${index}]`;
    assertMap(item, itemPath);
    assertKeys(item, ['path', 'sha256'], ['path', 'sha256'], itemPath);
    return { path: repositoryPath(item.path, `${itemPath}.path`), sha256: hash(item.sha256, `${itemPath}.sha256`) };
  });
  const paths = inputs.map(({ path: inputPath }) => inputPath);
  if (paths.join('\n') !== [...new Set(paths)].sort().join('\n')) {
    throw new ReviewError(`${path}.inputs must be unique and sorted by path`);
  }
  return {
    repository: { rootCommits },
    commit: value.commit,
    ...source,
    inputs,
  };
}

function validateOutcome(value, path) {
  assertMap(value, path);
  assertKeys(value, ['id', 'title', 'summary'], ['id', 'title'], path);
  const outcome = { id: useCaseId(value.id, `${path}.id`), title: text(value.title, `${path}.title`) };
  if (value.summary !== undefined) outcome.summary = text(value.summary, `${path}.summary`, true);
  return outcome;
}

function validateSubject(value, path, type) {
  assertMap(value, path);
  const fields =
    type === 'surface'
      ? ['id', 'label', 'route', 'kind', 'sources', 'classification']
      : ['id', 'title', 'entry', 'capability', 'sources', 'classification'];
  const required = type === 'surface' ? ['id', 'label', 'classification'] : ['id', 'title', 'classification'];
  assertKeys(value, fields, required, path);
  const subject = { id: subjectId(value.id, `${path}.id`) };
  if (type === 'surface') {
    subject.label = text(value.label, `${path}.label`);
    if (value.route !== undefined) {
      subject.route = text(value.route, `${path}.route`);
      if (!subject.route.startsWith('/')) throw new ReviewError(`${path}.route must be absolute`);
    }
    subject.kind = value.kind === undefined ? 'destination' : oneOf(value.kind, SURFACE_KINDS, `${path}.kind`);
  } else {
    subject.title = text(value.title, `${path}.title`);
    if (value.entry !== undefined) subject.entry = text(value.entry, `${path}.entry`);
    subject.capability =
      value.capability === undefined ? 'unknown' : oneOf(value.capability, CAPABILITIES, `${path}.capability`);
  }
  subject.sources = list(value.sources, `${path}.sources`).map((item, index) =>
    repositoryPath(item, `${path}.sources[${index}]`),
  );
  const classification = value.classification;
  const classificationPath = `${path}.classification`;
  assertMap(classification, classificationPath);
  assertKeys(classification, ['disposition', 'useCaseIds', 'rationale'], ['disposition'], classificationPath);
  subject.classification = {
    disposition: oneOf(classification.disposition, DISPOSITIONS, `${classificationPath}.disposition`),
    useCaseIds: list(classification.useCaseIds, `${classificationPath}.useCaseIds`).map((id, index) =>
      useCaseId(id, `${classificationPath}.useCaseIds[${index}]`),
    ),
    rationale: classification.rationale === undefined ? '' : text(classification.rationale, `${classificationPath}.rationale`, true),
  };
  return subject;
}

function validateUseCaseFields(value, path) {
  const fields = {};
  for (const field of TEXT_FIELDS) {
    if (value[field] !== undefined) fields[field] = text(value[field], `${path}.${field}`, field === 'rationale');
  }
  if (value.owner !== undefined) fields.owner = text(value.owner, `${path}.owner`);
  if (value.tier !== undefined) fields.tier = oneOf(value.tier, TIERS, `${path}.tier`);
  if (value.effect !== undefined) fields.effect = oneOf(value.effect, EFFECTS, `${path}.effect`);
  if (value.outcome !== undefined) fields.outcome = useCaseId(value.outcome, `${path}.outcome`);
  if (value.starts !== undefined) {
    fields.starts = list(value.starts, `${path}.starts`).map((start, index) =>
      validateStart(start, `${path}.starts[${index}]`),
    );
  }
  for (const field of ['requirements', 'gaps']) {
    if (value[field] !== undefined) {
      fields[field] = list(value[field], `${path}.${field}`).map((item, index) =>
        text(item, `${path}.${field}[${index}]`),
      );
    }
  }
  return fields;
}

function validateStart(value, path) {
  assertMap(value, path);
  if (value.entry !== undefined) {
    assertKeys(value, ['entry', 'prompt'], ['entry', 'prompt'], path);
    if (value.entry !== 'assistant') throw new ReviewError(`${path}.entry must be assistant`);
    return { entry: 'assistant', prompt: text(value.prompt, `${path}.prompt`) };
  }
  assertKeys(value, ['nav_id', 'route'], ['nav_id', 'route'], path);
  const route = text(value.route, `${path}.route`);
  if (!route.startsWith('/')) throw new ReviewError(`${path}.route must be absolute`);
  return { nav_id: subjectId(value.nav_id, `${path}.nav_id`), route };
}

function assertUnapproved(value, path) {
  assertMap(value, path);
  assertKeys(value, ['status', 'activatesCatalog'], ['status', 'activatesCatalog'], path);
  if (value.status !== 'unapproved' || value.activatesCatalog !== false) {
    throw new ReviewError(
      `${path} must be unapproved with activatesCatalog false; approval happens only through ux-guard review adopt`,
    );
  }
}

function assertKeys(value, allowed, required, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ReviewError(`${path}.${key} is not a recognized field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ReviewError(`${path}.${key} is required`);
  }
}

function assertMap(value, path) {
  if (!isMap(value)) throw new ReviewError(`${path} must be an object`);
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ReviewError(`${path} must be a list`);
  if (value.length > MAX_ITEMS) throw new ReviewError(`${path} has more than ${MAX_ITEMS} entries`);
  return value;
}

function text(value, path, allowEmpty = false) {
  if (typeof value !== 'string') throw new ReviewError(`${path} must be text`);
  if (!allowEmpty && !value.trim()) throw new ReviewError(`${path} must not be empty`);
  if (value.length > MAX_TEXT) throw new ReviewError(`${path} is longer than ${MAX_TEXT} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ReviewError(`${path} contains control characters`);
  }
  return value;
}

function oneOf(value, values, path) {
  if (!values.includes(value)) throw new ReviewError(`${path} must be one of ${values.join(', ')}`);
  return value;
}

function useCaseId(value, path) {
  if (typeof value !== 'string' || !USE_CASE_ID.test(value) || value.length > 120) {
    throw new ReviewError(`${path} must be a lowercase kebab-case use-case id`);
  }
  return value;
}

function subjectId(value, path) {
  if (typeof value !== 'string' || !SUBJECT_ID.test(value)) {
    throw new ReviewError(`${path} must be a simple identifier`);
  }
  return value;
}

function commit(value, path) {
  if (typeof value !== 'string' || !COMMIT.test(value)) throw new ReviewError(`${path} must be a Git object id`);
  return value;
}

function hash(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new ReviewError(`${path} must be a SHA-256 hex digest`);
  return value;
}

function repositoryPath(value, path) {
  try {
    return assertRepositoryRelativePath(value, path);
  } catch (error) {
    throw new ReviewError(error.message);
  }
}

function uniqueIds(items, path) {
  const seen = new Set();
  for (const { id } of items) {
    if (seen.has(id)) throw new ReviewError(`${path} repeats id ${id}`);
    seen.add(id);
  }
}

function omit(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
