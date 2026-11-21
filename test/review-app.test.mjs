import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_REVIEW_PATHS } from '../lib/review-store.mjs';
import { startReviewServer } from '../lib/review-server.mjs';
import { prepared, reviewRepo } from './review-helpers.mjs';

const APP = fileURLToPath(new URL('../lib/review-app/', import.meta.url));
const VOID = new Set(['meta', 'link', 'input', 'br', 'img']);
const nodeFetch = globalThis.fetch;

// A deliberately small DOM: enough of the standard API for the review app to
// run unmodified, so labels, references, and keyboard behavior can be checked
// without a browser dependency.
class FakeNode {
  constructor(document) {
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
  }
  // Failed assertions print nodes; the default inspection walks the whole
  // cyclic tree and effectively hangs.
  [Symbol.for('nodejs.util.inspect.custom')]() {
    if (!(this instanceof FakeElement)) return `#text ${JSON.stringify(this.textContent.slice(0, 40))}`;
    const key = this.getAttribute('data-focus-key');
    return `<${this.tagName.toLowerCase()}${this.id ? `#${this.id}` : ''}${key ? ` data-focus-key="${key}"` : ''}>`;
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.replaceChildren(String(value));
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof FakeNode ? node : new FakeText(this.ownerDocument, String(node));
      child.parentNode?.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  *elements() {
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) {
        yield child;
        yield* child.elements();
      }
    }
  }
  querySelectorAll(selector) {
    const match = compile(selector);
    return [...this.elements()].filter(match);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(document, text) {
    super(document);
    this.text = text;
  }
  get textContent() {
    return this.text;
  }
}

class FakeElement extends FakeNode {
  constructor(document, tagName) {
    super(document);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    const element = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_, key) => element.getAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      },
    );
    this.classList = {
      add: (...names) => (element.className = [...new Set([...element.className.split(' ').filter(Boolean), ...names])].join(' ')),
      contains: (name) => element.className.split(' ').includes(name),
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  get className() {
    return this.getAttribute('class') ?? '';
  }
  set className(value) {
    this.setAttribute('class', value);
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(value) {
    if (value) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }
  get tabIndex() {
    return Number(this.getAttribute('tabindex') ?? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1));
  }
  set tabIndex(value) {
    this.setAttribute('tabindex', String(value));
  }
  get selectedOptions() {
    return this.querySelectorAll('option').filter((option) => option.value === this.value);
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  click() {
    this.dispatchEvent(makeEvent('click'));
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (let current = this; current; current = current.parentNode ?? (current === this.ownerDocument.documentElement ? this.ownerDocument : null)) {
      for (const listener of current.listeners?.get(event.type) ?? []) {
        event.currentTarget = current;
        listener(event);
      }
      if (current === this.ownerDocument) break;
    }
    return !event.defaultPrevented;
  }
}

function makeEvent(type, init = {}) {
  return {
    type,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...init,
  };
}

function compile(selector) {
  const parsed = /^([a-z]+)?((?:\[[^\]]+\])*)$/i.exec(selector.trim());
  if (!parsed) throw new Error(`unsupported selector ${selector}`);
  const tag = parsed[1]?.toUpperCase();
  const tests = [...parsed[2].matchAll(/\[([a-z-]+)(?:="((?:\\.|[^"\\])*)")?\]/gi)].map(([, name, value]) => [
    name,
    value === undefined ? undefined : value.replace(/\\(.)/g, '$1'),
  ]);
  return (element) =>
    (!tag || element.tagName === tag) &&
    tests.every(([name, value]) => (value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value));
}

