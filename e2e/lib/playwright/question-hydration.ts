import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import type { ChatMessage, ChatRunListResponse } from '@readable-studio/contracts';
import { HELD_QUESTION_RUN } from '../fake-agents.ts';
import { T } from '../timeouts.ts';

/** URL and payload must identify the same persisted message (daemon returns 400 otherwise). */
export async function seedHydrationQuestion(
  request: Pick<APIRequestContext, 'put'>, projectId: string, conversationId: string,
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: randomUUID(), role: 'assistant', createdAt: Date.now(),
    content: `<question-form id="${HELD_QUESTION_RUN.formId}" title="Held run brief">${JSON.stringify(HELD_QUESTION_RUN.form)}</question-form>`,
  };
  const response = await request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/${message.id}`,
    { data: message },
  );
  if (!response.ok()) throw new Error(`Seed question failed (${response.status()}): ${await response.text()}`);
  return message;
}

/** Unmount the page first: terminating a run must not promote its queued sends. */
export async function cleanupHydrationRuns(
  request: Pick<APIRequestContext, 'get' | 'post'>,
  projectId: string,
  conversationId: string,
  releaseHeldRun: boolean,
): Promise<void> {
  const response = await request.get('/api/runs', {
    params: { projectId, conversationId }, timeout: T.long,
  });
  if (!response.ok()) throw new Error(`List owned runs failed (${response.status()}): ${await response.text()}`);
  const { runs } = await response.json() as ChatRunListResponse;
  // Include already-terminal runs: cancellation may have raced this read.
  // Start observers before cancellation/release. The daemon also replays end
  // for a late subscriber, so HTTP connection ordering cannot lose completion.
  const completion = Promise.allSettled(runs.map(async (run) => {
    const events = await request.get(`/api/runs/${run.id}/events`, { timeout: T.long });
    if (!events.ok()) throw new Error(`Run ${run.id} SSE failed (${events.status()}): ${await events.text()}`);
    // APIRequestContext buffers the whole response: resolution proves SSE EOF,
    // not merely HTTP 200 or the agent's earlier turn.completed frame.
    const ends = (await events.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
      const lines = frame.split(/\r?\n/);
      if (!lines.includes('event: end')) return [];
      const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      return [JSON.parse(data) as { status: string }];
    });
    if (ends.length !== 1 || !['canceled', 'succeeded'].includes(ends[0]!.status)) {
      throw new Error(`Run ${run.id} closed without a successful/canceled daemon end: ${JSON.stringify(ends)}`);
    }
    const status = await request.get(`/api/runs/${run.id}`, { timeout: T.long });
    if (!status.ok()) throw new Error(`Run ${run.id} status failed (${status.status()}): ${await status.text()}`);
    const body = await status.json() as ChatRunListResponse['runs'][number];
    if (body.id !== run.id || body.projectId !== projectId || body.conversationId !== conversationId
      || body.status !== ends[0]!.status) {
      throw new Error(`Run ${run.id} terminal status disagrees with SSE: ${JSON.stringify(body)}`);
    }
  }));
  const cancellations = await Promise.allSettled(runs
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .map(async (run) => {
      const canceled = await request.post(`/api/runs/${run.id}/cancel`, { timeout: T.long });
      if (!canceled.ok()) throw new Error(`Cancel run ${run.id} failed (${canceled.status()}): ${await canceled.text()}`);
    }));
  // Windows cancellation kills the .cmd wrapper, not necessarily its held Node
  // descendant. Release that descendant's watcher/stdout even if cancel failed;
  // otherwise the daemon's child close handler cannot emit end and close SSE.
  const release = await Promise.allSettled(releaseHeldRun && runs.length > 0 ? [(async () => {
    const released = await request.post(`/api/projects/${projectId}/files`, {
      data: { name: HELD_QUESTION_RUN.releaseFile, content: HELD_QUESTION_RUN.releaseToken }, timeout: T.long,
    });
    if (!released.ok()) throw new Error(`Release held run failed (${released.status()}): ${await released.text()}`);
  })()] : []);
  const failures = [...cancellations, ...release, ...await completion]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Owned hydration run cleanup failed');
}

export interface HeldHydration {
  fail(): Promise<void>;
  succeed(): Promise<ChatRunListResponse>;
}

/** Only the authoritative active-run read is gated. Messages, run creation and SSE stay real. */
export async function gateQuestionHydration(page: Page, projectId: string, conversationId: string) {
  const events = new EventEmitter();
  const pending = new Map<Route, () => void>();
  let requests = 0;
  let maxInflight = 0;
  const pattern = '**/api/runs?**';
  const handler = async (route: Route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (incoming.method() !== 'GET' || url.pathname !== '/api/runs'
      || url.searchParams.get('projectId') !== projectId
      || url.searchParams.get('conversationId') !== conversationId
      || url.searchParams.get('status') !== 'active') {
      await route.continue();
      return;
    }
    requests++;
    // Every request owns its release. A duplicate cannot overwrite the first
    // waiter or accidentally resolve against a later retry's release promise.
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    pending.set(route, release);
    maxInflight = Math.max(maxInflight, pending.size);
    const respond = async <TResult>(action: () => Promise<TResult>): Promise<TResult> => {
      if (!pending.has(route)) throw new Error('Hydration request already released');
      try {
        return await action();
      } finally {
        pending.delete(route);
        release();
      }
    };
    const held: HeldHydration = {
      fail: () => respond(() => route.fulfill({ status: 503, json: { error: 'Controlled hydration failure' } })),
      succeed: () => respond(async () => {
        const response = await route.fetch({ timeout: T.long });
        if (!response.ok()) throw new Error(`Authoritative hydration failed (${response.status()}): ${await response.text()}`);
        const body = await response.json() as ChatRunListResponse;
        await route.fulfill({ response });
        return body;
      }),
    };
    events.emit('request', held);
    await completed;
  };
  await page.route(pattern, handler);
  return {
    get requestCount() { return requests; },
    get inflight() { return pending.size; },
    get maxInflight() { return maxInflight; },
    async next(trigger: () => Promise<unknown>): Promise<HeldHydration> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('Hydration request did not arrive')), T.long);
      // Subscribe before navigation/click, never poll the route counter.
      const arrival = once(events, 'request', { signal: controller.signal });
      try {
        const [[held]] = await Promise.all([arrival, trigger()]);
        return held as HeldHydration;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    },
    async dispose() {
      try {
        await Promise.all([...pending].map(async ([route, release]) => {
          try { await route.abort('aborted'); }
          finally { pending.delete(route); release(); }
        }));
      } finally {
        await page.unroute(pattern, handler);
      }
    },
  };
}
