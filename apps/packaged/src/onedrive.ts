import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

export type OneDriveLocation = { source: 'OneDrive' | 'OneDriveConsumer' | 'OneDriveCommercial' | 'known-folder'; root: string };
const ENV_SIGNALS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const;
const SKYDRIVE_FOLDER_ID = '{A52BBA46-E9E1-435f-B3D9-28DAA648C0F6}';

export class OneDriveDetectionError extends Error {
  constructor(cause: unknown) {
    super('Could not read the OneDrive known-folder registration', { cause });
    this.name = 'OneDriveDetectionError';
  }
}

// FOLDERID_SkyDrive's registered path is the known-folder fallback when the
// shell did not populate OneDrive environment variables. No name heuristic.
export function readOneDriveKnownFolder(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') return null;
  let output: string;
  try {
    // Registry APIs plus explicit UTF-8 avoid reg.exe's locale-dependent
    // codepage corrupting Korean user names in the fallback path.
    const script = String.raw`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders');
      if ($null -ne $key) { try {
        $path = $key.GetValue('${SKYDRIVE_FOLDER_ID}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
        if ($null -ne $path) { [Console]::Out.Write($path) }
      } finally { $key.Dispose() } }`;
    output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new OneDriveDetectionError(error);
  }
  const path = output.trim();
  if (!path) return null;
  return path.replace(/%([^%]+)%/g, (token, key: string) => {
    const entry = Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase());
    return entry?.[1] ?? token;
  });
}
export function detectOneDriveLocation(exePath: string, env: NodeJS.ProcessEnv = process.env, knownFolder: string | null = null): OneDriveLocation | null {
  const directory = win32.dirname(exePath).toLowerCase();
  const candidates: OneDriveLocation[] = ENV_SIGNALS.flatMap((source) => env[source]?.trim() ? [{ source, root: env[source]!.trim() }] : []);
  if (knownFolder) candidates.push({ source: 'known-folder', root: knownFolder });
  for (const candidate of candidates) {
    if (!win32.isAbsolute(candidate.root)) continue;
    const relative = win32.relative(win32.resolve(candidate.root).toLowerCase(), directory);
    if (relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative))) return candidate;
  }
  return null;
}
export type StartupNoticeState = { snapshot(): { oneDriveNotice: boolean }; dismiss(): Promise<void> };
export function createStartupNoticeState(dataRoot: string, location: OneDriveLocation | null): StartupNoticeState {
  const marker = join(dataRoot, 'onedrive-notice-dismissed.json');
  let dismissed = existsSync(marker);
  return {
    snapshot: () => ({ oneDriveNotice: location !== null && !dismissed }),
    async dismiss() {
      await writeFile(marker, JSON.stringify({ dismissedAt: new Date().toISOString() }), 'utf8');
      dismissed = true;
    },
  };
}
