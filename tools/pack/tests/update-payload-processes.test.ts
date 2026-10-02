import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Exercise the shipped pre-swap function, with real executable image paths.
test.runIf(process.platform === 'win32')('pre-swap terminates and logs only processes inside app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'payload-probes-'));
  try {
    await mkdir(join(root, 'app'));
    await mkdir(join(root, 'app-other'));
    await copyFile(process.execPath, join(root, 'app', 'node.exe'));
    await copyFile(process.execPath, join(root, 'app-other', 'node.exe'));
    const script = `
$ErrorActionPreference='Stop'
. $env:PROBE_COMMON
$children=@()
try {
 foreach($folder in @('app','app-other')) {
  $info=[Diagnostics.ProcessStartInfo]::new((Join-Path $env:PROBE_ROOT ($folder+'\\node.exe')))
  $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true
  $info.Arguments='-e "console.log(process.pid);setInterval(()=>{},1000)"'
  $p=[Diagnostics.Process]::Start($info);$children+= $p
  if([int]$p.StandardOutput.ReadLine() -ne $p.Id){throw 'Probe did not signal readiness'}
 }
 if(Get-Command Stop-PayloadProcesses -ErrorAction SilentlyContinue){Stop-PayloadProcesses $env:PROBE_ROOT}
 $children[0].Refresh();$children[1].Refresh()
 $log=Join-Path $env:PROBE_ROOT 'update-broker.log'
 @{insideExited=$children[0].HasExited;outsideExited=$children[1].HasExited;insidePid=$children[0].Id;outsidePid=$children[1].Id;log=$(if([IO.File]::Exists($log)){[IO.File]::ReadAllText($log)}else{''})}|ConvertTo-Json -Compress
}finally{foreach($p in $children){if(!$p.HasExited){$p.Kill();[void]$p.WaitForExit(5000)};$p.Dispose()}}
`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, timeout: 20000,
      env: { ...process.env, READABLE_PACKAGED_NAMESPACE: 'probe-fix', PROBE_ROOT: root, PROBE_COMMON: resolve(import.meta.dirname, '../../../apps/packaged/launcher/common.ps1') },
    });
    const proof = JSON.parse(stdout);
    expect(proof.insideExited).toBe(true);
    expect(proof.outsideExited).toBe(false);
    expect(proof.log).toContain(`pid=${proof.insidePid}`);
    expect(proof.log).not.toContain(`pid=${proof.outsidePid}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);
