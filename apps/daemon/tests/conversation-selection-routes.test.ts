import type http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConversationResponse, ConversationsResponse, CreateProjectResponse } from '@readable-studio/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';
let server: http.Server;
let base: string;
beforeAll(async () => {
  const result = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
  server = result.server; base = result.url;
});
afterAll(() => new Promise<void>(resolve => {
  server.close(() => resolve());
  server.closeAllConnections();
}));
async function request<T = ConversationResponse>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}
it('copies recent selection for new sessions, persists independently, and honors explicit per-turn choices', async () => {
  const initial = { agentId: 'codex', agentModels: { codex: { model: 'model-a' } } };
  await request('/api/app-config', 'PUT', initial);
  const project = await request<CreateProjectResponse>('/api/projects', 'POST', { id: 'selection-project', name: 'Selection' });
  const route = '/api/projects/selection-project/conversations';
  const a = project.conversationId;
  expect((await request(`${route}/${a}`)).conversation.selection).toEqual(initial);
  const next = { agentId: 'claude', agentModels: { claude: { model: 'model-b' } } };
  await request(`${route}/${a}`, 'PATCH', { selection: next });
  const b = (await request(route, 'POST', {})).conversation.id;
  expect((await request(`${route}/${b}`)).conversation.selection).toEqual(next);
  const empty = { agentId: 'codex', agentModels: {} };
  await request(`${route}/${a}`, 'PATCH', { selection: empty });
  expect((await request(`${route}/${b}`)).conversation.selection).toEqual(next);
  expect((await request<ConversationsResponse>(route)).conversations.find(c => c.id === a)?.selection).toEqual(empty);
  await withFakeAgent('opencode', `
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'text', part: { text: 'explicit-selection-ok' } }));
  process.exit(0);
});
`, async () => {
    const run = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'selection-project', conversationId: a, agentId: 'opencode', model: 'openai/gpt-5', message: 'hello' }) });
    const body = await run.text();
    expect(run.ok, body).toBe(true);
    expect(body).toContain('explicit-selection-ok');
    const missingModel = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'selection-project', conversationId: a, agentId: 'opencode', model: null, message: 'hello' }) });
    const missingModelBody = await missingModel.text();
    expect(missingModelBody).toContain('"code":"MODEL_SELECTION_REQUIRED"');
    expect(missingModelBody).toContain('"status":"failed"');
    expect(missingModelBody).not.toContain('explicit-selection-ok');
  });
  expect((await request(`${route}/${a}`)).conversation.selection).toEqual(empty);
  const invalid = await fetch(`${base}${route}/${a}`, { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selection: { agentId: 3, agentModels: {} } }) });
  expect(invalid.status).toBe(400);
  const execute = promisify(execFile);
  const cli = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'conversation', 'set', b,
    '--project', 'selection-project', '--agent', 'claude', '--model', 'cli-model', '--daemon-url', base, '--json'],
  { timeout: 15_000 });
  expect(JSON.parse(cli.stdout).conversation.selection.agentModels.claude.model).toBe('cli-model');
  expect((await request(`${route}/${a}`)).conversation.selection).toEqual(empty);
  const details = await execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'conversation', 'info', b,
    '--daemon-url', base, '--json'], { timeout: 15_000 });
  expect(JSON.parse(details.stdout).conversation.selection.agentModels.claude.model).toBe('cli-model');
});
