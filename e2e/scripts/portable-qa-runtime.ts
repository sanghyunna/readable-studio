import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import {
  canonicalProductName,
  PortableQaError,
  runCommand,
  toRecord,
  workspaceRoot,
  verifyZipReceipt,
  type CommandResult,
  type Options,
} from './portable-qa-support.ts';

const sevenZipPath = join(workspaceRoot, 'tools', 'pack', 'resources', 'win', '7zip', '7z.exe');

/**
 * Run the entire legacy Electron driver on a private desktop, so its native
 * Electron handles and every descendant inherit that desktop. Like the shared
 * packaged-hidden-desktop host, assign the suspended child to a kill-on-close
 * job before resuming it; windowsHide alone does not isolate GUI windows.
 */
export async function runPortableQaHidden(
  args: readonly string[],
  evidenceRoot: string,
  command = process.execPath,
  commandArgs = [...process.execArgv, join(workspaceRoot, 'e2e/scripts/portable-qa.ts'), ...args],
  logPath = `${evidenceRoot}.hidden-desktop.log`,
): Promise<number> {
  assert.equal(process.platform, 'win32', 'portable QA requires a Windows private desktop');
  await mkdir(evidenceRoot, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const argv = [command, ...commandArgs].map((value) =>
    `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(' ');
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public class PortableQaDesktop {
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
 [DllImport("kernel32.dll",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr h,int c,ref LIMIT info,uint size);
 [DllImport("kernel32.dll",EntryPoint="SetInformationJobObject")] static extern bool SetJobPort(IntPtr h,int c,ref PORT info,uint size);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attrs,uint size);
 [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr existing,IntPtr key,uint count);
 [DllImport("kernel32.dll")] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint code,out IntPtr key,out IntPtr overlapped,uint ms);
 IntPtr desktop,job,port,reader,writer; PI child; bool assigned;
 public int Pid {get{return child.pid;}}
 static void Check(bool value,string label){if(!value)throw new Win32Exception(Marshal.GetLastWin32Error(),label);}
 public static string InputDesktop() {
  IntPtr h=OpenInputDesktop(0,false,1);Check(h!=IntPtr.Zero,"OpenInputDesktop");
  try{uint needed;var b=new StringBuilder(512);Check(ObjectInfo(h,2,b,1024,out needed),"GetUserObjectInformation");return b.ToString();}
  finally{CloseDesktop(h);}
 }
 public void Start(string exe,string args,string name,string cwd) {
  desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x10000000,IntPtr.Zero);Check(desktop!=IntPtr.Zero,"CreateDesktop");
  job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"CreateJobObject");
  var limit=new LIMIT();limit.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)),"SetInformationJobObject");
  port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1);Check(port!=IntPtr.Zero,"CreateIoCompletionPort");
  var completion=new PORT{key=new IntPtr(1),port=port};Check(SetJobPort(job,7,ref completion,(uint)Marshal.SizeOf(completion)),"SetJobPort");
  var sa=new SA{length=Marshal.SizeOf(typeof(SA)),inherit=1};
  Check(CreatePipe(out reader,out writer,ref sa,0),"CreatePipe");Check(SetHandleInformation(reader,1,0),"SetHandleInformation");
  var si=new SI{cb=Marshal.SizeOf(typeof(SI)),desktop="winsta0\\\\"+name,flags=0x100,output=writer,error=writer};
  Check(CreateProcess(exe,new StringBuilder(args),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out child),"CreateProcess");
  Check(AssignProcessToJobObject(job,child.process),"AssignProcessToJobObject");assigned=true;
  CloseHandle(writer);writer=IntPtr.Zero;
  var pipe=reader;reader=IntPtr.Zero;
  var pump=new Thread(()=>{try{using(var stream=new FileStream(new SafeFileHandle(pipe,true),FileAccess.Read))
   using(var text=new StreamReader(stream)){string line;while((line=text.ReadLine())!=null)Console.WriteLine(line);}}catch(IOException){}});
  pump.IsBackground=true;pump.Start();
  Check(ResumeThread(child.thread)!=0xffffffff,"ResumeThread");
 }
 public bool Running(){return WaitForSingleObject(child.process,1000)==258;}
 public uint ExitCode(){uint code;Check(GetExitCodeProcess(child.process,out code),"GetExitCodeProcess");return code;}
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
  }
  else if(child.process!=IntPtr.Zero)ok=TerminateProcess(child.process,1)&&ok;
  foreach(var h in new[]{child.thread,child.process,writer,reader,job,port})if(h!=IntPtr.Zero)ok=CloseHandle(h)&&ok;
  if(desktop!=IntPtr.Zero)ok=CloseDesktop(desktop)&&ok;
  return ok;
 }
}
'@
$runtime=New-Object PortableQaDesktop
$exitCode=1
$desktop='readable-qa-'+[Guid]::NewGuid().ToString()
$before=[PortableQaDesktop]::InputDesktop()
$env:READABLE_PORTABLE_QA_PRIVATE_DESKTOP=$desktop
function Observe-Windows {
 $visible=@(Get-Process -Name 'Readable Studio' -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {@{pid=$_.Id;handle=$_.MainWindowHandle.ToInt64();title=$_.MainWindowTitle}})
 [Console]::WriteLine(('QA_WINDOWS '+(@{ts=[DateTime]::UtcNow.ToString('o');visible=$visible;inputDesktop=[PortableQaDesktop]::InputDesktop()}|ConvertTo-Json -Depth 4 -Compress)))
 if($visible.Count -ne 0){throw 'Readable Studio has a nonzero MainWindowHandle on the input desktop'}
}
try {
 Observe-Windows
 $runtime.Start(${quote(command)},${quote(argv)},$desktop,${quote(workspaceRoot)})
 [Console]::WriteLine(('QA_DESKTOP_STARTED '+(@{desktop=$desktop;rootPid=$runtime.Pid;inputDesktop=$before}|ConvertTo-Json -Compress)))
 $nextObservation=[DateTime]::UtcNow
 while($runtime.Running()){
  if([DateTime]::UtcNow -ge $nextObservation){
   Observe-Windows
   $nextObservation=[DateTime]::UtcNow.AddSeconds(10)
  }
 }
 Observe-Windows
 $exitCode=$runtime.ExitCode()
} catch {[Console]::Error.WriteLine($_.Exception.ToString())}
finally {
 $closed=$runtime.Close()
 $after=[PortableQaDesktop]::InputDesktop()
 [Console]::WriteLine(('QA_DESKTOP_CLOSED '+(@{handlesClosed=$closed;activeProcesses=$(if($closed){0}else{-1});inputDesktopBefore=$before;inputDesktopAfter=$after;exitCode=$exitCode}|ConvertTo-Json -Compress)))
 if(-not $closed -or $before -ne $after){$exitCode=1}
}
exit $exitCode
`;
  const host = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logWork = Promise.resolve();
  const log = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    logWork = logWork.then(() => appendFile(logPath, text));
  };
  host.stdout.on('data', log);
  host.stderr.on('data', log);
  try {
    return await new Promise<number>((resolveExit, reject) => {
      host.once('error', reject);
      host.once('close', (code) => resolveExit(code ?? 1));
    });
  } finally { await logWork; }
}

export function portableAppRoot(root: string): string {
  return existsSync(join(root, 'app', `${canonicalProductName}.exe`)) ? join(root, 'app') : root;
}

// Subscribe before launching: the launcher exits after handing off to Electron,
// so its exit code alone cannot prove desktop readiness.
export async function waitForLauncherReady(
  root: string,
  logPath: string,
  start: () => void,
  timeoutMs = 180_000,
): Promise<string> {
  return new Promise<string>((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error?: Error, text = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error != null) rejectReady(error);
      else resolveReady(text);
    };
    const watcher = watch(root, { recursive: true }, () => {
      void readFile(logPath, 'utf8').then((text) => {
        if (text.includes('daemon-status-ready') && text.includes('main window revealed')) finish(undefined, text);
      }, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') finish(error);
      });
    });
    watcher.on('error', finish);
    const timeout = setTimeout(() => finish(new PortableQaError('launcher readiness timed out')), timeoutMs);
    try { start(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function runLauncherSmokeDriver(root: string, env: Record<string, string>): Promise<void> {
  const logPath = join(root, 'ReadableStudioData', 'namespaces', env.READABLE_PACKAGED_NAMESPACE!,
    'logs', 'desktop', 'latest.log');
  let pid: number | undefined;
  const log = await waitForLauncherReady(root, logPath, () => {
    const child = spawn(join(root, `${canonicalProductName}.exe`), [], {
      cwd: root, env, windowsHide: true, stdio: 'ignore',
    });
    pid = child.pid;
    child.once('error', (error) => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
    child.once('exit', (code) => {
      if (code !== 0) { process.stderr.write(`launcher exited ${code}\n`); process.exit(1); }
    });
  });
  process.stdout.write(`${JSON.stringify({ launcherPid: pid, logPath, log, status: 'passed' })}\n`);
  // The private-desktop host owns the suspended driver's PID and Job Object.
  // On driver exit it terminates only that job and waits for zero descendants.
}

export async function smokePortableLauncher(root: string, evidenceRoot: string, trap: NetworkTrap, offline: boolean, namespace: string): Promise<void> {
  const entry = pathToFileURL(join(workspaceRoot, 'e2e/scripts/portable-qa-runtime.ts')).href;
  const driver = `import {runLauncherSmokeDriver,launchEnvironment} from ${JSON.stringify(entry)}; await runLauncherSmokeDriver(${JSON.stringify(root)}, await launchEnvironment(${JSON.stringify(namespace)},{proxyUrl:${JSON.stringify(trap.proxyUrl)}},${offline},${JSON.stringify(root)}));`;
  const exitCode = await runPortableQaHidden([], join(evidenceRoot, 'launcher-smoke'), process.execPath,
    [...process.execArgv, '--input-type=module', '-e', driver], join(evidenceRoot, 'launcher-smoke', 'hidden-desktop.log'));
  assert.equal(exitCode, 0, 'top-level portable launcher smoke failed');
}

export type NetworkAttempt = {
  bytes: number;
  firstData: string;
  remoteAddress: string | undefined;
};

export type NetworkTrap = {
  readonly attempts: NetworkAttempt[];
  readonly proxyUrl: string;
  close(): Promise<void>;
};

export type AppCapture = {
  readonly app: ElectronApplication;
  readonly consoleMessages: string[];
  readonly namespace: string;
  readonly networkRequests: string[];
  readonly page: Page;
};

type ProcessRecord = {
  readonly commandLine: string;
  readonly executablePath: string;
  readonly name: string;
  readonly pid: number;
  readonly parentPid: number;
};

type ConnectionRecord = {
  readonly localAddress: string;
  readonly localPort: number;
  readonly owningProcess: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: string;
};

export type ProcessEvidence = {
  readonly connections: readonly ConnectionRecord[];
  readonly processes: readonly ProcessRecord[];
};

export async function extractPortable(zipPath: string, command = runCommand): Promise<string> {
  const archive = await stat(zipPath);
  assert.ok(archive.isFile(), `portable ZIP is not a file: ${zipPath}`);
  const extractionRoot = await mkdtemp(join(tmpdir(), 'readable-task30-portable-'));
  const result = await command(sevenZipPath, ['x', zipPath, `-o${extractionRoot}`, '-y']);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const executablePath = join(extractionRoot, `${canonicalProductName}.exe`);
  assert.ok((await stat(executablePath)).isFile(), `missing ${executablePath}`);
  return extractionRoot;
}

export async function assertPristinePortableRoot(root: string): Promise<void> {
  assert.ok((await stat(join(root, `${canonicalProductName}.exe`))).isFile(), 'missing top-level portable launcher');
  const data = await stat(join(root, 'ReadableStudioData')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(data, null, 'ReadableStudioData must not exist before launch');
}

export async function copySealedPortableTree(tree: string, manifestPath: string): Promise<string> {
  await assertPristinePortableRoot(tree);
  const manifest = toRecord(JSON.parse(await readFile(manifestPath, 'utf8')), 'sealed manifest');
  assert.ok(manifest.v === 1 && Array.isArray(manifest.files), 'invalid sealed manifest');
  const root = await mkdtemp(join(tmpdir(), 'readable-tree-precheck-'));
  const copy = async (value: unknown) => {
    const file = toRecord(value, 'sealed file');
    assert.equal(typeof file.path, 'string');
    const path = String(file.path);
    const destination = resolve(root, path);
    const rel = relative(root, destination);
    assert.ok(!isAbsolute(path) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'sealed path escapes private tree');
    await mkdir(dirname(destination), { recursive: true });
    // copyFile deliberately does not link, even when the source is a cache link.
    await copyFile(join(tree, path), destination);
    await chmod(destination, 0o666);
  };
  for (let offset = 0; offset < manifest.files.length; offset += 20) {
    await Promise.all(manifest.files.slice(offset, offset + 20).map(copy));
  }
  await assertPristinePortableRoot(root);
  return root;
}

export async function preparePortableQaRoot(options: Options): Promise<string> {
  process.stdout.write(`[portable-qa] preparing ${options.mode ?? 'legacy'} private root\n`);
  const zipHash = options.mode === 'zip-gate'
    ? await verifyZipReceipt(options.zipPath, options.zipReceiptPath!, options.runId!)
    : null;
  const root = options.mode === 'tree-precheck'
    ? await copySealedPortableTree(options.treePath!, options.sealedManifestPath!)
    : await extractPortable(options.zipPath);
  process.stdout.write(`[portable-qa] private root ready: ${root}\n`);
  if (options.mode != null) {
    await assertPristinePortableRoot(root);
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const result = await runCommand(process.execPath, [
      tsx, join(workspaceRoot, 'tools', 'pack', 'scripts', 'content-manifest.ts'),
      '--expected-json', options.sealedManifestPath!, '--actual-root', root,
      '--out-json', join(options.evidenceRoot, 'extracted-inventory.json'),
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    process.stdout.write('[portable-qa] sealed content inventory passed\n');
  }
  if (zipHash != null) {
    assert.equal(await verifyZipReceipt(options.zipPath, options.zipReceiptPath!, options.runId!), zipHash, 'ZIP changed during extraction');
  }
  return root;
}

export async function createNetworkTrap(): Promise<NetworkTrap> {
  const attempts: NetworkAttempt[] = [];
  const server: Server = createServer((socket) => {
    const attempt: NetworkAttempt = { bytes: 0, firstData: '', remoteAddress: socket.remoteAddress };
    attempts.push(attempt);
    // A denied/cancelled proxy connection may reset. Keep the attempt as a
    // failing offline observable rather than crashing the evidence driver.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      process.stderr.write(`[portable-qa] proxy socket ${error.code}: ${JSON.stringify(attempt)}\n`);
    });
    socket.once('data', (chunk: Buffer) => {
      attempt.bytes = chunk.length;
      attempt.firstData = chunk.toString('utf8', 0, 512);
      process.stderr.write(`[portable-qa] proxy attempt: ${JSON.stringify(attempt)}\n`);
      socket.destroy();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new PortableQaError('network trap did not bind');
  return {
    attempts,
    proxyUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error == null ? resolveClose() : rejectClose(error));
    }),
  };
}

export async function launchEnvironment(namespace: string, trap: NetworkTrap, offline: boolean, extractionRoot: string): Promise<Record<string, string>> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
  let environment = inherited;
  if (offline) {
    // Keep only OS inputs: host CLI overrides, credentials and toolchain paths
    // must not influence the strict zero-traffic offline acceptance run.
    const systemKeys = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS',
      'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS']);
    const system = Object.fromEntries(Object.entries(inherited).filter(([key]) => systemKeys.has(key.toUpperCase())));
    const windows = system.SystemRoot ?? system.SYSTEMROOT;
    assert.ok(windows, 'SystemRoot is required for offline Windows QA');
    const home = join(extractionRoot, '.qa-home', namespace);
    const roaming = join(home, 'roaming');
    const local = join(home, 'local');
    const temp = join(home, 'temp');
    await Promise.all([home, roaming, local, temp].map((path) => mkdir(path, { recursive: true })));
    environment = {
      ...system,
      HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
      TEMP: temp, TMP: temp, TMPDIR: temp,
      PATH: [join(windows, 'System32'), windows, join(windows, 'System32', 'Wbem'),
        join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    };
  }
  return {
    ...environment,
    READABLE_DESKTOP_LOG_ECHO: '1',
    READABLE_PACKAGED_NAMESPACE: namespace,
    ...(offline ? {
      ALL_PROXY: trap.proxyUrl,
      HTTP_PROXY: trap.proxyUrl,
      HTTPS_PROXY: trap.proxyUrl,
      NO_PROXY: '127.0.0.1,localhost',
    } : {}),
  };
}

function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  return new Promise<Page>((resolveWindow, rejectWindow) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      app.off('window', observeWindow);
      rejectWindow(new PortableQaError('timed out waiting for the packaged main window'));
    }, 600_000);
    const accept = (page: Page) => {
      if (settled || !page.url().startsWith('readable-studio://app/')) return;
      settled = true;
      clearTimeout(timeout);
      app.off('window', observeWindow);
      resolveWindow(page);
    };
    const observeWindow = (page: Page) => {
      accept(page);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) accept(page);
      });
    };
    app.on('window', observeWindow);
    for (const page of app.windows()) observeWindow(page);
  });
}

