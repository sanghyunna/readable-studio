import express from 'express';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { registerUpdateApplyRoutes, extractUpdatePayload } from '../src/update-apply-routes.js';
import { updateDownload } from '../src/update-download.js';
import { DatabricksUpdateSource } from '../src/update-source.js';
import type { UpdateCheckResult } from '@readable-studio/contracts';

const bytes = Buffer.from('download fixture');
const update = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length,
 sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: 'https://updates.databricksapps.com', notes: '', checkedAt: new Date().toISOString() };
async function fixture(hash: string, assetSize = bytes.length, brokerFails = false, acknowledgmentNamespace?: string, currentVersion = update.current) {
 const root = await mkdtemp(join(tmpdir(), 'apply-'));
 const spawn = vi.fn((_command, _args, options) => { const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => { child.emit('spawn'); setImmediate(() => { if (brokerFails) child.emit('exit', 1); else void (async () => {
  await writeFile(join(root, 'update-journal.json'), JSON.stringify({ id: options.env?.READABLE_UPDATE_HANDOFF_ID, step: 'prepared', pid: 54321, target: update.latest }));
  await writeFile(join(root, 'update-helper-ready.json'), JSON.stringify({ id: options.env?.READABLE_UPDATE_HANDOFF_ID, pid: 54321, namespace: acknowledgmentNamespace ?? options.env?.READABLE_PACKAGED_NAMESPACE }));
 })().catch(error => child.emit('error', error)); }); }); return child; });
 const quit = vi.fn(async () => {});
 const fetcher = vi.fn(async () => new Response(bytes));
 const extract = vi.fn(async (_zip: string, staging: string) => { expect(fetcher).not.toHaveBeenCalled(); await mkdir(join(staging, 'resources'), { recursive: true }); await writeFile(join(staging, 'Readable Studio.exe'), 'payload'); await writeFile(join(staging, 'resources/readable-studio-config.json'), JSON.stringify({ appVersion: update.latest })); });
 const app = express();
 const download = updateDownload(root);
 const settled = new Promise<void>((resolve) => { const listener = () => { if (['ready', 'failed'].includes(download.status.state)) { download.off('status', listener); resolve(); } }; download.on('status', listener); });
 download.start({ ...update, sha256: hash, assetSize }, new DatabricksUpdateSource(update.releaseUrl, async () => ({ token: 'test', host: update.releaseUrl }), vi.fn(async () => new Response(bytes))));
 await settled;
 const completed = new EventEmitter();
 const post = app.post.bind(app);
 app.post = ((path: string, handler: (req: express.Request, res: express.Response) => Promise<void>) =>
  post(path, async (req, res) => { res.once('close', () => completed.emit('response-close')); try { await handler(req, res); } finally { completed.emit(`completed:${req.get('X-Test-Request')}`); completed.emit('completed'); } })) as typeof app.post;
 const config = { enabled: true, serverUrl: update.releaseUrl };
 const check = vi.fn(async (): Promise<UpdateCheckResult> => ({ ...update, sha256: hash, assetSize }));
 registerUpdateApplyRoutes(app, { root, mainPid: 12345, source: { currentVersion: async () => currentVersion, config: async () => config }, check, fetch: fetcher, extract, spawn: spawn as never, quit });
 const server = createServer(app);
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
 // Real PowerShell startup can exceed five seconds under load; stay below the test's 20-second deadline.
 return { root, spawn, quit, extract, config, check, completed, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/update/`, async request(path = 'apply') { const id = randomUUID(); const done = once(completed, `completed:${id}`, { signal: AbortSignal.timeout(15000) }); const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/update/${path}`, { method: 'POST', headers: { Connection: 'close', 'X-Test-Request': id } }); const body = await response.json(); await done; return { status: response.status, body }; }, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
