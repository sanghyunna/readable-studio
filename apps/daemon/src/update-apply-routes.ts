import { execFile, spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Express } from 'express';
import type { UpdateCheckResult } from '@readable-studio/contracts';
import { checkForUpdate } from './update-routes.js';
import { createUpdateHttpClient } from './update-http.js';

let desktopQuit: (() => Promise<void>) | undefined;
export function setUpdateQuitHandler(handler: () => Promise<void>): void { desktopQuit = handler; }

export interface UpdateApplyDependencies {
  root?: string;
  mainPid?: number;
  check?: () => Promise<UpdateCheckResult>;
  fetch?: typeof fetch;
  extract?: (zip: string, staging: string) => Promise<void>;
  spawn?: typeof spawnProcess;
  quit?: () => Promise<void>;
}

/** Only app/ entries are installed. The immutable stub and user data in the ZIP are never applied. */
export async function extractUpdatePayload(zip: string, staging: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:READABLE_UPDATE_ZIP)
try {
  $root = [IO.Path]::GetFullPath($env:READABLE_UPDATE_STAGE) + [IO.Path]::DirectorySeparatorChar
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\\', '/')
    if (-not $name.StartsWith('app/', [StringComparison]::Ordinal)) { continue }
    $relative = $name.Substring(4)
    if ($relative.Length -eq 0) { continue }
    if ($relative.Contains(':') -or $relative.Split('/') -contains '..' -or $relative.StartsWith('/')) { throw 'Invalid ZIP path' }
    $dest = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative))
    if (-not $dest.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path escaped payload' }
    if ($name.EndsWith('/')) { [IO.Directory]::CreateDirectory($dest) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $false)
  }
} finally { $archive.Dispose() }
`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true, env: { ...process.env, READABLE_UPDATE_ZIP: zip, READABLE_UPDATE_STAGE: staging },
  });
  for (const file of ['Readable Studio.exe', 'resources/readable-studio-config.json', ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map((name) => `resources/update-helper/${name}`)]) await access(join(staging, file));
}

export function registerUpdateApplyRoutes(app: Express, deps: UpdateApplyDependencies = {}): void {
  let applying = false;
  app.post('/api/update/apply', async (_req, res) => {
    const root = deps.root ?? process.env.READABLE_UPDATE_ROOT;
    const mainPid = deps.mainPid ?? Number(process.env.READABLE_ELECTRON_MAIN_PID);
    const quit = deps.quit ?? desktopQuit;
    if (!root || !Number.isSafeInteger(mainPid) || mainPid <= 0 || !quit) { res.status(409).json({ error: 'unsupported-layout' }); return; }
    if (applying) { res.status(409).json({ error: 'update-in-progress' }); return; }
    applying = true;
    let temp: string | undefined;
    let launched = false;
    let ownedStaging: string | undefined;
    let client: ReturnType<typeof createUpdateHttpClient> | undefined;
    try {
      const update = await (deps.check ?? checkForUpdate)();
      if ('unavailable' in update) { res.status(503).json(update); return; }
      if (!update.isNewer) { res.status(409).json({ error: 'already-current' }); return; }
      temp = await mkdtemp(join(root, '.update-download-'));
      const zip = join(temp, 'update.zip');
      const url = `${update.releaseUrl.replace('/tag/', '/download/')}/${encodeURIComponent(update.assetName)}`;
      if (!deps.fetch) client = createUpdateHttpClient();
      const response = await (deps.fetch ?? client!.fetch)(url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > update.assetSize) { callback(new Error('download exceeds expected size')); return; }
        hash.update(chunk); callback(null, chunk);
      } }), createWriteStream(zip, { flags: 'wx' }));
      if (hash.digest('hex') !== update.sha256 || size !== update.assetSize) { res.status(422).json({ error: 'checksum-mismatch' }); return; }
      const payload = join(temp, 'payload');
      await mkdir(payload);
      await (deps.extract ?? extractUpdatePayload)(zip, payload);
      const staging = join(root, 'app.staging');
      // Never replace another updater's staging directory (or recovery state).
      await rename(payload, staging);
      ownedStaging = staging;
      const child = (deps.spawn ?? spawnProcess)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'app', 'resources', 'update-helper', 'update-broker.ps1'), '-Root', root, '-Staging', staging, '-TargetVersion', update.latest, '-WaitPid', String(mainPid)], { detached: true, windowsHide: true, stdio: 'ignore', cwd: root });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      launched = true;
      res.once('finish', () => { void quit().catch((error: unknown) => console.error('Update broker started but desktop quit failed:', error)); });
      res.status(202).json({ status: 'applying', targetVersion: update.latest });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      await client?.destroy();
      if (temp) await rm(temp, { recursive: true, force: true }).catch((error: unknown) => console.error('Update temp cleanup failed:', error));
      if (!launched) {
        if (ownedStaging) await rm(ownedStaging, { recursive: true, force: true }).catch((error: unknown) => console.error('Update staging cleanup failed:', error));
        applying = false;
      }
    }
  });
}