export async function launchPortable(extractionRoot: string, namespace: string, trap: NetworkTrap, offline: boolean): Promise<AppCapture> {
  const consoleMessages: string[] = [];
  const networkRequests: string[] = [];
  const app = await electron.launch({
    executablePath: join(portableAppRoot(extractionRoot), `${canonicalProductName}.exe`),
    env: await launchEnvironment(namespace, trap, offline, extractionRoot),
    timeout: 180_000,
  });
  app.on('console', (message) => consoleMessages.push(`[main:${message.type()}] ${message.text()}`));
  try {
    const page = await waitForMainWindow(app);
    page.on('console', (message) => consoleMessages.push(`[renderer:${message.type()}] ${message.text()}`));
    page.on('request', (request) => networkRequests.push(request.url()));
    await page.waitForFunction((expectedTitle) => document.title === expectedTitle, canonicalProductName, { timeout: 600_000 });
    await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: 600_000 });
    assert.ok((await stat(join(extractionRoot, 'ReadableStudioData', 'namespaces', namespace))).isDirectory(),
      'portable data must be created in the private extraction directory');
    return { app, consoleMessages, namespace, networkRequests, page };
  } catch (error) {
    await closePortable(app);
    throw error;
  }
}

export async function captureProcesses(rootPid: number): Promise<ProcessEvidence> {
  const script = [
    `$root=${rootPid}`,
    '$all=@(Get-CimInstance Win32_Process)',
    '$ids=New-Object System.Collections.Generic.HashSet[int]',
    '[void]$ids.Add($root)',
    'do { $before=$ids.Count; foreach($p in $all){ if($ids.Contains([int]$p.ParentProcessId)){[void]$ids.Add([int]$p.ProcessId)} } } while($ids.Count -gt $before)',
    '$processes=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}})',
    '$connections=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$ids.Contains([int]$_.OwningProcess)} | ForEach-Object {@{owningProcess=[int]$_.OwningProcess;localAddress=[string]$_.LocalAddress;localPort=[int]$_.LocalPort;remoteAddress=[string]$_.RemoteAddress;remotePort=[int]$_.RemotePort;state=[string]$_.State}})',
    '@{processes=$processes;connections=$connections} | ConvertTo-Json -Depth 5 -Compress',
  ].join(';');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-Command', script]);
  assert.equal(result.exitCode, 0, result.stderr);
  return parseProcessEvidence(JSON.parse(result.stdout));
}

