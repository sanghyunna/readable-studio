import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { BrowserContext, Page } from '@playwright/test';
import { describe, expect, test } from 'vitest';
import { seedBrowserConfig } from '../lib/playwright/amr.ts';
import { applyStorageConfig, STORAGE_KEY } from '../lib/playwright/mock-factory.ts';
import { configureVisualPage } from '../lib/playwright/visual.ts';
import { addStorageInitScript, evaluateStorageSeed, storageSeedScript } from '../lib/playwright/storage-init.ts';

const APP_ORIGIN = 'http://127.0.0.1:17573';
const NOW = 1_700_000_000_000;
const standardConfig = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
  agentId: 'mock', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: {}, privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};
const customConfig = {
  ...standardConfig, agentId: 'amr', onboardingCompleted: false,
  agentModels: { amr: { model: 'default', reasoning: 'default' } },
  agentCliEnv: { amr: { VELA_BIN: 'D:/fake/vela.exe' } },
};

function harness() {
  const scripts: string[] = [];
  const events = new EventEmitter();
  const page = Object.assign(events, {
    async addInitScript(script: ((arg: unknown) => void) | { content: string }, arg?: unknown) {
      scripts.push(typeof script === 'function'
        ? `(${script.toString()})(${JSON.stringify(arg)});`
        : script.content);
    },
    async route() {},
  }) as unknown as Page;
  return { page, events, scripts };
}

function documentContext(options: {
  url?: string;
  origin?: string;
  frame?: boolean;
  accessError?: Error;
  writeError?: Error;
} = {}) {
  const values = new Map<string, string>();
  let accesses = 0;
  const location = new URL(options.url ?? `${APP_ORIGIN}/projects/test`);
  const window = {
    location,
    origin: options.origin ?? location.origin,
    top: null as unknown,
    get localStorage() {
      accesses++;
      if (options.accessError) throw options.accessError;
      return {
        setItem(key: string, value: string) {
          if (options.writeError) throw options.writeError;
          values.set(key, value);
        },
        getItem(key: string) { return values.get(key) ?? null; },
        removeItem(key: string) { values.delete(key); },
        clear() { values.clear(); },
      };
    },
  };
  window.top = options.frame ? {} : window;
  return {
    values,
    accesses: () => accesses,
    context: {
      window,
      Date: { now: () => NOW },
      // The visual helper also installs a separate style-only init script.
      document: { createElement: () => ({}), head: { appendChild() {} } },
    },
  };
}

const helpers = [
  { name: 'standard config', install: applyStorageConfig, config: standardConfig },
  { name: 'custom AMR config', install: (page: Page) => seedBrowserConfig(page, customConfig), config: customConfig },
  { name: 'visual config', install: (page: Page) => configureVisualPage(page, { config: { onboardingCompleted: false } }), config: { ...standardConfig, onboardingCompleted: false } },
];

for (const helper of helpers) {
  describe(helper.name, () => {
    test('preserves the complete seeded payload on each app navigation', async () => {
      const { page, scripts } = harness();
      await helper.install(page);
      for (const url of [`${APP_ORIGIN}/`, `${APP_ORIGIN}/projects/test`, 'https://localhost:17573/']) {
        const doc = documentContext({ url });
        for (const script of scripts) runInNewContext(script, doc.context);
        expect(JSON.parse(doc.values.get(STORAGE_KEY)!)).toEqual(helper.config);
        if (helper.name === 'visual config') {
          expect(JSON.parse(doc.values.get('readable-studio:gh-stars')!)).toEqual({ count: 40_000, ts: NOW });
        } else {
          expect(doc.values.size).toBe(1);
        }
      }
    });

    test.each(['about:blank', 'about:srcdoc', 'data:text/html,blank', 'file:///D:/blank.html'])(
      'does not touch storage on %s', async (url) => {
        const { page, scripts } = harness();
        await helper.install(page);
        const doc = documentContext({ url, accessError: new DOMException('Access is denied for this document', 'SecurityError') });
        for (const script of scripts) runInNewContext(script, doc.context);
        expect(doc.accesses()).toBe(0);
      },
    );

    test.each([
      { url: `${APP_ORIGIN}/preview`, origin: 'null' },
      { url: 'about:srcdoc', origin: 'null' },
      { url: `${APP_ORIGIN}/preview`, origin: APP_ORIGIN },
      { url: 'https://preview.example/test', origin: 'https://preview.example' },
    ])('does not reseed an embedded document: $url ($origin)', async (location) => {
      const { page, scripts } = harness();
      await helper.install(page);
      const doc = documentContext({ ...location, frame: true, accessError: new DOMException('document is sandboxed and lacks allow-same-origin', 'SecurityError') });
      for (const script of scripts) runInNewContext(script, doc.context);
      expect(doc.accesses()).toBe(0);
    });

    test.each([
      { accessError: new DOMException('Access is denied for this document', 'SecurityError') },
      { writeError: new DOMException('Storage quota exceeded', 'QuotaExceededError') },
      { writeError: new Error('Unexpected storage failure') },
      { origin: 'null' },
    ])('fails the runner when the app cannot be seeded: %o', async (failure) => {
      const { page, events, scripts } = harness();
      await helper.install(page);
      const doc = documentContext(failure);
      let pageError: Error | undefined;
      try {
        for (const script of scripts) runInNewContext(script, doc.context);
      } catch (error) {
        pageError = error as Error;
      }
      expect(pageError).toBeDefined();
      // Reproduce Playwright's browser-to-Node pageerror boundary: an uncaught
      // runner exception must result, not merely a browser console message.
      expect(() => events.emit('pageerror', pageError)).toThrow(pageError);
      expect(doc.values.size).toBe(0);
    });
  });
}

