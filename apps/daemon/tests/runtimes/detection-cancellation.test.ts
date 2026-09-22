import { createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { detectAgents, configureDetectionStorage, _resetAgentDetectionCacheForTests } from '../../src/runtimes/detection.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

const fixture = vi.hoisted(() => ({ defs: [] as RuntimeAgentDef[] }));
vi.mock('../../src/runtimes/registry.js', () => ({ AGENT_DEFS: fixture.defs, DEFAULT_ENABLED_AGENT_IDS: ['fixture'] }));
afterEach(() => { vi.useRealTimers(); _resetAgentDetectionCacheForTests(); fixture.defs.length = 0; });

async function harness(stage: 'version' | 'help' | 'auth' | 'models' | 'custom' | 'tree' = 'version') {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const sockets: Socket[] = [];
  const pids: number[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('error', (error) => { if (!('code' in error) || error.code !== 'ECONNRESET') throw error; });
    socket.on('data', (data) => pids.push(...data.toString().split(',').map(Number)));
  });
  const started = new Promise<void>((resolve) => server.once('connection', (socket) => socket.once('data', () => resolve())));
  const held = ['-e', stage === 'tree'
    ? `const child=require('node:child_process').spawn(process.execPath,['-e','process.stdin.resume()'],{stdio:'pipe'}); child.once('spawn',()=>{ const s=require('node:net').connect(${address.port},'127.0.0.1',()=>s.write([process.pid,child.pid].join(','))); });`
    : `const net=require('node:net'); const s=net.connect(${address.port},'127.0.0.1',()=>s.write(String(process.pid)));`];
  const quick = ['-e', 'console.log("verified")'];
  fixture.defs.push({ id: 'fixture', name: 'Fixture', bin: 'node',
    versionArgs: stage === 'version' || stage === 'tree' ? held : quick, versionProbeTimeoutMs: 120_000,
    helpArgs: stage === 'help' ? held : quick, capabilityFlags: { verified: 'resume' },
    authProbe: { args: stage === 'auth' ? held : quick, timeoutMs: 120_000 },
    listModels: { args: stage === 'models' ? held : quick, timeoutMs: 120_000, parse: () => [{ id: 'verified', label: 'Verified' }] },
    ...(stage === 'custom' ? { fetchModels: async () => {
      const child = spawn(process.execPath, held, { stdio: 'pipe' });
      await once(child, 'close');
      return null;
    } } : {}),
    fallbackModels: [], buildArgs: () => [], streamFormat: 'plain' });
  return { started, pids,
    onNextStart: (resolve: () => void) => server.once('connection', (socket) => socket.once('data', resolve)),
    closed: () => Promise.all(sockets.map((socket) => new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(2000);
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      socket.once('close', () => { signal.removeEventListener('abort', abort); resolve(); });
    }))),
    finish: () => sockets.forEach((socket) => socket.end()),
    async cleanup() {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; } }
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

for (const stage of ['version', 'help', 'auth', 'models', 'custom', 'tree'] as const) {
  it(`terminates the production ${stage} child when its scan is aborted`, async () => {
    // Given a real probe child reached through detectAgents, cache and safeProbe.
    const h = await harness(stage);
    const before = h.pids.length;
    const controller = new AbortController();
    const result = detectAgents({}, { signal: controller.signal });
    const settled = Promise.allSettled([result]);
    try {
      await h.started;
      const closed = h.closed();
      // When the scan owner cancels (the fixture never receives a signal).
      controller.abort();
      expect((await settled)[0]?.status).toBe('rejected');
      await closed;
      // Then the actual spawned PID is dead, not merely the consumer settled.
      const remaining = h.pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      expect(remaining).toEqual([]);
      if (stage === 'tree') process.stdout.write(`${JSON.stringify({ ownedNodeProcesses: { before, during: h.pids.length, after: remaining.length } })}\n`);
    } finally { await h.cleanup(); await settled; }
  }, 10_000);
}

it('terminates the real child when the durable scan deadline expires', async () => {
  // Given a held subprocess under the production sixty-second deadline.
  const h = await harness();
  const dir = await mkdtemp(join(tmpdir(), 'scan-cancel-'));
  configureDetectionStorage(dir);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const settled = Promise.allSettled([detectAgents()]);
  try {
    await h.started;
    const closed = h.closed();
    // When time itself crosses the configured deadline.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await settled)[0]?.status).toBe('rejected');
    await closed;
    expect(h.pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } })).toEqual([]);
  } finally { vi.useRealTimers(); await h.cleanup(); await settled; await rm(dir, { recursive: true, force: true }); }
}, 10_000);

it('preserves another owner and allows a fresh successful scan after cancellation', async () => {
  // Given separate cancellation owners requesting the same agent.
  const h = await harness();
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = Promise.allSettled([detectAgents({}, { signal: first.signal })]);
  try {
    await h.started;
    const nextStarted = new Promise<void>((resolve) => {
      const onConnection = () => resolve();
      // The second owner's distinct child is observed before releasing it.
      h.onNextStart(onConnection);
    });
    const survivor = detectAgents({}, { signal: second.signal });
    void survivor.catch(() => undefined);
    // When only the first owner cancels, the other request remains legitimate.
    first.abort();
    expect((await cancelled)[0]?.status).toBe('rejected');
    await nextStarted;
    h.finish();
    const [agent] = await survivor;
    // Then normal availability, models, auth and diagnostics remain truthful.
    expect(agent).toMatchObject({ available: true, modelsSource: 'live', authStatus: 'ok', models: [{ id: 'verified', label: 'Verified' }] });
    expect(agent?.diagnostics).toBeUndefined();
    expect(await detectAgents()).toEqual([agent]);
  } finally { await h.cleanup(); await cancelled; }
}, 10_000);

it('spawns nothing when the production scan is already aborted', async () => {
  // Given a cancelled request before discovery starts.
  const h = await harness();
  const controller = new AbortController(); controller.abort();
  try {
    // When detection is invoked, no child should connect or enter the cache.
    await expect(detectAgents({}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.pids).toEqual([]);
  } finally { await h.cleanup(); }
});