function parseProcessEvidence(value: unknown): ProcessEvidence {
  const source = toRecord(value, 'process evidence');
  const processValues = Array.isArray(source.processes) ? source.processes : source.processes == null ? [] : [source.processes];
  const connectionValues = Array.isArray(source.connections) ? source.connections : source.connections == null ? [] : [source.connections];
  const processes = processValues.map((entry) => {
    const record = toRecord(entry, 'process record');
    return {
      commandLine: String(record.commandLine ?? ''),
      executablePath: String(record.executablePath ?? ''),
      name: String(record.name ?? ''),
      parentPid: Number(record.parentPid),
      pid: Number(record.pid),
    };
  });
  const connections = connectionValues.map((entry) => {
    const record = toRecord(entry, 'connection record');
    return {
      localAddress: String(record.localAddress ?? ''),
      localPort: Number(record.localPort),
      owningProcess: Number(record.owningProcess),
      remoteAddress: String(record.remoteAddress ?? ''),
      remotePort: Number(record.remotePort),
      state: String(record.state ?? ''),
    };
  });
  return { connections, processes };
}

export function daemonUrlFromProcesses(evidence: ProcessEvidence): string {
  const daemon = evidence.processes.find((entry) => entry.commandLine.includes('--readable-studio-stamp-app=daemon'));
  assert.ok(daemon, 'packaged daemon process was not observed');
  const listener = evidence.connections.find((entry) => entry.owningProcess === daemon.pid && entry.state === 'Listen');
  assert.ok(listener, 'packaged daemon listening socket was not observed');
  return `http://127.0.0.1:${listener.localPort}`;
}

