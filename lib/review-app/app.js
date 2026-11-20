// The review app is a view over server-computed state. Decisions are edited
// locally, evaluated by the local ux-guard process, and saved only on request.

const TOKEN_KEY = 'ux-guard-review-token';
const TABS = ['summary', 'use-cases', 'coverage', 'preview'];
const ACTION_LABELS = {
  pending: 'Undecided',
  approve: 'Approved as proposed',
  revise: 'Approved with revisions',
  reject: 'Rejected',
  merge: 'Merged',
  split: 'Split',
  add: 'Added by owner',
};
const STATUS_LABELS = {
  mapped: 'Mapped',
  proposed: 'Awaiting a use-case decision',
  excluded: 'Excluded',
  unresolved: 'Unresolved',
};
const DISPOSITION_LABELS = {
  'existing-use-case': 'existing use case',
  'proposed-use-case': 'proposed use case',
  excluded: 'excluded',
  unresolved: 'unresolved',
};
const TIERS = ['primary', 'secondary', 'tertiary'];
const EFFECTS = ['read', 'create', 'change'];
const TEXT_FIELDS = [
  ['title', 'Title', 'input'],
  ['persona', 'Persona', 'input'],
  ['owner', 'Owner', 'input'],
  ['goal', 'Goal', 'textarea'],
  ['success', 'Success outcome', 'textarea'],
  ['rationale', 'Rationale', 'textarea'],
];
const USE_CASE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAV_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const session = {
  token: null,
  data: null,
  review: null,
  dirty: false,
  tab: 'summary',
  useCase: null,
  subject: null,
  raw: new Map(),
  fieldErrors: new Map(),
  open: new Set(),
  filters: {
    useCases: { text: '', status: 'all', outcome: 'all' },
    subjects: { text: '', status: 'all', type: 'all' },
  },
  evalTimer: null,
  evalSequence: 0,
  closeArmed: false,
};

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'value' || key === 'checked') continue;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  if (props.value !== undefined) element.value = props.value;
  if (props.checked !== undefined) element.checked = Boolean(props.checked);
  return element;
}

// rerender replaces a region and restores focus and caret by data-focus-key,
// so keyboard and screen-reader users keep their place after each evaluation.
function rerender(container, build) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset.focusKey : null;
  const selection =
    key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scrolls = [...container.querySelectorAll('[data-scroll-key]')].map((node) => [node.dataset.scrollKey, node.scrollTop]);
  container.replaceChildren(...build().flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
  for (const [scrollKey, top] of scrolls) {
    const node = container.querySelector(`[data-scroll-key="${CSS.escape(scrollKey)}"]`);
    if (node) node.scrollTop = top;
  }
  if (!key) return;
  const next = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus({ preventScroll: true });
  if (selection && typeof next.setSelectionRange === 'function') {
    try {
      next.setSelectionRange(...selection);
    } catch {
      // Some input types do not support selection ranges.
    }
  }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-UX-Guard-Token': session.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
  });
  const data = await response.json().catch(() => ({ error: 'the local review returned an unreadable response' }));
  if (!response.ok) {
    const error = new Error(data.error ?? response.statusText);
    error.status = response.status;
    throw error;
  }
  return data;
}

function announce(message) {
  const status = document.getElementById('status');
  status.textContent = '';
  window.setTimeout(() => {
    status.textContent = message;
  }, 30);
}

function showError(message) {
  const error = document.getElementById('error');
  error.textContent = message;
  error.hidden = false;
}

function hideError() {
  document.getElementById('error').hidden = true;
}

function state() {
  return session.data.state;
}

function decisionFor(id) {
  return session.review.proposals[id] ?? { action: 'pending' };
}

function addedEntry(id) {
  return session.review.added.find((entry) => entry.id === id);
}

function itemById(id) {
  return state().useCases.find((item) => item.id === id) ?? null;
}

function actionOf(item) {
  return item.origin === 'candidate' ? decisionFor(item.id).action : 'add';
}

function changed(message) {
  session.dirty = true;
  session.closeArmed = false;
  renderHeader();
  window.clearTimeout(session.evalTimer);
  session.evalTimer = window.setTimeout(evaluate, 250);
  if (message) announce(message);
}

async function evaluate() {
  const sequence = ++session.evalSequence;
  try {
    const data = await api('/api/evaluate', { review: session.review });
    if (sequence !== session.evalSequence) return;
    session.data = data;
    hideError();
    renderAll();
  } catch (error) {
    if (sequence === session.evalSequence) {
      showError(`These decisions could not be checked: ${error.message}`);
    }
  }
}

async function save() {
  if (!session.dirty) return;
  window.clearTimeout(session.evalTimer);
  const button = document.getElementById('save');
  button.disabled = true;
  try {
    const data = await api('/api/save', { review: session.review });
    session.data = data;
    session.review = structuredClone(data.review);
    session.dirty = false;
    hideError();
    renderAll();
    announce(
      `Saved revision ${data.saved.revision} to ${data.saved.path} as an unapproved review. Nothing was approved, adopted, or enforced.`,
    );
  } catch (error) {
    renderHeader();
    if (error.status === 409) {
      showError(`${error.message} Your unsaved decisions remain in this tab; reload only after copying anything you need.`);
    } else {
      showError(`The review was not saved: ${error.message}`);
    }
  }
}

async function closeReview() {
  if (session.dirty && !session.closeArmed) {
    session.closeArmed = true;
    announce('You have unsaved decisions. Save them first, or choose Close review again to discard them.');
    return;
  }
  try {
    await api('/api/close', {});
  } catch {
    // The process may already be stopping.
  }
  session.dirty = false;
  document.body.replaceChildren(
    h(
      'main',
      { id: 'main', class: 'closed', tabindex: '-1' },
      h('h1', { text: 'The review is closed' }),
      h('p', { text: 'The local ux-guard review process has stopped. You can close this tab.' }),
    ),
  );
  document.getElementById('main').focus();
}

