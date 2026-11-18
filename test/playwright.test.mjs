import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJourneyRecorder } from '../lib/journeys.mjs';
import {
  PLAYWRIGHT_JOURNEY_METRICS,
  attachPlaywrightMeasurements,
  capturePlaywrightCheckpoint,
} from '../lib/playwright.mjs';
import { canonicalHash } from '../lib/visuals.mjs';

class FakePage {
  constructor() {
    this.currentUrl = 'about:blank';
    this.frame = { url: () => this.currentUrl };
    this.listeners = new Map();
  }

  url() {
    return this.currentUrl;
  }

  async exposeBinding(name, callback) {
    this.bindingName = name;
    this.binding = callback;
  }

  async addInitScript(callback, argument) {
    this.initScript = { callback, argument };
  }

  async evaluate(callback, argument) {
    this.evaluations ??= [];
    this.evaluations.push({ callback, argument });
    if (this.failNextEvaluation) {
      this.failNextEvaluation = false;
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
  }

  async waitForLoadState(state) {
    this.waitedFor = state;
  }

  mainFrame() {
    return this.frame;
  }

  on(event, callback) {
    this.listeners.set(event, callback);
  }

  off(event, callback) {
    if (this.listeners.get(event) === callback) this.listeners.delete(event);
  }

  async emitMeasurement(metric, amount = 1) {
    await this.binding({}, { metric, amount });
  }

  navigate(url) {
    this.currentUrl = url;
    this.listeners.get('framenavigated')?.(this.frame);
  }
}

test('optional Playwright adapter flushes independent browser counts into a step', async () => {
  const page = new FakePage();
  const adapter = await attachPlaywrightMeasurements(page);
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
    metrics: PLAYWRIGHT_JOURNEY_METRICS,
  });

  recorder.beginStep('open-form');
  await page.emitMeasurement('clicks', 2);
  await page.emitMeasurement('keystrokes', 8);
  await page.emitMeasurement('editedFields', 1);
  page.navigate('/records');
  page.navigate('/records');
  await adapter.flush(recorder);
  recorder.endStep();

  recorder.beginStep('idle');
  await adapter.flush(recorder);
  recorder.endStep();

  const journey = recorder.finish();
  assert.deepEqual(journey.metrics, {
    clicks: 2,
    keystrokes: 8,
    editedFields: 1,
    routeChanges: 1,
    steps: 2,
  });
  assert.deepEqual(journey.steps[1].metrics, {
    clicks: 0,
    keystrokes: 0,
    editedFields: 0,
    routeChanges: 0,
    steps: 1,
  });
});

test('adapter ignores child frames, stops route capture on dispose, and rejects bad events', async () => {
  const page = new FakePage();
  const adapter = await attachPlaywrightMeasurements(page, { bindingName: '__testUxMeasure' });
  const childFrame = { url: () => '/embedded' };
  page.listeners.get('framenavigated')(childFrame);
  assert.throws(
    () => page.binding({}, { metric: 'scrollDistance', amount: 10 }),
    /invalid journey measurement/,
  );

  adapter.dispose();
  page.navigate('/after-dispose');
  assert.equal(page.listeners.has('framenavigated'), false);
  await assert.rejects(() => adapter.flush({ record() {} }), /adapter is disposed/);
});

test('adapter retries a flush that races with main-frame navigation', async () => {
  const page = new FakePage();
  const adapter = await attachPlaywrightMeasurements(page);
  const recorder = createJourneyRecorder({
    useCaseId: 'create-record',
    journeyId: 'standard',
    metrics: PLAYWRIGHT_JOURNEY_METRICS,
  });
  recorder.beginStep('navigate');
  page.failNextEvaluation = true;
  await adapter.flush(recorder);
  recorder.endStep();

  assert.equal(page.waitedFor, 'domcontentloaded');
  assert.equal(page.evaluations.length, 3);
});

test('adapter requires a Page-compatible object and a safe binding name', async () => {
  await assert.rejects(() => attachPlaywrightMeasurements({}), /Page-compatible/);
  await assert.rejects(
    () => attachPlaywrightMeasurements(new FakePage(), { bindingName: 'not-valid!' }),
    /JavaScript identifier/,
  );
});

class FakeVisualPage {
  constructor({
    viewport = { width: 1280, height: 720 },
    browserVersion = '123.0.0.0',
    maskCount = 1,
  } = {}) {
    this.viewport = viewport;
    this.browserVersion = browserVersion;
    this.maskCount = maskCount;
  }

  viewportSize() {
    return this.viewport;
  }

  context() {
    return {
      browser: () => ({ version: () => this.browserVersion }),
    };
  }

  async emulateMedia(options) {
    this.media = options;
  }