export async function runCli(extractionRoot: string, args: readonly string[], daemonUrl?: string, input?: string): Promise<CommandResult> {
  const appRoot = portableAppRoot(extractionRoot);
  const node = join(appRoot, 'resources', 'readable-studio', 'bin', 'node.exe');
  const entry = join(appRoot, 'resources', 'app', 'prebundled', 'daemon', 'daemon-cli.mjs');
  const command = await runCommand(node, [entry, ...args, ...(daemonUrl == null ? [] : ['--daemon-url', daemonUrl])], input);
  assert.equal(command.exitCode, 0, `${command.stderr}\n${command.stdout}`);
  return command;
}

export async function closePortable(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  const closed = app.close();
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new PortableQaError('Electron application did not close within 15 seconds')), 15_000);
  });
  try {
    await Promise.race([closed, timeout]);
  } catch (error) {
    if (!(error instanceof PortableQaError)) throw error;
  } finally {
    if (pid != null) {
      try {
        await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], undefined, { timeoutMs: 10_000 });
      } catch {
        // process tree already gone; ignore
      }
    }
  }
}

export async function registrySnapshot(): Promise<Record<string, CommandResult>> {
  const entries = await Promise.all([canonicalProductName].map(async (name) => {
    const key = `HKCU\\Software\\${name}`;
    return [name, await runCommand('reg.exe', ['query', key, '/s'])] as const;
  }));
  return Object.fromEntries(entries);
}

