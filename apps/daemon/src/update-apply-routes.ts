import { execFile, spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express } from 'express';
import { compareUpdateVersions, type UpdateCheckResult } from '@readable-studio/contracts';
import { checkForUpdate, updateConfig, type UpdateCheckDependencies } from './update-routes.js';
import { DatabricksUpdateSource } from './update-source.js';
import { updateDownload } from './update-download.js';
import { waitForUpdateHelper } from './update-handoff.js';
import { readCurrentAppVersionInfo } from './app-version.js';

let desktopQuit: (() => Promise<void>) | undefined;
export function setUpdateQuitHandler(handler: () => Promise<void>): void { desktopQuit = handler; }

class InvalidUpdatePackageError extends Error {
  constructor() { super('invalid-package'); }
}

export interface UpdateApplyDependencies {
  root?: string;
  mainPid?: number;
  check?: () => Promise<UpdateCheckResult>;
  fetch?: typeof fetch;
  extract?: (zip: string, staging: string, progress: (completed: number, total: number, completedBytes?: number, totalBytes?: number) => void) => Promise<void>;
  spawn?: typeof spawnProcess;
  quit?: () => Promise<void>;
  source?: UpdateCheckDependencies;
}

/** Only app/ entries are installed. The immutable stub and user data in the ZIP are never applied. */
export async function extractUpdatePayload(zip: string, staging: string, progress?: (completed: number, total: number, completedBytes?: number, totalBytes?: number) => void): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$archive = $null
try {
  $archive = [IO.Compression.ZipFile]::OpenRead($env:READABLE_UPDATE_ZIP)
  $root = [IO.Path]::GetFullPath($env:READABLE_UPDATE_STAGE) + [IO.Path]::DirectorySeparatorChar
  $files = @($archive.Entries | Where-Object { $_.FullName.Replace('\\', '/').StartsWith('app/', [StringComparison]::Ordinal) -and -not $_.FullName.Replace('\\', '/').EndsWith('/') })
  $total = $files.Count
  [long]$totalBytes = 0
  foreach ($file in $files) { $totalBytes += $file.Length }
  [long]$completedBytes = 0
  [long]$lastBytes = 0
  $buffer = New-Object byte[] 1048576
  $completed = 0
  $lastCompleted = 0
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $lastEmission = 0
  [Console]::WriteLine("READABLE_EXTRACT 0 $total 0 $totalBytes")
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\\', '/')
    if (-not $name.StartsWith('app/', [StringComparison]::Ordinal)) { continue }
    $relative = $name.Substring(4)
    if ($relative.Length -eq 0) { continue }
    if ($relative.Contains(':') -or $relative.Split('/') -contains '..' -or $relative.StartsWith('/')) { throw 'READABLE_INVALID_PACKAGE' }
    $dest = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative))
    if (-not $dest.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'READABLE_INVALID_PACKAGE' }
    if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($dest) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
    $inputStream = $entry.Open()
    try {
      $outputStream = [IO.File]::Open($dest, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try {
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $outputStream.Write($buffer, 0, $read)
          $completedBytes += $read
          if (($completedBytes - $lastBytes) -ge 4194304 -or ($clock.ElapsedMilliseconds - $lastEmission) -ge 250) {
            [Console]::WriteLine("READABLE_EXTRACT $completed $total $completedBytes $totalBytes")
            [Console]::Out.Flush()
            $lastBytes = $completedBytes
            $lastCompleted = $completed
            $lastEmission = $clock.ElapsedMilliseconds
          }
        }
      } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
    [IO.File]::SetLastWriteTime($dest, $entry.LastWriteTime.DateTime)
    $completed++
    if (($completed - $lastCompleted) -ge 64 -or ($clock.ElapsedMilliseconds - $lastEmission) -ge 250) {
      [Console]::WriteLine("READABLE_EXTRACT $completed $total $completedBytes $totalBytes")
      $lastCompleted = $completed
      $lastBytes = $completedBytes
      $lastEmission = $clock.ElapsedMilliseconds
    }
  }
  [Console]::WriteLine("READABLE_EXTRACT $completed $total $completedBytes $totalBytes")
} catch {
  $errorCause = $_.Exception
  while ($null -ne $errorCause) {
    if ($errorCause -is [IO.InvalidDataException]) { throw 'READABLE_INVALID_PACKAGE' }
    $errorCause = $errorCause.InnerException
  }
  throw
} finally { if ($null -ne $archive) { $archive.Dispose() } }
`;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true, env: { ...process.env, READABLE_UPDATE_ZIP: zip, READABLE_UPDATE_STAGE: staging },
      }, (error, _stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve());
      let buffered = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop()!;
        for (const line of lines) {
          const match = /^READABLE_EXTRACT (\d+) (\d+) (\d+) (\d+)\r?$/.exec(line);
          if (match) progress?.(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]));
        }
      });
    });
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('READABLE_INVALID_PACKAGE')) throw new InvalidUpdatePackageError();
    throw error;
  }
  // Installable payload entries required after extraction.
  // Keep this list in sync with deploy/update-server-databricks/src/zip.ts.
  for (const file of ['Readable Studio.exe', 'resources/readable-studio-config.json', ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map((name) => `resources/update-helper/${name}`)]) {
    try { await access(join(staging, file)); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new InvalidUpdatePackageError();
      throw error;
    }
  }
}

export function registerUpdateApplyRoutes(app: Express, deps: UpdateApplyDependencies = {}): void {
  let applying = false;
  let handedOffJournal: string | undefined;
  let reconciling: Promise<void> | undefined;
  const rootPath = () => deps.root ?? process.env.READABLE_UPDATE_ROOT;
  const reconcileApply = async () => {
    if (!applying || !handedOffJournal) return;
    if (reconciling) return reconciling;
    const identity = handedOffJournal;
    const root = rootPath()!;
    reconciling = (async () => {
      try {
        const journal = JSON.parse(await readFile(join(root, 'update-journal.json'), 'utf8')) as { id?: string; step?: string; done?: boolean; pid?: number };
        if (journal.id !== identity || journal.step !== 'rolled-back' || journal.done !== true || journal.pid !== 0) return;
        // The terminal journal is saved before the helper releases its handoff files.
        try { await access(join(root, 'update-helper-ready.json')); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rm(join(root, 'app.staging'), { recursive: true, force: true });
        handedOffJournal = undefined;
        applying = false;
      } catch (error) { console.error('Update handoff reconciliation failed:', error); }
    })().finally(() => { reconciling = undefined; });
    return reconciling;
  };
  const currentVersion = () => (deps.source?.currentVersion ?? (async () => (await readCurrentAppVersionInfo()).version))();
  // Registration runs during daemon startup, before any update surface is opened.
  const startupRoot = rootPath();
  const recovered = startupRoot ? currentVersion().then((current) => updateDownload(startupRoot).staged(current)) : Promise.resolve(null);
  void recovered.catch((error: unknown) => console.error('Update recovery failed:', error));
  app.get('/api/update/status', async (_req, res) => {
    await reconcileApply();
    const root = rootPath();
    if (!root) { res.json({ state: 'idle', received: 0, total: 0, version: null, error: null }); return; }
    const download = updateDownload(root);
    await recovered;
    if (!['downloading', 'verifying', 'ready'].includes(download.status.state)) {
      await download.staged(await currentVersion());
      if (download.status.releaseUrl && download.status.releaseUrl !== (await (deps.source?.config ?? updateConfig)()).serverUrl) await download.invalidate();
    }
    res.json(download.status);
  });
  app.get('/api/update/events', async (req, res) => {
    await reconcileApply();
    const root = rootPath();
    if (!root) { res.status(409).json({ error: 'unsupported-layout' }); return; }
    const download = updateDownload(root);
    await recovered;
    if (!['downloading', 'verifying', 'ready'].includes(download.status.state)) {
      await download.staged(await currentVersion());
      if (download.status.releaseUrl && download.status.releaseUrl !== (await (deps.source?.config ?? updateConfig)()).serverUrl) await download.invalidate();
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = () => res.write(`data: ${JSON.stringify(download.status)}\n\n`);
    send();
    download.on('status', send);
    req.on('close', () => download.off('status', send));
  });
  app.post('/api/update/download', async (_req, res) => {
    await reconcileApply();
    if (applying) { res.status(409).json({ error: 'update-in-progress' }); return; }
    const root = rootPath();
    if (!root) { res.status(409).json({ error: 'unsupported-layout' }); return; }
    const download = updateDownload(root);
    const generation = download.generation;
    if (['downloading', 'verifying'].includes(download.status.state)) { res.status(202).json(download.status); return; }
    const update = await (deps.check ?? (() => checkForUpdate(deps.source)))();
    if (generation !== download.generation) { res.status(409).json({ error: 'cancelled' }); return; }
    if ('unavailable' in update) { await download.checked(update); res.status(503).json(update); return; }
    if (!update.isNewer) { await download.checked(update); res.status(409).json({ error: 'already-current' }); return; }
    const staged = await download.staged(update.current);
    const config = await (deps.source?.config ?? updateConfig)();
    if (generation !== download.generation) { res.status(409).json({ error: 'cancelled' }); return; }
    if (config.serverUrl !== update.releaseUrl) { await download.invalidate(); res.status(409).json({ error: 'source-changed' }); return; }
    if (staged?.releaseUrl === update.releaseUrl && staged.latest === update.latest && staged.sha256 === update.sha256 && staged.assetSize === update.assetSize) { res.status(202).json(download.status); return; }
    if (!config.serverUrl) { res.status(409).json({ error: 'not-configured' }); return; }
    download.start(update, new DatabricksUpdateSource(config.serverUrl, deps.source?.token, deps.fetch ?? deps.source?.fetch));
    res.status(202).json(download.status);
  });
  app.post('/api/update/cancel', async (_req, res) => {
    await reconcileApply();
    if (applying) { res.status(409).json({ error: 'update-in-progress' }); return; }
    const root = rootPath();
    if (root) { const download = updateDownload(root); await download.cancel(); res.json(download.status); return; }
    res.json({ state: 'idle', received: 0, total: 0, version: null, error: null });
  });
  app.post('/api/update/apply', async (_req, res) => {
    await reconcileApply();
    const root = deps.root ?? process.env.READABLE_UPDATE_ROOT;
    const mainPid = deps.mainPid ?? Number(process.env.READABLE_ELECTRON_MAIN_PID);
    const quit = deps.quit ?? desktopQuit;
    if (!root || !Number.isSafeInteger(mainPid) || mainPid <= 0 || !quit) { res.status(409).json({ error: 'unsupported-layout' }); return; }
    if (applying) { res.status(409).json({ error: 'update-in-progress' }); return; }
    applying = true;
    const namespace = process.env.READABLE_PACKAGED_NAMESPACE ?? 'rg';
    console.info('[update-apply] start', { root, mainPid, namespace });
    let temp: string | undefined;
    let launched = false;
    let ownedStaging: string | undefined;
    let preparing = true;
    let handoffFailed = false;
    try {
      await recovered;
      const update = await updateDownload(root).staged();
      if (!update) { res.status(409).json({ error: 'not-ready' }); return; }
      if (update.releaseUrl !== (await (deps.source?.config ?? updateConfig)()).serverUrl) {
        await updateDownload(root).invalidate(); res.status(409).json({ error: 'source-changed' }); return;
      }
      const latest = await (deps.check ?? (() => checkForUpdate(deps.source)))();
      if ('unavailable' in latest ? latest.unavailable === 'no-release'
        : latest.latest !== update.latest || latest.sha256 !== update.sha256 || latest.assetSize !== update.assetSize || latest.releaseUrl !== update.releaseUrl) {
        await updateDownload(root).invalidate(); res.status(409).json({ error: 'release-withdrawn' }); return;
      }
      if ('unavailable' in latest && !['unreachable', 'timeout'].includes(latest.unavailable)) {
        res.status(503).json(latest); return;
      }
      const current = await (deps.source?.currentVersion ?? (async () => (await readCurrentAppVersionInfo()).version))();
      if (compareUpdateVersions(update.latest, current) !== 1) { res.status(409).json({ error: 'already-current' }); return; }
      temp = await mkdtemp(join(root, '.update-download-'));
      const zip = updateDownload(root).zip;
      const payload = join(temp, 'payload');
      await mkdir(payload);
      updateDownload(root).extracting({ completed: 0, total: 0 });
      await (deps.extract ?? extractUpdatePayload)(zip, payload, (completed, total, completedBytes, totalBytes) => updateDownload(root).extracting({ completed, total, ...(completedBytes !== undefined && totalBytes !== undefined ? { completedBytes, totalBytes } : {}) }));
      let metadata: { appVersion?: unknown };
      try {
        metadata = JSON.parse(await readFile(join(payload, 'resources', 'readable-studio-config.json'), 'utf8')) as { appVersion?: unknown };
        if (!metadata || typeof metadata.appVersion !== 'string') throw new InvalidUpdatePackageError();
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new InvalidUpdatePackageError();
        throw error;
      }
      if (metadata.appVersion !== update.latest) { await updateDownload(root).invalidate(); res.status(409).json({ error: 'version-mismatch' }); return; }
      if (update.releaseUrl !== (await (deps.source?.config ?? updateConfig)()).serverUrl) {
        await updateDownload(root).invalidate(); res.status(409).json({ error: 'source-changed' }); return;
      }
      const staging = join(root, 'app.staging');
      // Never replace another updater's staging directory (or recovery state).
      await rename(payload, staging);
      ownedStaging = staging;
      preparing = false;
      const handoffId = randomUUID();
      console.info('[update-apply] payload staged', { staging, target: update.latest, handoffId, namespace });
      // Windows PowerShell silently exits in Node's detached/no-console mode.
      // The broker independently Start-Process launches the helper; acknowledge that helper before quitting.
      const child = (deps.spawn ?? spawnProcess)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'app', 'resources', 'update-helper', 'update-broker.ps1'), '-Root', root, '-Staging', staging, '-TargetVersion', update.latest, '-WaitPid', String(mainPid), '-Namespace', namespace], { windowsHide: true, stdio: 'ignore', cwd: root, env: { ...process.env, READABLE_PACKAGED_NAMESPACE: namespace, READABLE_UPDATE_HANDOFF_ID: handoffId } });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      console.info('[update-apply] broker spawned', { pid: child.pid, handoffId, namespace });
      const helperPid = await waitForUpdateHelper(root, handoffId, child, namespace);
      console.info('[update-apply] helper acknowledged', { helperPid, handoffId, namespace });
      launched = true;
      const journal = JSON.parse(await readFile(join(root, 'update-journal.json'), 'utf8')) as { id: string };
      handedOffJournal = journal.id;
      res.once('finish', () => { console.info('[update-apply] desktop quit requested', { mainPid, helperPid, namespace }); void quit().catch((error: unknown) => console.error('Update broker started but desktop quit failed:', error)); });
      res.status(202).json({ status: 'applying', targetVersion: update.latest });
    } catch (error) {
      console.error('[update-apply] handoff failed; desktop remains running', { namespace, error });
      if (preparing) await updateDownload(root).invalidate();
      else handoffFailed = true;
      res.status(500).json({ error: error instanceof InvalidUpdatePackageError ? 'invalid-package' : preparing ? 'disk-extract-failed' : 'helper-not-acknowledged' });
    } finally {
      // A failed handoff clears extraction with its error after cleanup, in one event.
      if (!handoffFailed) updateDownload(root).extracting(undefined);
      if (temp) await rm(temp, { recursive: true, force: true }).catch((error: unknown) => console.error('Update temp cleanup failed:', error));
      if (!launched) {
        if (ownedStaging) await rm(ownedStaging, { recursive: true, force: true }).catch((error: unknown) => console.error('Update staging cleanup failed:', error));
        applying = false;
        if (handoffFailed) updateDownload(root).applyFailed('helper-not-acknowledged');
      }
    }
  });
}
