import assert from 'node:assert/strict';
import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import type {
  HostedPiRuntimeAdapter,
  HostedPiRuntimeHandle,
} from '../src/runtimes/hosted-pi-runtime.js';

const servers: http.Server[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeHttpServer(server)));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FAKE_PI = `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let finished = false;
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (finished || request.type !== 'prompt') return;
  finished = true;
  const usage = { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } };
  for (const event of [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hosted' } },
    { type: 'turn_end', message: { usage, stopReason: 'stop' } },
    { type: 'agent_end' },
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
  setTimeout(() => process.exit(0), 10);
});
`;

async function createProject(baseUrl: string): Promise<{ projectId: string; conversationId: string }> {
  const projectId = `hosted-pi-server-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: projectId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { conversationId: string };
  return { projectId, conversationId: body.conversationId };
}

async function waitForRun(baseUrl: string, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await fetch(`${baseUrl}/api/runs/${runId}`).then((response) => response.json()) as { status: string };
    if (status.status !== 'queued' && status.status !== 'running') {
      return fetch(`${baseUrl}/api/runs/${runId}/events`).then((response) => response.text());
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('hosted Pi server run did not finish');
}

describe('hosted Pi server runtime seam', () => {
  test('spawns the injected package-local invocation instead of ambient Pi discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'readable-hosted-pi-server-'));
    temporaryRoots.push(root);
    const fakeScript = join(root, 'fake-pi.cjs');
    writeFileSync(fakeScript, FAKE_PI);
    const close = vi.fn(async () => undefined);
    let requestSeen: Parameters<HostedPiRuntimeAdapter>[0] | undefined;
    const hostedPiRuntime = vi.fn<HostedPiRuntimeAdapter>(async (request): Promise<HostedPiRuntimeHandle> => {
      requestSeen = request;
      const sessionDir = join(request.cwd, '.hosted-pi-sessions');
      mkdirSync(sessionDir, { recursive: true });
      return {
        invocation: {
          command: process.execPath,
          args: [fakeScript],
          cwd: request.cwd,
          env: { PATH: '' },
          packageRoot: root,
          entrypoint: fakeScript,
          agentDir: root,
          sessionDir,
        },
        close,
      };
    });

    const started = await startServer({
      port: 0,
      returnServer: true,
      hostedPiRuntime,
      hostedRequestBoundary: {
        testComposition: true,
        resolveIdentity: async () => ({
          userKey: 'authenticated-user',
          storageKey: 'hosted-test',
        }),
      },
    }) as {
      url: string;
      server: http.Server;
    };
    servers.push(started.server);
    const project = await createProject(started.url);
    const response = await fetch(`${started.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'pi', message: 'hosted boundary', ...project }),
    });
    assert.equal(response.status, 202);
    const { runId } = await response.json() as { runId: string };
    const events = await waitForRun(started.url, runId);

    assert.match(events, /hosted/);
    assert.equal(hostedPiRuntime.mock.calls.length, 1);
    assert.ok(requestSeen?.projectRoot === requestSeen?.cwd);
    assert.equal(requestSeen?.projectId, project.projectId);
    assert.equal(requestSeen?.userKey, 'authenticated-user');
    assert.equal(close.mock.calls.length, 1);
    const deleted = await fetch(`${started.url}/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'DELETE' });
    assert.equal(deleted.ok, true);
  }, 20_000);
});
