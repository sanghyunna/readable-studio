import express from 'express';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { registerUpdateApplyRoutes, extractUpdatePayload } from '../src/update-apply-routes.js';

const bytes = Buffer.from('download fixture');
const update = { current: '1.2.1', latest: '1.3.0', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length,
 sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: 'https://github.com/sanghyunna/readable-studio/releases/tag/v1.3.0', notes: '', checkedAt: new Date().toISOString() };
async function fixture(hash: string, assetSize = bytes.length) {
 const root = await mkdtemp(join(tmpdir(), 'apply-'));
 const spawn = vi.fn(() => { const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); queueMicrotask(() => child.emit('spawn')); return child; });
 const quit = vi.fn(async () => {});
 const extract = vi.fn(async (_zip: string, staging: string) => { await mkdir(staging, { recursive: true }); await writeFile(join(staging, 'Readable Studio.exe'), 'payload'); });
 const app = express();
 const completed = new EventEmitter();
 const post = app.post.bind(app);
 app.post = ((path: string, handler: (req: express.Request, res: express.Response) => Promise<void>) =>
  post(path, async (req, res) => { try { await handler(req, res); } finally { completed.emit('completed'); } })) as typeof app.post;
 registerUpdateApplyRoutes(app, { root, mainPid: 12345, check: async () => ({ ...update, sha256: hash, assetSize }), fetch: vi.fn(async () => new Response(bytes)), extract, spawn: spawn as never, quit });
 const server = createServer(app);
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
 return { root, spawn, quit, extract, async request() { const done = once(completed, 'completed', { signal: AbortSignal.timeout(5000) }); const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/update/apply`, { method: 'POST' }); const body = await response.json(); await done; return { status: response.status, body }; }, async close() { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}
describe('update apply route', () => {
 it('extracts only app entries through real PowerShell and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-update-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  await mkdir(stage);
  const createZip = async (bad: boolean) => {
   await rm(zip, { force: true });
   const files = ['Readable Studio.exe', 'ReadableStudioData/keep.txt', 'app/Readable Studio.exe', 'app/resources/readable-studio-config.json', ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map((name) => `app/resources/update-helper/${name}`), ...(bad ? ['app/../escape.txt'] : [])];
   const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem; $a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create); try { foreach ($name in ($env:TEST_FILES | ConvertFrom-Json)) { $entry = $a.CreateEntry($name); $w = New-Object IO.StreamWriter($entry.Open()); $w.Write('fixture'); $w.Dispose() } } finally { $a.Dispose() }`;
   await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, TEST_ZIP: zip, TEST_FILES: JSON.stringify(files) }, windowsHide: true });
  };
  try {
   await createZip(false);
   await extractUpdatePayload(zip, stage);
   expect(await readFile(join(stage, 'Readable Studio.exe'), 'utf8')).toBe('fixture');
   await expect(access(join(stage, 'app'))).rejects.toThrow();
   await expect(access(join(stage, 'ReadableStudioData'))).rejects.toThrow();
   await rm(stage, { recursive: true }); await mkdir(stage);
   await createZip(true);
   await expect(extractUpdatePayload(zip, stage)).rejects.toThrow();
   await expect(access(join(root, 'escape.txt'))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
 }, 20000);
 it('refuses checksum mismatch before extraction, launch or quit', async () => {
  const f = await fixture('a'.repeat(64));
  try { expect(await f.request()).toMatchObject({ status: 422, body: { error: 'checksum-mismatch' } }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it.each([{ assetSize: bytes.length - 1, status: 500 }, { assetSize: bytes.length + 1, status: 422 }])('refuses incorrect asset size $assetSize before extraction, launch or quit', async ({ assetSize, status }) => {
  const f = await fixture(update.sha256, assetSize);
  try { expect(await f.request()).toMatchObject({ status }); expect(f.extract).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.quit).not.toHaveBeenCalled(); } finally { await f.close(); }
 });
 it('streams verified asset, stages payload and launches the exact broker contract', async () => {
  const f = await fixture(update.sha256);
  try { expect(await f.request()).toMatchObject({ status: 202, body: { status: 'applying', targetVersion: '1.3.0' } });
   expect(f.spawn).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(f.root, 'app', 'resources', 'update-helper', 'update-broker.ps1'), '-Root', f.root, '-Staging', join(f.root, 'app.staging'), '-TargetVersion', '1.3.0', '-WaitPid', '12345'], expect.objectContaining({ detached: true, windowsHide: true, stdio: 'ignore', cwd: f.root }));
   expect(f.quit).toHaveBeenCalledOnce();
  } finally { await f.close(); }
 });
});