function createDocument(html) {
  const document = {
    listeners: new Map(),
    activeElement: null,
    createElement: (tag) => new FakeElement(document, tag),
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    getElementById(id) {
      return [...this.documentElement.elements()].find((element) => element.id === id) ?? null;
    },
    querySelector(selector) {
      return this.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return this.documentElement.querySelectorAll(selector);
    },
  };
  const root = new FakeElement(document, 'html');
  document.documentElement = root;
  const stack = [root];
  const source = html.replace(/<!doctype[^>]*>/i, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const [, closing, tag, attrs, text] of source.matchAll(/<(\/)?([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    const parent = stack.at(-1);
    if (text !== undefined) {
      if (text.trim()) parent.append(text.replace(/\s+/g, ' '));
      continue;
    }
    if (closing) {
      stack.pop();
      continue;
    }
    if (tag === 'html') {
      for (const [, name, value] of attrs.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) root.setAttribute(name, value ?? '');
      continue;
    }
    const element = new FakeElement(document, tag);
    for (const [, name, value] of attrs.matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) element.setAttribute(name, value ?? '');
    parent.append(element);
    if (!VOID.has(tag)) stack.push(element);
  }
  document.body = root.querySelector('body');
  document.activeElement = document.body;
  return document;
}

let runs = 0;

async function loadApp(t, { root = prepared(reviewRepo()).root } = {}) {
  const server = await startReviewServer((await import('./review-helpers.mjs')).context(root));
  const document = createDocument(readFileSync(join(APP, 'index.html'), 'utf8'));
  const storage = new Map();
  const windowListeners = new Map();
  const confirmCalls = [];
  const window = {
    location: { hash: `#token=${server.token}`, pathname: '/' },
    history: { replaceState: (_, __, path) => (window.location.hash = path.includes('#') ? path.slice(path.indexOf('#')) : '') },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (handle) => clearTimeout(handle),
    confirm: (message) => {
      confirmCalls.push(message);
      return true;
    },
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) ?? []) listener(event);
      return !event.defaultPrevented;
    },
  };
  const saved = {};
  const globals = {
    document,
    window,
    Node: FakeNode,
    CSS: { escape: (value) => String(value).replace(/["\\]/g, '\\$&') },
    fetch: (path, init) => nodeFetch(`${server.origin}${path}`, init),
  };
  for (const [key, value] of Object.entries(globals)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(async () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await server.close();
  });
  runs += 1;
  await import(`${pathToFileURL(join(APP, 'app.js')).href}?run=${runs}`);
  await until(
    () => document.getElementById('panel-summary').childNodes.length > 0 || !document.getElementById('error').hidden,
    'the first render',
  );
  assert.equal(document.getElementById('error').hidden, true, document.getElementById('error').textContent);
  return { document, window, server, root, storage, confirmCalls };
}

async function until(condition, message = 'condition') {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${message}`);
}

function key(target, name, extra = {}) {
  const event = makeEvent('keydown', { key: name, ...extra });
  target.dispatchEvent(event);
  return event;
}

function auditLabels(document) {
  const problems = [];
  for (const panel of document.querySelectorAll('section[role="tabpanel"]')) {
    const stray = /\bnull\b|\bundefined\b|\[object /.exec(panel.textContent);
    if (stray) problems.push(`${panel.id} renders a placeholder as text: ${stray[0]}`);
  }
  const all = [...document.documentElement.elements()];
  const ids = new Map();
  for (const element of all) {
    if (!element.id) continue;
    if (ids.has(element.id)) problems.push(`duplicate id ${element.id}`);
    ids.set(element.id, element);
  }
  const labelled = new Set(all.filter((element) => element.tagName === 'LABEL').map((label) => label.getAttribute('for')));
  for (const element of all) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
      const named = element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || labelled.has(element.id);
      if (!named) problems.push(`${element.tagName.toLowerCase()}#${element.id || '?'} has no label`);
    }
    if (element.tagName === 'BUTTON' && !(element.textContent.trim() || element.getAttribute('aria-label'))) {
      problems.push('button without an accessible name');
    }
    if (element.tagName === 'PRE' && element.getAttribute('tabindex') === '0' && !element.getAttribute('aria-label')) {
      problems.push('focusable pre without a label');
    }
    for (const attribute of ['aria-describedby', 'aria-labelledby', 'aria-controls']) {
      for (const reference of (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean)) {
        if (!ids.has(reference)) problems.push(`${attribute}="${reference}" does not resolve`);
      }
    }
    if (element.tagName === 'LABEL' && element.getAttribute('for') && !ids.has(element.getAttribute('for'))) {
      problems.push(`label for="${element.getAttribute('for')}" does not resolve`);
    }
  }
  return problems;
}

test('the review page has landmarks, a skip link, live regions, and a labelled tab pattern', () => {
  const document = createDocument(readFileSync(join(APP, 'index.html'), 'utf8'));
  assert.equal(document.documentElement.getAttribute('lang'), 'en');
  const skip = document.querySelector('a[href]');
  assert.equal(skip.getAttribute('href'), '#main');
  assert.equal(document.getElementById('main').tagName, 'MAIN');
  assert.ok(document.querySelector('header'));
  assert.ok(document.querySelector('nav[aria-label]'));
  assert.equal(document.getElementById('status').getAttribute('role'), 'status');
  assert.equal(document.getElementById('status').getAttribute('aria-live'), 'polite');
  assert.equal(document.getElementById('save-confirmation').getAttribute('role'), 'status');
  assert.equal(document.getElementById('save-confirmation').getAttribute('aria-live'), 'polite');
  assert.equal(document.getElementById('error').getAttribute('role'), 'alert');
  assert.match(document.getElementById('save').getAttribute('aria-keyshortcuts'), /Control\+S/);
  const tabs = document.querySelectorAll('button[role="tab"]');
  assert.equal(tabs.length, 4);
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
  }
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1, -1, -1]);
  assert.deepEqual(auditLabels(document), []);
});

