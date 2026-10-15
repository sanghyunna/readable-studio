import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { HiddenLaunchError, launchHiddenDesktop } from '../lib/packaged-hidden-desktop.ts';
import { runCommand, workspaceRoot } from '../scripts/portable-qa-support.ts';
import { packagedFileRoute, parsePackagedDeleteOptions, resolvePackagedAppRoot } from '../scripts/direct-edit-delete-packaged.ts';

const scratchParent = join(workspaceRoot, '.tmp/direct-edit-delete/r1/w');
let scratch: string;
let executablePath: string;
const receipts: unknown[] = [];

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

beforeAll(async () => {
  await mkdir(scratchParent, { recursive: true });
  scratch = await mkdtemp(join(scratchParent, 'lifecycle-'));
  const archive = process.env.READABLE_HIDDEN_TEST_ZIP
    ?? join(workspaceRoot, '.tmp/fin12/drop/Readable-Studio-win-x64-portable.zip');
  const extracted = await runCommand(join(workspaceRoot, 'tools/pack/resources/win/7zip/7z.exe'),
    ['x', archive, `-o${scratch}`, '-y']);
  expect(extracted.exitCode).toBe(0);
  executablePath = join(scratch, 'Readable Studio.exe');
  receipts.push({ case: 'extraction', archive, archiveSha256: await sha256(archive),
    executablePath, executableSha256: await sha256(executablePath), extraction: extracted });
}, 180_000);

afterAll(async () => {
  const evidence = process.env.READABLE_HIDDEN_EVIDENCE;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'lifecycle.json'), JSON.stringify(receipts, null, 2));
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test('private packaged desktop leaves input desktop unchanged and closes owned handles', async () => {
  const runtime = await launchHiddenDesktop({
    executablePath, namespace: `hidden-${process.pid}`, debugPort: await freePort(),
  });
  try {
    expect(runtime.page.url()).toMatch(/^readable-studio:\/\/app\//);
    expect(runtime.desktopName).not.toBe(runtime.inputDesktopBefore);
    expect(runtime.inputDesktopAfter).toBe(runtime.inputDesktopBefore);
    expect(runtime.rootPid).toBeGreaterThan(0);
    expect(Object.values(runtime.nativeHandles).every(handle => handle !== '0')).toBe(true);
    const windows = await runtime.inspectWindows();
    expect(windows.privateWindowPids.length).toBeGreaterThan(0);
    expect(windows.activeOwnedWindowPids).toEqual([]);
    expect(windows.inputDesktop).toBe(runtime.inputDesktopBefore);
    receipts.push({ case: 'window-containment', windows });
    if (process.env.READABLE_HIDDEN_EVIDENCE) {
      await runtime.page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 60_000 });
      await runtime.page.screenshot({ path: join(process.env.READABLE_HIDDEN_EVIDENCE, 'hidden-main.png') });
    }
  } finally {
    const first = await runtime.close();
    expect(await runtime.close()).toEqual(first);
    expect(first.activeProcesses).toBe(0);
    expect(first.handlesClosed).toBe(true);
    expect(first.inputDesktop).toBe(runtime.inputDesktopBefore);
    expect(() => process.kill(runtime.rootPid, 0)).toThrow();
    expect(() => process.kill(runtime.hostPid, 0)).toThrow();
    receipts.push({ rootPid: runtime.rootPid, hostPid: runtime.hostPid, handles: runtime.nativeHandles, desktop: runtime.desktopName,
      namespace: `hidden-${process.pid}`, cdpEndpoint: runtime.cdpEndpoint, logs: runtime.logs,
      before: runtime.inputDesktopBefore, after: runtime.inputDesktopAfter, cleanup: first });
  }
}, 180_000);

test('CreateProcess failure closes the private desktop and process handles', async () => {
  const bad = join(scratch, 'not-executable.exe');
  await writeFile(bad, 'not a PE executable');
  const error = await launchHiddenDesktop({
    executablePath: bad, namespace: `bad-${process.pid}`, debugPort: await freePort(),
  }).catch(error => error as unknown);
  expect(error).toBeInstanceOf(HiddenLaunchError);
  expect(error).toMatchObject({ cleanup: { activeProcesses: 0, handlesClosed: true } });
  expect((error as Error).message).toContain('CreateProcess');
  receipts.push({ case: 'invalid-executable', error });
});

