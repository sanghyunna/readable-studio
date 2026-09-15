import { request } from 'node:http';
import type { ApiErrorResponse } from '@readable-studio/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabricksServiceError } from '../src/databricks/service.js';
import { bounded, ids, login, lookup, model, models, scan, secrets, status, surfaceHarness, verification } from './databricks-surface-fixtures.js';

let harness: Awaited<ReturnType<typeof surfaceHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const enable = { scanId: ids.scan, expectedRevision: 2 };
const routes = [
  ['GET', '/status', undefined, status, 200],
  ['POST', '/login', { host: secrets.host }, login(), 202],
  ['GET', `/login/${ids.scan}`, undefined, login('authenticated'), 200],
  ['DELETE', `/login/${ids.scan}`, undefined, login('cancelled'), 200],
  ['POST', '/setup', { mode: 'workspace-token', host: secrets.host, token: secrets.access_token }, { profile: status.profiles[0]!, status }, 200],
  ['POST', '/setup', { mode: 'cli-profile', profileId: ids.profile }, { profile: status.profiles[0]!, status }, 200],
  ['POST', '/probe', { profileId: ids.profile }, { profiles: status.profiles, issues: [] }, 200],
  ['PUT', '/client', { executableId: null }, status, 200],
  ['POST', '/scans', { profileId: ids.profile }, scan(), 202],
  ['GET', `/scans/${ids.scan}`, undefined, scan(), 200],
  ['GET', `/scans/${ids.scan}/events`, undefined, { type: 'done', revision: 2, scan: scan() }, 200],
  ['DELETE', `/scans/${ids.scan}`, undefined, scan('cancelled', 3), 200],
  ['POST', '/lookup', { profileId: ids.profile, resourceId: ids.endpoint, kind: 'uc-model-service' }, lookup, 200],
  ['GET', '/models', undefined, models, 200],
  ['PUT', `/models/${ids.endpoint}`, enable, model, 200],
  ['DELETE', `/models/${ids.endpoint}`, { expectedRevision: 2 }, models, 200],
  ['POST', `/models/${ids.endpoint}/verify`, { ...enable, allowInference: true }, verification, 200],
  ['DELETE', `/connections/${ids.profile}`, undefined, status, 200],
] as const;