describe('update apply route', () => {
 beforeEach(() => vi.stubEnv('READABLE_PACKAGED_NAMESPACE', undefined));
 afterEach(() => vi.unstubAllEnvs());
 it.each([
  { unavailable: 'no-release' },
  { ...update, latest: '1.3.5' },
  { ...update, sha256: 'b'.repeat(64) },
  { ...update, assetSize: bytes.length + 1 },
 ] satisfies UpdateCheckResult[])('discards a withdrawn or replaced staged offer before extraction: %j', async (latest) => {
  const f = await fixture(update.sha256);
  f.check.mockResolvedValue(latest);
  try {
   expect(await f.request()).toMatchObject({ status: 409, body: { error: 'release-withdrawn' } });
   expect(f.check).toHaveBeenCalledOnce();
   expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled();
   await expect(access(join(f.root, '.update-download'))).rejects.toMatchObject({ code: 'ENOENT' });
   expect(updateDownload(f.root).status).toMatchObject({ state: 'idle', version: null, received: 0, total: 0 });
  } finally { await f.close(); }
 });
 it.each(['unreachable', 'timeout'] as const)('allows the verified staged offer when the server is %s', async (unavailable) => {
  const f = await fixture(update.sha256);
  f.check.mockResolvedValue({ unavailable });
  try { expect(await f.request()).toMatchObject({ status: 202 }); expect(f.check).toHaveBeenCalledOnce(); expect(f.quit).toHaveBeenCalledOnce(); } finally { await f.close(); }
 });
 it('cancel discards a ready offer durably', async () => {
  const f = await fixture(update.sha256);
  try {
   expect(await f.request('cancel')).toMatchObject({ status: 200, body: { state: 'idle', version: null, received: 0, total: 0 } });
   expect(await updateDownload(f.root).staged()).toBeNull();
   await expect(access(join(f.root, '.update-download'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
 });
 it.each(['extract', 'metadata', 'version', 'archive'] as const)('discards failed apply preparation: %s', async (failure) => {
  const f = await fixture(update.sha256);
  if (failure === 'extract') f.extract.mockRejectedValueOnce(Object.assign(new Error('I/O'), { code: 'EIO' }));
  if (failure === 'metadata') f.extract.mockResolvedValueOnce(undefined);
  if (failure === 'archive') f.extract.mockImplementationOnce(extractUpdatePayload);
  if (failure === 'version') f.extract.mockImplementationOnce(async (_zip, staging) => {
   await mkdir(join(staging, 'resources'), { recursive: true });
   await writeFile(join(staging, 'resources/readable-studio-config.json'), JSON.stringify({ appVersion: '1.3.2' }));
  });
  try {
   const error = failure === 'extract' ? 'disk-extract-failed' : failure === 'version' ? 'version-mismatch' : 'invalid-package';
   expect(await f.request()).toMatchObject({ status: failure === 'version' ? 409 : 500, body: { error } });
   expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled();
   expect(updateDownload(f.root).status).toMatchObject({ state: 'idle', version: null, received: 0, total: 0 });
   await expect(access(join(f.root, '.update-download'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.close(); }
 });
 it('rejects a mismatched internal appVersion before launching or quitting', async () => {
  const f = await fixture(update.sha256);
  f.extract.mockImplementationOnce(async (_zip, staging) => { await mkdir(join(staging, 'resources'), { recursive: true }); await writeFile(join(staging, 'resources/readable-studio-config.json'), JSON.stringify({ appVersion: '1.3.3' })); });
  try { expect(await f.request()).toMatchObject({ status: 409, body: { error: 'version-mismatch' } }); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); await expect(access(join(f.root, 'app.staging'))).rejects.toThrow(); } finally { await f.close(); }
 });
 it('rejects a staged payload from the previous configured source', async () => {
  const f = await fixture(update.sha256);
  f.config.serverUrl = 'https://other.databricksapps.com';
  try { expect(await f.request()).toMatchObject({ status: 409, body: { error: 'source-changed' } }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('reports update-in-progress while extraction is pending', async () => {
  const f = await fixture(update.sha256);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const extracting = new Promise<void>((resolve) => { entered = resolve; });
  f.extract.mockImplementationOnce(async () => { entered(); await pending; throw new Error('stop fixture'); });
  let first: ReturnType<typeof f.request> | undefined;
  try {
   first = f.request();
   await extracting;
   expect(await f.request()).toMatchObject({ status: 409, body: { error: 'update-in-progress' } });
   expect(await f.request('cancel')).toMatchObject({ status: 409, body: { error: 'update-in-progress' } });
   release();
   expect(await first).toMatchObject({ status: 500, body: { error: 'disk-extract-failed' } });
   const staging = f.extract.mock.calls[0]![1];
   await expect(access(join(staging, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
   expect(f.quit).not.toHaveBeenCalled();
  } finally { release(); await first; await f.close(); }
 });
 it('publishes extraction file counts before apply handoff and clears them on failure', async () => {
  const f = await fixture(update.sha256);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const extracting = new Promise<void>((resolve) => { entered = resolve; });
  f.extract.mockImplementationOnce(async (...args) => {
   const progress = (args as unknown as [string, string, ((completed: number, total: number) => void)?])[2];
   progress?.(2, 4);
   entered(); await pending; throw new Error('stop fixture');
  });
  let first: ReturnType<typeof f.request> | undefined;
  const statuses: unknown[] = [];
  const onStatus = (status: unknown) => statuses.push(status);
  updateDownload(f.root).on('status', onStatus);
  try {
   first = f.request(); await extracting;
   expect(statuses).toContainEqual(expect.objectContaining({ extraction: { completed: 2, total: 4 } }));
   expect(updateDownload(f.root).status).toMatchObject({ extraction: { completed: 2, total: 4 } });
   const status = await fetch(`${f.url}status`).then((response) => response.json());
   expect(status).toMatchObject({ extraction: { completed: 2, total: 4 } });
  } finally {
   release(); await first;
   expect(updateDownload(f.root).status).not.toHaveProperty('extraction', expect.anything());
   updateDownload(f.root).off('status', onStatus);
   await f.close();
  }
 });
 it.each(['cancel', 'download', 'apply'])('releases an abandoned acknowledged apply only after helper terminalization: %s', async (operation) => {
  const f = await fixture(update.sha256);
  f.quit.mockRejectedValueOnce(new Error('shutdown IPC failed'));
  try {
   expect(await f.request()).toMatchObject({ status: 202 });
   expect(await f.request(operation)).toMatchObject({ status: 409, body: { error: 'update-in-progress' } });
   const journal = JSON.parse(await readFile(join(f.root, 'update-journal.json'), 'utf8'));
   await writeFile(join(f.root, 'update-journal.json'), JSON.stringify({ ...journal, step: 'rolled-back', done: true, pid: 0 }));
   // A terminal write alone is not enough while the helper still owns its handoff.
   expect(await f.request(operation)).toMatchObject({ status: 409, body: { error: 'update-in-progress' } });
   await rm(join(f.root, 'update-helper-ready.json'));
   expect((await f.request(operation)).status).toBe(operation === 'cancel' ? 200 : 202);
  } finally { await f.close(); }
 });
 it('recovers the apply latch after the renderer disconnects before acknowledgment', async () => {
  const f = await fixture(update.sha256);
  const extract = f.extract.getMockImplementation()!;
  let entered!: () => void;
  let release!: () => void;
  const extracting = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  f.extract.mockImplementationOnce(async (zip, staging) => { await extract(zip, staging); entered(); await resume; });
  const controller = new AbortController();
  const done = once(f.completed, 'completed', { signal: AbortSignal.timeout(5000) });
  const closed = once(f.completed, 'response-close', { signal: AbortSignal.timeout(5000) });
  const request = fetch(`${f.url}apply`, { method: 'POST', signal: controller.signal }).catch(() => null);
  try {
   await extracting;
   controller.abort();
   await request; await closed;
   release(); await done;
   expect(f.quit).not.toHaveBeenCalled();
   const journal = JSON.parse(await readFile(join(f.root, 'update-journal.json'), 'utf8'));
   await writeFile(join(f.root, 'update-journal.json'), JSON.stringify({ ...journal, step: 'rolled-back', done: true, pid: 0 }));
   await rm(join(f.root, 'update-helper-ready.json'));
   expect(await f.request('cancel')).toMatchObject({ status: 200 });
  } finally { release(); await request; await done; await f.close(); }
 });
 it('keeps the desktop running when a spawned broker fails before helper acknowledgment', async () => {
  const f = await fixture(update.sha256, bytes.length, true);
  try { expect(await f.request()).toMatchObject({ status: 500 }); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('R9-01 publishes helper failure to observers and status while preserving retryable bytes', async () => {
  const f = await fixture(update.sha256, bytes.length, true);
  const statuses: unknown[] = [];
  const download = updateDownload(f.root);
  const listener = (status: unknown) => statuses.push(status);
  download.on('status', listener);
  try {
   expect(await f.request()).toMatchObject({ status: 500, body: { error: 'helper-not-acknowledged' } });
   expect(statuses).toContainEqual(expect.objectContaining({ state: 'ready', error: 'helper-not-acknowledged', extraction: undefined }));
   // The observer missed failure SSE, and another window checked the same release.
   download.checking();
   await download.checked(update);
   expect(await fetch(`${f.url}status`).then(response => response.json())).toMatchObject({ state: 'ready', error: 'helper-not-acknowledged' });
   const reconnect = new AbortController();
   try {
    const response = await fetch(`${f.url}events`, { signal: AbortSignal.any([reconnect.signal, AbortSignal.timeout(5000)]) });
    const reader = response.body!.getReader();
    const event = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(event.value).split('\n')[0]!.slice(6))).toMatchObject({ state: 'ready', error: 'helper-not-acknowledged' });
    await reader.cancel();
   } finally { reconnect.abort(); }
   await expect(access(download.zip)).resolves.toBeUndefined();
   expect(f.quit).not.toHaveBeenCalled();
  } finally { download.off('status', listener); await f.close(); }
 });
 it('R12-01 publishes helper failure atomically with extraction removal', async () => {
  const f = await fixture(update.sha256, bytes.length, true);
  const download = updateDownload(f.root);
  const statuses: typeof download.status[] = [];
  const listener = (status: typeof download.status) => statuses.push(status);
  download.on('status', listener);
  try {
   expect(await f.request()).toMatchObject({ status: 500, body: { error: 'helper-not-acknowledged' } });
   const extracting = statuses.findIndex(status => status.extraction);
   expect(extracting).toBeGreaterThanOrEqual(0);
   const terminal = statuses.slice(extracting + 1).filter(status => !status.extraction);
   expect(terminal).toEqual([expect.objectContaining({ state: 'ready', extraction: undefined, error: 'helper-not-acknowledged' })]);
   await expect(access(join(f.root, 'app.staging'))).rejects.toMatchObject({ code: 'ENOENT' });
   expect(f.quit).not.toHaveBeenCalled();
  } finally { download.off('status', listener); await f.close(); }
 });
 it('returns a typed disk/extract failure without launching or quitting', async () => {
  const f = await fixture(update.sha256);
  f.extract.mockRejectedValueOnce(new Error('disk full'));
  try { expect(await f.request()).toMatchObject({ status: 500, body: { error: 'disk-extract-failed' } }); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('does not reapply a persistent ZIP after that version has already been installed', async () => {
  const f = await fixture(update.sha256, bytes.length, false, undefined, update.latest);
  try { expect(await f.request()).toMatchObject({ status: 409, body: { error: 'not-ready' } }); await expect(access(join(f.root, '.update-download'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('extracts only app entries through real PowerShell and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-update-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  await mkdir(stage);
  const createZip = async (bad: boolean, incomplete = false) => {
   await rm(zip, { force: true });
   const files = ['Readable Studio.exe', 'ReadableStudioData/keep.txt', 'app/resources/', 'app\\assets\\', ...(!incomplete ? ['app/Readable Studio.exe'] : []), 'app/resources/readable-studio-config.json', ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map((name) => `app/resources/update-helper/${name}`), ...(bad ? ['app/../escape.txt'] : [])];
   const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem; $a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create); try { foreach ($name in ($env:TEST_FILES | ConvertFrom-Json)) { $entry = $a.CreateEntry($name); $w = New-Object IO.StreamWriter($entry.Open()); $w.Write('fixture'); $w.Dispose() } } finally { $a.Dispose() }`;
   await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, TEST_ZIP: zip, TEST_FILES: JSON.stringify(files) }, windowsHide: true });
  };
  try {
   await createZip(false);
   const progress = vi.fn();
   await (extractUpdatePayload as (zip: string, stage: string, progress: (completed: number, total: number) => void) => Promise<void>)(zip, stage, progress);
   expect(progress).toHaveBeenLastCalledWith(5, 5, 35, 35);
   expect(await readFile(join(stage, 'Readable Studio.exe'), 'utf8')).toBe('fixture');
   if (process.platform === 'win32') await expect(readFile(join(stage, 'Readable Studio.exe:Zone.Identifier'))).rejects.toMatchObject({ code: 'ENOENT' });
   await expect(access(join(stage, 'app'))).rejects.toThrow();
   await expect(access(join(stage, 'ReadableStudioData'))).rejects.toThrow();
   await rm(stage, { recursive: true }); await mkdir(stage);
   await createZip(true);
   await expect(extractUpdatePayload(zip, stage)).rejects.toMatchObject({ message: 'invalid-package' });
   await expect(access(join(root, 'escape.txt'))).rejects.toThrow();
   await rm(stage, { recursive: true }); await mkdir(stage);
   await createZip(false, true);
   await expect(extractUpdatePayload(zip, stage)).rejects.toMatchObject({ message: 'invalid-package' });
  } finally { await rm(root, { recursive: true, force: true }); }
 // Six real Windows PowerShell startups can exceed 20 seconds on a loaded host.
 }, 60000);
 it('streams count-based extraction through the real emitter beyond percentage changes and ends at total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-progress-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  const download = updateDownload(root);
  const counts: { completed: number; total: number }[] = [];
  const onStatus = () => { if (download.status.extraction) counts.push({ ...download.status.extraction }); };
  download.on('status', onStatus);
  try {
   await mkdir(stage);
   const files = ['app/Readable Studio.exe', 'app/resources/readable-studio-config.json',
    ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map(name => `app/resources/update-helper/${name}`),
    ...Array.from({ length: 10000 }, (_, index) => `app/files/${index}.txt`)];
   const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem; $a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create); try { foreach ($name in (Get-Content -LiteralPath $env:TEST_FILES -Raw | ConvertFrom-Json)) { $entry = $a.CreateEntry($name); $w = New-Object IO.StreamWriter($entry.Open()); $w.Write('fixture'); $w.Dispose() } } finally { $a.Dispose() }`;
   const list = join(root, 'files.json');
   await writeFile(list, JSON.stringify(files));
   await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, TEST_ZIP: zip, TEST_FILES: list }, windowsHide: true });
   await extractUpdatePayload(zip, stage, (completed, total) => download.extracting({ completed, total }));
   expect(counts.at(-1)).toEqual({ completed: files.length, total: files.length });
   const percentages = counts.map(({ completed, total }) => Math.floor(100 * completed / total));
   expect(percentages.some((percent, index) => {
    const previous = counts[index - 1];
    return previous !== undefined && previous.completed > 0 && percent === percentages[index - 1];
   })).toBe(true);
   expect(counts.length).toBeGreaterThan(102);
  } finally {
   download.off('status', onStatus);
   await rm(root, { recursive: true, force: true });
  }
 }, 60000);
 it('refuses checksum mismatch before extraction, launch or quit', async () => {
  const f = await fixture('a'.repeat(64));
  try { expect(await f.request()).toMatchObject({ status: 409, body: { error: 'not-ready' } }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it.each([{ assetSize: bytes.length - 1, status: 409 }, { assetSize: bytes.length + 1, status: 409 }])('refuses incorrect asset size $assetSize before extraction, launch or quit', async ({ assetSize, status }) => {
  const f = await fixture(update.sha256, assetSize);
  try { expect(await f.request()).toMatchObject({ status }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('keeps the desktop running if the helper acknowledges a different namespace', async () => {
  vi.stubEnv('READABLE_PACKAGED_NAMESPACE', 'probe-fix');
  const f = await fixture(update.sha256, bytes.length, false, 'rg');
  try { expect(await f.request()).toMatchObject({ status: 500 }); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it.each([undefined, 'rg', 'probe-fix'])('streams verified asset and passes the explicit namespace %s to the broker', async (namespace) => {
  vi.stubEnv('READABLE_PACKAGED_NAMESPACE', namespace);
  const f = await fixture(update.sha256);
  try { expect(await f.request()).toMatchObject({ status: 202, body: { status: 'applying', targetVersion: '1.3.4' } });
   expect(f.spawn).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(f.root, 'app', 'resources', 'update-helper', 'update-broker.ps1'), '-Root', f.root, '-Staging', join(f.root, 'app.staging'), '-TargetVersion', '1.3.4', '-WaitPid', '12345', '-Namespace', namespace ?? 'rg'], expect.objectContaining({ windowsHide: true, stdio: 'ignore', cwd: f.root, env: expect.objectContaining({ READABLE_PACKAGED_NAMESPACE: namespace ?? 'rg' }) }));
   expect(f.spawn.mock.calls[0]?.[2]?.detached).not.toBe(true);
   expect(f.quit).toHaveBeenCalledOnce();
  } finally { await f.close(); }
 });
});