test('every rendered control is labelled and every reference resolves across views', async (t) => {
  const { document } = await loadApp(t);
  assert.deepEqual(auditLabels(document), [], 'initial render');
  const items = document.getElementById('panel-use-cases').querySelectorAll('button[data-list-item]');
  assert.ok(items.length >= 3);
  for (const index of items.keys()) {
    document.getElementById('panel-use-cases').querySelectorAll('button[data-list-item]')[index].click();
    assert.deepEqual(auditLabels(document), [], `use case ${index}`);
  }
  assert.equal(document.getElementById('field-title').hasAttribute('readonly'), false, 'undecided proposals are editable');
  assert.equal(document.getElementById('decision-revise').disabled, true, 'revised approval needs a draft change');
  assert.equal(document.querySelector('label[for="field-owner"]'), null);
  assert.equal(document.querySelector('label[for="field-starts"]').textContent, 'Entry points (optional)');
  assert.match(
    document.getElementById('field-starts-help').textContent,
    /Leave blank when the implementation binding is not known yet/,
  );
  assert.deepEqual(auditLabels(document), [], 'revise form');
  const subjects = document.getElementById('panel-coverage').querySelectorAll('button[data-list-item]');
  assert.ok(subjects.length >= 5);
  for (const index of subjects.keys()) {
    document.getElementById('panel-coverage').querySelectorAll('button[data-list-item]')[index].click();
    assert.deepEqual(auditLabels(document), [], `subject ${index}`);
  }
  assert.match(document.getElementById('panel-summary').textContent, /unresolved decision/);
  assert.match(document.getElementById('panel-preview').textContent, /This app never runs it/);
});

test('tabs and lists follow the arrow, Home, and End keyboard pattern', async (t) => {
  const { document } = await loadApp(t);
  const tab = (name) => document.getElementById(`tab-${name}`);
  tab('summary').focus();
  assert.equal(key(tab('summary'), 'ArrowRight').defaultPrevented, true);
  assert.equal(document.activeElement, tab('use-cases'));
  assert.equal(tab('use-cases').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('panel-use-cases').hidden, false);
  assert.equal(document.getElementById('panel-summary').hidden, true);
  assert.equal(tab('summary').tabIndex, -1);
  key(document.activeElement, 'End');
  assert.equal(document.activeElement, tab('preview'));
  key(document.activeElement, 'ArrowRight');
  assert.equal(document.activeElement, tab('summary'));
  key(document.activeElement, 'ArrowLeft');
  assert.equal(document.activeElement, tab('preview'));
  key(document.activeElement, 'Home');
  assert.equal(document.activeElement, tab('summary'));
  assert.equal(key(document.activeElement, 'Enter').defaultPrevented, false);

  const items = () => document.getElementById('panel-use-cases').querySelectorAll('button[data-list-item]');
  const first = items()[0];
  first.focus();
  key(first, 'ArrowDown');
  assert.equal(document.activeElement, items()[1]);
  key(document.activeElement, 'End');
  assert.equal(document.activeElement, items().at(-1));
  key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, items().at(-1), 'arrow keys stop at the end of the list');
  key(document.activeElement, 'Home');
  assert.equal(document.activeElement, items()[0]);
});

