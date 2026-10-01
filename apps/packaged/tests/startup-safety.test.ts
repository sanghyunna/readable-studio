import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));
import { handleReadableStudioRequest } from '../src/protocol.js';
import { acquireDataLock, PackagedDataLockError } from '../src/data-lock.js';
import { detectOneDriveLocation, createStartupNoticeState } from '../src/onedrive.js';

const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'launch-safety-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const metadata = { pid: process.pid, appVersion: '1.2.1', exePath: process.execPath, startedAt: '2026-10-01T00:00:00.000Z' };
describe('data lock', () => {
  it('serializes concurrent stale recovery, recovers a killed owner, and releases on real exit', async () => {
    const dir = root();
    writeFileSync(join(dir, 'data.lock'), JSON.stringify({ ...metadata, pid: 2147483647 }));
    const moduleUrl = new URL('../src/data-lock.ts', import.meta.url).href;
    const script = `import { acquireDataLock, PackagedDataLockError } from ${JSON.stringify(moduleUrl)};
      process.on('message', (message) => {
        if (message === 'acquire') {
          try { acquireDataLock(${JSON.stringify(dir)}, { pid: process.pid, appVersion: 'child', exePath: process.execPath, startedAt: new Date().toISOString() }); process.send('acquired'); }
          catch (error) { if (error instanceof PackagedDataLockError) process.send('refused'); else { console.error(error); process.exit(2); } }
        } else if (message === 'quit') process.exit(0);
      }); process.send('ready');`;
    const children = Array.from({ length: 3 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
    const errors = children.map(() => '');
    children.forEach((child, index) => { child.stderr!.on('data', (chunk: Buffer) => { errors[index] += chunk.toString(); }); });
    const exits = children.map((child) => once(child, 'exit', { signal: AbortSignal.timeout(15000) }));
    const ready = children.map((child, index) => Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15000) }),
      exits[index]!.then(() => { throw new Error(`Lock worker exited before ready: ${errors[index]}`); }),
    ]));
    try {
      await Promise.all(ready);
      const results = children.map((child) => once(child, 'message', { signal: AbortSignal.timeout(15000) }));
      for (const child of children) child.send('acquire');
      const outcomes = (await Promise.all(results)).map(([message]) => message);
      expect(outcomes.filter((message) => message === 'acquired')).toHaveLength(1);
      expect(outcomes.filter((message) => message === 'refused')).toHaveLength(2);
      const winner = outcomes.indexOf('acquired');
      children[winner]!.kill(); await exits[winner];
      const lock = acquireDataLock(dir, metadata); lock.release();
      expect(existsSync(join(dir, 'data.lock'))).toBe(false);
      const survivor = children.findIndex((_, index) => index !== winner);
      const acquired = once(children[survivor]!, 'message', { signal: AbortSignal.timeout(15000) });
      children[survivor]!.send('acquire'); expect((await acquired)[0]).toBe('acquired');
      children[survivor]!.send('quit'); await exits[survivor];
      expect(existsSync(join(dir, 'data.lock'))).toBe(false);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(exits);
    }
  }, 20000);
  it('acquires and publishes complete updater-readable metadata', () => {
    const dir = root(); const lock = acquireDataLock(dir, metadata);
    expect(JSON.parse(readFileSync(join(dir, 'data.lock'), 'utf8'))).toEqual(metadata);
    lock.release();
  });
  it('refuses an alive pid and identifies the running version', () => {
    const dir = root(); const lock = acquireDataLock(dir, metadata);
    expect(() => acquireDataLock(dir, { ...metadata, appVersion: '2.0.0' })).toThrow(PackagedDataLockError);
    try { acquireDataLock(dir, metadata); } catch (error) { expect((error as Error).message).toContain('1.2.1'); }
    expect(JSON.parse(readFileSync(join(dir, 'data.lock'), 'utf8'))).toEqual(metadata);
    lock.release();
  });
  it('replaces a dead owner after a crash', () => {
    const dir = root(); writeFileSync(join(dir, 'data.lock'), JSON.stringify({ ...metadata, pid: 2147483647 }));
    const lock = acquireDataLock(dir, metadata);
    expect(JSON.parse(readFileSync(join(dir, 'data.lock'), 'utf8')).pid).toBe(process.pid);
    lock.release();
  });
  it('recovers truncated crash metadata', () => {
    const dir = root(); writeFileSync(join(dir, 'data.lock'), '{');
    const lock = acquireDataLock(dir, metadata); lock.release();
    expect(existsSync(join(dir, 'data.lock'))).toBe(false);
  });
  it('releases on normal process exit and release is idempotent', () => {
    const dir = root(); const lifecycle = new EventEmitter();
    const lock = acquireDataLock(dir, metadata, lifecycle);
    lifecycle.emit('exit'); lock.release();
    expect(existsSync(join(dir, 'data.lock'))).toBe(false);
  });
});
describe('OneDrive detection and persisted notice', () => {
  it('serves startup state without proxying and persists a same-origin dismissal', async () => {
    const state = createStartupNoticeState(root(), { source: 'known-folder', root: 'C:\\Cloud' });
    const upstream = vi.fn<typeof fetch>();
    const endpoint = 'readable-studio://app/__packaged/startup-state';
    expect(await (await handleReadableStudioRequest(new Request(endpoint), 'http://localhost:1', upstream, state)).json()).toEqual({ oneDriveNotice: true });
    expect((await handleReadableStudioRequest(new Request(endpoint, { method: 'POST', headers: { origin: 'https://untrusted.test' } }), 'http://localhost:1', upstream, state)).status).toBe(403);
    expect(state.snapshot().oneDriveNotice).toBe(true);
    expect((await handleReadableStudioRequest(new Request(endpoint, { method: 'POST', headers: { origin: 'readable-studio://app' } }), 'http://localhost:1', upstream, state)).status).toBe(200);
    expect(state.snapshot().oneDriveNotice).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'])('uses %s with case-insensitive path boundaries', (key) => {
    expect(detectOneDriveLocation('c:\\sync\\studio\\Readable.exe', { [key]: 'C:\\Sync' }, null)?.source).toBe(key);
    expect(detectOneDriveLocation('C:\\Sync-other\\Readable.exe', { [key]: 'C:\\Sync' }, null)).toBeNull();
  });
  it('uses the Windows known-folder path even without environment variables', () => {
    expect(detectOneDriveLocation('C:\\Cloud\\Studio\\Readable.exe', {}, 'C:\\Cloud')?.source).toBe('known-folder');
    expect(detectOneDriveLocation('C:\\OneDrive\\Readable.exe', {}, null)).toBeNull();
  });
  it('remembers dismissal per data root, not per executable or browser profile', async () => {
    const dir = root(); const state = createStartupNoticeState(dir, { source: 'OneDrive', root: 'C:\\Cloud' });
    expect(state.snapshot().oneDriveNotice).toBe(true);
    await state.dismiss();
    expect(createStartupNoticeState(dir, { source: 'OneDrive', root: 'C:\\Cloud' }).snapshot().oneDriveNotice).toBe(false);
    expect(createStartupNoticeState(root(), { source: 'OneDrive', root: 'C:\\Cloud' }).snapshot().oneDriveNotice).toBe(true);
  });
});
