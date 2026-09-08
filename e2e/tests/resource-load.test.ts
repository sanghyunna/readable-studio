import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from '@playwright/test';
import { expect, test } from 'vitest';
import { observeResourceLoads } from '../lib/playwright/resource-load.ts';

function harness() {
  const events = new EventEmitter();
  const page = Object.assign(events, { url: () => 'http://localhost/integrations' });
  // Only the Page event boundary is faked; the real observer handles each event.
  const resources = observeResourceLoads(page as unknown as Page);
  return { events, resources };
}

function request(resourceType: string, url: string, errorText = 'net::ERR_CONNECTION_RESET') {
  return {
    resourceType: () => resourceType,
    url: () => url,
    failure: () => ({ errorText }),
  } as Request;
}

function response(req: Request, status: number) {
  return { request: () => req, url: () => req.url(), status: () => status } as Response;
}

test('accepts successful resources with arbitrary bundle names and no source literals', () => {
  const { events, resources } = harness();
  events.emit('response', response(request('script', 'http://localhost/9f32.js'), 200));
  events.emit('response', response(request('stylesheet', 'http://localhost/c80.css'), 200));
  events.emit('response', response(request('script', 'http://localhost/cached.js'), 304));
  expect(resources.failures).toEqual([]);
  resources.dispose();
});

test('does not require an unrelated lazy chunk or a second fetch for cached modules', () => {
  const { resources } = harness();
  // The caller proves module readiness by interacting with the mounted view.
  // No network activity is required for an already evaluated/cached module.
  expect(resources.failures).toEqual([]);
  resources.dispose();
});

test('reports HTTP failures for scripts and styles, not unrelated API or image requests', () => {
  const { events, resources } = harness();
  for (const kind of ['script', 'stylesheet', 'fetch', 'image']) {
    events.emit('response', response(request(kind, `http://localhost/${kind}`), 404));
  }
  expect(resources.failures).toEqual([
    { url: 'http://localhost/script', error: 'HTTP 404' },
    { url: 'http://localhost/stylesheet', error: 'HTTP 404' },
  ]);
  resources.dispose();
});

test('reports failed module transfers even when headers already returned HTTP 200', () => {
  const { events, resources } = harness();
  const script = request('script', 'http://localhost/truncated.js');
  events.emit('response', response(script, 200));
  events.emit('requestfailed', script);
  events.emit('requestfailed', request('stylesheet', 'http://localhost/failed.css'));
  events.emit('requestfailed', request('fetch', 'http://localhost/api/cancelled'));
  expect(resources.failures).toEqual([
    { url: 'http://localhost/truncated.js', error: 'net::ERR_CONNECTION_RESET' },
    { url: 'http://localhost/failed.css', error: 'net::ERR_CONNECTION_RESET' },
  ]);
  resources.dispose();
});

test('reports execution errors after a successful resource response and releases listeners', () => {
  const { events, resources } = harness();
  events.emit('response', response(request('script', 'http://localhost/module.js'), 200));
  events.emit('pageerror', new Error('module evaluation failed'));
  expect(resources.failures).toEqual([
    { url: 'http://localhost/integrations', error: 'module evaluation failed' },
  ]);
  resources.dispose();
  for (const event of ['response', 'requestfailed', 'pageerror']) {
    expect(events.listenerCount(event)).toBe(0);
  }
});
