import { randomUUID } from 'node:crypto';
import type { ConsoleMessage, Page, Request as WireRequest, Response as WireResponse } from '@playwright/test';

const projectFilePath = /^\/api\/projects\/[^/]+\/(files\/?|raw\/.+)$/;

type FetchSignal = {
  token: string;
  url: string;
  kind: 'started' | 'aborted';
  at: string;
  stack: string;
  reason: string | null;
};
export type ClientFetchRead = {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  finished: boolean;
  errorText: string | null;
  token: string | null;
};

/** Exact request identity, not URL proximity or a source-code inference. */
export function classifyClientFetchCancellation(read: ClientFetchRead, signals: readonly FetchSignal[]) {
  const started = signals.find((signal) => signal.kind === 'started' && signal.token === read.token && signal.url === read.url);
  const aborted = signals.find((signal) => signal.kind === 'aborted' && signal.token === read.token && signal.url === read.url);
  const httpFailure = read.status !== null && (read.status < 200 || read.status >= 300);
  const transportFailure = read.errorText !== null && read.errorText !== 'net::ERR_ABORTED';
  const corroborated = read.method === 'GET' && read.resourceType === 'fetch'
    && !projectFilePath.test(new URL(read.url).pathname)
    && !read.finished && !httpFailure && !transportFailure && read.errorText === 'net::ERR_ABORTED'
    && started !== undefined && aborted !== undefined && signals.indexOf(started) < signals.indexOf(aborted);
  return {
    ...read, httpFailure, transportFailure, corroborated,
    reason: corroborated ? 'client-abort-signal' : null,
    ownership: corroborated ? { token: started.token, startedAt: started.at, ownerStack: started.stack,
      abortedAt: aborted.at, abortStack: aborted.stack, abortReason: aborted.reason } : null,
  };
}

/** Self-contained init script; exported so static tests exercise the shipped probe.
 * The diagnostic header identifies simultaneous same-URL fetches exactly. Only
 * same-origin, top-level GETs with a live signal are tagged; no CORS preflight,
 * URL rewrite, body consumption, retry, or replacement of the app's signal.
 * Project raw/list traffic is deliberately untouched.
 */
export function installClientFetchCancellationProbe({ header, marker }: { header: string; marker: string }): void {
  if (window !== window.top || !/^https?:$/.test(window.location.protocol)) return;
  const nativeFetch = window.fetch;
  const documentId = crypto.randomUUID();
  let sequence = 0;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const incoming = input instanceof Request ? input : null;
    const url = new URL(incoming?.url ?? String(input), window.location.href);
    const method = (init?.method ?? incoming?.method ?? 'GET').toUpperCase();
    const signal = init?.signal !== undefined ? init.signal : incoming?.signal;
    if (url.origin !== window.location.origin || method !== 'GET' || !signal || signal.aborted
      || /^\/api\/projects\/[^/]+\/(files\/?|raw\/.+)$/.test(url.pathname)) {
      return nativeFetch.call(this, input, init);
    }
    const token = `${documentId}:${++sequence}`;
    const headers = new Headers(init?.headers ?? incoming?.headers);
    headers.set(header, token);
    const emit = (kind: FetchSignal['kind']) => console.debug(marker + JSON.stringify({
      kind, token, url: url.href, at: new Date().toISOString(), stack: new Error().stack ?? '',
      reason: kind === 'aborted' ? String(signal.reason) : null,
    } satisfies FetchSignal));
    emit('started');
    signal.addEventListener('abort', () => emit('aborted'), { once: true });
    // Keep observing after headers: cleanup can abort an in-progress JSON body.
    return nativeFetch.call(this, input, { ...init, headers });
  };
}

/** Install before the first navigation; dispose after collecting the wire ledger.
 * This does NOT grant exemptions in observeProjectFileHydration. A browser-wide
 * audit can use corroborated=true as an alternative to a completed counterpart,
 * while retaining its independent HTTP/transport checks and pending-read ledger.
 * Old timelines without the probe remain uncorroborated.
 */
export async function observeClientFetchCancellations(page: Page) {
  const id = randomUUID();
  const header = `x-e2e-fetch-${id}`;
  const marker = `[e2e-fetch-${id}]`;
  const signals: FetchSignal[] = [];
  const reads = new Map<WireRequest, ClientFetchRead>();
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'debug' && message.text().startsWith(marker)) {
      signals.push(JSON.parse(message.text().slice(marker.length)) as FetchSignal);
    }
  };
  const onRequest = (request: WireRequest) => {
    const token = request.headers()[header];
    if (!token) return;
    reads.set(request, { url: request.url(), method: request.method(), resourceType: request.resourceType(),
      status: null, finished: false, errorText: null, token });
  };
  const onResponse = (response: WireResponse) => {
    const read = reads.get(response.request());
    if (read) read.status = response.status();
  };
  const onFinished = (request: WireRequest) => {
    const read = reads.get(request);
    if (read) read.finished = true;
  };
  const onFailed = (request: WireRequest) => {
    const read = reads.get(request);
    if (read) read.errorText = request.failure()?.errorText ?? 'requestfailed';
  };
  const dispose = () => {
    page.off('console', onConsole);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  };
  page.on('console', onConsole);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  try {
    await page.addInitScript(installClientFetchCancellationProbe, { header, marker });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    get requests() { return [...reads.values()].map((read) => classifyClientFetchCancellation(read, signals)); },
    get signals() { return [...signals]; },
    classify(request: WireRequest) {
      const read = reads.get(request);
      return read ? classifyClientFetchCancellation(read, signals) : null;
    },
    dispose,
  };
}
