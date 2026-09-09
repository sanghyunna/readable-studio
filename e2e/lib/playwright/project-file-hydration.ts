import { EventEmitter, once } from 'node:events';
import type { Frame, Page, Request, Response } from '@playwright/test';
import { T } from '../timeouts.ts';

// Opt-in browser-wide lifecycle proof. It never changes the project-file barrier.
export { observeClientFetchCancellations, classifyClientFetchCancellation } from './client-fetch-cancellation.ts';

// projectRawUrl encodes each segment, preserving nested path separators.
const rawFilePath = /^\/api\/projects\/[^/]+\/raw\/(.+)$/;
const fileListPath = /^\/api\/projects\/[^/]+\/files\/?$/;

// These parameters refresh/bridge the same artifact, not a different file.
function readKey(url: string): string {
  const key = new URL(url);
  for (const parameter of ['cacheBust', 'v', 'r', 'fr', 'odPreviewBridge']) key.searchParams.delete(parameter);
  key.searchParams.sort();
  return key.href;
}

export type HydrationContract = 'responses' | 'raw' | 'no-artifact';
type ReadState = {
  id: number;
  url: string;
  key: string;
  raw: boolean;
  resourceType: string;
  status: number | null;
  outcome: 'pending' | 'finished' | 'cancelled' | 'transport-failure';
  errorText: string | null;
  startedAt: string;
  discardedDocument: { url: string; committedAt: string } | null;
};

/**
 * Arm before mounting/refreshing; drain AFTER asserting the final public UI.
 * Headers are not completion. Strict Mode aborts superseded fetches and the
 * viewer replaces iframe loads: only exact Chromium ERR_ABORTED is a client
 * cancellation candidate. A completed 2xx read of the SAME resource must also
 * exist to corroborate it (fetch and document are alternative viewer paths).
 * HTTP errors and every other/missing failure text stay fatal even if a later
 * read succeeds. Cancellation without a counterpart fails the hydration
 * contract, rather than being silently relabelled as a network success.
 */
