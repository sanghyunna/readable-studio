import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

export interface ExecutableProcess { pid: number; executablePath: string }
export async function listWindowsExecutableProcesses(requiredName: RegExp): Promise<ExecutableProcess[]> {
  if (process.platform !== 'win32') throw new Error('Windows process inspection is required');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,ProcessId | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const raw = JSON.parse(stdout) as { Name: string; ExecutablePath: string | null; ProcessId: number }[];
  const rows = Array.isArray(raw) ? raw : [raw];
  if (rows.some(row => requiredName.test(row.Name) && !row.ExecutablePath)) throw new Error('Cannot inspect a running application process');
  return rows.flatMap(row => row.ExecutablePath && row.ProcessId !== process.pid ? [{ pid: row.ProcessId, executablePath: row.ExecutablePath }] : []);
}

export function processesInsideRoot(root: string, processes: ExecutableProcess[]): ExecutableProcess[] {
  return processes.filter(row => {
    if (row.pid === process.pid) return false;
    const rel = path.relative(path.resolve(root), path.resolve(row.executablePath));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  });
}

async function terminateWindowsProcess(target: ExecutableProcess): Promise<void> {
  // Hold the native handle before checking the image, so PID reuse cannot
  // redirect Kill to another process. Wait on that handle, not a delay.
  const image = Buffer.from(target.executablePath, 'utf16le').toString('base64');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $image=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${image}')); try { $p=[Diagnostics.Process]::GetProcessById(${target.pid}) } catch [ArgumentException] { exit 0 }; try { $handle=$p.Handle; if ($p.HasExited) { exit 0 }; $row=Get-CimInstance Win32_Process -Filter "ProcessId = ${target.pid}"; if ($null -eq $row) { exit 0 }; if ($row.ExecutablePath -ne $image -or $p.MainModule.FileName -ne $image) { throw 'Process executable changed' }; $p.Kill(); if (!$p.WaitForExit(10000)) { throw 'Process did not exit' } } finally { $p.Dispose() }`],
  { windowsHide: true, timeout: 15000 });
}

export async function stopProcessesInsideRoot(root: string, options: {
  list: () => Promise<ExecutableProcess[]>;
  terminate?: (target: ExecutableProcess) => Promise<void>;
}): Promise<ExecutableProcess[]> {
  const targets = processesInsideRoot(root, await options.list());
  for (const target of targets) await (options.terminate ?? terminateWindowsProcess)(target);
  const remaining = processesInsideRoot(root, await options.list());
  if (remaining.length) throw new Error(`Source processes are still running: ${remaining.map(row => row.pid).join(', ')}`);
  return targets;
}
