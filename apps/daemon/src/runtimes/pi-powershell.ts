import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let resolution: Promise<string> | undefined;

/** Reuse the first successful interpreter per process, but allow failed probes to retry. */
export function resolvePiPowerShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  resolution ??= probePiPowerShell(env).catch(error => {
    resolution = undefined;
    throw error;
  });
  return resolution;
}

/** Windows 10/11 ships Windows PowerShell even when Git and PATH are absent. */
async function probePiPowerShell(env: NodeJS.ProcessEnv): Promise<string> {
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const comspec = values.get('COMSPEC');
  const roots = [values.get('SYSTEMROOT'), values.get('WINDIR'),
    ...(comspec && path.win32.isAbsolute(comspec) ? [path.win32.dirname(path.win32.dirname(comspec))] : []),
    'C:\\Windows'];
  const candidates = [...new Set(roots.filter((root): root is string => Boolean(root && path.win32.isAbsolute(root)))
    .map(root => path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')))];
  const failures: string[] = [];
  const timeouts: string[] = [];
  for (const executable of candidates) {
    if (!existsSync(executable)) {
      failures.push(`${executable}: not found`);
      continue;
    }
    // Probe the exact -c transport Pi uses, not just file existence or a PATH hit.
    const startedAt = Date.now();
    const probe = await new Promise<{ error: ExecFileException | null; stdout: string }>(resolve => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-c', "if ($PSVersionTable.PSVersion.Major -ge 5) { [Console]::Write('READABLE_PI_POWERSHELL') } else { exit 1 }"], {
        env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 180000, maxBuffer: 4096,
      }, (error, stdout) => resolve({ error, stdout }));
    });
    if (!probe.error && probe.stdout === 'READABLE_PI_POWERSHELL') return executable;
    if (probe.error?.killed && probe.error.signal === 'SIGTERM' && probe.error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      timeouts.push(`${executable}: did not respond within 180 s (elapsed ${Date.now() - startedAt} ms)`);
    } else {
      failures.push(`${executable}: ${probe.error?.message ?? 'returned unexpected output'}`);
    }
  }
  if (timeouts.length) throw new Error(`PowerShell is starting slowly. ${[...timeouts, ...failures].join('; ')}`);
  throw new Error(`No usable Windows PowerShell interpreter. ${failures.join('; ')}`);
}
