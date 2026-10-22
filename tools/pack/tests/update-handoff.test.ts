import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { prepareUpdateLayout } from '../src/win/update-layout.js';

// Hidden console flags do not hide WinForms. Put the whole detached process
// chain on a private desktop, including the helper's normal progress form.
const privateDesktop = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class HandoffDesktop {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct StartupInfo {
  public int cb; public string reserved; public string desktop; public string title;
  public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reservedSize;
  public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr security);
 [DllImport("user32.dll", SetLastError=true)]
 public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static IntPtr Open(string name) {
  var desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero);
  if(desktop==IntPtr.Zero) throw new Win32Exception();
  return desktop;
 }
 public static Process Start(string app,string args,string desktop,string cwd) {
  var startup=new StartupInfo(); startup.cb=Marshal.SizeOf(startup); startup.desktop=desktop;
  ProcessInfo info;
  if(!CreateProcess(app,new StringBuilder("\\""+app+"\\" "+args),IntPtr.Zero,IntPtr.Zero,false,0x08000000,IntPtr.Zero,cwd,ref startup,out info)) throw new Win32Exception();
  try {
   var process=Process.GetProcessById(info.pid);
   // Keep a .NET-owned handle before releasing CreateProcess's handle, so
   // ExitCode remains available after a fast child exits.
   var handle=process.Handle;
   return process;
  }
  finally { CloseHandle(info.thread); CloseHandle(info.process); }
 }
}
'@
$desktopName='handoff-'+$env:READABLE_UPDATE_TEST_ID
$desktop=[HandoffDesktop]::Open($desktopName)
`;

describe('real update helper acknowledgment', () => {
  it.each(['probe-fix', 'rg'])('owns its journal and preserves namespace %s across the detached handoff', async (namespace) => {
    const root = await mkdtemp(join(tmpdir(), 'update-handoff-'));
    const id = randomUUID();
    try {
      await mkdir(join(root, 'app'));
      await mkdir(join(root, 'app.staging'));
      await writeFile(join(root, 'app', 'Readable Studio.exe'), 'old fixture');
      await writeFile(join(root, 'app.staging', 'Readable Studio.exe'), 'new fixture');
      await prepareUpdateLayout(join(import.meta.dirname, '..', '..', '..'), root);
      const node = `const{spawn}=require('node:child_process');const{watch,readFileSync,writeFileSync}=require('node:fs');const path=require('node:path');const root=process.env.HANDOFF_ROOT;const w=watch(root,check);const timeout=setTimeout(()=>{throw Error('helper acknowledgment timeout')},15000);function check(){try{const ready=JSON.parse(readFileSync(path.join(root,'update-helper-ready.json'),'utf8'));if(ready.id===process.env.READABLE_UPDATE_HANDOFF_ID){clearTimeout(timeout);w.close();process.exit(0)}}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e}}const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(root,'app/resources/update-helper/update-broker.ps1'),'-NonInteractive','-Root',root,'-Staging',path.join(root,'app.staging'),'-TargetVersion','9.9.9','-WaitPid',String(process.pid),'-Namespace',process.env.HANDOFF_NAMESPACE],{windowsHide:true,stdio:'ignore',cwd:root,env:{...process.env,READABLE_PACKAGED_NAMESPACE:'probe-fix'}});writeFileSync(path.join(root,'broker.pid'),String(p.pid));p.unref();check();`;
      const script = `