export function observeProjectFileHydration(page: Pick<Page, 'on' | 'off'>) {
  const events = new EventEmitter();
  const pending = new Map<Request, ReadState>();
  const reads: ReadState[] = [];
  const failures: Error[] = [];
  type Navigation = {
    request: Request | null; frame: Frame | null; responseOK: boolean;
    committedAt: string | null; candidates: ReadState[];
  };
  let navigation: Navigation | null = null;
  const successful = (read: ReadState) => read.outcome === 'finished'
    && read.status !== null && read.status >= 200 && read.status < 300;
  const replacement = (read: ReadState) => reads.find((other) => other !== read
    && other.key === read.key && successful(other));
  const exclusion = (read: ReadState) => read.outcome === 'pending' && read.status === null
    && read.discardedDocument && replacement(read)
    ? { reason: 'Headerless file-list fetch issued by the outgoing document during confirmed replacement',
      ...read.discardedDocument } : null;
  const unresolved = () => [...pending.values()].filter((read) => !exclusion(read));
  const onRequest = (request: Request) => {
    if (navigation && request.isNavigationRequest() && request.frame().parentFrame() === null) {
      navigation.request = request;
      navigation.frame = request.frame();
    }
    if (request.method() !== 'GET') return;
    const pathname = new URL(request.url()).pathname;
    if (!rawFilePath.test(pathname) && !fileListPath.test(pathname)) return;
    const state: ReadState = {
      id: reads.length + 1, url: request.url(), key: readKey(request.url()),
      raw: rawFilePath.test(pathname), resourceType: request.resourceType(),
      status: null, outcome: 'pending', errorText: null,
      startedAt: new Date().toISOString(), discardedDocument: null,
    };
    // Only the outgoing document can issue fetches after the navigation's
    // headers but before its frame commits. Earlier/live reads are never exempt.
    if (navigation?.responseOK && !navigation.committedAt && !state.raw
      && state.resourceType === 'fetch' && request.frame() === navigation.frame) {
      navigation.candidates.push(state);
    }
    pending.set(request, state);
    reads.push(state);
  };
  const onResponse = (response: Response) => {
    if (navigation?.request === response.request()) navigation.responseOK = response.ok();
    const state = pending.get(response.request());
    if (!state) return;
    state.status = response.status();
    if (!response.ok()) failures.push(new Error(`Project-file hydration HTTP ${response.status()}: ${response.url()}`));
  };
  const onFinished = (request: Request) => {
    const state = pending.get(request);
    if (!state) return;
    pending.delete(request);
    state.outcome = 'finished';
    events.emit('settled');
  };
  const onFailed = (request: Request) => {
    const state = pending.get(request);
    if (!state) return;
    pending.delete(request);
    state.errorText = request.failure()?.errorText ?? 'requestfailed';
    state.outcome = state.errorText === 'net::ERR_ABORTED' ? 'cancelled' : 'transport-failure';
    if (state.outcome === 'transport-failure') {
      failures.push(new Error(`Project-file hydration ${state.errorText}: ${state.url}`));
    }
    events.emit('settled');
  };
  const onFrameNavigated = (frame: Frame) => {
    if (navigation?.frame === frame && navigation.responseOK) navigation.committedAt = new Date().toISOString();
  };
  page.on('framenavigated', onFrameNavigated);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    get counts() {
      const cancelled = reads.filter((read) => read.outcome === 'cancelled');
      const superseded = cancelled.filter((read) => replacement(read)).length;
      return {
        reads: reads.length, responses: reads.filter((read) => read.status !== null).length,
        rawReads: reads.filter((read) => read.raw).length,
        rawResponses: reads.filter((read) => read.raw && read.status !== null).length,
        rawFinished: reads.filter((read) => read.raw && successful(read)).length,
        finished: reads.filter((read) => read.outcome === 'finished').length,
        pending: unresolved().length, excludedPending: [...pending.values()].filter((read) => exclusion(read)).length,
        cancelled: cancelled.length, superseded,
        unprovenCancelled: cancelled.length - superseded,
        httpFailures: reads.filter((read) => read.status !== null && (read.status < 200 || read.status >= 300)).length,
        transportFailures: reads.filter((read) => read.outcome === 'transport-failure').length,
        failed: failures.length,
      };
    },
    get requests() {
      return reads.map((read) => ({ ...read, exclusion: exclusion(read),
        replacementId: read.outcome === 'cancelled' || exclusion(read) ? replacement(read)?.id ?? null : null }));
    },
    /** Drain live reads before replacing a document. A reload can itself abort
     * the run SSE, whose error handler starts one last file-list fetch during
     * teardown. Chromium may never report its terminal event. Record that exact
     * discarded-document read; never pretend it finished or cancelled. A real
     * completed same-resource read is still required, and late errors stay fatal.
     * The trigger must await the bounded Playwright navigation, not just start it.
     */
    async navigate<TResult>(trigger: () => Promise<TResult>, timeout = T.long,
      contract: HydrationContract = 'responses'): Promise<TResult> {
      await this.drain(timeout, contract);
      if (navigation) throw new Error('Project-file navigation already armed');
      const boundary: Navigation = { request: null, frame: null, responseOK: false, committedAt: null, candidates: [] };
      navigation = boundary;
      try {
        const result = await trigger();
        if (!boundary.committedAt || !boundary.request) throw new Error('Project-file navigation did not commit a successful document');
        for (const read of boundary.candidates) {
          read.discardedDocument = { url: boundary.request.url(), committedAt: boundary.committedAt };
        }
        return result;
      } finally {
        navigation = null;
      }
    },
    async drain(timeout = T.long, contract: HydrationContract = 'responses'): Promise<void> {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error(
        `Project-file hydration did not finish: ${JSON.stringify(unresolved())}`,
      )), timeout);
      try {
        while (unresolved().length > 0) await once(events, 'settled', { signal: controller.signal });
        if (failures.length > 0) throw new AggregateError(failures, 'Project-file hydration failed');
        const unproven = reads.filter((read) => read.outcome === 'cancelled' && !replacement(read));
        if (unproven.length > 0) throw new Error(`Project-file cancellation without a completed replacement: ${JSON.stringify(unproven)}`);
        if (!reads.some(successful)) throw new Error('Project-file hydration observed no completed matching GET response');
        if (contract === 'raw' && !reads.some((read) => read.raw && successful(read))) {
          throw new Error('Project-file hydration observed no completed raw GET');
        }
        if (contract === 'no-artifact' && reads.some((read) => read.raw)) {
          throw new Error('No-artifact hydration unexpectedly read a raw artifact');
        }
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    },
    dispose() {
      page.off('framenavigated', onFrameNavigated);
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}

/** Legacy body consumer: choose a completed read, never the first headers.
 * The caller still asserts the rendered artifact and drains its full observer.
 */
export async function readHydratedProjectFile(
  page: Page, fileName: string, trigger: () => Promise<unknown>,
): Promise<string> {
  const matches = (request: Request) => {
    const match = rawFilePath.exec(new URL(request.url()).pathname);
    return request.method() === 'GET' && match !== null && decodeURIComponent(match[1]!) === fileName;
  };
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const body = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const onResponse = (response: Response) => {
    if (matches(response.request()) && !response.ok()) reject(new Error(`Hydrate ${fileName} HTTP ${response.status()}: ${response.url()}`));
  };
  const onFailed = (request: Request) => {
    if (!matches(request)) return;
    const text = request.failure()?.errorText ?? 'requestfailed';
    if (text !== 'net::ERR_ABORTED') reject(new Error(`Hydrate ${fileName} ${text}: ${request.url()}`));
  };
  const onFinished = (request: Request) => {
    if (!matches(request)) return;
    void request.response().then(async (response) => {
      if (!response?.ok()) throw new Error(`Hydrate ${fileName} finished without a successful response`);
      return response.text();
    }).then(resolve, reject);
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('requestfinished', onFinished);
  const deadline = setTimeout(() => reject(new Error(`Hydrate ${fileName} observed no completed raw body`)), T.long);
  try {
    const [text] = await Promise.all([body, trigger()]);
    return text;
  } finally {
    clearTimeout(deadline);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
    page.off('requestfinished', onFinished);
  }
}
