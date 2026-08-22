import { setTimeout as delay } from 'node:timers/promises';

import type { HostedHttpClient } from './hosted.ts';

export const HOSTED_ASSISTANT_MESSAGE_ID = 'assistant-acceptance';

export type HostedRunResponse = {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
};

export type HostedRunStatus = {
  id: string;
  status: string;
  resumable?: boolean;
};

export function jsonRequest(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export async function jsonMutation<T = Record<string, unknown>>(
  client: HostedHttpClient,
  method: string,
  path: string,
  value: unknown,
): Promise<T> {
  return await client.json<T>(path, jsonRequest(method, value));
}

export async function expectHttpStatus(
  client: HostedHttpClient,
  path: string,
  status: number,
  init?: RequestInit,
): Promise<Response> {
  const response = await client.request(path, init);
  if (response.status !== status) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path}: expected ${status}, received ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

export async function readText(
  client: HostedHttpClient,
  path: string,
  init?: RequestInit,
): Promise<string> {
  return await (await expectHttpStatus(client, path, 200, init)).text();
}

export function runIntent(
  projectId: string,
  conversationId: string,
  clientRequestId: string,
  message: string,
  assistantMessageId = HOSTED_ASSISTANT_MESSAGE_ID,
): Record<string, unknown> {
  return {
    projectId,
    conversationId,
    assistantMessageId,
    agentId: 'pi',
    message,
    clientRequestId,
    sessionMode: 'design',
  };
}

export async function startRun(
  client: HostedHttpClient,
  projectId: string,
  conversationId: string,
  clientRequestId: string,
  message: string,
  assistantMessageId = HOSTED_ASSISTANT_MESSAGE_ID,
): Promise<HostedRunResponse> {
  return await jsonMutation<HostedRunResponse>(
    client,
    'POST',
    '/api/runs',
    runIntent(projectId, conversationId, clientRequestId, message, assistantMessageId),
  );
}

export async function waitForRun(
  client: HostedHttpClient,
  runId: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<HostedRunStatus> {
  const attempts = Math.ceil(timeoutMs / 100);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await client.json<HostedRunStatus>(`/api/runs/${runId}`);
    if (run.status === expected) return run;
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) {
      throw new Error(`run ${runId} ended ${run.status}, expected ${expected}`);
    }
    await delay(100);
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
}

export async function readSseUntil(
  client: HostedHttpClient,
  path: string,
  pattern: RegExp,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let text = '';
  try {
    const response = await expectHttpStatus(client, path, 200, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader == null) throw new Error(`${path} returned no stream body`);
    const decoder = new TextDecoder();
    while (!pattern.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (!pattern.test(text)) throw new Error(`${path} ended before ${pattern}`);
  return text;
}

export function requiredCursor(events: string): string {
  const cursor = /^id: ([A-Za-z0-9._-]+)$/mu.exec(events)?.[1];
  if (cursor == null) throw new Error(`SSE payload did not contain a cursor: ${events}`);
  return cursor;
}

export async function waitForProviderOverlap(
  summary: () => { maxConcurrentMarkedRequests: number },
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (summary().maxConcurrentMarkedRequests >= 2) return;
    await delay(50);
  }
  throw new Error('different hosted users did not overlap at the provider fixture');
}