function selectTab(name, { focus = false } = {}) {
  session.tab = name;
  for (const tab of TABS) {
    const button = document.getElementById(`tab-${tab}`);
    const panel = document.getElementById(`panel-${tab}`);
    const selected = tab === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  if (focus) document.getElementById(`tab-${name}`).focus();
}

function wireTabs() {
  const list = document.querySelector('[role="tablist"]');
  for (const tab of TABS) {
    document.getElementById(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
  }
  list.addEventListener('keydown', (event) => {
    const index = TABS.indexOf(session.tab);
    const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    selectTab(TABS[(moves[event.key] + TABS.length) % TABS.length], { focus: true });
  });
}

// List navigation: arrow keys move between the item buttons of one inbox,
// across outcome groups.
function listKeys(event) {
  const buttons = [...event.currentTarget.querySelectorAll('button[data-list-item]')];
  const index = buttons.indexOf(document.activeElement);
  if (index === -1) return;
  const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
  if (!(event.key in moves)) return;
  event.preventDefault();
  buttons[Math.max(0, Math.min(buttons.length - 1, moves[event.key]))].focus();
}

function badge(text, tone) {
  return h('span', { class: `badge ${tone ?? ''}`, text });
}

function actionTone(action) {
  return { pending: 'warn', reject: 'muted', merge: 'info', split: 'info' }[action] ?? 'ok';
}

function statusTone(status) {
  return { mapped: 'ok', excluded: 'muted', proposed: 'info', unresolved: 'warn' }[status];
}

function goToScope(scope) {
  if (scope.startsWith('use-case:')) {
    session.useCase = scope.slice('use-case:'.length);
    selectTab('use-cases');
    renderUseCases();
    document.querySelector(`[data-focus-key="use-case:${CSS.escape(session.useCase)}"]`)?.focus();
  } else if (scope.startsWith('surface:') || scope.startsWith('workflow:')) {
    session.subject = scope;
    selectTab('coverage');
    renderCoverage();
    document.querySelector(`[data-focus-key="subject:${CSS.escape(scope)}"]`)?.focus();
  } else {
    selectTab('preview');
  }
}

function renderAll() {
  renderHeader();
  renderIdentity();
  renderSummary();
  renderUseCases();
  renderCoverage();
  renderPreview();
}

function renderHeader() {
  if (!session.data) return;
  const { paths } = session.data;
  document.getElementById('repo-line').textContent =
    `Candidate ${paths.candidate} · Review decisions ${paths.review} · Catalog ${paths.catalog}`;
  const saveState = document.getElementById('save-state');
  if (session.dirty) saveState.textContent = 'Unsaved changes';
  else if (session.data.saved) saveState.textContent = `Saved revision ${session.review.revision} · unapproved`;
  else saveState.textContent = 'Not saved yet';
  document.getElementById('save').disabled = !session.dirty;
}

function renderIdentity() {
  const banner = document.getElementById('identity-banner');
  const identity = state().identity;
  banner.className = 'banner';
  if (identity.status === 'current') {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (identity.status === 'stale') {
    banner.classList.add('danger');
    banner.replaceChildren(
      h('strong', { text: 'This candidate is stale. ' }),
      'You can keep reviewing and saving, but adoption is blocked until a fresh candidate is prepared. ',
      h('ul', {}, identity.reasons.map((reason) => h('li', { text: reason }))),
    );
  } else if (identity.status === 'moved') {
    banner.classList.add('info');
    banner.textContent =
      'The repository has new commits since the assessment, but every assessed file is unchanged.';
  } else {
    banner.classList.add('warn');
    banner.textContent =
      'Repository identity could not be verified because Git history is unavailable. Assessed file contents still match.';
  }
}

function renderSummary() {
  const panel = document.getElementById('panel-summary');
  rerender(panel, () => {
    const { summary, unresolved, issues, questions } = state();
    const cards = [
      ['discovered', 'Discovered', summary.discovered, 'Surfaces and workflows found by the assessment and navigation source.', 'all'],
      ['mapped', 'Mapped', summary.mapped, 'Covered by an accepted or existing use case.', 'mapped'],
      ['proposed', 'Awaiting decision', summary.proposed, 'Mapped only to proposals that are still undecided.', 'proposed'],
      ['excluded', 'Excluded', summary.excluded, 'Explicitly out of scope, with a rationale.', 'excluded'],
      ['unresolved', 'Unresolved', summary.unresolved, 'Needs a mapping, an exclusion rationale, or a fix.', 'unresolved'],
    ];
    const ready = summary.readyForOwnerApproval;
    return [
      h('h2', { text: 'Summary' }),
      h(
        'p',
        { class: ready ? 'callout ok' : 'callout warn' },
        ready
          ? 'No unresolved decisions or blocking issues remain. The owner can now decide whether to approve and adopt this catalog; saving alone changes nothing.'
          : `${summary.unresolvedDecisions} unresolved decision${summary.unresolvedDecisions === 1 ? '' : 's'} and ${summary.blockingIssues} blocking issue${summary.blockingIssues === 1 ? '' : 's'} remain. Unknowns stay visible until someone decides them.`,
      ),
      h(
        'ul',
        { class: 'cards', 'aria-label': 'Coverage totals' },
        cards.map(([key, label, count, help, filter]) =>
          h(
            'li',
            { class: `card ${key}` },
            h('span', { class: 'card-count', text: String(count) }),
            h('span', { class: 'card-label', text: label }),
            h('span', { class: 'card-help', text: help }),
            h('button', {
              type: 'button',
              class: 'link',
              'data-focus-key': `summary-card:${key}`,
              text: `Show ${label.toLowerCase()}`,
              onclick: () => {
                session.filters.subjects.status = filter;
                selectTab('coverage');
                renderCoverage();
                document.querySelector('[data-focus-key="subjects-status"]')?.focus();
              },
            }),
          ),
        ),
      ),
      h('h3', { text: 'Proposed use cases' }),
      h(
        'div',
        { class: 'progress-row' },
        h('label', { for: 'proposal-progress', text: `${summary.proposals.decided} of ${summary.proposals.total} proposals decided` }),
        h('progress', { id: 'proposal-progress', max: String(Math.max(1, summary.proposals.total)), value: String(summary.proposals.decided) }),
      ),
      h(
        'ul',
        { class: 'inline-list' },
        ['approve', 'revise', 'reject', 'merge', 'split', 'pending'].map((action) =>
          h('li', {}, badge(`${ACTION_LABELS[action]}: ${summary.proposals[action]}`, actionTone(action))),
        ),
        h('li', {}, badge(`Added by owner: ${summary.proposals.added}`, 'ok')),
        h('li', {}, badge(`Split parts: ${summary.proposals.splitParts}`, 'info')),
      ),
      h('h3', { text: `Unresolved decisions (${unresolved.length})` }),
      unresolved.length
        ? h(
            'ul',
            { class: 'task-list' },
            unresolved.slice(0, 200).map((item, index) =>
              h(
                'li',
                {},
                h('span', { text: item.message }),
                h('button', {
                  type: 'button',
                  class: 'link',
                  'data-focus-key': `unresolved:${index}`,
                  text: 'Go to item',
                  'aria-label': `Go to: ${item.message}`,
                  onclick: () => goToScope(item.scope),
                }),
              ),
            ),
          )
        : h('p', { text: 'Every proposal and discovered item has a decision.' }),
      h('h3', { text: `Validation and conflicts (${issues.length})` }),
      issues.length
        ? h(
            'ul',
            { class: 'issue-list' },
            [...issues]
              .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
              .map((issue) =>
                h(
                  'li',
                  { class: issue.severity },
                  badge(issue.severity === 'error' ? 'Blocking' : 'Warning', issue.severity === 'error' ? 'danger' : 'warn'),
                  ' ',
                  issue.message,
                ),
              ),
          )
        : h('p', { text: 'No validation problems were found.' }),
      questions.length ? h('h3', { text: 'Open questions from the assessment' }) : null,
      questions.length
        ? h(
            'ul',
            { class: 'question-list' },
            questions.map((question) =>
              h('li', {}, h('strong', { text: question.question }), question.impact ? h('p', { class: 'muted', text: question.impact }) : null),
            ),
          )
        : null,
    ];
  });
}

function useCaseMatches(item) {
  const filter = session.filters.useCases;
  const action = actionOf(item);
  if (filter.status === 'issues' && !item.issues.length && !item.omitted.length) return false;
  if (!['all', 'issues'].includes(filter.status) && action !== filter.status) return false;
  if (filter.outcome !== 'all' && (item.effective.outcome ?? '') !== filter.outcome) return false;
  const text = filter.text.trim().toLowerCase();
  if (text && !`${item.id} ${item.effective.title ?? ''} ${item.effective.persona ?? ''}`.toLowerCase().includes(text)) {
    return false;
  }
  return true;
}

function renderUseCases() {
  const panel = document.getElementById('panel-use-cases');
  rerender(panel, () => {
    const { useCases, outcomes, summary } = state();
    if (!session.useCase || !useCases.some(({ id }) => id === session.useCase)) {
      session.useCase = useCases.find((item) => actionOf(item) === 'pending')?.id ?? useCases[0]?.id ?? null;
    }
    const filter = session.filters.useCases;
    const visible = useCases.filter(useCaseMatches);
    const groups = outcomes
      .map((group) => ({ ...group, items: visible.filter((item) => group.useCaseIds.includes(item.id)) }))
      .filter((group) => group.items.length);
    const filters = h(
      'div',
      { class: 'filters', role: 'group', 'aria-label': 'Filter use cases' },
      h('label', { for: 'use-case-search', text: 'Search' }),
      h('input', {
        id: 'use-case-search',
        type: 'search',
        'data-focus-key': 'use-case-search',
        value: filter.text,
        oninput: (event) => {
          filter.text = event.target.value;
          renderUseCases();
        },
      }),
      h('label', { for: 'use-case-status', text: 'Decision' }),
      h(
        'select',
        {
          id: 'use-case-status',
          'data-focus-key': 'use-case-status',
          value: filter.status,
          onchange: (event) => {
            filter.status = event.target.value;
            renderUseCases();
          },
        },
        h('option', { value: 'all', text: 'All decisions' }),
        h('option', { value: 'issues', text: 'Has warnings or blockers' }),
        Object.entries(ACTION_LABELS).map(([value, label]) => h('option', { value, text: label })),
      ),
      outcomes.length > 1
        ? [
            h('label', { for: 'use-case-outcome', text: 'User outcome' }),
            h(
              'select',
              {
                id: 'use-case-outcome',
                'data-focus-key': 'use-case-outcome',
                value: filter.outcome,
                onchange: (event) => {
                  filter.outcome = event.target.value;
                  renderUseCases();
                },
              },
              h('option', { value: 'all', text: 'All outcomes' }),
              outcomes.map((group) => h('option', { value: group.id, text: group.title })),
            ),
          ]
        : null,
    );
    const inbox = h(
      'div',
      { class: 'inbox', 'data-scroll-key': 'use-case-inbox', onkeydown: listKeys },
      h(
        'div',
        { class: 'progress-row' },
        h('label', { for: 'inbox-progress', text: `${summary.proposals.decided} of ${summary.proposals.total} decided · showing ${visible.length}` }),
        h('progress', { id: 'inbox-progress', max: String(Math.max(1, summary.proposals.total)), value: String(summary.proposals.decided) }),
      ),
      h('button', { type: 'button', class: 'secondary', 'data-focus-key': 'add-use-case', text: 'Add a missed use case', onclick: addUseCase }),
      groups.length === 0 ? h('p', { text: 'No use cases match these filters.' }) : null,
      groups.map((group) =>
        h(
          'section',
          { class: 'group', 'aria-labelledby': `outcome-${group.id || 'none'}` },
          h('h3', { id: `outcome-${group.id || 'none'}`, text: group.title }),
          group.summary ? h('p', { class: 'muted', text: group.summary }) : null,
          h(
            'ul',
            { class: 'item-list', 'aria-label': `${group.title} use cases` },
            group.items.map((item) =>
              h(
                'li',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'item',
                    'data-list-item': true,
                    'data-focus-key': `use-case:${item.id}`,
                    'aria-current': item.id === session.useCase ? 'true' : null,
                    onclick: () => {
                      session.useCase = item.id;
                      renderUseCases();
                    },
                  },
                  h('span', { class: 'item-title', text: item.effective.title ?? item.id }),
                  h('span', { class: 'item-meta' }, badge(ACTION_LABELS[actionOf(item)], actionTone(actionOf(item))),
                    item.issues.some(({ severity }) => severity === 'error') || item.omitted.length ? badge('Needs attention', 'danger') : null),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const selected = useCases.find(({ id }) => id === session.useCase);
    return [
      h('h2', { text: 'Use cases' }),
      h('p', { class: 'muted', text: 'Proposals are grouped by the user outcome they serve. Choose one to review it.' }),
      filters,
      h('div', { class: 'master-detail' }, inbox, selected ? useCaseDetail(selected) : h('p', { text: 'There are no use cases to review.' })),
    ];
  });
}

function rawKey(id, field) {
  return `${id}:${field}`;
}

function fieldValue(item, field) {
  if (item.origin === 'candidate') {
    const fields = decisionFor(item.id).fields ?? {};
    return Object.hasOwn(fields, field) ? fields[field] : item.proposed[field];
  }
  return addedEntry(item.id)?.[field];
}

function editableItem(item) {
  return item.origin !== 'candidate' || decisionFor(item.id).action === 'revise';
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function setField(item, field, value) {
  if (item.origin === 'candidate') {
    const decision = session.review.proposals[item.id];
    if (decision?.action !== 'revise') return;
    decision.fields ??= {};
    if (value === undefined || sameValue(value, item.proposed[field])) delete decision.fields[field];
    else decision.fields[field] = value;
  } else {
    const entry = addedEntry(item.id);
    if (!entry) return;
    if (value === undefined) delete entry[field];
    else entry[field] = value;
  }
  changed();
}

function parseStarts(text) {
  const starts = [];
  const errors = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const assistant = /^assistant:\s*(.+)$/i.exec(line);
    if (assistant) {
      starts.push({ entry: 'assistant', prompt: assistant[1].trim() });
      return;
    }
    const parts = line.split(/\s+/);
    if (parts.length === 2 && NAV_ID.test(parts[0]) && parts[1].startsWith('/')) {
      starts.push({ nav_id: parts[0], route: parts[1] });
    } else {
      errors.push(`Line ${index + 1}: write “navigation-id /route” or “assistant: prompt”.`);
    }
  });
  return { starts, errors };
}

function formatStarts(starts = []) {
  return starts.map((start) => (start.entry === 'assistant' ? `assistant: ${start.prompt}` : `${start.nav_id} ${start.route}`)).join('\n');
}

function fieldControl(item, field, label, kind) {
  const id = `field-${field}`;
  const key = rawKey(item.id, field);
  const editable = editableItem(item);
  const error = session.fieldErrors.get(key);
  const proposed = item.origin === 'candidate' ? item.proposed[field] : undefined;
  const current = fieldValue(item, field);
  const value = session.raw.has(key) ? session.raw.get(key) : current ?? '';
  const describedBy = [error ? `${id}-error` : null, item.origin === 'candidate' && !sameValue(current, proposed) ? `${id}-proposed` : null]
    .filter(Boolean)
    .join(' ');
  const onInput = (event) => {
    const text = event.target.value;
    session.raw.set(key, text);
    if (!text.trim()) {
      if (field === 'title' && item.origin !== 'candidate') {
        session.fieldErrors.set(key, 'A use case needs a title.');
        renderUseCases();
        return;
      }
      session.fieldErrors.delete(key);
      setField(item, field, field === 'rationale' && item.origin !== 'candidate' ? '' : undefined);
      return;
    }
    session.fieldErrors.delete(key);
    setField(item, field, text);
  };
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: label }),
    h(kind, {
      id,
      'data-focus-key': id,
      value,
      readonly: !editable,
      'aria-invalid': error ? 'true' : null,
      'aria-describedby': describedBy || null,
      rows: kind === 'textarea' ? '2' : null,
      oninput: onInput,
    }),
    item.origin === 'candidate' && !sameValue(current, proposed)
      ? h('p', { id: `${id}-proposed`, class: 'hint', text: `Proposed: ${proposed ?? '(not provided)'}` })
      : null,
    error ? h('p', { id: `${id}-error`, class: 'field-error', text: error }) : null,
  );
}

function choiceControl(item, field, label, values) {
  const id = `field-${field}`;
  const current = fieldValue(item, field) ?? '';
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: label }),
    h(
      'select',
      {
        id,
        'data-focus-key': id,
        value: current,
        disabled: !editableItem(item),
        onchange: (event) => setField(item, field, event.target.value || undefined),
      },
      h('option', { value: '', text: 'Not set' }),
      values.map(([value, text]) => h('option', { value, text })),
    ),
  );
}

function listControl(item, field, label, help) {
  const id = `field-${field}`;
  const key = rawKey(item.id, field);
  const error = session.fieldErrors.get(key);
  const current = fieldValue(item, field);
  const formatted = field === 'starts' ? formatStarts(current) : (current ?? []).join('\n');
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: label }),
    h('p', { id: `${id}-help`, class: 'hint', text: help }),
    h('textarea', {
      id,
      rows: '3',
      'data-focus-key': id,
      value: session.raw.has(key) ? session.raw.get(key) : formatted,
      readonly: !editableItem(item),
      'aria-invalid': error ? 'true' : null,
      'aria-describedby': [`${id}-help`, error ? `${id}-error` : null].filter(Boolean).join(' '),
      oninput: (event) => {
        session.raw.set(key, event.target.value);
        if (field === 'starts') {
          const parsed = parseStarts(event.target.value);
          if (parsed.errors.length) {
            session.fieldErrors.set(key, parsed.errors.join(' '));
            renderUseCases();
            return;
          }
          session.fieldErrors.delete(key);
          setField(item, field, parsed.starts);
          return;
        }
        const values = event.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
        setField(item, field, values.length ? values : undefined);
      },
    }),
    error ? h('p', { id: `${id}-error`, class: 'field-error', text: error }) : null,
  );
}