test('undecided definition edits persist as drafts and require explicit revised approval', async (t) => {
  const { document, root } = await loadApp(t);
  document
    .getElementById('panel-use-cases')
    .querySelectorAll('button[data-list-item]')
    .find((button) => /Archive a record/.test(button.textContent))
    .click();

  const approve = document.getElementById('decision-approve');
  assert.equal(approve.disabled, true);
  assert.match(document.getElementById('decision-approve-help').textContent, /Unavailable until Goal, Success outcome/);
  const goalLink = document.querySelector('button[data-focus-key="missing:goal"]');
  goalLink.click();
  assert.equal(document.activeElement, document.getElementById('field-goal'));

  const goal = document.getElementById('field-goal');
  goal.value = 'Remove an old record from active work.';
  goal.dispatchEvent(makeEvent('input'));
  const success = document.getElementById('field-success');
  success.value = 'The record is archived.';
  success.dispatchEvent(makeEvent('input'));
  await until(() => /Draft revision · still Undecided/.test(document.getElementById('panel-use-cases').textContent), 'draft revision');
  assert.equal(document.getElementById('decision-pending').checked, true);
  assert.equal(document.getElementById('decision-revise').disabled, false);
  assert.match(document.getElementById('decision-revise-help').textContent, /Accept your draft changes to Goal, Success outcome/);

  document.getElementById('save').click();
  await until(() => /Saved revision 1/.test(document.getElementById('save-confirmation').textContent), 'draft save');
  let saved = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8'));
  assert.equal(saved.proposals['archive-record'].action, 'pending');
  assert.equal(saved.proposals['archive-record'].fields.goal, 'Remove an old record from active work.');

  const revise = document.getElementById('decision-revise');
  revise.checked = true;
  revise.dispatchEvent(makeEvent('change'));
  await until(() => document.getElementById('decision-revise')?.checked === true, 'explicit revised approval');
  assert.match(document.getElementById('panel-use-cases').textContent, /Approved revised proposal/);
  document.getElementById('save').click();
  await until(() => /Saved revision 2/.test(document.getElementById('save-confirmation').textContent), 'approved revision save');
  saved = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8'));
  assert.equal(saved.proposals['archive-record'].action, 'revise');
  assert.deepEqual(Object.keys(saved.proposals['archive-record'].fields), ['goal', 'success']);
});

