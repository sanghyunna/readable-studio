import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabricksUpdateSource } from '../src/update-source.js';
import { waitForUpdateHelper } from '../src/update-handoff.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('accepts an update server health response taking one minute', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const source = new DatabricksUpdateSource('https://updates.example', async () => ({ token: 'fixture', host: 'https://workspace.example' }),
    async (_url, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      setTimeout(() => resolve(Response.json({ ok: true, service: 'readable-studio-update-server', apiVersion: 1 })), 60_000);
    }));
  const health = source.health().then(() => 'ready', error => error);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await health).toBe('ready');
});

it('accepts a helper ready receipt after a ninety-second cold start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-vdi-'));
  const broker = new EventEmitter() as ChildProcess;
  vi.useFakeTimers();
  const ready = waitForUpdateHelper(root, 'fixture-id', broker, 'fixture-namespace').catch(error => error);
  try {
    await vi.advanceTimersByTimeAsync(90_000);
    await writeFile(join(root, 'update-helper-ready.json'), JSON.stringify({ id: 'fixture-id', pid: 12345, namespace: 'fixture-namespace' }));
    expect(await ready).toBe(12345);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    broker.emit('exit', 1);
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
