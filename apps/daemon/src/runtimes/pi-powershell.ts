import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Windows 10/11 ships Windows PowerShell even when Git and PATH are absent. */
export function resolvePiPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const comspec = values.get('COMSPEC');
  const roots = [values.get('SYSTEMROOT'), values.get('WINDIR'),
    ...(comspec && path.win32.isAbsolute(comspec) ? [path.win32.dirname(path.win32.dirname(comspec))] : []),
    'C:\\Windows'];
  const candidates = [...new Set(roots.filter((root): root is string => Boolean(root && path.win32.isAbsolute(root)))
    .map(root => path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')))];
  const failures: string[] = [];
  for (const executable of candidates) {
    if (!existsSync(executable)) {
      failures.push(`${executable}: absent`);
      continue;
    }
    // Probe the exact -c transport Pi uses, not just file existence or a PATH hit.
    const probe = spawnSync(executable, ['-c', "if ($PSVersionTable.PSVersion.Major -ge 5) { [Console]::Write('READABLE_PI_POWERSHELL') } else { exit 1 }"], {
      env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096,
    });
    if (!probe.error && probe.status === 0 && probe.stdout === 'READABLE_PI_POWERSHELL') return executable;
    failures.push(`${executable}: ${probe.error?.message ?? `readiness probe exited ${probe.status}`}`);
  }
  throw new Error(`No usable Windows PowerShell interpreter. ${failures.join('; ')}`);
}
