import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { prepareUpdateLayout } from '../src/win/update-layout.js';

test.runIf(process.platform === 'win32').each(['probe-fix', 'rg'])('helper and rollback relaunch explicitly preserve namespace %s', async (namespace) => {
  const root = await mkdtemp(join(tmpdir(), 'update-context-'));
  try {
    await mkdir(join(root, 'app'));
    await writeFile(join(root, 'app', 'Readable Studio.exe'), 'payload fixture');
    await prepareUpdateLayout(join(import.meta.dirname, '../../..'), root);
    const script = `
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadFrom((Join-Path $env:CONTEXT_ROOT 'Readable Studio.exe'))
$tx=[ReadableStudio.Launcher.Transaction]::new($env:CONTEXT_ROOT)
try {
 $payload=Join-Path $env:CONTEXT_ROOT 'app\\Readable Studio.exe'
 [IO.File]::Delete($payload)
 $source=@'
using System;
using System.IO;
using System.Diagnostics;
using System.Web.Script.Serialization;
public static class FakePayload {
 public static void Main() {
  var root=Environment.GetEnvironmentVariable("CONTEXT_ROOT");
  var json=new JavaScriptSerializer();
  var id=Environment.GetEnvironmentVariable("READABLE_UPDATE_TRANSACTION");
  File.WriteAllText(Path.Combine(root,"launch-context.json"),json.Serialize(new { ns=Environment.GetEnvironmentVariable("READABLE_PACKAGED_NAMESPACE"),pid=Process.GetCurrentProcess().Id }));
  if(id!=null) {
   var ready=Path.Combine(root,"update-ready.json");
   File.WriteAllText(ready+".tmp",json.Serialize(new { id=id,version=Environment.GetEnvironmentVariable("READABLE_UPDATE_TARGET") }));
   File.Move(ready+".tmp",ready);
  }
 }
}
'@
 Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.dll','System.Web.Extensions.dll' -OutputAssembly $payload -OutputType WindowsApplication
 if(!$tx.TryLock()){throw 'Fixture could not claim transaction'}
 $tx.State=[ReadableStudio.Launcher.Journal]::new()
 $tx.State.id=[Guid]::NewGuid().ToString();$tx.State.target='9.9.9';$tx.State.step='complete'
 $tx.State.launchNamespace=$env:CONTEXT_NAMESPACE
 $tx.Claim()
 $helper=$tx.CreateStartInfo((Join-Path $env:CONTEXT_ROOT 'Readable Studio.exe'),'--readable-update-start='+$tx.State.id,$true)
 if(!$tx.LaunchAndWaitReady(10000)){throw 'Real stub relaunch did not write ready receipt'}
 $internal=[IO.File]::ReadAllText((Join-Path $env:CONTEXT_ROOT 'launch-context.json'))|ConvertFrom-Json
 try{$child=[Diagnostics.Process]::GetProcessById($internal.pid);try{if(!$child.WaitForExit(5000)){throw 'Payload did not exit'}}finally{$child.Dispose()}}catch [ArgumentException]{}
 if(!$tx.TryLock()){throw 'Fixture could not reclaim transaction'}
 $tx.Move('old-move','app','app.old');$tx.Rollback()
 $rollback=$tx.CreateStartInfo($payload,'',$true)
 $normal=$tx.CreateStartInfo($payload,'',$false)
 $child=[Diagnostics.Process]::Start($rollback)
 try{if(!$child.WaitForExit(5000)){$child.Kill();throw 'Rollback payload did not exit'}}finally{$child.Dispose()}
 $recovered=[IO.File]::ReadAllText((Join-Path $env:CONTEXT_ROOT 'launch-context.json'))|ConvertFrom-Json
 @{helperNamespace=$helper.EnvironmentVariables['READABLE_PACKAGED_NAMESPACE'];rollbackNamespace=$rollback.EnvironmentVariables['READABLE_PACKAGED_NAMESPACE'];helperExe=$helper.FileName;rollbackExe=$rollback.FileName;internalNamespace=$internal.ns;recoveredNamespace=$recovered.ns;normalNamespace=$normal.EnvironmentVariables['READABLE_PACKAGED_NAMESPACE'];step=$tx.State.step}|ConvertTo-Json -Compress
}finally{$tx.Dispose()}
`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true, timeout: 20000,
      env: { ...process.env, READABLE_PACKAGED_NAMESPACE: 'probe-fix', CONTEXT_ROOT: root, CONTEXT_NAMESPACE: namespace },
    });
    const proof = JSON.parse(stdout);
    expect(proof.helperNamespace).toBe(namespace);
    expect(proof.rollbackNamespace).toBe(namespace);
    expect(proof.internalNamespace).toBe(namespace);
    expect(proof.recoveredNamespace).toBe(namespace);
    expect(proof.normalNamespace).toBe('probe-fix');
    expect(proof.step).toBe('rolled-back');
    expect(proof.helperExe).toBe(join(root, 'Readable Studio.exe'));
    expect(proof.rollbackExe).toBe(join(root, 'app', 'Readable Studio.exe'));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);