export function assertPortableBoundaries(extractionRoot: string, capture: AppCapture, evidence: ProcessEvidence, trap: NetworkTrap): void {
  const namespaceRoot = join(extractionRoot, 'ReadableStudioData', 'namespaces', capture.namespace);
  assert.ok(evidence.processes.length >= 3, 'portable process tree is incomplete');
  for (const entry of evidence.processes) {
    const joined = `${entry.executablePath} ${entry.commandLine}`.toLowerCase();
    // The renderer can intentionally launch user tools (for example the
    // configured agent CLI). Their payloads may live in the user's AppData;
    // only commands belonging to this extraction are
    // subject to the portable Electron boundary.
    // A user CLI shim can resolve "node" to our bundled executable while its
    // actual command still belongs to the external agent, not this runtime.
    if (!entry.commandLine.toLowerCase().includes(extractionRoot.toLowerCase())) continue;
    const outsideExtraction = joined.replaceAll(extractionRoot.toLowerCase(), '<extraction>');
    assert.equal(outsideExtraction.includes('\\appdata\\'), false, `AppData fallback leak in pid ${entry.pid}`);
  }
  const services = evidence.processes.filter((entry) => /gpu-process|network\.mojom\.NetworkService/u.test(entry.commandLine));
  assert.ok(services.length >= 2, 'Chromium GPU/network service processes were not observed');
  for (const entry of services) assert.ok(entry.commandLine.includes(namespaceRoot), `pid ${entry.pid} is not namespace portable`);
  const externalConnections = evidence.connections.filter((entry) => entry.state === 'Established' && !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(entry.remoteAddress));
  assert.deepEqual(externalConnections, [], 'external TCP connections were observed');
  const externalRequests = capture.networkRequests.filter((url) => {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) && !['127.0.0.1', 'localhost'].includes(parsed.hostname);
    } catch {
      return false;
    }
  });
  assert.deepEqual(externalRequests, [], 'external renderer requests were observed');
  assert.deepEqual(trap.attempts, [], 'offline proxy trap received traffic');
}
