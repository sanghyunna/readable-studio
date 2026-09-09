import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  file: '',
  events: [] as string[],
  opened: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
  failRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (args[0] !== io.file) return actual.readFile(...args);
      io.events.push('read-start');
      // Preserve a real Windows handle. Only its release is controlled, rather
      // than fabricating EPERM or guessing how long a filesystem read takes.
      const handle = await actual.open(io.file, 'r');
      const release = io.release;
      io.release = undefined;
      try {
        io.opened?.();
        await release;
        return await handle.readFile(args[1]);
      } finally {
        await handle.close();
        io.events.push('read-close');
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === io.file) {
        io.events.push('rename');
        if (io.failRename) {
          io.failRename = false;
          throw Object.assign(new Error('external handle prevents replacement'), { code: 'EPERM' });
        }
      }
      return actual.rename(...args);
    },
  };
});

import { readAppConfig, writeAppConfig } from '../src/app-config.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'readable-config-lifecycle-'));
  await writeAppConfig(dir, { agentId: 'codex' });
  io.file = path.join(dir, 'app-config.json');
  io.events = [];
});
afterEach(async () => {
  io.file = '';
  io.opened = undefined;
  io.release = undefined;
  io.failRename = false;
  await rm(dir, { recursive: true, force: true });
});

it('closes the active reader before a queued replacement, then serves the new config', async () => {
  const opened = signal();
  const release = signal();
  io.opened = opened.resolve;
  io.release = release.promise;
  const before = readAppConfig(dir);
  await opened.promise;
  // Submit both operations while the exact read handle is still open. The
  // later reader must not jump the queued writer or read the pre-write file.
  const write = writeAppConfig(dir, { agentId: 'claude' });
  const after = readAppConfig(dir);
  release.resolve();
  const [oldConfig, written, newConfig] = await Promise.all([before, write, after]);
  expect(oldConfig.agentId).toBe('codex');
  expect(written.agentId).toBe('claude');
  expect(newConfig.agentId).toBe('claude');
  expect(io.events).toEqual([
    'read-start', 'read-close',
    'read-start', 'read-close', 'rename',
    'read-start', 'read-close',
  ]);
});

it('does not block a different data directory behind an open reader', async () => {
  const opened = signal();
  const release = signal();
  io.opened = opened.resolve;
  io.release = release.promise;
  const read = readAppConfig(dir);
  await opened.promise;
  try {
    const other = await writeAppConfig(path.join(dir, 'other'), { agentId: 'claude' });
    expect(other.agentId).toBe('claude');
    expect(io.events).toEqual(['read-start']);
  } finally {
    release.resolve();
    await read;
  }
});

it('propagates replacement failures without poisoning the next queued operation', async () => {
  io.failRename = true;
  const failed = writeAppConfig(dir, { agentId: 'claude' });
  const rejection = expect(failed).rejects.toMatchObject({ code: 'EPERM' });
  const next = writeAppConfig(dir, { skillId: 'coder' });
  await rejection;
  expect(await next).toMatchObject({ agentId: 'codex', skillId: 'coder' });
  expect(await readAppConfig(dir)).toMatchObject({ agentId: 'codex', skillId: 'coder' });
});
