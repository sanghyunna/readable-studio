// A skill or template picked on the Hub owns the session: the per-kind default
// scenario plugin (prototype -> example-web-prototype, deck ->
// example-simple-deck) must neither be pinned at create time nor bound by the
// /api/runs fallback, because its SKILL.md would replace the chosen skill.
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatRunCreateResponse, CreateSessionResponse } from '@readable-studio/contracts';

vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));

import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';
import { withFakeAgent } from './helpers/fake-agent.js';

let server: http.Server;
let baseUrl: string;
let shutdown: () => Promise<void>;
beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as { server: http.Server; url: string; shutdown: () => Promise<void> };
  server = started.server;
  baseUrl = started.url;
  shutdown = started.shutdown;
});
afterAll(async () => {
  await shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

async function post<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as T;
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload;
}

describe('default scenario plugin vs an explicit skill pick', () => {
  it.each([
    ['design-taste-frontend', 'prototype'],
    ['deck-swiss-international', 'deck'],
  ])('design-mode session with skill %s (%s) pins no default plugin', async (skillId, kind) => {
    const created = await post<CreateSessionResponse>('/api/sessions', {
      title: `Explicit ${skillId}`, skillId, metadata: { kind }, conversationMode: 'design',
    });
    expect(created.workspace.skillId).toBe(skillId);
    expect(created.appliedPluginSnapshotId).toBeUndefined();
    expect(created.workspace.appliedPluginSnapshotId ?? null).toBeNull();
  });

  // The run-body skill is what `readable run start --skill` sends. The
  // no-skill row is the control: the /api/runs fallback still binds the default.
  it.each([
    ['the session', { skillId: 'design-taste-frontend' }, {}, undefined],
    ['the run body', {}, { skillId: 'design-taste-frontend' }, undefined],
    ['neither', {}, {}, 'example-web-prototype'],
  ])('a chat-mode run with the skill on %s binds only the expected default plugin', async (_where, sessionSkill, runSkill, expectedPluginId) => {
    const created = await post<CreateSessionResponse>('/api/sessions', {
      title: 'Explicit chat skill', ...sessionSkill, metadata: { kind: 'prototype' }, conversationMode: 'chat',
    });
    expect(created.appliedPluginSnapshotId).toBeUndefined();
    await withFakeAgent('opencode', `
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'text', part: { text: 'ok' } })));
`, async () => {
      const run = await post<ChatRunCreateResponse>('/api/runs', {
        agentId: 'opencode', model: 'openai/gpt-5', message: 'Make a landing page',
        projectId: created.workspace.id, conversationId: created.session.id, ...runSkill,
      });
      expect(run.pluginId).toBe(expectedPluginId);
      if (expectedPluginId) expect(run.appliedPluginSnapshotId).toBeTruthy();
      else expect(run.appliedPluginSnapshotId).toBeUndefined();
      // Finish at the buffered terminal SSE event so the fake agent exits before PATH is restored.
      const response = await fetch(`${baseUrl}/api/runs/${run.runId}/events`, { signal: AbortSignal.timeout(15_000) });
      const reader = response.body!.getReader();
      let events = '';
      try {
        while (!events.includes('event: end')) {
          const { value, done } = await reader.read();
          if (done) break;
          events += new TextDecoder().decode(value);
        }
      } finally { await reader.cancel(); }
    });
  }, 60_000);
});
