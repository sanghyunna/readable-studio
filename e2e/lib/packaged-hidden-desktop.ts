import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from '@playwright/test';

export type HiddenDesktopInput = { executablePath: string; namespace: string; debugPort: number };
export type CleanupReceipt = { activeProcesses: number; handlesClosed: boolean; inputDesktop: string };
export type WindowReceipt = { privateWindowPids: number[]; activeOwnedWindowPids: number[]; inputDesktop: string };
export class HiddenLaunchError extends Error {
  constructor(message: string, readonly cleanup: CleanupReceipt, readonly rootPid: number | undefined,
    readonly logs: readonly string[]) {
    super(message);
    this.name = 'HiddenLaunchError';
  }
}
export type HiddenDesktop = {
  rootPid: number;
  hostPid: number;
  hostProcess: ChildProcessWithoutNullStreams;
  /** Opaque handles owned by hostPid, never valid handles in the JS process. */
  nativeHandles: { process: string; thread: string; desktop: string; job: string };
  desktopName: string;
  inputDesktopBefore: string;
  inputDesktopAfter: string;
  cdpEndpoint: string;
  page: Page;
  logs: string[];
  inspectWindows(): Promise<WindowReceipt>;
  close(): Promise<CleanupReceipt>;
};

// The host retains the native handles. A suspended child enters the job before it
// can create descendants; closing that job contains failures of the JS driver too.
export const hiddenDesktopNativeSource = String.raw`
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public class HiddenRuntime {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SI {
  public int cb; public string reserved,desktop,title; public int x,y,cx,cy,xc,yc,fill,flags;
  public short show,cb2; public IntPtr reserved2,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public int pid,tid;}
 [StructLayout(LayoutKind.Sequential)] public struct SA {public int length;public IntPtr security;public int inherit;}
 [StructLayout(LayoutKind.Sequential)] public struct BASIC {
  public long perProcess,perJob;public uint flags;public UIntPtr min,max;public uint active;
  public UIntPtr affinity;public uint priority,scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] public struct IO {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] public struct LIMIT {
  public BASIC basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
 }
 [StructLayout(LayoutKind.Sequential)] public struct PORT {public IntPtr key,port;}
 [DllImport("user32.dll",EntryPoint="CreateDesktopW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern IntPtr CreateDesktop(string n,IntPtr d,IntPtr m,int f,uint a,IntPtr s);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint a);
 [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool ObjectInfo(IntPtr h,int index,StringBuilder b,uint length,out uint needed);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr h,ref uint information,byte[] descriptor,uint size,out uint needed);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetUserObjectSecurity(IntPtr h,ref uint information,byte[] descriptor);
 delegate bool WindowCallback(IntPtr window,IntPtr parameter);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr desktop,WindowCallback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool belongs);
 [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int c,IntPtr info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attrs,uint size);
 [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,IntPtr key,uint count);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint code,out IntPtr key,out IntPtr overlapped,uint ms);
 IntPtr desktop,job,port,reader,writer; PI child; bool assigned;
 public int Pid {get{return child.pid;}}
 public string ProcessHandle {get{return child.process.ToString();}}
 public string ThreadHandle {get{return child.thread.ToString();}}
 public string DesktopHandle {get{return desktop.ToString();}}
 public string JobHandle {get{return job.ToString();}}
 public int[] WindowPids(bool active) {
  IntPtr h=active?OpenInputDesktop(0,false,0x41):desktop;
  Check(h!=IntPtr.Zero,"OpenInputDesktop");
  try {
   var pids=new HashSet<int>();
   Check(EnumDesktopWindows(h,(window,parameter)=>{
    uint pid;GetWindowThreadProcessId(window,out pid);
    if(!active){pids.Add((int)pid);return true;}
    IntPtr process=OpenProcess(0x1000,false,pid);
    if(process!=IntPtr.Zero)try {
     bool belongs;Check(IsProcessInJob(process,job,out belongs),"IsProcessInJob");
     if(belongs)pids.Add((int)pid);
    } finally {CloseHandle(process);}
    return true;
   },IntPtr.Zero),"EnumDesktopWindows");
   var result=new int[pids.Count];pids.CopyTo(result);return result;
  } finally {if(active)CloseDesktop(h);}
 }
 public static string InputDesktop() {
  IntPtr h=OpenInputDesktop(0,false,1); if(h==IntPtr.Zero)throw new Win32Exception();
  try{uint needed;var b=new StringBuilder(512);if(!ObjectInfo(h,2,b,1024,out needed))throw new Win32Exception();return b.ToString();}
  finally{CloseDesktop(h);}
 }
 static void Check(bool ok,string label){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),label);}
 static void GrantPackageStartupAccess(IntPtr desktop) {
  uint information=4,needed;
  GetUserObjectSecurity(desktop,ref information,null,0,out needed);
  var bytes=new byte[needed];
  Check(GetUserObjectSecurity(desktop,ref information,bytes,needed,out needed),"GetUserObjectSecurity");
  var descriptor=new RawSecurityDescriptor(bytes,0);
  foreach(var sid in new[]{"S-1-15-2-1","S-1-15-2-2"}) {
   CommonAce target=null;
   foreach(GenericAce entry in descriptor.DiscretionaryAcl) {
    var ace=entry as CommonAce;
    if(ace!=null && ace.AceQualifier==AceQualifier.AccessAllowed && ace.SecurityIdentifier.Value==sid) {
     if(target!=null)throw new InvalidOperationException("Ambiguous package desktop ACL");
     target=ace;
    }
   }
   if(target==null)throw new InvalidOperationException("Missing package desktop ACL");
   // AppContainer startup needs CREATEWINDOW and WRITEOBJECTS on our desktop.
   target.AccessMask|=0x82;
  }
  bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
  Check(SetUserObjectSecurity(desktop,ref information,bytes),"SetUserObjectSecurity");
 }
 void JobInfo<T>(int kind,T info) {
  int size=Marshal.SizeOf(info);IntPtr p=Marshal.AllocHGlobal(size);
  try{Marshal.StructureToPtr(info,p,false);Check(SetInformationJobObject(job,kind,p,(uint)size),"SetInformationJobObject");}
  finally{Marshal.FreeHGlobal(p);}
 }
 public void Start(string exe,string name,string cwd,int debugPort) {
  desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero);
  Check(desktop!=IntPtr.Zero,"CreateDesktopW");
  GrantPackageStartupAccess(desktop);
  job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"CreateJobObject");
  var limit=new LIMIT();limit.basic.flags=0x2000;JobInfo(9,limit);
  port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1);
  Check(port!=IntPtr.Zero,"CreateIoCompletionPort");JobInfo(7,new PORT{key=new IntPtr(1),port=port});
  var sa=new SA{length=Marshal.SizeOf(typeof(SA)),inherit=1};
  Check(CreatePipe(out reader,out writer,ref sa,0),"CreatePipe");
  Check(SetHandleInformation(reader,1,0),"SetHandleInformation");
  var si=new SI{cb=Marshal.SizeOf(typeof(SI)),desktop="winsta0\\"+name,flags=0x100,output=writer,error=writer};
  var cmd=new StringBuilder("\""+exe+"\" --remote-debugging-port="+debugPort+" --enable-logging=stderr");
  Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,4,IntPtr.Zero,cwd,ref si,out child),"CreateProcessW");
  Check(AssignProcessToJobObject(job,child.process),"AssignProcessToJobObject");assigned=true;
  CloseHandle(writer);writer=IntPtr.Zero;
  var pipe=reader;reader=IntPtr.Zero;
  var pump=new Thread(()=>{try{using(var stream=new FileStream(new SafeFileHandle(pipe,true),FileAccess.Read))
   using(var text=new StreamReader(stream)){string line;while((line=text.ReadLine())!=null)Console.WriteLine("LOG "+line);}}catch(IOException){}});
  pump.IsBackground=true;pump.Start();
  Check(ResumeThread(child.thread)!=0xffffffff,"ResumeThread");
 }
 public bool Close() {
  bool ok=true;
  if(assigned) {
   ok=TerminateJobObject(job,0)&&ok;
   uint code;IntPtr key,overlapped;bool zero=false;
   var deadline=DateTime.UtcNow.AddSeconds(15);
   while(DateTime.UtcNow<deadline && GetQueuedCompletionStatus(port,out code,out key,out overlapped,15000)) {
    if(code==4){zero=true;break;}
   }
   ok=zero&&ok;
  } else if(child.process!=IntPtr.Zero){TerminateProcess(child.process,1);ok=WaitForSingleObject(child.process,15000)==0&&ok;}
  foreach(var h in new[]{child.thread,child.process,writer,reader,job,port})if(h!=IntPtr.Zero)ok=CloseHandle(h)&&ok;
  if(desktop!=IntPtr.Zero)ok=CloseDesktop(desktop)&&ok;
  return ok;
 }
}
`;

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

