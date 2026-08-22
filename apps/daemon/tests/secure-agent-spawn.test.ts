import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommandInvocation } from '@readable-studio/platform';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

const TOKEN_ENV = 'READABLE_DESKTOP_APPROVAL_TOKEN';
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeHttpServer(server)));
  closeDatabase();
  delete process.env[TOKEN_ENV];
});

const fakeQwen = `
if (process.argv.includes('--version')) { console.log('qwen 1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  process.stdout.write('CAPABILITY:' + (prompt.includes('<readable-rollback-request') ? 'yes' : 'no') + '\\n');
  process.stdout.write('<readable-rollback-request mode="files_only" reason="undo the edit" />\\n');
});
`;

const fakeCodex = `
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const text = 'CAPABILITY:' + (prompt.includes('<readable-rollback-request') ? 'yes' : 'no') + '\\n' +
    '<readable-rollback-request mode="files_only" reason="undo the edit" />';
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }));
});
`;

async function createProject(baseUrl: string): Promise<{ conversationId: string; projectId: string }> {
  const projectId = `secure-spawn-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'Secure spawn test' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { conversationId: string };
  return { conversationId: body.conversationId, projectId };
}

async function runAgent(
  baseUrl: string,
  project: { conversationId: string; projectId: string },
  agentId = 'codex',
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, message: 'edit then self-correct', ...project }),
  });
  expect(response.status).toBe(202);
  const { runId } = await response.json() as { runId: string };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await fetch(`${baseUrl}/api/runs/${runId}`).then((item) => item.json()) as { status: string };
    if (!['queued', 'running'].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await fetch(`${baseUrl}/api/runs/${runId}/events`).then((item) => item.text());
}

describe('secure rollback agent spawn selection', () => {
  it('selects the isolated spawn, strips privileged env, and keeps tool wrappers brokered', async () => {
    process.env[TOKEN_ENV] = 'desktop-secret';
    const spawnCalls: any[] = [];
    const isolatedAgentSpawn = vi.fn(async (options: any) => {
      spawnCalls.push(options);
      const invocation = createCommandInvocation({ command: options.command, args: options.args, env: options.env });
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }) as ChildProcessWithoutNullStreams;
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      return child;
    });

    await withFakeAgent('codex', fakeCodex, async () => {
      const started = await startServer({
        port: 0,
        returnServer: true,
        isolatedAgentProbe: async () => ({
          supported: true,
          capabilities: {
            appContainer: true,
            filesystemAcl: true,
            internetClient: true,
            killOnJobClose: true,
            loopbackDenied: true,
          },
        }),
        isolatedAgentSpawn,
      }) as { url: string; server: http.Server };
      servers.push(started.server);
      const events = await runAgent(started.url, await createProject(started.url));

      expect(events).toContain('CAPABILITY:yes');
      expect(events).toContain('"type":"rollback_request"');
      expect(events).not.toContain('readable-rollback-request mode');
      expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
      const options = spawnCalls[0];
      const envKeys = Object.keys(options.env).map((key) => key.toUpperCase());
      for (const key of [
        'READABLE_DAEMON_URL',
        'READABLE_DATA_DIR',
        'READABLE_DESKTOP_APPROVAL_TOKEN',
        'READABLE_SIDECAR_IPC_PATH',
        'READABLE_TOOL_TOKEN',
      ]) expect(envKeys).not.toContain(key);
      expect(options.env.READABLE_BIN).toMatch(/readable-tool-broker-client\.mjs$/);
      expect(options.env.HOME).toContain('readable-studio-isolated-agents');
      expect(options.writablePaths).toContain(options.cwd);
      expect(options.readExecutePaths.some((candidate: string) => candidate.includes('readable-fake-agent-'))).toBe(true);
    });
  }, 20_000);

  it('uses the legacy spawn and omits the capability when isolation is unavailable', async () => {
    process.env[TOKEN_ENV] = 'desktop-secret';
    const isolatedAgentSpawn = vi.fn();
    await withFakeAgent('codex', fakeCodex, async () => {
      const started = await startServer({
        port: 0,
        returnServer: true,
        isolatedAgentProbe: async () => ({ supported: false, reason: 'helper missing' }),
        isolatedAgentSpawn,
      }) as { url: string; server: http.Server };
      servers.push(started.server);
      const events = await runAgent(started.url, await createProject(started.url));

      expect(events).toContain('CAPABILITY:no');
      expect(events).toContain('readable-rollback-request');
      expect(events).not.toContain('"type":"rollback_request"');
      expect(isolatedAgentSpawn).not.toHaveBeenCalled();
    });
  }, 20_000);

  it('keeps Node-based adapters on the legacy spawn even when AppContainer itself probes green', async () => {
    process.env[TOKEN_ENV] = 'desktop-secret';
    const isolatedAgentSpawn = vi.fn();
    await withFakeAgent('qwen', fakeQwen, async () => {
      const started = await startServer({
        port: 0,
        returnServer: true,
        isolatedAgentProbe: async () => ({
          supported: true,
          capabilities: {
            appContainer: true,
            filesystemAcl: true,
            internetClient: true,
            killOnJobClose: true,
            loopbackDenied: true,
          },
        }),
        isolatedAgentSpawn,
      }) as { url: string; server: http.Server };
      servers.push(started.server);
      const events = await runAgent(started.url, await createProject(started.url), 'qwen');
      expect(events).toContain('CAPABILITY:no');
      expect(events).toContain('readable-rollback-request');
      expect(events).not.toContain('"type":"rollback_request"');
      expect(isolatedAgentSpawn).not.toHaveBeenCalled();
    });
  }, 20_000);
});