  async addStyleTag(options) {
    this.style = options;
  }

  async evaluate(_callback, argument) {
    this.runtimeExpectation = argument;
  }

  locator(selector) {
    return {
      selector,
      count: async () => this.maskCount,
    };
  }

  async screenshot(options) {
    this.screenshotOptions = options;
    return png(1280, 720);
  }
}

test('visual capture derives generic font readiness from the reviewed profile', async () => {
  const page = new FakeVisualPage();
  const { profile, checkpoint } = visualContracts();
  let readyContext;
  const captured = await capturePlaywrightCheckpoint(page, {
    profile,
    checkpoint,
    styleContent: 'html { color-scheme: light; }',
    waitUntilReady: async (readyPage, context) => {
      assert.equal(readyPage, page);
      readyContext = context;
    },
  });

  assert.deepEqual(page.media, {
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  assert.deepEqual(page.runtimeExpectation.fontQueries, [
    'normal 400 16px "Example \\"Display\\""',
    'italic 700 16px "Example Sans"',
    'normal 400 16px "Example Mono"',
  ]);
  assert.match(page.style.content, /^html \{ color-scheme: light; \}/);
  assert.match(page.style.content, /animation: none/);
  assert.doesNotMatch(page.style.content, /font-family/);
  assert.deepEqual(readyContext, { profile, checkpoint });
  assert.equal(captured.image.width, 1280);
  assert.equal(captured.image.height, 720);
  assert.equal(captured.bytes.length, 24);
});

test('visual capture rejects an unreviewed viewport', async () => {
  const page = new FakeVisualPage({ viewport: { width: 1024, height: 768 } });
  const { profile, checkpoint } = visualContracts();
  await assert.rejects(
    () => capturePlaywrightCheckpoint(page, { profile, checkpoint }),
    /viewport does not match/,
  );
});

test('visual capture rejects an unreviewed browser version', async () => {
  const page = new FakeVisualPage({ browserVersion: '124.0.0.0' });
  const { profile, checkpoint } = visualContracts();
  await assert.rejects(
    () => capturePlaywrightCheckpoint(page, { profile, checkpoint }),
    /browser version does not match/,
  );
});

test('visual capture requires every reviewed mask to match', async () => {
  const page = new FakeVisualPage({ maskCount: 0 });
  const { profile, checkpoint } = visualContracts();
  await assert.rejects(
    () => capturePlaywrightCheckpoint(page, { profile, checkpoint }),
    /reviewed visual mask stable-region matched nothing/,
  );
});

function visualContracts() {
  const profile = {
    id: 'chromium.desktop.light.example.v1',
    version: 1,
    browser: {
      engine: 'chromium',
      version: '123.0.0.0',
      revision: '1234',
      channel: 'chrome-for-testing',
    },
    runtime: {
      os: 'linux',
      distribution: 'example',
      release: '1',
      architecture: 'x86_64',
      container: {
        image: 'registry.example.invalid/browser/runtime:1',
        digest: `sha256:${'1'.repeat(64)}`,
        indexDigest: `sha256:${'2'.repeat(64)}`,
      },
    },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    fonts: [
      {
        family: 'Example "Display"',
        style: 'normal',
        weight: 400,
        path: '/fonts/example-display.ttf',
        sha256: `sha256:${'3'.repeat(64)}`,
      },
      {
        family: 'Example Sans',
        style: 'italic',
        weight: 700,
        path: '/fonts/example-sans-italic.ttf',
        sha256: `sha256:${'4'.repeat(64)}`,
      },
      {
        family: 'Example Mono',
        style: 'normal',
        weight: 400,
        path: '/fonts/example-mono.ttf',
        sha256: `sha256:${'5'.repeat(64)}`,
      },
    ],
    locale: 'en-US',
    timezone: 'UTC',
    colorScheme: 'light',
    clock: '2026-01-01T00:00:00.000Z',
    reducedMotion: 'reduce',
    rendering: {
      animations: 'disabled',
      transitions: 'disabled',
      carets: 'hidden',
    },
    network: { mode: 'mocked-only' },
    screenshot: {
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      omitBackground: false,
      maskColor: '#ff00ff',
    },
    adapters: {
      uxGuard: '0.6.0',
      visual: '1',
      playwright: '1',
      schema: '1',
    },
    canonicalHash: '',
  };
  profile.canonicalHash = canonicalHash(profile);
  const checkpoint = {
    useCaseId: 'create-record',
    journeyId: 'standard',
    checkpointId: 'complete',
    tier: 'primary',
    purpose: 'success',
    profiles: [profile.id],
    masks: [{ id: 'stable-region', selector: '[data-stable]' }],
    tolerance: { mode: 'exact' },
  };
  return { profile, checkpoint };
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