test('draft reset and original approval require explicit discard without losing edits silently', async (t) => {
  const { document, window, confirmCalls } = await loadApp(t);
  const proposedGoal = document.getElementById('field-goal').value;
  const editGoal = async (value) => {
    const goal = document.getElementById('field-goal');
    goal.value = value;
    goal.dispatchEvent(makeEvent('input'));
    await until(() => /Draft revision · still Undecided/.test(document.getElementById('panel-use-cases').textContent), 'goal draft');
  };

  await editGoal('Review activity before starting work.');
  document.querySelector('button[data-focus-key="reset-draft"]').click();
  await until(() => document.querySelector('button[data-focus-key="reset-draft"]') === null, 'draft reset');
  assert.equal(document.getElementById('field-goal').value, proposedGoal);

  await editGoal('Review activity and identify priorities.');
  window.confirm = (message) => {
    confirmCalls.push(message);
    return false;
  };
  let approve = document.getElementById('decision-approve');
  approve.checked = true;
  approve.dispatchEvent(makeEvent('change'));
  assert.match(confirmCalls[0], /Discard your draft changes to Goal/);
  assert.ok(document.querySelector('button[data-focus-key="reset-draft"]'));
  assert.equal(document.getElementById('decision-pending').checked, true);

  window.confirm = (message) => {
    confirmCalls.push(message);
    return true;
  };
  approve = document.getElementById('decision-approve');
  approve.checked = true;
  approve.dispatchEvent(makeEvent('change'));
  await until(() => document.getElementById('field-goal')?.hasAttribute('readonly'), 'original approval after discard');
  assert.equal(document.getElementById('decision-approve').checked, true);
  assert.equal(document.querySelector('button[data-focus-key="reset-draft"]'), null);
  assert.equal(document.getElementById('field-goal').value, proposedGoal);
  assert.equal(confirmCalls.length, 2);
});

test('merge requires a searchable explicit target and previews what will move', async (t) => {
  const { document, root } = await loadApp(t);
  document
    .getElementById('panel-use-cases')
    .querySelectorAll('button[data-list-item]')
    .find((button) => /Archive a record/.test(button.textContent))
    .click();
  const merge = document.getElementById('decision-merge');
  assert.equal(merge.disabled, false);
  merge.checked = true;
  merge.dispatchEvent(makeEvent('change'));
  assert.equal(document.activeElement, document.getElementById('merge-target-search'));
  assert.equal(document.getElementById('save').disabled, true, 'opening the picker is not a completed decision');
  assert.match(document.getElementById('panel-use-cases').textContent, /Merge this proposal into …/);

  const pendingTarget = document.querySelector('button[data-focus-key="merge-target:export-records"]');
  assert.equal(pendingTarget.disabled, true);
  assert.match(pendingTarget.textContent, /Must first be accepted/);
  const existingTarget = document.querySelector('button[data-focus-key="merge-target:create-record"]');
  assert.equal(existingTarget.disabled, false);
  assert.match(existingTarget.textContent, /surface\(s\).*workflow\(s\).*entry point\(s\)/);

  const search = document.getElementById('merge-target-search');
  search.value = 'create';
  search.dispatchEvent(makeEvent('input'));
  assert.equal(document.activeElement, document.getElementById('merge-target-search'), 'search keeps keyboard focus');
  assert.equal(document.querySelector('button[data-focus-key="merge-target:export-records"]'), null);
  document.querySelector('button[data-focus-key="merge-target:create-record"]').click();
  await until(() => /Merge preview: archive-record → create-record/.test(document.getElementById('panel-use-cases').textContent), 'merge preview');
  assert.match(document.getElementById('panel-use-cases').textContent, /workflow mapping\(s\) will resolve to the target/);
  assert.match(document.getElementById('panel-use-cases').textContent, /source title, persona, goal, success outcome/i);
  assert.equal(document.getElementById('save').disabled, false);
  assert.deepEqual(auditLabels(document), []);

  document.getElementById('save').click();
  await until(() => /Saved revision 1/.test(document.getElementById('save-confirmation').textContent), 'merge save');
  const saved = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8'));
  assert.deepEqual(saved.proposals['archive-record'], { action: 'merge', into: 'create-record' });
});