test('installs one failure listener per page and releases it at close', async () => {
  const { page, events } = harness();
  await applyStorageConfig(page);
  await seedBrowserConfig(page, customConfig);
  expect(events.listenerCount('pageerror')).toBe(1);
  expect(events.listenerCount('close')).toBe(1);
  events.emit('close');
  expect(events.listenerCount('pageerror')).toBe(0);
  expect(events.listenerCount('close')).toBe(0);
});

test('does not consume or filter unrelated page errors', async () => {
  const { page, events } = harness();
  await applyStorageConfig(page);
  const observed: Error[] = [];
  events.on('pageerror', (error: Error) => observed.push(error));
  const error = new Error('Product error');
  expect(() => events.emit('pageerror', error)).not.toThrow();
  expect(observed).toEqual([error]);
});

test('keeps conditional seeding and navigation-time values in the original callback', async () => {
  const { page, scripts } = harness();
  await addStorageInitScript(page, (key) => {
    if (window.localStorage.getItem(key)) return;
    window.localStorage.setItem(key, JSON.stringify({ ts: Date.now() }));
  }, STORAGE_KEY);
  const doc = documentContext();
  runInNewContext(scripts[0]!, doc.context);
  expect(JSON.parse(doc.values.get(STORAGE_KEY)!)).toEqual({ ts: NOW });
  doc.values.set(STORAGE_KEY, JSON.stringify(customConfig));
  runInNewContext(scripts[0]!, doc.context);
  expect(JSON.parse(doc.values.get(STORAGE_KEY)!)).toEqual(customConfig);
});

test('context seed failures fail the runner, including pages created after installation', async () => {
  const { page, events, scripts } = harness();
  const context = Object.assign(page, { pages: () => [] }) as unknown as BrowserContext;
  const seed = (key: string) => window.localStorage.setItem(key, 'context-value');
  await addStorageInitScript(context, seed, STORAGE_KEY);
  await addStorageInitScript(context, seed, STORAGE_KEY);
  expect(events.listenerCount('weberror')).toBe(1);
  expect(events.listenerCount('pageerror')).toBe(0);
  const app = documentContext();
  runInNewContext(scripts[0]!, app.context);
  expect(app.values.get(STORAGE_KEY)).toBe('context-value');
  for (const failure of [
    { accessError: new DOMException('denied', 'SecurityError') },
    { writeError: new DOMException('full', 'QuotaExceededError') },
    { origin: 'null' },
  ]) {
    const doc = documentContext(failure);
    let error: unknown;
    try { runInNewContext(scripts[0]!, doc.context); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(() => events.emit('weberror', { error: () => error })).toThrow('[e2e-storage-seed]');
  }
  expect(() => events.emit('weberror', { error: () => new Error('unrelated') })).not.toThrow();
  events.emit('close');
  expect(events.listenerCount('weberror')).toBe(0);
});

test('one-shot storage mutations return their result without installing a reload seeder', async () => {
  const { page, scripts } = harness();
  const doc = documentContext();
  doc.values.set('collapsed', 'true');
  Object.assign(page, { evaluate: async (script: string) => runInNewContext(script, doc.context) });
  const stale = await evaluateStorageSeed(page, (key) => {
    const had = window.localStorage.getItem(key) === 'true';
    window.localStorage.removeItem(key);
    return had;
  }, 'collapsed');
  expect(stale).toBe(true);
  expect(doc.values.has('collapsed')).toBe(false);
  expect(scripts).toEqual([]);
});

test.each([
  { accessError: new DOMException('denied', 'SecurityError') },
  { writeError: new DOMException('full', 'QuotaExceededError') },
  { origin: 'null' },
])('immediate app seeding rejects through evaluate: %o', async (failure) => {
  const { page } = harness();
  const doc = documentContext(failure);
  Object.assign(page, { evaluate: async (script: string) => runInNewContext(script, doc.context) });
  await expect(evaluateStorageSeed(page, (key) => window.localStorage.setItem(key, 'value'), STORAGE_KEY))
    .rejects.toThrow('[e2e-storage-seed]');
});

test.each([
  { url: 'about:blank' },
  { url: 'about:srcdoc', frame: true, origin: 'null' },
  { url: `${APP_ORIGIN}/preview`, frame: true, origin: 'null' },
])('the shared desktop/evaluate expression does not access ineligible documents: %o', (location) => {
  const doc = documentContext({ ...location, accessError: new DOMException('denied', 'SecurityError') });
  const script = storageSeedScript((key) => window.localStorage.setItem(key, 'value'), STORAGE_KEY);
  expect(runInNewContext(script, doc.context)).toBeUndefined();
  expect(doc.accesses()).toBe(0);
});

test('the shared expression preserves clear, locale, multi-key payloads and callback return values', () => {
  const doc = documentContext();
  doc.values.set('stale', 'old');
  const script = storageSeedScript(({ key, config }) => {
    window.localStorage.clear();
    window.localStorage.setItem(key, JSON.stringify(config));
    window.localStorage.setItem('readable-studio:locale', 'ko');
    window.localStorage.setItem('readable-studio:locale-source', 'manual');
    return true;
  }, { key: STORAGE_KEY, config: customConfig });
  expect(runInNewContext(script, doc.context)).toBe(true);
  expect(Object.fromEntries(doc.values)).toEqual({
    [STORAGE_KEY]: JSON.stringify(customConfig),
    'readable-studio:locale': 'ko',
    'readable-studio:locale-source': 'manual',
  });
});
