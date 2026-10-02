import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { prepareUpdateLayout } from '../src/win/update-layout.js';

describe('real update helper acknowledgment', () => {
  it('owns its journal and survives both the broker and its Node parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'update-handoff-'));
    const id = randomUUID();
    try {
      await mkdir(join(root, 'app'));
      await mkdir(join(root, 'app.staging'));
      await writeFile(join(root, 'app', 'Readable Studio.exe'), 'old fixture');
      await writeFile(join(root, 'app.staging', 'Readable Studio.exe'), 'new fixture');
      await prepareUpdateLayout(join(import.meta.dirname, '..', '..', '..'), root);
      const node = `const{spawn}=require('node:child_process');const{watch,readFileSync}=require('node:fs');const path=require('node:path');const root=process.env.HANDOFF_ROOT;const w=watch(root,check);const timeout=setTimeout(()=>{throw Error('helper acknowledgment timeout')},15000);function check(){try{const ready=JSON.parse(readFileSync(path.join(root,'update-helper-ready.json'),'utf8'));if(ready.id===process.env.READABLE_UPDATE_HANDOFF_ID){clearTimeout(timeout);w.close();process.exit(0)}}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e}}const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(root,'app/resources/update-helper/update-broker.ps1'),'-Root',root,'-Staging',path.join(root,'app.staging'),'-TargetVersion','9.9.9','-WaitPid',String(process.pid)],{windowsHide:true,stdio:'ignore',cwd:root,env:{...process.env,READABLE_PACKAGED_NAMESPACE:'f-update-test'}});p.unref();check();`;
      const script = `
$ErrorActionPreference='Stop'
$hit=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,'Local\\ReadableUpdateCheckpoint-'+$env:READABLE_UPDATE_TEST_ID)
$release=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,'Local\\ReadableUpdateRelease-'+$env:READABLE_UPDATE_TEST_ID)
$parent=$null;$helper=$null
try {
 $info=[Diagnostics.ProcessStartInfo]::new($env:HANDOFF_NODE);$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.Arguments='-e '+('"'+$env:HANDOFF_CODE.Replace('"','\"')+'"')
 $parent=[Diagnostics.Process]::Start($info)
 if(!$hit.WaitOne(15000)){
  foreach($name in @('update-broker.log','update-error.log','update-broker-error.log','update-helper-ready.json','update-journal.json')){$path=Join-Path $env:HANDOFF_ROOT $name;if([IO.File]::Exists($path)){Write-Output ($name+': '+[IO.File]::ReadAllText($path))}}
  throw 'Helper did not claim prepared journal'
 }
 $journal=[IO.File]::ReadAllText((Join-Path $env:HANDOFF_ROOT 'update-journal.json'))|ConvertFrom-Json
 $ready=[IO.File]::ReadAllText((Join-Path $env:HANDOFF_ROOT 'update-helper-ready.json'))|ConvertFrom-Json
 $helper=[Diagnostics.Process]::GetProcessById($journal.pid)
 if(!$parent.WaitForExit(15000)){throw 'Node did not acknowledge helper'}
 @{parentExit=$parent.ExitCode;helperAlive=(!$helper.HasExited);ready=$ready;journal=$journal}|ConvertTo-Json -Compress -Depth 8
}finally{if($helper -and !$helper.HasExited){$helper.Kill();[void]$helper.WaitForExit(5000)};if($parent -and !$parent.HasExited){$parent.Kill();[void]$parent.WaitForExit(5000)};$hit.Dispose();$release.Dispose()}
`;
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, env: { ...process.env, READABLE_PACKAGED_NAMESPACE: 'f-update-test', READABLE_UPDATE_TEST_POINT: 'prepared', READABLE_UPDATE_TEST_ID: id, READABLE_UPDATE_HANDOFF_ID: id, HANDOFF_ROOT: root, HANDOFF_NODE: process.execPath, HANDOFF_CODE: node } }).catch(error => { console.error(error.stdout); throw error; });
      const proof = JSON.parse(result.stdout);
      expect(proof.parentExit).toBe(0);
      expect(proof.helperAlive).toBe(true);
      expect(proof.ready).toMatchObject({ id, pid: proof.journal.pid });
      expect(proof.journal).toMatchObject({ id, step: 'prepared', target: '9.9.9' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 40_000);
});