function acceptedTargets(exceptId) {
  const targets = state().existingUseCases.map(({ id, title }) => ({ id, title, label: 'active catalog' }));
  for (const item of state().useCases) {
    if (item.id === exceptId) continue;
    const action = actionOf(item);
    if (['approve', 'revise', 'add'].includes(action)) {
      targets.push({ id: item.id, title: fieldValue(item, 'title') ?? item.id, label: ACTION_LABELS[action].toLowerCase() });
    }
  }
  return targets;
}

function uniqueId(base) {
  const taken = new Set([...state().useCases.map(({ id }) => id), ...state().existingUseCases.map(({ id }) => id), ...session.review.added.map(({ id }) => id)]);
  let index = 1;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function removeParts(parentId) {
  const parts = session.review.added.filter((entry) => entry.origin === 'split' && entry.from === parentId).map(({ id }) => id);
  session.review.added = session.review.added.filter((entry) => !parts.includes(entry.id));
  for (const mapping of Object.values(session.review.mappings)) {
    mapping.useCaseIds = mapping.useCaseIds.filter((id) => !parts.includes(id));
  }
  return parts.length;
}

function setAction(item, action) {
  const previous = decisionFor(item.id);
  const note = previous.note;
  let message = `${fieldValue(item, 'title') ?? item.id}: ${ACTION_LABELS[action]}.`;
  if (previous.action === 'split' && action !== 'split') {
    const removed = removeParts(item.id);
    message += ` Removed ${removed} split part${removed === 1 ? '' : 's'}.`;
  }
  let decision = { action };
  if (action === 'revise') decision.fields = structuredClone(previous.fields ?? {});
  if (action === 'merge') {
    const target = acceptedTargets(item.id)[0];
    if (!target) return;
    decision.into = target.id;
    message = `${fieldValue(item, 'title') ?? item.id}: merged into ${target.title}.`;
  }
  if (action === 'split') {
    const parts = [uniqueId(`${item.id}-part`)];
    session.review.added.push(splitPart(item, parts[0], 1));
    parts.push(uniqueId(`${item.id}-part`));
    session.review.added.push(splitPart(item, parts[1], 2));
    decision.parts = parts;
    message += ' Created two parts to edit below.';
  }
  if (note) decision.note = note;
  if (action === 'pending' && !note) delete session.review.proposals[item.id];
  else session.review.proposals[item.id] = decision;
  for (const key of [...session.raw.keys()]) if (key.startsWith(`${item.id}:`)) session.raw.delete(key);
  changed(message);
}

function splitPart(item, id, index) {
  const part = { id, origin: 'split', from: item.id, title: `${fieldValue(item, 'title') ?? item.id} (part ${index})` };
  for (const field of ['persona', 'tier', 'effect', 'owner', 'goal', 'success', 'outcome']) {
    const value = fieldValue(item, field);
    if (value !== undefined) part[field] = value;
  }
  part.starts = structuredClone(fieldValue(item, 'starts') ?? []);
  return part;
}

function addUseCase() {
  const id = uniqueId('new-use-case');
  const outcome = session.filters.useCases.outcome !== 'all' ? session.filters.useCases.outcome : undefined;
  session.review.added.push({ id, origin: 'added', title: 'New use case', ...(outcome ? { outcome } : {}), starts: [] });
  session.useCase = id;
  changed('Added a new use case. Fill in its details.');
  window.setTimeout(() => document.getElementById('field-title')?.focus(), 300);
}

function renameAdded(item, next) {
  const entry = addedEntry(item.id);
  entry.id = next;
  for (const mapping of Object.values(session.review.mappings)) {
    mapping.useCaseIds = mapping.useCaseIds.map((id) => (id === item.id ? next : id));
  }
  for (const decision of Object.values(session.review.proposals)) {
    if (decision.into === item.id) decision.into = next;
    if (decision.parts) decision.parts = decision.parts.map((id) => (id === item.id ? next : id));
  }
  session.useCase = next;
  changed(`Renamed to ${next}.`);
}

function removeAdded(item) {
  session.review.added = session.review.added.filter((entry) => entry.id !== item.id);
  for (const mapping of Object.values(session.review.mappings)) {
    mapping.useCaseIds = mapping.useCaseIds.filter((id) => id !== item.id);
  }
  if (item.from) {
    const parent = session.review.proposals[item.from];
    if (parent?.parts) parent.parts = parent.parts.filter((id) => id !== item.id);
  }
  session.useCase = null;
  changed(`Removed ${item.id}.`);
}

function addSplitPart(parent) {
  const decision = session.review.proposals[parent.id];
  const id = uniqueId(`${parent.id}-part`);
  session.review.added.push(splitPart(parent, id, decision.parts.length + 1));
  decision.parts.push(id);
  changed(`Added split part ${id}.`);
}

function useCaseDetail(item) {
  const action = actionOf(item);
  const title = fieldValue(item, 'title') ?? item.id;
  const targets = acceptedTargets(item.id);
  const decisionNote = item.origin === 'candidate' ? decisionFor(item.id).note ?? '' : '';
  const subjects = state().subjects.filter((subject) => item.subjects.includes(subject.key));
  const idKey = rawKey(item.id, 'id');
  const idError = session.fieldErrors.get(idKey);
  const actions = [
    ['pending', 'Undecided', 'Keep this proposal open.'],
    ['approve', 'Approve as proposed', 'Accept the proposal exactly as written.'],
    ['revise', 'Approve with revisions', 'Accept it after editing the fields below.'],
    ['reject', 'Reject', 'Do not add it; anything mapped to it becomes unresolved.'],
    ['merge', 'Merge into another use case', targets.length ? 'Fold its starts and mappings into an accepted use case.' : 'Approve or add a use case first; there is nothing to merge into yet.'],
    ['split', 'Split into separate use cases', 'Create editable parts; remap anything that pointed at this proposal.'],
  ];
  return h(
    'article',
    { class: 'detail', 'aria-labelledby': 'detail-title' },
    h(
      'header',
      { class: 'detail-header' },
      h('h3', { id: 'detail-title', text: title }),
      h('p', { class: 'muted' }, `${item.id} · `, item.origin === 'candidate' ? 'Proposed by the assessment' : item.origin === 'split' ? `Split from ${item.from}` : 'Added by the owner', ' · ', badge(ACTION_LABELS[action], actionTone(action))),
      item.origin === 'candidate' && item.proposed.rationale
        ? h('p', { class: 'rationale' }, h('strong', { text: 'Why it was proposed: ' }), item.proposed.rationale)
        : null,
      item.capability !== 'unknown' ? h('p', { class: 'muted', text: `Product capability: ${item.capability}` }) : null,
    ),
    item.issues.length || item.omitted.length
      ? h(
          'ul',
          { class: 'issue-list' },
          item.issues.map((issue) => h('li', { class: issue.severity }, badge(issue.severity === 'error' ? 'Blocking' : 'Warning', issue.severity === 'error' ? 'danger' : 'warn'), ' ', issue.message)),
          item.omitted.map((reason) => h('li', { class: 'error' }, badge('Not in catalog', 'danger'), ` ${reason}`)),
        )
      : null,
    item.origin === 'candidate'
      ? h(
          'fieldset',
          { class: 'decision' },
          h('legend', { text: 'Decision' }),
          actions.map(([value, label, help]) =>
            h(
              'div',
              { class: 'radio' },
              h('input', {
                type: 'radio',
                name: 'decision',
                id: `decision-${value}`,
                value,
                'data-focus-key': `decision-${value}`,
                checked: action === value,
                disabled: value === 'merge' && !targets.length && action !== 'merge',
                'aria-describedby': `decision-${value}-help`,
                onchange: () => setAction(item, value),
              }),
              h('label', { for: `decision-${value}`, text: label }),
              h('p', { id: `decision-${value}-help`, class: 'hint', text: help }),
            ),
          ),
          action === 'merge'
            ? h(
                'div',
                { class: 'field' },
                h('label', { for: 'merge-into', text: 'Merge into' }),
                h(
                  'select',
                  {
                    id: 'merge-into',
                    'data-focus-key': 'merge-into',
                    value: decisionFor(item.id).into,
                    onchange: (event) => {
                      session.review.proposals[item.id].into = event.target.value;
                      changed(`Merging into ${event.target.selectedOptions[0].textContent}.`);
                    },
                  },
                  targets.map((target) => h('option', { value: target.id, text: `${target.title} (${target.label})` })),
                  targets.some(({ id }) => id === decisionFor(item.id).into) ? null : h('option', { value: decisionFor(item.id).into, text: `${decisionFor(item.id).into} (not accepted)` }),
                ),
              )
            : null,
          action === 'split'
            ? h(
                'div',
                { class: 'split-parts' },
                h('p', { text: `Parts: ${decisionFor(item.id).parts.join(', ')}` }),
                h(
                  'ul',
                  { class: 'inline-list' },
                  decisionFor(item.id).parts.map((part) =>
                    h('li', {}, h('button', { type: 'button', class: 'link', 'data-focus-key': `open-part:${part}`, text: `Edit ${part}`, onclick: () => { session.useCase = part; renderUseCases(); document.getElementById('detail-title')?.focus(); } })),
                  ),
                ),
                h('button', { type: 'button', class: 'secondary', 'data-focus-key': 'add-part', text: 'Add another part', onclick: () => addSplitPart(item) }),
              )
            : null,
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'decision-note', text: 'Decision note (optional)' }),
            h('textarea', {
              id: 'decision-note',
              rows: '2',
              'data-focus-key': 'decision-note',
              value: decisionNote,
              oninput: (event) => {
                const decision = session.review.proposals[item.id] ?? { action: 'pending' };
                if (event.target.value) decision.note = event.target.value;
                else delete decision.note;
                if (decision.action === 'pending' && !decision.note) delete session.review.proposals[item.id];
                else session.review.proposals[item.id] = decision;
                changed();
              },
            }),
          ),
        )
      : h(
          'div',
          { class: 'decision' },
          h('div', { class: 'field' },
            h('label', { for: 'field-id', text: 'Use-case id' }),
            h('input', {
              id: 'field-id',
              'data-focus-key': 'field-id',
              value: session.raw.has(idKey) ? session.raw.get(idKey) : item.id,
              'aria-invalid': idError ? 'true' : null,
              'aria-describedby': idError ? 'field-id-error' : 'field-id-help',
              onchange: (event) => {
                const next = event.target.value.trim();
                session.raw.set(idKey, next);
                const taken = new Set([...state().useCases.map(({ id }) => id), ...state().existingUseCases.map(({ id }) => id)]);
                if (!USE_CASE_ID.test(next)) session.fieldErrors.set(idKey, 'Use lowercase words separated by hyphens.');
                else if (next !== item.id && taken.has(next)) session.fieldErrors.set(idKey, `${next} is already used.`);
                else {
                  session.fieldErrors.delete(idKey);
                  session.raw.delete(idKey);
                  if (next !== item.id) renameAdded(item, next);
                  return;
                }
                renderUseCases();
              },
            }),
            h('p', { id: 'field-id-help', class: 'hint', text: 'Lowercase words separated by hyphens. Changes apply when you leave the field.' }),
            idError ? h('p', { id: 'field-id-error', class: 'field-error', text: idError }) : null,
          ),
          h('button', { type: 'button', class: 'danger', 'data-focus-key': 'remove-added', text: item.origin === 'split' ? 'Remove this split part' : 'Remove this added use case', onclick: () => removeAdded(item) }),
        ),
    h(
      'fieldset',
      { class: 'fields', disabled: ['reject', 'merge', 'split'].includes(action) },
      h('legend', { text: editableItem(item) ? 'Catalog details' : 'Catalog details (choose “Approve with revisions” to edit)' }),
      item.origin === 'candidate' && action === 'revise' ? h('p', { class: 'hint', text: 'Blank fields keep the proposed value.' }) : null,
      TEXT_FIELDS.slice(0, 3).map(([field, label, kind]) => fieldControl(item, field, label, kind)),
      h('div', { class: 'field-row' },
        choiceControl(item, 'tier', 'Tier', TIERS.map((tier) => [tier, tier])),
        choiceControl(item, 'effect', 'Effect', EFFECTS.map((effect) => [effect, effect])),
        state().outcomes.some(({ id }) => id)
          ? choiceControl(item, 'outcome', 'User outcome', state().outcomes.filter(({ id }) => id).map(({ id, title: text }) => [id, text]))
          : null,
      ),
      TEXT_FIELDS.slice(3).map(([field, label, kind]) => fieldControl(item, field, label, kind)),
      listControl(item, 'starts', 'Starts', 'One per line: “navigation-id /route” or “assistant: prompt”. Mapped surfaces are added automatically.'),
      listControl(item, 'requirements', 'Requirements', 'One requirement per line.'),
      listControl(item, 'gaps', 'Known gaps', 'One gap per line.'),
    ),
    h(
      'div',
      { class: 'side-by-side' },
      h(
        'section',
        { 'aria-labelledby': 'sources-title' },
        h('h4', { id: 'sources-title', text: `Source surfaces and workflows (${subjects.length})` }),
        subjects.length
          ? h('ul', { class: 'subject-list' }, subjects.map((subject) =>
              h('li', {},
                h('button', { type: 'button', class: 'link', 'data-focus-key': `source:${subject.key}`, text: subject.label, onclick: () => goToScope(subject.key) }),
                ' ', badge(subject.type === 'surface' ? 'Surface' : 'Workflow', 'muted'), ' ', badge(STATUS_LABELS[subject.status], statusTone(subject.status)),
                h('p', { class: 'muted', text: [subject.route ?? subject.entry, subject.sources.join(', ')].filter(Boolean).join(' · ') }),
              ),
            ))
          : h('p', { class: 'muted', text: 'Nothing is mapped to this use case yet.' }),
      ),
      h(
        'section',
        { 'aria-labelledby': 'entry-title' },
        h('h4', { id: 'entry-title', text: 'Resulting catalog entry' }),
        item.catalogEntry
          ? h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Resulting catalog entry', text: entryText(item.catalogEntry) })
          : h('p', { class: 'muted', text: item.omitted.length ? `Not included: ${item.omitted.join('; ')}` : action === 'pending' ? 'Not included until a decision is made.' : 'Not included in the catalog.' }),
      ),
    ),
  );
}