export async function waitForCdpEndpoint(debugPort: number, signal: AbortSignal): Promise<string> {
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error',
      });
      if (response.ok) {
        const body = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof body?.webSocketDebuggerUrl === 'string') {
          const endpoint = new URL(body.webSocketDebuggerUrl);
          if (endpoint.protocol === 'ws:' && endpoint.hostname === '127.0.0.1' && Number(endpoint.port) === debugPort) return endpoint.href;
        }
      }
    } catch { signal.throwIfAborted(); }
    await delay(250, undefined, { signal });
  }
}

export async function launchHiddenDesktop(input: HiddenDesktopInput): Promise<HiddenDesktop> {
  if (process.platform !== 'win32') throw new Error('Private desktops require Windows');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,70}$/.test(input.namespace)) throw new Error('Invalid private namespace');
  if (!Number.isInteger(input.debugPort) || input.debugPort < 1 || input.debugPort > 65535) throw new Error('Invalid debug port');
  const executablePath = resolve(input.executablePath);
  if (!(await stat(executablePath)).isFile()) throw new Error('Executable is not a file');
  const probe = createServer();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(input.debugPort, '127.0.0.1', done);
  });
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  const desktopName = `readable-qa-${randomUUID()}`;
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
${hiddenDesktopNativeSource}
'@
$runtime=New-Object HiddenRuntime
$failure=$null
try {
 $before=[HiddenRuntime]::InputDesktop()
 $env:READABLE_PACKAGED_NAMESPACE=${quote(input.namespace)}
 $runtime.Start(${quote(executablePath)},${quote(desktopName)},${quote(dirname(executablePath))},${input.debugPort})
 [Console]::WriteLine(('START '+(@{rootPid=$runtime.Pid;before=$before;after=[HiddenRuntime]::InputDesktop();handles=@{process=$runtime.ProcessHandle;thread=$runtime.ThreadHandle;desktop=$runtime.DesktopHandle;job=$runtime.JobHandle}}|ConvertTo-Json -Depth 3 -Compress)))
 while(($command=[Console]::ReadLine()) -eq 'inspect') {
  [Console]::WriteLine(('WINDOWS '+(@{privateWindowPids=@($runtime.WindowPids($false));activeOwnedWindowPids=@($runtime.WindowPids($true));inputDesktop=[HiddenRuntime]::InputDesktop()}|ConvertTo-Json -Compress)))
 }
} catch { $failure=$_.Exception.ToString(); [Console]::WriteLine(('FAIL '+$failure.Replace("\`r",' ').Replace("\`n",' '))) }
finally {
 $closed=$runtime.Close()
 [Console]::WriteLine(('CLOSED '+(@{activeProcesses=$(if($closed){0}else{-1});handlesClosed=$closed;inputDesktop=[HiddenRuntime]::InputDesktop()}|ConvertTo-Json -Compress)))
}
if($failure -or -not $closed){exit 1}`;
  const host = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const logs: string[] = [];
  let browser: Browser | undefined;
  let cleanup: CleanupReceipt | undefined;
  let failure = '';
  let started: { rootPid: number; before: string; after: string; handles: HiddenDesktop['nativeHandles'] } | undefined;
  let endpoint: string | undefined;
  const endpointAbort = new AbortController();
  let startResolve: () => void;
  const start = new Promise<void>((done) => { startResolve = done; });
  const lines = createInterface({ input: host.stdout });
  lines.on('line', line => {
    logs.push(line);
    if (line.startsWith('START ')) {
      started = JSON.parse(line.slice(6));
      startResolve();
    }
    if (line.startsWith('CLOSED ')) cleanup = JSON.parse(line.slice(7));
    if (line.startsWith('FAIL ')) failure = line.slice(5);
  });
  host.stderr.on('data', data => logs.push(String(data)));
  const exited = new Promise<void>((done, reject) => {
    host.once('error', reject);
    host.once('close', () => done());
  });
  let closing: Promise<CleanupReceipt> | undefined;
  const close = () => closing ??= (async () => {
    endpointAbort.abort();
    // Disconnect CDP first; the native host, not Chromium, owns tree shutdown.
    if (browser) {
      await bounded(browser.close(), 10_000, 'CDP disconnect timed out')
        .catch(error => { logs.push(`DISCONNECT ${String(error)}`); });
    }
    if (host.exitCode === null) host.stdin.end('\n');
    try {
      await bounded(exited, 25_000, 'Hidden host cleanup timed out');
    } catch (error) {
      // Closing the host's last job handle kills only this contained tree even
      // if native shutdown cannot return its receipt.
      host.kill();
      await bounded(exited, 10_000, 'Hidden host termination timed out');
      throw error;
    }
    lines.close();
    if (!cleanup?.handlesClosed || cleanup.activeProcesses !== 0) {
      throw new Error(`Private desktop cleanup failed: ${JSON.stringify({ cleanup, logs })}`);
    }
    return cleanup;
  })();
  const inspectWindows = async (): Promise<WindowReceipt> => {
    if (closing || host.exitCode !== null) throw new Error('Private desktop is closed');
    let onLine: (line: string) => void;
    const response = new Promise<WindowReceipt>((done) => {
      onLine = line => { if (line.startsWith('WINDOWS ')) done(JSON.parse(line.slice(8))); };
      lines.on('line', onLine);
    });
    host.stdin.write('inspect\n');
    try {
      return await bounded(Promise.race([response, exited.then(() => {
        throw new Error(failure || 'Hidden host exited during window inspection');
      })]), 10_000, 'Window inspection timed out');
    } finally { lines.off('line', onLine!); }
  };
  try {
    const timeout = Number(process.env.READABLE_HIDDEN_TIMEOUT_MS ?? 120_000);
    // Native compilation/launch is separate from the CDP availability deadline.
    await bounded(Promise.race([start, exited.then(() => { throw new Error(failure || logs.join('\n')); })]),
      30_000, 'Native launch timed out');
    endpoint = await bounded(Promise.race([waitForCdpEndpoint(input.debugPort, endpointAbort.signal),
      exited.then(() => { throw new Error(failure || logs.join('\n')); })]),
      timeout, 'CDP readiness timed out');
    browser = await chromium.connectOverCDP(endpoint!, { timeout });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Packaged CDP has no browser context');
    const page = await bounded(new Promise<Page>((done) => {
      const observed = new Set<Page>();
      const accept = (candidate: Page) => {
        if (!candidate.url().startsWith('readable-studio://app/')) return;
        context.off('page', watch);
        for (const p of observed) p.off('framenavigated', changed);
        done(candidate);
      };
      const changed = () => { for (const p of observed) accept(p); };
      const watch = (p: Page) => { observed.add(p); p.on('framenavigated', changed); accept(p); };
      context.on('page', watch);
      context.pages().forEach(watch);
    }), timeout, 'Packaged main page readiness timed out');
    await page.locator('html[data-readable-app-mounted="1"]').waitFor({ state: 'attached', timeout });
    return { rootPid: started!.rootPid, hostPid: host.pid!, hostProcess: host,
      nativeHandles: started!.handles, desktopName,
      inputDesktopBefore: started!.before, inputDesktopAfter: started!.after,
      cdpEndpoint: endpoint!, page, logs, inspectWindows, close };
  } catch (error) {
    const receipt = await close();
    throw new HiddenLaunchError(`Hidden readiness failed: ${String(error)}; ${JSON.stringify(receipt)}`,
      receipt, started?.rootPid, logs);
  }
}