$ErrorActionPreference='Stop'
${privateDesktop}
$hit=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,'Local\\ReadableUpdateCheckpoint-'+$env:READABLE_UPDATE_TEST_ID)
$release=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,'Local\\ReadableUpdateRelease-'+$env:READABLE_UPDATE_TEST_ID)
$parent=$null;$helper=$null
try {
 $arguments='-e '+('"'+$env:HANDOFF_CODE.Replace('"','\"')+'"')
 $parent=[HandoffDesktop]::Start($env:HANDOFF_NODE,$arguments,$desktopName,$env:HANDOFF_ROOT)
 if(!$hit.WaitOne(15000)){
  foreach($name in @('update-broker.log','update-error.log','update-broker-error.log','update-helper-ready.json','update-journal.json')){$path=Join-Path $env:HANDOFF_ROOT $name;if([IO.File]::Exists($path)){Write-Output ($name+': '+[IO.File]::ReadAllText($path))}}
  throw 'Helper did not claim prepared journal'
 }
 $journal=[IO.File]::ReadAllText((Join-Path $env:HANDOFF_ROOT 'update-journal.json'))|ConvertFrom-Json
 $ready=[IO.File]::ReadAllText((Join-Path $env:HANDOFF_ROOT 'update-helper-ready.json'))|ConvertFrom-Json
 $helper=[Diagnostics.Process]::GetProcessById($journal.pid)
 if(!$parent.WaitForExit(15000)){throw 'Node did not acknowledge helper'}
 @{parentExit=$parent.ExitCode;helperAlive=(!$helper.HasExited);ready=$ready;journal=$journal}|ConvertTo-Json -Compress -Depth 8
}finally{
 if(!$helper -and [IO.File]::Exists((Join-Path $env:HANDOFF_ROOT 'update-helper-ready.json'))){
  $ready=[IO.File]::ReadAllText((Join-Path $env:HANDOFF_ROOT 'update-helper-ready.json'))|ConvertFrom-Json
  try{$helper=[Diagnostics.Process]::GetProcessById($ready.pid)}catch [ArgumentException]{}
 }
 if($helper -and !$helper.HasExited){$helper.Kill();[void]$helper.WaitForExit(5000)}
 if($parent -and !$parent.HasExited){$parent.Kill();[void]$parent.WaitForExit(5000)}
 $brokerPid=Join-Path $env:HANDOFF_ROOT 'broker.pid'
 if([IO.File]::Exists($brokerPid)){
  try{$broker=[Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText($brokerPid));if(!$broker.WaitForExit(5000)){$broker.Kill();[void]$broker.WaitForExit(5000)}}catch [ArgumentException]{}
 }
 $hit.Dispose();$release.Dispose();[void][HandoffDesktop]::CloseDesktop($desktop)
}
`;
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: { ...process.env, READABLE_PACKAGED_NAMESPACE: 'probe-fix', HANDOFF_NAMESPACE: namespace, READABLE_UPDATE_TEST_POINT: 'prepared', READABLE_UPDATE_TEST_ID: id, READABLE_UPDATE_HANDOFF_ID: id, HANDOFF_ROOT: root, HANDOFF_NODE: process.execPath, HANDOFF_CODE: node } }).catch(error => { console.error(error.stdout); throw error; });
      const proof = JSON.parse(result.stdout);
      expect(proof.parentExit).toBe(0);
      expect(proof.helperAlive).toBe(true);
      expect(proof.ready).toMatchObject({ id, pid: proof.journal.pid });
      expect(proof.journal).toMatchObject({ id, step: 'prepared', target: '9.9.9', launchNamespace: namespace });
      expect(proof.ready).toMatchObject({ namespace });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000);

  it('logs broker failures without a dialog when explicitly non-interactive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'update-handoff-error-'));
    try {
      await mkdir(join(root, 'app'));
      await mkdir(join(root, 'app.staging'));
      await writeFile(join(root, 'app', 'Readable Studio.exe'), 'old fixture');
      await writeFile(join(root, 'app.staging', 'Readable Studio.exe'), 'new fixture');
      await prepareUpdateLayout(join(import.meta.dirname, '..', '..', '..'), root);
      const script = `
$ErrorActionPreference='Stop'
${privateDesktop}
$broker=$null
try {
 $arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $env:HANDOFF_ROOT 'app/resources/update-helper/update-broker.ps1')+'" -NonInteractive -Root "'+$env:HANDOFF_ROOT+'" -Staging "'+(Join-Path $env:HANDOFF_ROOT 'invalid.staging')+'" -TargetVersion 9.9.9 -WaitPid 0'
 $broker=[HandoffDesktop]::Start((Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'),$arguments,$desktopName,$env:HANDOFF_ROOT)
 if(!$broker.WaitForExit(15000)){throw 'Non-interactive broker did not exit; a dialog may be blocking it'}
 Write-Output $broker.ExitCode
} finally {
 if($broker -and !$broker.HasExited){$broker.Kill();[void]$broker.WaitForExit(5000)}
 [void][HandoffDesktop]::CloseDesktop($desktop)
}
`;
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        env: { ...process.env, HANDOFF_ROOT: root, READABLE_UPDATE_TEST_ID: randomUUID() },
      });
      expect(result.stdout.trim()).toBe('1');
      expect(await readFile(join(root, 'update-broker-error.log'), 'utf8')).toContain('Staging must be the installation app.staging folder.');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000);
});
