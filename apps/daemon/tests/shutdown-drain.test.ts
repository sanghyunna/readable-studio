import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestJsonIpc, resolveAppIpcPath } from '@readable-studio/sidecar';
import { APP_KEYS, SIDECAR_CONTRACT, SIDECAR_MESSAGES, SIDECAR_MODES, SIDECAR_SOURCES } from '@readable-studio/sidecar-proto';
import { expect, it, vi } from 'vitest';

const drain = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../src/runtimes/probe-lifetime.js', async original => ({
  ...await original<typeof import('../src/runtimes/probe-lifetime.js')>(), shutdownProbes: drain,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('concurrent daemon shutdown callers join the in-flight probe drain', async () => {
  const gate = deferred();
  const entered = deferred();
  drain.mockImplementation(() => { entered.resolve(); return gate.promise; });
  const { startServer } = await import('../src/server.js');
  const started = await startServer({ port: 0, returnServer: true }) as { server: Server; shutdown(): Promise<void> };
  let joined = false;
  const first = started.shutdown();
  await entered.promise;
  const second = started.shutdown().then(() => { joined = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(joined).toBe(false);
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
    await new Promise<void>((resolve, reject) => started.server.close(error => error ? reject(error) : resolve()));
  }
  expect(drain).toHaveBeenCalledTimes(1);
});

it('real sidecar IPC shutdown invokes and waits for the server probe drain', async () => {
  drain.mockReset();
  const gate = deferred();
  const entered = deferred();
  const exited = deferred();
  drain.mockImplementation(() => { entered.resolve(); return gate.promise; });
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => { exited.resolve(); }) as typeof process.exit);
  const beforeInt = process.listeners('SIGINT');
  const beforeTerm = process.listeners('SIGTERM');
  const namespace = `shutdown-${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), 'readable-shutdown-'));
  const ipc = resolveAppIpcPath({ app: APP_KEYS.DAEMON, contract: SIDECAR_CONTRACT, namespace });
  const { startDaemonSidecar } = await import('../src/sidecar/server.js');
  const handle = await startDaemonSidecar({ app: APP_KEYS.DAEMON, base: root, ipc, namespace, mode: SIDECAR_MODES.RUNTIME, source: SIDECAR_SOURCES.PACKAGED });
  try {
    const response = await requestJsonIpc(ipc, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1000 });
    expect(response).toEqual({ accepted: true });
    await entered.promise;
    expect(exit).not.toHaveBeenCalled();
    gate.resolve();
    await exited.promise;
    await handle.waitUntilStopped();
    expect(drain).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await handle.stop();
    exit.mockRestore();
    for (const listener of process.listeners('SIGINT')) if (!beforeInt.includes(listener)) process.off('SIGINT', listener);
    for (const listener of process.listeners('SIGTERM')) if (!beforeTerm.includes(listener)) process.off('SIGTERM', listener);
    await rm(root, { recursive: true, force: true });
  }
});
