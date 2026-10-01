import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export type DataLockMetadata = { pid: number; appVersion: string | null; exePath: string; startedAt: string };
export class PackagedDataLockAccessError extends Error {
  readonly title = 'Readable Studio 데이터 폴더를 잠글 수 없습니다';
  constructor(cause: unknown) {
    super('데이터 폴더의 실행 잠금을 확인하지 못했습니다. 폴더 접근 권한과 Windows PowerShell 실행 가능 여부를 확인한 뒤 다시 시작해 주세요.', { cause });
    this.name = 'PackagedDataLockAccessError';
  }
}
export class PackagedDataLockError extends Error {
  readonly title = 'Readable Studio가 이미 실행 중입니다';
  readonly owner: Pick<DataLockMetadata, 'pid' | 'appVersion'>;
  constructor(owner: Pick<DataLockMetadata, 'pid' | 'appVersion'>) {
    super(`Readable Studio ${owner.appVersion ?? '(버전 정보 없음)'} 버전이 이 데이터 폴더를 사용 중입니다. 실행 중인 앱을 종료한 뒤 다시 시작해 주세요. (PID: ${owner.pid})`);
    this.name = 'PackagedDataLockError';
    this.owner = owner;
  }
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}
function readOwner(path: string): Pick<DataLockMetadata, 'pid' | 'appVersion'> | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return null;
  const pid = Reflect.get(value, 'pid');
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const version = Reflect.get(value, 'appVersion');
  return { pid, appVersion: typeof version === 'string' ? version : null };
}

// Windows' kernel mutex serializes stale recovery as well as fresh acquisition.
// It is automatically abandoned on a crash, unlike a second filesystem guard.
// The temporary file is already complete before this worker publishes it.
const WINDOWS_ACQUIRE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, $env:READABLE_LOCK_MUTEX)
$held = $false
try {
  try { $held = $mutex.WaitOne(10000) }
  catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { throw 'Timed out acquiring the data-lock recovery mutex' }
  $path = $env:READABLE_LOCK_PATH
  if ([System.IO.File]::Exists($path)) {
    $text = $null
    try { $text = [System.IO.File]::ReadAllText($path) }
    catch [System.IO.FileNotFoundException] { Write-Verbose 'Owner released its lock during startup' }
    $owner = $null
    try { if ($null -ne $text) { $owner = ConvertFrom-Json -InputObject $text } }
    catch [System.ArgumentException] { Write-Verbose 'Recovering malformed crash metadata' }
    if ($null -ne $owner -and $owner.pid -is [ValueType] -and $owner.pid -gt 0) {
      $alive = $true
      try { $running = [System.Diagnostics.Process]::GetProcessById([int]$owner.pid); $running.Dispose() }
      catch [System.ArgumentException] { $alive = $false }
      if ($alive) {
        [Console]::Out.Write($text)
        exit 3
      }
    }
    [System.IO.File]::Delete($path)
  }
  [System.IO.File]::Move($env:READABLE_LOCK_TEMP, $path)
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
function acquireWindowsLock(path: string, temporary: string): void {
  const mutex = 'Global\\ReadableStudioData-' + createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACQUIRE_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, READABLE_LOCK_MUTEX: mutex, READABLE_LOCK_PATH: path, READABLE_LOCK_TEMP: temporary },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    if (failure.status === 3 && failure.stdout) {
      const owner = JSON.parse(failure.stdout) as DataLockMetadata;
      throw new PackagedDataLockError(owner);
    }
    throw new PackagedDataLockAccessError(error);
  }
}

// Publish fully written metadata atomically; PID liveness, never age, decides
// whether an existing lock is stale. Windows is the supported product target.
export function acquireDataLock(
  dataRoot: string,
  metadata: DataLockMetadata,
  lifecycle: {
    once(event: 'exit', listener: () => void): unknown;
    removeListener(event: 'exit', listener: () => void): unknown;
  } = process,
): { release(): void } {
  mkdirSync(dataRoot, { recursive: true });
  const path = join(dataRoot, 'data.lock');
  const temporary = join(dataRoot, `.data-lock-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(metadata), { flag: 'wx' });
  try {
    if (process.platform === 'win32') acquireWindowsLock(path, temporary);
    else for (;;) {
      try { linkSync(temporary, path); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = readOwner(path);
        if (owner && isAlive(owner.pid)) throw new PackagedDataLockError(owner);
        // Re-read before deletion so a competing recovery's live owner wins.
        const current = readOwner(path);
        if (current && isAlive(current.pid)) throw new PackagedDataLockError(current);
        try { unlinkSync(path); }
        catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
      }
    }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  let released = false;
  const release = () => {
    if (released) return;
    if (existsSync(path)) {
      const current = readOwner(path);
      if (current?.pid === metadata.pid) unlinkSync(path);
    }
    released = true;
    lifecycle.removeListener('exit', release);
  };
  lifecycle.once('exit', release);
  return { release };
}
