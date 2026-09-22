import { Server } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

import type { detectAgents as DetectAgents } from '../src/agents.js';
import type { readAppConfig as ReadAppConfig } from '../src/app-config.js';

const { detectAgentsMock, readAppConfigMock } = vi.hoisted(() => ({
  detectAgentsMock: vi.fn<typeof DetectAgents>(),
  readAppConfigMock: vi.fn<typeof ReadAppConfig>(),
}));

vi.mock('../src/agents.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agents.js')>(),
  detectAgents: detectAgentsMock,
}));

vi.mock('../src/app-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app-config.js')>();
  readAppConfigMock.mockImplementation(actual.readAppConfig);
  return { ...actual, readAppConfig: readAppConfigMock };
});

import { AGENT_DEFS } from '../src/agents.js';
import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import { agentCapabilities } from '../src/runtimes/capabilities.js';
import { withFakeAgent } from './helpers/fake-agent.js';

type StartedServer = {
  readonly url: string;
  readonly server: Server;
  readonly shutdown: () => Promise<void>;
};

const startedServers: StartedServer[] = [];
const dataDir = process.env.READABLE_DATA_DIR;
if (!dataDir) throw new Error('Test setup must isolate READABLE_DATA_DIR');
const configFile = path.join(dataDir, 'app-config.json');

async function startWithProfileFile(contents: string | null): Promise<StartedServer> {
  if (contents === null) await rm(configFile, { force: true });
  else await writeFile(configFile, contents);
  const started = await startServer({ port: 0, returnServer: true });
  if (typeof started !== 'object' || started === null || !('url' in started) ||
      typeof started.url !== 'string' || !('server' in started) || !(started.server instanceof Server) ||
      !('shutdown' in started) || typeof started.shutdown !== 'function') {
    throw new Error('startServer must return a controllable server');
  }
  const shutdown = started.shutdown;
  const typed: StartedServer = {
    url: started.url,
    server: started.server,
    shutdown: async () => { await shutdown(); },
  };
  startedServers.push(typed);
  await Promise.allSettled(readAppConfigMock.mock.results.map((result) => result.value));
  return typed;
}

beforeEach(() => {
  detectAgentsMock.mockReset();
  readAppConfigMock.mockClear();
  const def = AGENT_DEFS.find((agent) => agent.id === 'codex');
  if (!def) throw new Error('codex definition is missing');
  detectAgentsMock.mockResolvedValue([{
    ...def,
    available: true,
    path: process.execPath,
    authStatus: 'ok',
    models: [{ id: 'same-model', label: 'Same model' }],
    modelsSource: 'live',
  }]);
});

afterAll(async () => {
  await Promise.all(startedServers.map(async ({ shutdown, server }) => {
    await shutdown();
    await closeHttpServer(server);
  }));
});

it('skips speculative startup detection in full mode', async () => {
  // Given an enabled agent under the full profile.
  // When the daemon starts.
  await startWithProfileFile(JSON.stringify({ performanceProfile: 'full', enabledAgentIds: ['codex'] }));

  // Then startup performs no speculative detection work.
  expect(detectAgentsMock).not.toHaveBeenCalled();
});

it('skips speculative startup detection in low mode', async () => {
  // Given an enabled agent under the low profile.
  // When the daemon starts.
  await startWithProfileFile(JSON.stringify({ performanceProfile: 'low', enabledAgentIds: ['codex'] }));

  // Then startup performs no speculative detection work.
  expect(detectAgentsMock).not.toHaveBeenCalled();
});

it.each([
  { name: 'missing', contents: null },
  { name: 'invalid', contents: JSON.stringify({ performanceProfile: 'unsupported', enabledAgentIds: ['codex'] }) },
])('skips startup detection when the profile is $name', async ({ contents }) => {
  // Given a persisted profile that does not select low mode.
  // When the daemon starts.
  await startWithProfileFile(contents);

  // Then defaulting to full does not introduce speculative probes.
  expect(detectAgentsMock).not.toHaveBeenCalled();
});

it('runs explicit rescans at full fidelity in both profiles', async () => {
  // Given live daemons started under each valid profile.
  const full = await startWithProfileFile(JSON.stringify({ performanceProfile: 'full', enabledAgentIds: ['codex'] }));
  const low = await startWithProfileFile(JSON.stringify({ performanceProfile: 'low', enabledAgentIds: ['codex'] }));
  detectAgentsMock.mockClear();

  // When the user explicitly rescans under each profile.
  await writeFile(configFile, JSON.stringify({ performanceProfile: 'full', enabledAgentIds: ['codex'] }));
  const fullResponse = await fetch(`${full.url}/api/agents?refresh=1`);
  await writeFile(configFile, JSON.stringify({ performanceProfile: 'low', enabledAgentIds: ['codex'] }));
  const lowResponse = await fetch(`${low.url}/api/agents?refresh=1`);

  // Then both requests force the same fresh detection path.
  expect(fullResponse.status).toBe(200);
  expect(lowResponse.status).toBe(200);
  expect(detectAgentsMock.mock.calls.map((call) => call[1])).toEqual([
    { enabledAgentIds: ['codex'], refresh: true },
    { enabledAgentIds: ['codex'], refresh: true },
  ]);
});

it.each(['full', 'low'] as const)('initializes cold Claude streaming capabilities on demand in %s', async (profile) => {
  // Given no speculative detection and a CLI with partial streaming support.
  const started = await startWithProfileFile(JSON.stringify({ performanceProfile: profile, enabledAgentIds: ['claude'] }));
  agentCapabilities.delete('claude');
  detectAgentsMock.mockImplementation(async () => {
    agentCapabilities.set('claude', { partialMessages: true, addDir: true });
    return [];
  });
  try {
    await withFakeAgent('claude', `
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ partialMessages: process.argv.includes('--include-partial-messages') }) }] } }));
`, async () => {
      // When a caller starts chat without visiting an agent surface first.
      const response = await fetch(`${started.url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'claude', model: 'sonnet', message: 'hello' }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.text();
      // Then the real spawned CLI receives its supported streaming flag.
      expect(body).toContain('partialMessages\\\":true');
    });
  } finally {
    agentCapabilities.delete('claude');
  }
});

it('reports identical agent availability and models in both profiles', async () => {
  // Given live daemons started under each valid profile.
  const full = await startWithProfileFile(JSON.stringify({ performanceProfile: 'full', enabledAgentIds: ['codex'] }));
  const low = await startWithProfileFile(JSON.stringify({ performanceProfile: 'low', enabledAgentIds: ['codex'] }));

  // When each profile reads the agent surface explicitly.
  await writeFile(configFile, JSON.stringify({ performanceProfile: 'full', enabledAgentIds: ['codex'] }));
  const fullBody = await (await fetch(`${full.url}/api/agents`)).json();
  await writeFile(configFile, JSON.stringify({ performanceProfile: 'low', enabledAgentIds: ['codex'] }));
  const lowBody = await (await fetch(`${low.url}/api/agents`)).json();

  // Then profile choice changes timing only, not availability or model truth.
  expect(fullBody).toEqual(lowBody);
  expect(lowBody).toEqual({ agents: [expect.objectContaining({
    id: 'codex',
    available: true,
    models: [{ id: 'same-model', label: 'Same model' }],
  })] });
});