async function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = `${harness!.url}/api/databricks${path}`;
  // Fetch normalizes Host; use the raw HTTP surface to test a hostile authority.
  if (headers.Host) return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(5000) }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.once('error', reject);
      res.once('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(new Response(text, { status: res.statusCode!, headers: responseHeaders }));
      });
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return fetch(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function noCredentialsOrRawFields(text: string) {
  expect(text).not.toContain(secrets.access_token);
  for (const key of Object.keys(secrets)) expect(text).not.toContain(`"${key}"`);
}
function noSecrets(text: string) {
  noCredentialsOrRawFields(text);
  for (const value of Object.values(secrets)) expect(text).not.toContain(value);
}

describe('Databricks HTTP surface', () => {
  for (const [method, path, body, expected, code] of routes) {
    it(`${method} ${path} allows real names in UI DTOs but excludes credentials and raw fields, with no-store`, async () => {
      harness = await surfaceHarness();
      const response = await send(method, path, body);
      expect(response.status).toBe(code);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      noCredentialsOrRawFields(text);
      const payload = path.endsWith('/events') ? JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
      expect(payload).toEqual(expected);
      expect(harness.guard).toHaveBeenCalledOnce();
    });
    for (const headers of [{ Origin: 'https://attacker.example' }, { Host: 'attacker.example' }]) {
      it(`${method} ${path} rejects non-local ${Object.keys(headers)[0]}`, async () => {
        harness = await surfaceHarness();
        const response = await send(method, path, body, headers);
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const failure = await response.json() as ApiErrorResponse;
        expect(failure.error.code).toBe('FORBIDDEN');
        expect(harness.guard).toHaveBeenCalledOnce();
        for (const call of Object.values(harness.service)) expect(call).not.toHaveBeenCalled();
        expect(harness.setClient).not.toHaveBeenCalled();
      });
    }
  }

  it('replays completion to late and reconnecting subscribers and releases both', async () => {
    harness = await surfaceHarness();
    for (const lastEventId of ['0', '2']) {
      const response = await send('GET', `/scans/${ids.scan}/events`, undefined, { 'Last-Event-ID': lastEventId });
      const text = await response.text();
      expect(text).toContain('id: 2\nevent: done\n');
      expect(JSON.parse(text.split('data: ')[1]!.trim())).toEqual({ type: 'done', revision: 2, scan: scan() });
    }
    expect(harness.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('terminates invalid completion payloads with a sanitized SSE error', async () => {
    harness = await surfaceHarness(scan('running', 1));
    const pending = send('GET', `/scans/${ids.scan}/events`);
    await bounded(harness.subscribed);
    const invalid = scan('complete', 2);
    invalid.endpoints[0] = { ...invalid.endpoints[0]!, label: '' };
    harness.complete(invalid);
    const text = await (await pending).text();
    const frames = text.split('\n\n');
    const error = frames.find(frame => frame.startsWith('event: error'))!;
    expect(error).toBeDefined();
    const payload = JSON.parse(error.split('data: ')[1]!);
    expect(payload.error.code).toBe('DATABRICKS_UPSTREAM_UNAVAILABLE');
    noSecrets(error);
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it('streams multiple typed events without resetting sent headers', async () => {
    harness = await surfaceHarness(scan('running', 1));
    const pending = send('GET', `/scans/${ids.scan}/events`);
    await bounded(harness.subscribed);
    harness.emit({ type: 'progress', scanId: ids.scan, revision: 2, state: 'running', counters: scan().counters, completeness: scan().completeness, issues: [] });
    harness.emit({ type: 'endpoint', scanId: ids.scan, revision: 3, endpoint: model.endpoint });
    harness.complete(scan('complete', 4));
    const text = await (await pending).text();
    noCredentialsOrRawFields(text);
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    expect(events.map((event) => event.type)).toEqual(['snapshot', 'progress', 'endpoint', 'done']);
    expect(events.at(-1).scan.revision).toBe(4);
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases an active subscriber when the HTTP client closes', async () => {
    harness = await surfaceHarness(scan('running', 1));
    const controller = new AbortController();
    const closed = new Promise<void>((resolve) => { harness!.unsubscribe.mockImplementation(resolve); });
    const response = await fetch(`${harness.url}/api/databricks/scans/${ids.scan}/events`, { signal: controller.signal });
    controller.abort();
    await bounded(closed);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it('passes opaque request fields and pagination unchanged to the service', async () => {
    harness = await surfaceHarness();
    await send('GET', `/scans/${ids.scan}?cursor=${ids.scan}&limit=25`);
    expect(harness.service.getScan).toHaveBeenCalledWith(ids.scan, { cursor: ids.scan, limit: 25 });
    await send('POST', '/probe', { profileId: ids.profile });
    expect(harness.service.probe).toHaveBeenCalledWith({ profileId: ids.profile });
    await send('PUT', `/models/${ids.endpoint}`, enable);
    expect(harness.service.enable).toHaveBeenCalledWith(ids.endpoint, enable);
    await send('PUT', '/client', { executableId: 'exe_private_reference' });
    expect(harness.setClient).toHaveBeenCalledWith({ executableId: 'exe_private_reference' });
  });

  for (const [method, path, body] of [
    ['POST', '/login', {}],
    ['POST', '/login', { host: 'http://workspace.example' }],
    ['POST', '/login', { host: secrets.host, token: secrets.access_token }],
    ['POST', '/setup', { mode: 'workspace-token', host: secrets.host }],
    ['POST', '/setup', { mode: 'workspace-token', host: 'http://workspace.example', token: secrets.access_token }],
    ['POST', '/setup', { mode: 'workspace-token', host: 'https://user:password@workspace.example', token: secrets.access_token }],
    ['POST', '/setup', { mode: 'workspace-token', host: secrets.host, token: 'bad\ntoken' }],
    ['POST', '/setup', { mode: 'workspace-token', host: secrets.host, token: secrets.access_token, extra: true }],
    ['POST', '/setup', { mode: 'cli-profile', token: secrets.access_token }],
    ['POST', '/setup', { mode: 'unknown' }],
    ['POST', '/scans', { profileId: secrets.host }],
    ['POST', '/scans', { profileId: ids.profile, scopeIds: 'not-an-array' }],
    ['POST', '/probe', { profileId: ids.profile, token: secrets.access_token }],
    ['POST', '/lookup', { profileId: ids.profile, resourceId: secrets.full_name, kind: 'uc-model-service' }],
    ['PUT', '/client', { executablePath: 'C:\\private\\databricks.exe' }],
    ['PUT', `/models/${ids.endpoint}`, { ...enable, expectedRevision: -1 }],
    ['POST', `/models/${ids.endpoint}/verify`, enable],
    ['POST', `/models/${ids.endpoint}/verify`, { ...enable, allowInference: false }],
    ['GET', `/scans/${ids.scan}?limit=1001`, undefined],
    ['GET', `/scans/${ids.scan}?limit=1.5`, undefined],
  ] as const) {
    it(`rejects invalid ${method} ${path} input before calling the service`, async () => {
      harness = await surfaceHarness();
      const response = await send(method, path, body);
      expect(response.status).toBe(400);
      const failure = await response.json() as ApiErrorResponse;
      expect(failure.error.code).toBe('BAD_REQUEST');
      for (const call of Object.values(harness.service)) expect(call).not.toHaveBeenCalled();
      expect(harness.setClient).not.toHaveBeenCalled();
    });
  }

  for (const [code, expected] of [['DATABRICKS_AUTH_REQUIRED', 401], ['DATABRICKS_STALE_REVISION', 409], ['DATABRICKS_SCAN_EXPIRED', 404]] as const) {
    it(`maps ${code} without leaking exception details`, async () => {
      harness = await surfaceHarness();
      harness.service.status.mockRejectedValueOnce(Object.assign(new DatabricksServiceError(code), secrets));
      const response = await send('GET', '/status');
      expect(response.status).toBe(expected);
      const text = await response.text(); noSecrets(text);
      expect(JSON.parse(text).error.code).toBe(code);
    });
  }

  it('does not serialize raw exceptions or unsafe public IDs', async () => {
    harness = await surfaceHarness();
    harness.service.status.mockRejectedValueOnce(new Error(Object.values(secrets).join(' ')));
    const failure = await send('GET', '/status');
    expect(failure.status).toBe(503); noSecrets(await failure.text());
    harness.service.status.mockResolvedValueOnce({ ...status, profiles: [{ ...status.profiles[0]!, id: secrets.access_token }] });
    const unsafe = await send('GET', '/status');
    expect(unsafe.status).toBe(503); noSecrets(await unsafe.text());
  });
});
