import { createHash } from 'node:crypto';
import { JourneyReportError } from './journeys.mjs';
import {
  pngDimensions,
  validateVisualProfile,
  visualImageId,
  VisualContractError,
} from './visuals.mjs';

export const PLAYWRIGHT_JOURNEY_METRICS = Object.freeze([
  'clicks',
  'keystrokes',
  'editedFields',
  'routeChanges',
]);

const BROWSER_METRICS = new Set(PLAYWRIGHT_JOURNEY_METRICS.filter((metric) => metric !== 'routeChanges'));

// This adapter intentionally uses only Playwright's structural Page API. The
// consumer supplies its Page; ux-guard has no Playwright runtime dependency.
export async function attachPlaywrightMeasurements(
  page,
  { bindingName = '__uxGuardJourneyMeasurementV1' } = {},
) {
  validatePage(page);
  if (typeof bindingName !== 'string' || !/^[_A-Za-z][_A-Za-z0-9]*$/.test(bindingName)) {
    throw new JourneyReportError('Playwright measurement bindingName must be a JavaScript identifier');
  }

  const totals = Object.fromEntries(PLAYWRIGHT_JOURNEY_METRICS.map((metric) => [metric, 0]));
  const flushed = structuredClone(totals);
  let disposed = false;
  let currentUrl = page.url();

  await page.exposeBinding(bindingName, (_source, event) => {
    if (disposed) return;
    validateBrowserEvent(event);
    totals[event.metric] += event.amount;
  });
  await page.addInitScript(installBrowserMeasurements, bindingName);
  await page.evaluate(installBrowserMeasurements, bindingName);

  const onFrameNavigated = (frame) => {
    if (disposed || frame !== page.mainFrame()) return;
    const nextUrl = frame.url();
    if (nextUrl === currentUrl) return;
    currentUrl = nextUrl;
    totals.routeChanges += 1;
  };
  page.on('framenavigated', onFrameNavigated);

  return Object.freeze({
    metrics: PLAYWRIGHT_JOURNEY_METRICS,

    async flush(recorder) {
      if (disposed) throw new JourneyReportError('Playwright measurement adapter is disposed');
      if (!recorder || typeof recorder.record !== 'function') {
        throw new JourneyReportError('flush needs an active journey recorder step');
      }
      try {
        await page.evaluate(flushBrowserMeasurements, bindingName);
      } catch (error) {
        if (!isNavigationEvaluationError(error)) throw error;
        if (typeof page.waitForLoadState === 'function') {
          await page.waitForLoadState('domcontentloaded');
        }
        await page.evaluate(flushBrowserMeasurements, bindingName);
      }
      for (const metric of PLAYWRIGHT_JOURNEY_METRICS) {
        const delta = totals[metric] - flushed[metric];
        recorder.record(metric, delta);
        flushed[metric] = totals[metric];
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      page.off('framenavigated', onFrameNavigated);
    },
  });
}

export async function capturePlaywrightCheckpoint(
  page,
  {
    profile,
    checkpoint,
    styleContent = '',
    waitUntilReady = null,
  } = {},
) {
  validateVisualPage(page);
  validateVisualProfile(profile);
  if (!checkpoint || !checkpoint.profiles?.includes(profile.id)) {
    throw new VisualContractError('visual checkpoint is not approved for this profile');
  }
  if (typeof styleContent !== 'string') {
    throw new VisualContractError('visual consumer styleContent must be text');
  }
  if (waitUntilReady !== null && typeof waitUntilReady !== 'function') {
    throw new VisualContractError('visual consumer waitUntilReady must be a function');
  }
  const viewport = page.viewportSize();
  if (
    !viewport ||
    viewport.width !== profile.viewport.width ||
    viewport.height !== profile.viewport.height
  ) {
    throw new VisualContractError('Playwright viewport does not match visual profile');
  }
  const browser = page.context().browser();
  if (!browser || browser.version() !== profile.browser.version) {
    throw new VisualContractError('Playwright browser version does not match visual profile');
  }
  await page.emulateMedia({
    colorScheme: profile.colorScheme,
    reducedMotion: profile.reducedMotion,
  });
  await page.addStyleTag({
    content: [
      styleContent,
      '*, *::before, *::after {',
      '  animation: none !important;',
      '  animation-duration: 0s !important;',
      '  transition: none !important;',
      '  transition-duration: 0s !important;',
      '  caret-color: transparent !important;',
      '}',
    ].filter(Boolean).join('\n'),
  });
  const fontQueries = [
    ...new Set(profile.fonts.map((font) => cssFontQuery(font))),
  ];
  await page.evaluate(async ({ expected, fontQueries: expectedFonts }) => {
    await document.fonts.ready;
    const facts = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      clock: new Date(Date.now()).toISOString(),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      externalResources: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter(
          (url) =>
            !url.startsWith(location.origin) &&
            !url.startsWith('data:') &&
            !url.startsWith('blob:'),
        ),
      fonts: expectedFonts.map((query) => ({
        query,
        available: document.fonts.check(query),
      })),
    };
    if (
      facts.width !== expected.viewport.width ||
      facts.height !== expected.viewport.height ||
      facts.dpr !== expected.viewport.deviceScaleFactor ||
      facts.locale !== expected.locale ||
      facts.timezone !== expected.timezone ||
      facts.clock !== expected.clock ||
      !facts.reducedMotion ||
      facts.dark !== (expected.colorScheme === 'dark') ||
      facts.externalResources.length !== 0 ||
      facts.fonts.some(({ available }) => !available)
    ) {
      throw new Error(`visual profile mismatch: ${JSON.stringify(facts)}`);
    }
  }, { expected: profile, fontQueries });
  if (waitUntilReady) {
    await waitUntilReady(page, { profile, checkpoint });
  }
  const masks = [];
  for (const mask of checkpoint.masks) {
    const locator = page.locator(mask.selector);
    if ((await locator.count()) === 0) {
      throw new VisualContractError(`reviewed visual mask ${mask.id} matched nothing`);
    }
    masks.push(locator);
  }
  const bytes = await page.screenshot({
    fullPage: profile.screenshot.fullPage,
    animations: profile.screenshot.animations,
    caret: profile.screenshot.caret,
    scale: profile.screenshot.scale,
    omitBackground: profile.screenshot.omitBackground,
    mask: masks,
    maskColor: profile.screenshot.maskColor,
  });
  const dimensions = pngDimensions(bytes, 'Playwright screenshot');
  const image = {
    id: visualImageId({
      ...checkpoint,
      scheme: profile.colorScheme,
      profileId: profile.id,
    }),
    useCaseId: checkpoint.useCaseId,
    journeyId: checkpoint.journeyId,
    checkpointId: checkpoint.checkpointId,
    scheme: profile.colorScheme,
    profileId: profile.id,
    profileHash: profile.canonicalHash,
    tier: checkpoint.tier,
    purpose: checkpoint.purpose,
    path: '',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: dimensions.width,
    height: dimensions.height,
    masks: checkpoint.masks.map(({ id }) => id),
    tolerance: structuredClone(checkpoint.tolerance),
  };
  return { image, bytes };
}

function isNavigationEvaluationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context|navigation/i.test(message);
}

function installBrowserMeasurements(bindingName) {
  const stateKey = '__uxGuardJourneyMeasurementStateV1';
  const existing = globalThis[stateKey];
  if (existing?.bindingName === bindingName) return;
  if (existing) throw new Error('ux-guard journey measurement is already installed');

  const pending = [];
  const completedFields = new WeakSet();
  const modifiers = new Set([
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Fn',
    'FnLock',
    'Meta',
    'NumLock',
    'ScrollLock',
    'Shift',
    'Symbol',
    'SymbolLock',
  ]);
  const send = (metric) => {
    const binding = globalThis[bindingName];
    if (typeof binding !== 'function') return;
    pending.push(Promise.resolve(binding({ metric, amount: 1 })));
  };

  globalThis.addEventListener(
    'click',
    (event) => {
      // Keyboard activation also emits click, but with detail=0. Count only
      // primary pointer clicks so clicks and keystrokes remain independent.
      if (event.isTrusted && event.detail > 0) send('clicks');
    },
    true,
  );
  globalThis.addEventListener(
    'keydown',
    (event) => {
      if (event.isTrusted && !modifiers.has(event.key)) send('keystrokes');
    },
    true,
  );
  globalThis.addEventListener(
    'input',
    (event) => {
      if (!event.isTrusted || !event.target || completedFields.has(event.target)) return;
      const tag = event.target.tagName?.toLowerCase();
      const field =
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        event.target.isContentEditable === true;
      if (!field) return;
      completedFields.add(event.target);
      send('editedFields');
    },
    true,
  );

  globalThis[stateKey] = {
    bindingName,
    async flush() {
      await Promise.all(pending.splice(0));
    },
  };
}

async function flushBrowserMeasurements(bindingName) {
  const state = globalThis.__uxGuardJourneyMeasurementStateV1;
  if (state?.bindingName === bindingName) await state.flush();
}

function validateBrowserEvent(event) {
  if (
    event === null ||
    typeof event !== 'object' ||
    !BROWSER_METRICS.has(event.metric) ||
    !Number.isSafeInteger(event.amount) ||
    event.amount < 0
  ) {
    throw new JourneyReportError('Playwright emitted an invalid journey measurement');
  }
}

function validatePage(page) {
  const methods = [
    'url',
    'exposeBinding',
    'addInitScript',
    'evaluate',
    'mainFrame',
    'on',
    'off',
  ];
  if (!page || methods.some((method) => typeof page[method] !== 'function')) {
    throw new JourneyReportError('Playwright adapter needs a Page-compatible object');
  }
}

function validateVisualPage(page) {
  const methods = [
    'viewportSize',
    'context',
    'emulateMedia',
    'addStyleTag',
    'evaluate',
    'locator',
    'screenshot',
  ];
  if (!page || methods.some((method) => typeof page[method] !== 'function')) {
    throw new VisualContractError('visual adapter needs a Page-compatible object');
  }
}

function cssFontQuery({ family, style, weight }) {
  const escapedFamily = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${style} ${weight} 16px "${escapedFamily}"`;
}
