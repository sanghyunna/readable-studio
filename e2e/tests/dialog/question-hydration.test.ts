import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page, Route } from '@playwright/test';
import { describe, expect, test, vi } from 'vitest';
import { HELD_QUESTION_RUN } from '@/fake-agents';
import { gateQuestionHydration, seedHydrationQuestion } from '@/playwright/question-hydration';

// Static contracts only: no browser, daemon, subprocess, sleeps or real I/O.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function apiResponse(body: unknown, status = 200): APIResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as APIResponse;
}

describe('question hydration fixture identities', () => {
  test('uses one UUID for the persisted message URL and payload and matches the live agent form', async () => {
    const put = vi.fn<APIRequestContext['put']>().mockResolvedValue(apiResponse({}));
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const message = await seedHydrationQuestion({ put }, projectId, conversationId);
    for (const id of [projectId, conversationId, message.id]) expect(id).toMatch(uuid);
    expect(put).toHaveBeenCalledExactlyOnceWith(
      `/api/projects/${projectId}/conversations/${conversationId}/messages/${message.id}`,
      { data: message },
    );
    const match = /^<question-form id="([^"]+)"[^>]*>(.*)<\/question-form>$/.exec(message.content);
    expect(match?.[1]).toBe(HELD_QUESTION_RUN.formId);
    expect(JSON.parse(match![2]!)).toEqual(HELD_QUESTION_RUN.form);
  });

  test('does not ignore a daemon seeding failure', async () => {
    const put = vi.fn<APIRequestContext['put']>().mockResolvedValue(apiResponse({ error: 'id mismatch' }, 400));
    await expect(seedHydrationQuestion({ put }, randomUUID(), randomUUID())).rejects.toThrow('400');
  });
});

async function harness() {
  const projectId = randomUUID();
  const conversationId = randomUUID();
  let handler!: (route: Route) => Promise<void>;
  const completions: Promise<void>[] = [];
  const page = {
    route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }),
    unroute: vi.fn(async () => {}),
  };
  const gate = await gateQuestionHydration(page as unknown as Page, projectId, conversationId);
  const makeRoute = (params: Record<string, string> = {}, method = 'GET', body: unknown = { runs: [] }) => {
    const response = apiResponse(body);
    return {
      request: () => ({ method: () => method, url: () => `http://localhost/api/runs?${new URLSearchParams({
        projectId, conversationId, status: 'active', ...params,
      })}` }),
      continue: vi.fn(async () => {}),
      fulfill: vi.fn(async (_options: Parameters<Route['fulfill']>[0]) => {}),
      fetch: vi.fn(async () => response),
      abort: vi.fn(async (_reason: string) => {}),
    };
  };
  const receive = (route: ReturnType<typeof makeRoute>) => {
    completions.push(handler(route as unknown as Route));
    return Promise.resolve();
  };
  return { gate, page, makeRoute, receive, completions };
}

describe('question hydration event gate', () => {
  test('subscribes before the trigger and independently releases concurrent requests', async () => {
    const value = await harness();
    try {
      const firstRoute = value.makeRoute();
      const secondRoute = value.makeRoute({}, 'GET', { runs: [{ id: randomUUID(), status: 'running' }] });
      const first = await value.gate.next(() => value.receive(firstRoute));
      const second = await value.gate.next(() => value.receive(secondRoute));
      expect(value.gate.requestCount).toBe(2);
      expect(value.gate.inflight).toBe(2);
      expect(value.gate.maxInflight).toBe(2);
      expect(firstRoute.fulfill).not.toHaveBeenCalled();
      expect(secondRoute.fulfill).not.toHaveBeenCalled();
      await first.fail();
      expect(firstRoute.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 503 }));
      expect(value.gate.inflight).toBe(1);
      expect(secondRoute.fulfill).not.toHaveBeenCalled();
      const authoritative = await second.succeed();
      expect(authoritative).toEqual(await (await secondRoute.fetch()).json());
      expect(secondRoute.fulfill).toHaveBeenCalledWith({ response: await secondRoute.fetch() });
      expect(value.gate.inflight).toBe(0);
      await expect(first.fail()).rejects.toThrow('already released');
      await Promise.all(value.completions);
    } finally {
      await value.gate.dispose();
    }
  });

  test('does not gate another project, conversation, status, or method', async () => {
    const value = await harness();
    try {
      const unrelated = [
        value.makeRoute({ projectId: randomUUID() }),
        value.makeRoute({ conversationId: randomUUID() }),
        value.makeRoute({ status: 'succeeded' }),
        value.makeRoute({}, 'POST'),
      ];
      for (const route of unrelated) await value.receive(route);
      await Promise.all(value.completions);
      for (const route of unrelated) expect(route.continue).toHaveBeenCalledOnce();
      expect(value.gate.requestCount).toBe(0);
    } finally {
      await value.gate.dispose();
    }
  });

  test('propagates unsuccessful authoritative responses rather than inventing idle', async () => {
    const value = await harness();
    try {
      const route = value.makeRoute();
      route.fetch.mockResolvedValue(apiResponse({ error: 'unavailable' }, 503));
      const held = await value.gate.next(() => value.receive(route));
      await expect(held.succeed()).rejects.toThrow('503');
      expect(route.fulfill).not.toHaveBeenCalled();
      await Promise.all(value.completions);
    } finally {
      await value.gate.dispose();
    }
  });

  test('disposal aborts every outstanding request and unregisters its route', async () => {
    const value = await harness();
    const first = value.makeRoute();
    const second = value.makeRoute();
    await value.gate.next(() => value.receive(first));
    await value.gate.next(() => value.receive(second));
    await value.gate.dispose();
    await Promise.all(value.completions);
    expect(first.abort).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(second.abort).toHaveBeenCalledExactlyOnceWith('aborted');
    expect(value.gate.inflight).toBe(0);
    expect(value.page.unroute).toHaveBeenCalledOnce();
  });
});