function entryText(entry) {
  const lines = [];
  for (const [key, value] of Object.entries(entry)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === 'string') lines.push(`  - ${item}`);
        else lines.push(`  - ${Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function subjectMatches(subject) {
  const filter = session.filters.subjects;
  if (filter.status !== 'all' && subject.status !== filter.status) return false;
  if (filter.type !== 'all' && subject.type !== filter.type) return false;
  const text = filter.text.trim().toLowerCase();
  if (text && !`${subject.id} ${subject.label} ${subject.route ?? ''} ${subject.entry ?? ''}`.toLowerCase().includes(text)) return false;
  return true;
}

function renderCoverage() {
  const panel = document.getElementById('panel-coverage');
  rerender(panel, () => {
    const { subjects, summary } = state();
    const filter = session.filters.subjects;
    const visible = subjects.filter(subjectMatches);
    if (!session.subject || !subjects.some(({ key }) => key === session.subject)) {
      session.subject = subjects.find(({ status }) => status === 'unresolved')?.key ?? subjects[0]?.key ?? null;
    }
    const selected = subjects.find(({ key }) => key === session.subject);
    return [
      h('h2', { text: 'Surfaces and workflows' }),
      h('p', { class: 'muted', text: `Map each discovered item to a use case or exclude it with a reason. ${summary.mapped} mapped, ${summary.proposed} awaiting a decision, ${summary.excluded} excluded, ${summary.unresolved} unresolved.` }),
      h(
        'div',
        { class: 'filters', role: 'group', 'aria-label': 'Filter surfaces and workflows' },
        h('label', { for: 'subjects-search', text: 'Search' }),
        h('input', { id: 'subjects-search', type: 'search', 'data-focus-key': 'subjects-search', value: filter.text, oninput: (event) => { filter.text = event.target.value; renderCoverage(); } }),
        h('label', { for: 'subjects-status', text: 'Status' }),
        h('select', { id: 'subjects-status', 'data-focus-key': 'subjects-status', value: filter.status, onchange: (event) => { filter.status = event.target.value; renderCoverage(); } },
          h('option', { value: 'all', text: 'All statuses' }),
          Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, text: label })),
        ),
        h('label', { for: 'subjects-type', text: 'Type' }),
        h('select', { id: 'subjects-type', 'data-focus-key': 'subjects-type', value: filter.type, onchange: (event) => { filter.type = event.target.value; renderCoverage(); } },
          h('option', { value: 'all', text: 'Surfaces and workflows' }),
          h('option', { value: 'surface', text: 'Navigation surfaces' }),
          h('option', { value: 'workflow', text: 'Workflows' }),
        ),
      ),
      h(
        'div',
        { class: 'master-detail' },
        h(
          'div',
          { class: 'inbox', 'data-scroll-key': 'subject-inbox' },
          h('p', { class: 'muted', text: `Showing ${visible.length} of ${subjects.length}` }),
          visible.length
            ? h('ul', { class: 'item-list', onkeydown: listKeys, 'aria-label': 'Surfaces and workflows' }, visible.map((subject) =>
                h('li', {}, h('button', {
                  type: 'button',
                  class: 'item',
                  'data-list-item': true,
                  'data-focus-key': `subject:${subject.key}`,
                  'aria-current': subject.key === session.subject ? 'true' : null,
                  onclick: () => { session.subject = subject.key; renderCoverage(); },
                },
                h('span', { class: 'item-title', text: subject.label }),
                h('span', { class: 'item-meta' }, badge(subject.type === 'surface' ? 'Surface' : 'Workflow', 'muted'), badge(STATUS_LABELS[subject.status], statusTone(subject.status))),
                )),
              ))
            : h('p', { text: 'Nothing matches these filters.' }),
        ),
        selected ? subjectDetail(selected) : h('p', { text: 'There is nothing to map.' }),
      ),
    ];
  });
}

function mappingFor(subject) {
  return session.review.mappings[subject.key] ?? structuredClone(subject.effective);
}

// An exclusion needs its own reason; the assessment's rationale for mapping
// the item must not silently satisfy it.
function inheritedRationale(subject, mapping, disposition) {
  const proposed = subject.proposed;
  if (disposition !== 'excluded' || proposed.disposition === 'excluded') return {};
  return mapping.rationale === proposed.rationale ? { rationale: '' } : {};
}

function setMapping(subject, patch, message) {
  session.review.mappings[subject.key] = { ...mappingFor(subject), ...patch };
  changed(message);
}

function subjectDetail(subject) {
  const mapping = mappingFor(subject);
  const choices = [
    ...state().existingUseCases.map(({ id, title }) => ({ id, title, note: 'active catalog' })),
    ...state().useCases.map((item) => ({ id: item.id, title: fieldValue(item, 'title') ?? item.id, note: ACTION_LABELS[actionOf(item)].toLowerCase() })),
  ];
  const rationaleRequired = mapping.disposition === 'excluded';
  const rationaleMissing = rationaleRequired && !mapping.rationale.trim();
  const proposed = subject.proposed;
  return h(
    'article',
    { class: 'detail', 'aria-labelledby': 'subject-title' },
    h('header', { class: 'detail-header' },
      h('h3', { id: 'subject-title', text: subject.label }),
      h('p', { class: 'muted' }, `${subject.type === 'surface' ? 'Navigation surface' : 'Workflow'} ${subject.id} · `, badge(STATUS_LABELS[subject.status], statusTone(subject.status))),
      h('dl', { class: 'facts' },
        subject.route ? [h('dt', { text: 'Route' }), h('dd', { text: subject.route })] : null,
        subject.entry ? [h('dt', { text: 'Entry' }), h('dd', { text: subject.entry })] : null,
        subject.kind ? [h('dt', { text: 'Kind' }), h('dd', { text: subject.kind })] : null,
        subject.capability ? [h('dt', { text: 'Product capability' }), h('dd', { text: subject.capability })] : null,
        [h('dt', { text: 'Sources' }), h('dd', { text: subject.sources.join(', ') || 'none recorded' })],
        [h('dt', { text: 'Assessment proposed' }), h('dd', { text: `${DISPOSITION_LABELS[proposed.disposition]}${proposed.useCaseIds.length ? `: ${proposed.useCaseIds.join(', ')}` : ''}${proposed.rationale ? ` — ${proposed.rationale}` : ''}` })],
      ),
    ),
    subject.issues.length ? h('ul', { class: 'issue-list' }, subject.issues.map((message) => h('li', { class: subject.status === 'unresolved' ? 'error' : 'warning' }, badge(subject.status === 'unresolved' ? 'Unresolved' : 'Warning', subject.status === 'unresolved' ? 'danger' : 'warn'), ` ${message}`))) : null,
    h('fieldset', { class: 'decision' },
      h('legend', { text: 'Decision' }),
      [
        ['use-case', 'Covered by use cases'],
        ['excluded', 'Excluded from the catalog'],
        ['unresolved', 'Leave unresolved'],
      ].map(([value, label]) =>
        h('div', { class: 'radio' },
          h('input', { type: 'radio', name: 'disposition', id: `disposition-${value}`, value, 'data-focus-key': `disposition-${value}`, checked: mapping.disposition === value, onchange: () => setMapping(subject, { disposition: value, ...inheritedRationale(subject, mapping, value) }, `${subject.label}: ${label.toLowerCase()}.`) }),
          h('label', { for: `disposition-${value}`, text: label }),
        ),
      ),
    ),
    mapping.disposition === 'use-case'
      ? h('fieldset', { class: 'choices', 'data-scroll-key': 'subject-choices' },
          h('legend', { text: `Use cases (${mapping.useCaseIds.length} selected)` }),
          choices.map((choice) =>
            h('div', { class: 'checkbox' },
              h('input', {
                type: 'checkbox',
                id: `map-${choice.id}`,
                'data-focus-key': `map-${choice.id}`,
                checked: mapping.useCaseIds.includes(choice.id),
                onchange: (event) => {
                  const ids = mapping.useCaseIds.filter((id) => id !== choice.id);
                  if (event.target.checked) ids.push(choice.id);
                  setMapping(subject, { useCaseIds: ids }, `${event.target.checked ? 'Mapped to' : 'Removed'} ${choice.title}.`);
                },
              }),
              h('label', { for: `map-${choice.id}` }, choice.title, h('span', { class: 'muted', text: ` (${choice.id}, ${choice.note})` })),
            ),
          ),
        )
      : null,
    h('div', { class: 'field' },
      h('label', { for: 'mapping-rationale', text: rationaleRequired ? 'Exclusion rationale (required)' : 'Rationale (optional)' }),
      h('textarea', {
        id: 'mapping-rationale',
        rows: '3',
        'data-focus-key': 'mapping-rationale',
        value: mapping.rationale,
        required: rationaleRequired,
        'aria-invalid': rationaleMissing ? 'true' : null,
        'aria-describedby': rationaleMissing ? 'mapping-rationale-error' : null,
        oninput: (event) => setMapping(subject, { rationale: event.target.value }),
      }),
      rationaleMissing ? h('p', { id: 'mapping-rationale-error', class: 'field-error', text: 'Explain why this is out of scope so the exclusion can be reviewed later.' }) : null,
    ),
    subject.decided
      ? h('button', { type: 'button', class: 'secondary', 'data-focus-key': 'reset-mapping', text: 'Reset to the assessment’s proposal', onclick: () => { delete session.review.mappings[subject.key]; changed(`${subject.label}: reset to the assessment’s proposal.`); } })
      : null,
  );
}

function renderPreview() {
  const panel = document.getElementById('panel-preview');
  rerender(panel, () => {
    const { catalog, summary } = state();
    const copy = (text, label) => async () => {
      try {
        await navigator.clipboard.writeText(text);
        announce(`${label} copied.`);
      } catch {
        announce(`Copying is unavailable here; select the ${label.toLowerCase()} text instead.`);
      }
    };
    return [
      h('h2', { text: 'Catalog preview' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Catalog path' }), h('dd', { text: catalog.path }),
        h('dt', { text: 'Status' }), h('dd', { text: catalog.exists ? 'An active catalog exists; the diff is against it.' : 'No catalog exists yet; the diff creates it.' }),
        h('dt', { text: 'Inventory' }), h('dd', { text: `${catalog.inventory} (unchanged; enforcement is a separate decision)` }),
        h('dt', { text: 'Generated use cases' }), h('dd', { text: String(catalog.entries) }),
      ),
      catalog.omitted.length
        ? [h('h3', { text: `Not included (${catalog.omitted.length})` }), h('ul', { class: 'issue-list' }, catalog.omitted.map((entry) => h('li', { class: 'error' }, h('button', { type: 'button', class: 'link', 'data-focus-key': `omitted:${entry.id}`, text: entry.id, onclick: () => goToScope(`use-case:${entry.id}`) }), `: ${entry.reasons.join('; ')}`)))]
        : null,
      h('h3', { text: 'Exact catalog diff' }),
      catalog.text === null
        ? h('p', { text: 'No catalog can be generated yet. Approve, revise, or add at least one complete use case.' })
        : catalog.diff
          ? [
              h('button', { type: 'button', class: 'secondary', 'data-focus-key': 'copy-diff', text: 'Copy diff', onclick: copy(catalog.diff, 'Diff') }),
              h('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Catalog diff', 'data-scroll-key': 'diff' },
                catalog.diff.trimEnd().split('\n').map((line) =>
                  h('span', { class: line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'remove' : 'context', text: `${line}\n` }),
                ),
              ),
            ]
          : h('p', { text: 'The generated catalog is identical to the active catalog.' }),
      catalog.text !== null
        ? h('details', { 'data-detail-key': 'full-catalog', open: session.open.has('full-catalog'), ontoggle: (event) => (event.target.open ? session.open.add('full-catalog') : session.open.delete('full-catalog')) },
            h('summary', { text: 'Full generated catalog' }),
            h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Full generated catalog', text: catalog.text }),
          )
        : null,
      h('section', { class: 'adoption', 'aria-labelledby': 'adoption-title' },
        h('h3', { id: 'adoption-title', text: 'After explicit owner approval' }),
        h('ol', {},
          h('li', { text: session.dirty ? 'Save this review. The command below uses the saved review and its saved preview, not unsaved edits.' : session.data.saved ? `The review is saved (revision ${session.review.revision}).` : 'Save this review first.' }),
          h('li', { text: summary.blockingIssues ? `Resolve the ${summary.blockingIssues} blocking issue${summary.blockingIssues === 1 ? '' : 's'}; adoption refuses while any remain.` : 'No blocking issues remain.' }),
          h('li', {}, 'The owner runs this command in a terminal. This app never runs it.',
            h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Adoption command', text: session.data.adoptCommand }),
            h('button', { type: 'button', class: 'secondary', 'data-focus-key': 'copy-command', text: 'Copy command', onclick: copy(session.data.adoptCommand, 'Command') }),
          ),
          h('li', { text: 'Checking in the catalog and changing enforcement are separate decisions after adoption.' }),
        ),
      ),
    ];
  });
}

async function init() {
  const match = /token=([0-9a-f]+)/.exec(window.location.hash);
  if (match) {
    window.sessionStorage.setItem(TOKEN_KEY, match[1]);
    window.history.replaceState(null, '', window.location.pathname);
  }
  session.token = window.sessionStorage.getItem(TOKEN_KEY);
  wireTabs();
  document.getElementById('save').addEventListener('click', save);
  document.getElementById('close').addEventListener('click', closeReview);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (session.dirty) event.preventDefault();
  });
  if (!session.token) {
    showError('Open the address printed by “ux-guard review” in your terminal; this page needs its session link.');
    return;
  }
  try {
    const data = await api('/api/state');
    session.data = data;
    session.review = structuredClone(data.review);
    renderAll();
    announce(`Review loaded: ${data.state.summary.unresolvedDecisions} unresolved decisions.`);
  } catch (error) {
    showError(`The review could not be loaded: ${error.message}`);
  }
}

init();