test('decisions keep focus through re-rendering and Ctrl+S saves with an unapproved announcement', async (t) => {
  const { document, root } = await loadApp(t);
  const save = document.getElementById('save');
  assert.equal(save.disabled, true);
  const approve = document.getElementById('decision-approve');
  approve.focus();
  approve.checked = true;
  approve.dispatchEvent(makeEvent('change'));
  assert.equal(save.disabled, false);
  assert.match(document.getElementById('save-state').textContent, /Unsaved changes/);
  await until(() => /Approved as proposed\./.test(document.getElementById('status').textContent), 'decision announcement');
  await until(() => document.getElementById('decision-approve')?.checked === true, 'server evaluation');
  assert.equal(document.activeElement.id, 'decision-approve', 'focus survives the re-render');

  const shortcut = key(document.getElementById('decision-approve'), 's', { ctrlKey: true });
  assert.equal(shortcut.defaultPrevented, true);
  await until(() => /Saved revision 1/.test(document.getElementById('status').textContent), 'save announcement');
  assert.match(document.getElementById('status').textContent, /Status: unapproved\. Nothing was approved, adopted, checked in, or enforced\./);
  assert.match(document.getElementById('save-state').textContent, /Saved revision 1 · unapproved/);
  const confirmation = document.getElementById('save-confirmation');
  assert.equal(confirmation.hidden, false);
  assert.match(confirmation.textContent, /Saved revision 1 at \d{4}-\d{2}-\d{2}T/);
  assert.match(confirmation.textContent, new RegExp(DEFAULT_REVIEW_PATHS.review.replaceAll('/', '\\/')));
  assert.equal(document.activeElement, confirmation);
  assert.equal(save.textContent, 'Saved ✓');
  assert.equal(save.disabled, true);
  const saved = JSON.parse(readFileSync(join(root, DEFAULT_REVIEW_PATHS.review), 'utf8'));
  assert.equal(saved.approval.status, 'unapproved');
  assert.equal(Object.values(saved.proposals)[0].action, 'approve');
});

test('dirty reviews warn on browser unload and require confirmation before close', async (t) => {
  const { document, window, server, confirmCalls } = await loadApp(t);
  const approve = document.getElementById('decision-approve');
  approve.checked = true;
  approve.dispatchEvent(makeEvent('change'));
  assert.match(document.getElementById('save-state').textContent, /Unsaved changes/);
  assert.equal(document.getElementById('save-state').classList.contains('unsaved'), true);

  const unload = makeEvent('beforeunload');
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  assert.equal(unload.returnValue, '');

  window.confirm = (message) => {
    confirmCalls.push(message);
    return false;
  };
  document.getElementById('close').click();
  await until(() => /Close cancelled/.test(document.getElementById('status').textContent), 'close cancellation');
  assert.match(confirmCalls[0], /discard those unsaved changes/);
  assert.equal(document.activeElement, document.getElementById('save'));
  assert.equal((await nodeFetch(`${server.origin}/`)).status, 200);

  window.confirm = (message) => {
    confirmCalls.push(message);
    return true;
  };
  document.getElementById('close').click();
  await until(() => /review is closed/i.test(document.body.textContent), 'confirmed close');
  assert.equal(confirmCalls.length, 2);
  assert.equal(document.activeElement.id, 'main');
});

test('an exclusion without a rationale is flagged in place and stays unresolved', async (t) => {
  const { document } = await loadApp(t);
  const subjects = () => document.getElementById('panel-coverage').querySelectorAll('button[data-list-item]');
  subjects().find((button) => /Dashboard/.test(button.textContent)).click();
  const exclude = document.getElementById('disposition-excluded');
  exclude.checked = true;
  exclude.dispatchEvent(makeEvent('change'));
  await until(() => document.getElementById('mapping-rationale-error') !== null, 'rationale error');
  const rationale = document.getElementById('mapping-rationale');
  assert.equal(rationale.getAttribute('aria-invalid'), 'true');
  assert.equal(rationale.getAttribute('aria-describedby'), 'mapping-rationale-error');
  assert.match(document.querySelector('label[for="mapping-rationale"]').textContent, /required/);
  await until(() => /Unresolved/.test(subjects().find((button) => /Dashboard/.test(button.textContent)).textContent), 'unresolved status');
  assert.deepEqual(auditLabels(document), []);
});

test('the stylesheet provides visible focus, reduced motion, and dark mode without external assets', () => {
  const css = readFileSync(join(APP, 'app.css'), 'utf8');
  assert.match(css, /:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\.skip-link:focus/);
  assert.doesNotMatch(css, /url\(|@import|https?:/);
  const js = readFileSync(join(APP, 'app.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|eval\(|new Function|https?:\/\//);
});