test('CDP readiness failure terminates only its owned job', async () => {
  const previous = process.env.READABLE_HIDDEN_TIMEOUT_MS;
  process.env.READABLE_HIDDEN_TIMEOUT_MS = '3000';
  try {
    const error = await launchHiddenDesktop({
      executablePath: resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      namespace: `no-cdp-${process.pid}`, debugPort: await freePort(),
    }).catch(error => error as unknown);
    expect(error).toBeInstanceOf(HiddenLaunchError);
    expect(error).toMatchObject({ cleanup: { activeProcesses: 0, handlesClosed: true } });
    const failure = error as HiddenLaunchError;
    expect(failure.rootPid).toBeGreaterThan(0);
    expect(() => process.kill(failure.rootPid!, 0)).toThrow();
    receipts.push({ case: 'readiness-failure', error });
  } finally {
    if (previous === undefined) delete process.env.READABLE_HIDDEN_TIMEOUT_MS;
    else process.env.READABLE_HIDDEN_TIMEOUT_MS = previous;
  }
}, 30_000);

test('rejects an occupied debug port without launching', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    await expect(launchHiddenDesktop({
      executablePath, namespace: `occupied-${process.pid}`, debugPort: address.port,
    })).rejects.toThrow(/EADDRINUSE/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('packaged runner rejects missing and non-file ZIP arguments before launch', async () => {
  await expect(parsePackagedDeleteOptions([])).rejects.toThrow(/required/);
  await expect(parsePackagedDeleteOptions([
    '--zip', scratch, '--namespace', 'invalid-input', '--evidence', join(scratch, 'evidence'),
  ])).rejects.toThrow(/ZIP.*file/);
  await expect(parsePackagedDeleteOptions([
    '--zip', join(scratch, 'missing.zip'), '--namespace', 'invalid-input', '--evidence', join(scratch, 'evidence'),
  ])).rejects.toThrow(/ENOENT/);
  const runner = join(workspaceRoot, 'e2e/scripts/direct-edit-delete-packaged.ts');
  const tsx = join(workspaceRoot, 'e2e/node_modules/tsx/dist/cli.mjs');
  const missing = await runCommand(process.execPath, [tsx, runner]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('--zip, --namespace and --evidence are required');
  const directory = await runCommand(process.execPath, [tsx, runner,
    '--zip', scratch, '--namespace', 'bad-zip', '--evidence', join(scratch, 'evidence')]);
  expect(directory.exitCode).toBe(1);
  expect(directory.stderr).toContain('ZIP input must be a file');
  receipts.push({ case: 'runner-arguments', missing, directory });
});

test('packaged runner resolves the CLI app root for the portable ZIP layout', async () => {
  const extract = join(scratch, 'zip-layout');
  const nodePath = (root: string) => join(root, 'resources', 'readable-studio', 'bin', 'node.exe');
  await mkdir(join(extract, 'app', 'resources', 'readable-studio', 'bin'), { recursive: true });
  await writeFile(nodePath(join(extract, 'app')), '');
  expect(await resolvePackagedAppRoot(extract)).toBe(join(extract, 'app'));
  const flat = join(scratch, 'flat-layout');
  await mkdir(join(flat, 'resources', 'readable-studio', 'bin'), { recursive: true });
  await writeFile(nodePath(flat), '');
  expect(await resolvePackagedAppRoot(flat)).toBe(flat);
  await expect(resolvePackagedAppRoot(join(scratch, 'empty-layout'))).rejects.toThrow(/node\.exe/);
});

test('packaged runner addresses each artifact by its own project file route', () => {
  expect(packagedFileRoute('p1', 'host-discard.html')).toBe('/projects/p1/files/host-discard.html');
  expect(packagedFileRoute('p1', 'assets/a b.html')).toBe('/projects/p1/files/assets%2Fa%20b.html');
});
