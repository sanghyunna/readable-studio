import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ExecFileException, type ExecFileOptions, type ExecFileSyncOptions } from 'node:child_process';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Counts every PowerShell launch by the lock and OneDrive modules; `failOneDrive`
// points the OneDrive lookup (the call without the lock's mutex variable) at a
// missing executable so both the sync and async paths take their real error path.
const spawns = vi.hoisted(() => ({ sync: 0, async: 0, inFlight: 0, peak: 0, failOneDrive: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const target = (file: string, options?: { env?: NodeJS.ProcessEnv }) =>
    spawns.failOneDrive && !options?.env?.READABLE_LOCK_MUTEX ? 'readable-missing-powershell.exe' : file;
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], options: ExecFileSyncOptions) => {
      spawns.sync++;
      return actual.execFileSync(target(file, options), args, options);
    },
    execFile: (file: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' }, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => {
      spawns.async++; spawns.peak = Math.max(spawns.peak, ++spawns.inFlight);
      return actual.execFile(target(file, options), args, options, (error, stdout, stderr) => { spawns.inFlight--; callback(error, stdout, stderr); });
    },
  };
});
import * as dataLock from '../src/data-lock.js';
import * as oneDrive from '../src/onedrive.js';
const { acquireDataLock, PackagedDataLockError } = dataLock;

const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'startup-powershell-')); roots.push(dir); return dir; }
afterEach(async () => {
  await vi.waitFor(() => expect(spawns.inFlight).toBe(0), { timeout: 15000 });
  Object.assign(spawns, { sync: 0, async: 0, peak: 0, failOneDrive: false });
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const metadata = { pid: process.pid, appVersion: '1.2.1', exePath: process.execPath, startedAt: '2026-10-01T00:00:00.000Z' };
const exePath = 'C:\\ReadableStudioTest\\Readable Studio.exe';
const lockMessage = (version: string) => `Readable Studio ${version} 버전이 이 데이터 폴더를 사용 중입니다. 실행 중인 앱을 종료한 뒤 다시 시작해 주세요. (PID: ${process.pid})`;
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('.data-lock-'));

// Execute the entry's actual lock + OneDrive section; replace only its dependencies.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const sectionStart = '  await ensurePackagedNamespacePaths(paths);\n';
const section = source.slice(source.indexOf(sectionStart) + sectionStart.length, source.indexOf('  const existingDesktop ='));
const noCalls = () => ({ once: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], notices: [] as unknown[][] });
// Pass `calls` to inspect side effects when the section rejects.
async function runSection(dir: string, env: NodeJS.ProcessEnv = {}, overrides: Record<string, unknown> = {}, calls = noCalls()) {
  const context = vm.createContext({
    paths: { dataRoot: dir }, activeConfig: { appVersion: '1.3.8' }, process: { pid: process.pid, execPath: exePath, env },
    app: { once: (...args: unknown[]) => calls.once.push(args) },
    console: { info: (...args: unknown[]) => calls.info.push(args), warn: (...args: unknown[]) => calls.warn.push(args) },
    ...dataLock, ...oneDrive,
    createStartupNoticeState: (...args: Parameters<typeof oneDrive.createStartupNoticeState>) => { calls.notices.push(args); return oneDrive.createStartupNoticeState(...args); },
    ...overrides,
  });
  const result = await vm.runInContext(`(async () => { ${section}\n return { dataLock, oneDrive, startupNotice }; })()`, context) as {
    dataLock: { release(): void }; oneDrive: unknown; startupNotice: { snapshot(): { oneDriveNotice: boolean } };
  };
  return { calls, result };
}

