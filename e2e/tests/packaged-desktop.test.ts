import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, test } from 'vitest';
import { hiddenDesktopNativeSource } from '../lib/packaged-hidden-desktop.ts';

test.skipIf(process.platform !== 'win32')('adds only package startup rights to an owned private desktop', async () => {
  const source = `${hiddenDesktopNativeSource}
public static class QaDesktopAclProbe {
 [DllImport("user32.dll",EntryPoint="CreateDesktopW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string n,IntPtr d,IntPtr m,int f,uint a,IntPtr s);
 [DllImport("user32.dll",EntryPoint="OpenDesktopW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string n,uint f,bool i,uint a);
 [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr h,ref uint i,byte[] d,uint s,out uint n);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
 public static IntPtr Create(string name){var h=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero);if(h==IntPtr.Zero)throw new Win32Exception();return h;}
 public static IntPtr Default(){var h=OpenDesktop("Default",0,false,0x20000);if(h==IntPtr.Zero)throw new Win32Exception();return h;}
 public static RawSecurityDescriptor Read(IntPtr h){uint i=7,n;GetUserObjectSecurity(h,ref i,null,0,out n);var b=new byte[n];if(!GetUserObjectSecurity(h,ref i,b,n,out n))throw new Win32Exception();return new RawSecurityDescriptor(b,0);}
 public static void Close(IntPtr h){if(!CloseDesktop(h))throw new Win32Exception();}
}`;
  const script = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${source}
'@
$private=[IntPtr]::Zero;$default=[IntPtr]::Zero
try {
 $private=[QaDesktopAclProbe]::Create('readable-qa-'+[Guid]::NewGuid().ToString())
 $default=[QaDesktopAclProbe]::Default()
 $sections=[Security.AccessControl.AccessControlSections]::All
 $before=[QaDesktopAclProbe]::Read($private)
 $defaultBefore=[QaDesktopAclProbe]::Read($default).GetSddlForm($sections)
 $expected=New-Object Security.AccessControl.RawSecurityDescriptor($before.GetSddlForm($sections))
 $targets=@('S-1-15-2-1','S-1-15-2-2')
 $beforeMasks=@()
 foreach($target in $targets){
  $aces=@($expected.DiscretionaryAcl | Where-Object {$_.AceQualifier -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -eq $target})
  if($aces.Count -ne 1){throw 'Expected one existing package allow ACE per SID'}
  $beforeMasks+=$aces[0].AccessMask
  $aces[0].AccessMask=$aces[0].AccessMask -bor 0x82
 }
 [HiddenRuntime].GetMethod('GrantPackageStartupAccess',[Reflection.BindingFlags]'Static,NonPublic').Invoke($null,@($private))
 $after=[QaDesktopAclProbe]::Read($private)
 if($before.Owner.Value -ne $after.Owner.Value -or $before.Group.Value -ne $after.Group.Value -or $before.ControlFlags -ne $after.ControlFlags){throw 'Owner/group/flags changed'}
 $expectedBytes=New-Object byte[] $expected.DiscretionaryAcl.BinaryLength
 $expected.DiscretionaryAcl.GetBinaryForm($expectedBytes,0)
 $actualBytes=New-Object byte[] $after.DiscretionaryAcl.BinaryLength
 $after.DiscretionaryAcl.GetBinaryForm($actualBytes,0)
 if([Convert]::ToBase64String($expectedBytes) -ne [Convert]::ToBase64String($actualBytes)){throw 'Another DACL entry changed'}
 if([QaDesktopAclProbe]::Read($default).GetSddlForm($sections) -ne $defaultBefore){throw 'Default desktop ACL changed'}
 @{beforeMasks=$beforeMasks;afterMasks=@($after.DiscretionaryAcl | Where-Object {$_.SecurityIdentifier.Value -in $targets} | ForEach-Object {$_.AccessMask});otherAclUnchanged=$true;defaultUnchanged=$true}|ConvertTo-Json -Compress
} finally {
 if($private -ne [IntPtr]::Zero){[QaDesktopAclProbe]::Close($private)}
 if($default -ne [IntPtr]::Zero){[QaDesktopAclProbe]::Close($default)}
}`;
  const root = await mkdtemp(join(tmpdir(), 'packaged-desktop-acl-'));
  try {
    // Generated PowerShell avoids the Windows encoded-command size limit.
    const scriptPath = join(root, 'check.ps1');
    await writeFile(scriptPath, script);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.otherAclUnchanged).toBe(true);
    expect(result.defaultUnchanged).toBe(true);
    expect(result.afterMasks).toEqual(result.beforeMasks.map((mask: number) => mask | 0x82));
  } finally {
    expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
