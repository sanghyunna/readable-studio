import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandInvocation, spawnIsolatedAgent, type SpawnIsolatedAgentOptions } from '@readable-studio/platform';
import { closeHttpServer } from '../src/daemon-startup.js';
import { closeDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';
import { withFakeAgent } from './helpers/fake-agent.js';

// Memory extraction is unrelated background work and must not call paid APIs.
vi.mock('../src/memory-llm.js', () => ({ extractWithLLM: vi.fn(async () => undefined) }));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeHttpServer(server)));
  closeDatabase();
  delete process.env.READABLE_DESKTOP_APPROVAL_TOKEN;
});

const homeFailure = 'WARNING: proceeding, even though we could not create PATH aliases: failed to canonicalize CODEX_HOME "C:\\isolated\\home\\.codex": Access is denied. (os error 5)\nError: Access is denied. (os error 5)';
const success = `
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({id:message.id,result:{}});
  if (message.method === 'thread/start') send({id:message.id,result:{thread:{id:'fallback-thread'}}});
  if (message.method === 'turn/start') {
    send({id:message.id,result:{turn:{id:'fallback-turn'}}});
    send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'fallback-response'}});
    send({method:'item/completed',params:{item:{id:'answer',type:'agentMessage',text:'fallback-response'}}});
    send({method:'turn/completed',params:{turn:{status:'completed'}}});
  }
}).on('close', () => process.exit(0));`;

it.each([
  { scenario: 'real AppContainer DOS resolution fails', stderr: homeFailure, output: '', fallback: true, legacyFails: false },
  { scenario: 'helper readiness fails', stderr: 'Windows AppContainer helper did not become ready', output: '', fallback: true, legacyFails: false },
  { scenario: 'home canonicalization fails before work', stderr: homeFailure, output: '', fallback: true, legacyFails: false },
  { scenario: 'credentials fail', stderr: 'Invalid API key: 401 Unauthorized', output: '', fallback: false, legacyFails: false },
  { scenario: 'real work fails after a home warning', stderr: homeFailure, output: 'work-started', fallback: false, legacyFails: false },
  { scenario: 'legacy attempt also fails', stderr: homeFailure, output: '', fallback: true, legacyFails: true },
])('handles isolation precisely when $scenario', async ({ scenario, stderr, output, fallback, legacyFails }) => {
  // Given: real child processes with an isolated-only startup failure.
  process.env.READABLE_DESKTOP_APPROVAL_TOKEN = 'desktop-test-secret';
  const script = `
    if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
      if (process.env.READABLE_ISOLATED_TOOL_BROKER_PIPE) {
        ${output ? `console.log(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'work',delta:${JSON.stringify(output)}}}));` : ''}
        ${scenario === 'real AppContainer DOS resolution fails' ? `
          // Codex canonicalizes CODEX_HOME before doing work. Native Windows
          // measurements show DOS-volume resolution fails with error 5 even
          // when CreateFileW and VOLUME_NAME_NT succeed; ACL grants cannot fix it.
          try { require('node:fs').realpathSync.native(process.env.CODEX_HOME); }
          catch (error) {
            if (error.code !== 'EPERM' || error.syscall !== 'realpath') throw error;
            process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;
          }
        ` : `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`}
      } else { ${legacyFails ? "process.stderr.write('Invalid API key: 401 Unauthorized'); process.exitCode = 1;" : success} }
    `;
  const isolatedAgentSpawn = vi.fn(async (options: SpawnIsolatedAgentOptions) => {
    if (stderr === 'Windows AppContainer helper did not become ready') throw new Error(stderr);
    if (scenario === 'real AppContainer DOS resolution fails') {
      const node = options.env?.READABLE_NODE_BIN;
      if (!node) throw new Error('Missing isolated Node executable');
      return spawnIsolatedAgent({ ...options, command: node, args: ['-e', script] });
    }
    const invocation = createCommandInvocation({ command: options.command, args: [...(options.args ?? [])], ...(options.env ? { env: options.env } : {}) });
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd, env: options.env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  });
  await withFakeAgent('codex', script, async () => {
    const started = await startServer({
      port: 0, returnServer: true,
      isolatedAgentProbe: async () => ({ supported: true, capabilities: {
        appContainer: true, filesystemAcl: true, internetClient: true, killOnJobClose: true, loopbackDenied: true,
      } }), isolatedAgentSpawn,
    });
    if (!started || typeof started !== 'object' || !('server' in started) || !(started.server instanceof Server) || !('url' in started) || typeof started.url !== 'string') throw new Error('Missing test server');
    servers.push(started.server);
    const projectId = `fallback-${randomUUID()}`;
    const project = await fetch(`${started.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, name: 'Fallback regression' }) }).then(response => response.json());
    if (!project || typeof project !== 'object' || !('conversationId' in project) || typeof project.conversationId !== 'string') throw new Error('Missing conversation');
    // When: a user runs through the actual daemon route and terminal SSE signal.
    const run = await fetch(`${started.url}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, conversationId: project.conversationId, agentId: 'codex', model: 'gpt-5.4', message: 'Respond briefly' }) }).then(response => response.json());
    if (!run || typeof run !== 'object' || !('runId' in run) || typeof run.runId !== 'string') throw new Error('Missing run');
    const events = await fetch(`${started.url}/api/runs/${run.runId}/events`, { signal: AbortSignal.timeout(15_000) }).then(response => response.text());
    const status = await fetch(`${started.url}/api/runs/${run.runId}`).then(response => response.json());
    if (!status || typeof status !== 'object' || !('status' in status) || !('eventsLogPath' in status) || typeof status.eventsLogPath !== 'string') throw new Error('Missing run status');
    // Then: at most one downgrade, with an honest terminal status and durable event.
    const persisted = await readFile(status.eventsLogPath, 'utf8');
    expect(persisted.match(/"label":"sandbox_isolation_unavailable"/g) ?? []).toHaveLength(fallback ? 1 : 0);
    if (fallback) {
      const rollback = persisted.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.data?.label === 'sandbox_isolation_unavailable');
      expect(rollback?.data.detail).toEqual(expect.any(String));
      expect(rollback?.data.detail.length).toBeGreaterThan(0);
    }
    expect(status.status).toBe(fallback && !legacyFails ? 'succeeded' : 'failed');
    expect(isolatedAgentSpawn).toHaveBeenCalledTimes(1);
    expect(events.match(/"label":"sandbox_isolation_unavailable"/g) ?? []).toHaveLength(fallback ? 1 : 0);
    expect(events.match(/event: start\n/g) ?? []).toHaveLength(fallback ? 2 : 1);
    expect(events.match(/event: end\n/g) ?? []).toHaveLength(1);
    if (fallback && !legacyFails) expect(events).toContain('fallback-response');
    if (!fallback) expect(events).not.toContain('fallback-response');
  });
}, 30_000);