describe('pre-window data lock and OneDrive lookup', () => {
  it('publishes the lock, registers its release on quit, and builds the notice state', async () => {
    const dir = root(); const before = Date.now();
    const { calls, result } = await runSection(dir);
    const text = readFileSync(join(dir, 'data.lock'), 'utf8');
    const startedAt = (JSON.parse(text) as { startedAt: string }).startedAt;
    expect(text).toBe(JSON.stringify({ pid: process.pid, appVersion: '1.3.8', exePath, startedAt }));
    expect(new Date(startedAt).toISOString()).toBe(startedAt);
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(calls.once).toEqual([['quit', result.dataLock.release]]);
    expect(result.oneDrive).toBeNull();
    expect(calls).toMatchObject({ info: [], warn: [], notices: [[dir, null]] });
    expect(result.startupNotice.snapshot()).toEqual({ oneDriveNotice: false });
    expect(leftovers(dir)).toEqual([]);
    result.dataLock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('logs an environment OneDrive match without the known-folder lookup', async () => {
    const dir = root();
    const { calls, result } = await runSection(dir, { OneDrive: 'C:\\ReadableStudioTest' });
    expect(result.oneDrive).toEqual({ source: 'OneDrive', root: 'C:\\ReadableStudioTest' });
    expect(calls).toMatchObject({ info: [['OneDrive startup detection: source=OneDrive root=C:\\ReadableStudioTest']], warn: [], notices: [[dir, result.oneDrive]] });
    expect(result.startupNotice.snapshot()).toEqual({ oneDriveNotice: true });
    expect(spawns.sync + spawns.async).toBe(1);
    result.dataLock.release();
  });

  it('warns and continues when the known-folder lookup fails', async () => {
    const dir = root(); spawns.failOneDrive = true;
    const { calls, result } = await runSection(dir);
    expect(result.oneDrive).toBeNull();
    expect(calls.warn).toHaveLength(1);
    const [message, error] = calls.warn[0]!;
    expect(message).toBe('OneDrive known-folder detection failed; startup will continue');
    expect(error).toBeInstanceOf(oneDrive.OneDriveDetectionError);
    expect((error as Error).message).toBe('Could not read the OneDrive known-folder registration');
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(calls).toMatchObject({ info: [], notices: [[dir, null]] });
    expect(calls.once).toEqual([['quit', result.dataLock.release]]);
    result.dataLock.release();
  });

  it('refuses a second instance before any notice, log, or quit hook', async () => {
    const dir = root(); const holder = acquireDataLock(dir, { ...metadata, appVersion: '1.3.7' });
    const held = readFileSync(join(dir, 'data.lock'), 'utf8'); const calls = noCalls();
    const outcome = await runSection(dir, {}, {}, calls).then(() => null, (error: unknown) => error);
    expect(calls).toEqual(noCalls());
    expect(outcome).toBeInstanceOf(PackagedDataLockError);
    expect(outcome).toMatchObject({ title: 'Readable Studio가 이미 실행 중입니다', message: lockMessage('1.3.7'), owner: { ...metadata, appVersion: '1.3.7' } });
    expect(readFileSync(join(dir, 'data.lock'), 'utf8')).toBe(held);
    expect(leftovers(dir)).toEqual([]);
    holder.release();
  });

  it('never leaves a known-folder failure unhandled when the lock is refused', async () => {
    const lockError = new PackagedDataLockError({ pid: 1, appVersion: '1.3.8' });
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled); const calls = noCalls();
    try {
      const outcome = await runSection(root(), {}, {
        acquireDataLock: () => { throw lockError; },
        acquireDataLockAsync: () => new Promise((_, reject) => setTimeout(() => reject(lockError), 30)),
        readOneDriveKnownFolder: () => Promise.reject(new oneDrive.OneDriveDetectionError(new Error('registry'))),
      }, calls).then(() => null, (error: unknown) => error);
      expect(outcome).toBe(lockError);
      await new Promise((done) => setTimeout(done, 50));
      expect(unhandled).not.toHaveBeenCalled();
      expect(calls).toEqual(noCalls());
    } finally { process.off('unhandledRejection', unhandled); }
  });

  // Cost counter: both lookups used to be execFileSync calls that blocked the
  // Electron main thread back to back before any window could exist.
  it('runs both PowerShell lookups off the main thread and concurrently', async () => {
    const { result } = await runSection(root());
    expect({ sync: spawns.sync, async: spawns.async, peak: spawns.peak }).toEqual({ sync: 0, async: 2, peak: 2 });
    result.dataLock.release();
  });
});

type Acquire = (dir: string, owner: typeof metadata, lifecycle?: NodeJS.EventEmitter) => Promise<{ release(): void }>;
const variants: [string, Acquire][] = [
  ['sync', async (dir, owner, lifecycle) => acquireDataLock(dir, owner, lifecycle)],
  ['async', (dir, owner, lifecycle) => dataLock.acquireDataLockAsync(dir, owner, lifecycle)],
];
const acquireBy = Object.fromEntries(variants);
describe.each(variants)('%s data lock', (_, acquire) => {
  it('publishes the exact metadata, refuses a live owner, and releases idempotently', async () => {
    const dir = root(); const lifecycle = new EventEmitter();
    const lock = await acquire(dir, metadata, lifecycle);
    expect(readFileSync(join(dir, 'data.lock'), 'utf8')).toBe(JSON.stringify(metadata));
    const refused = await acquire(dir, { ...metadata, appVersion: '2.0.0' }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(PackagedDataLockError);
    expect(refused).toMatchObject({ message: lockMessage('1.2.1'), owner: metadata });
    expect(readFileSync(join(dir, 'data.lock'), 'utf8')).toBe(JSON.stringify(metadata));
    expect(leftovers(dir)).toEqual([]);
    lifecycle.emit('exit'); lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['{', '', JSON.stringify({ ...metadata, pid: 2147483647 })])('recovers crash metadata %j', async (stale) => {
    const dir = root(); writeFileSync(join(dir, 'data.lock'), stale);
    const lock = await acquire(dir, metadata);
    expect(readFileSync(join(dir, 'data.lock'), 'utf8')).toBe(JSON.stringify(metadata));
    lock.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('waits for the recovery mutex held by a closing instance, then acquires', async () => {
    const dir = root();
    const mutex = 'Global\\ReadableStudioData-' + createHash('sha256').update(resolve(join(dir, 'data.lock')).toLowerCase()).digest('hex');
    const holder = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$m = [System.Threading.Mutex]::new($false, $env:HOLD_MUTEX); [void]$m.WaitOne(); [Console]::Out.Write("held"); Start-Sleep -Milliseconds 1500; $m.ReleaseMutex()'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, HOLD_MUTEX: mutex } });
    try {
      await once(holder.stdout!, 'data');
      const started = Date.now();
      const lock = await acquire(dir, metadata);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(readFileSync(join(dir, 'data.lock'), 'utf8')).toBe(JSON.stringify(metadata));
      lock.release();
    } finally { if (holder.exitCode === null) holder.kill(); }
  }, 20000);
});

describe('sync and async data locks exclude each other', () => {
  const holderScript = (dir: string, fn: string) => `import * as lock from ${JSON.stringify(new URL('../src/data-lock.ts', import.meta.url).href)};
    try { await lock.${fn}(${JSON.stringify(dir)}, { pid: process.pid, appVersion: 'other', exePath: process.execPath, startedAt: new Date().toISOString() }); process.send('acquired'); }
    catch (error) { process.send(error.name); }
    process.on('message', () => process.exit(0));`;
  async function hold(dir: string, fn: string) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', holderScript(dir, fn)], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(15000) }) as [string];
    return { child, message, async close() { const exited = once(child, 'exit'); child.send('quit'); await exited; } };
  }
  it.each([['acquireDataLock', 'async'], ['acquireDataLockAsync', 'sync']] as const)('%s holder refuses the %s variant', async (fn, variant) => {
    const dir = root(); const holder = await hold(dir, fn);
    try {
      expect(holder.message).toBe('acquired');
      const refused = await acquireBy[variant]!(dir, metadata).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(PackagedDataLockError);
      expect(refused).toMatchObject({ owner: { pid: holder.child.pid, appVersion: 'other' } });
    } finally { await holder.close(); }
    const lock = await acquireBy[variant]!(dir, metadata);
    lock.release();
  }, 20000);
  it.each([['async', 'acquireDataLock'], ['sync', 'acquireDataLockAsync']] as const)('%s holder refuses %s in another process', async (variant, fn) => {
    const dir = root(); const lock = await acquireBy[variant]!(dir, metadata);
    try {
      const other = await hold(dir, fn);
      expect(other.message).toBe('PackagedDataLockError');
      await other.close();
    } finally { lock.release(); }
  }, 20000);
});
