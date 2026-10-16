using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Test-only containment. Children enter a kill-on-close job while suspended,
// before any test code runs, and inherit a desktop that is never made interactive.
public sealed class HarnessHost : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SI {
        public int cb; public string reserved, desktop, title;
        public int x, y, cx, cy, xc, yc, fill, flags;
        public short show, cb2; public IntPtr reserved2, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PI { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC {
        public long perProcess, perJob; public uint flags; public UIntPtr min, max;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    [StructLayout(LayoutKind.Sequential)]
    struct PORT { public IntPtr key, port; }
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", EntryPoint = "CreateDesktopW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr security);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool belongs);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint code, out IntPtr key, out IntPtr value, uint milliseconds);
    IntPtr desktop, job, port;
    PI child;
    bool assigned;
    FileStream log;
    static void Check(bool ok, string label) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), label); }
    void JobInfo<T>(int kind, T value) {
        int size = Marshal.SizeOf(value); IntPtr memory = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, memory, false); Check(SetInformationJobObject(job, kind, memory, (uint)size), "SetInformationJobObject"); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public void Start(string script, string output, bool worker) {
        string name = "ReadableLauncherTests-" + Guid.NewGuid().ToString("N");
        desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero);
        Check(desktop != IntPtr.Zero, "CreateDesktop");
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
        var limit = new LIMIT(); limit.basic.flags = 0x2000; JobInfo(9, limit);
        port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
        Check(port != IntPtr.Zero, "CreateIoCompletionPort"); JobInfo(7, new PORT { key = new IntPtr(1), port = port });
        log = new FileStream(Path.Combine(output, "worker.log"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
        IntPtr handle = log.SafeFileHandle.DangerousGetHandle();
        Check(SetHandleInformation(handle, 1, 1), "SetHandleInformation");
        var si = new SI { cb = Marshal.SizeOf(typeof(SI)), desktop = "winsta0\\" + name, flags = 0x100, output = handle, error = handle };
        string exe = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        var command = new StringBuilder("\"" + exe + "\" -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -OutputDirectory \"" + output + "\"" + (worker ? " -Worker" : ""));
        string previous = Environment.GetEnvironmentVariable("READABLE_LAUNCHER_TEST_WORKER");
        try {
            Environment.SetEnvironmentVariable("READABLE_LAUNCHER_TEST_WORKER", "1");
            Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, 4 | 0x08000000, IntPtr.Zero, Environment.CurrentDirectory, ref si, out child), "CreateProcess");
        } finally { Environment.SetEnvironmentVariable("READABLE_LAUNCHER_TEST_WORKER", previous); }
        Check(AssignProcessToJobObject(job, child.process), "AssignProcessToJobObject"); assigned = true;
        Check(ResumeThread(child.thread) != 0xffffffff, "ResumeThread");
    }
    public int Wait() {
        if (WaitForSingleObject(child.process, 120000) != 0) throw new Exception("Test worker exceeded 120 seconds");
        uint code; Check(GetExitCodeProcess(child.process, out code), "GetExitCodeProcess"); return (int)code;
    }
    public int OwnedProcesses() {
        int count = 0;
        foreach (var process in Process.GetProcesses()) using (process) {
            try { bool belongs; if (IsProcessInJob(process.Handle, job, out belongs) && belongs && !process.HasExited) count++; }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { }
        }
        return count;
    }
    public void Dispose() {
        try {
            if (assigned) {
                Check(TerminateJobObject(job, 0), "TerminateJobObject");
                uint code; IntPtr key, value; bool empty = false;
                var deadline = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < deadline && GetQueuedCompletionStatus(port, out code, out key, out value, 15000)) {
                    if (code == 4) { empty = true; break; }
                }
                if (!empty || OwnedProcesses() != 0) throw new Exception("Test job did not become empty");
            } else if (child.process != IntPtr.Zero) {
                Check(TerminateProcess(child.process, 1), "TerminateProcess");
                Check(WaitForSingleObject(child.process, 15000) == 0, "Wait for unassigned worker");
            }
        } finally {
            if (log != null) log.Dispose();
            foreach (var handle in new[] { child.thread, child.process, job, port }) if (handle != IntPtr.Zero) CloseHandle(handle);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
        }
    }
    static int VisibleAppWindows(IntPtr ownedJob) {
        if (ownedJob == IntPtr.Zero) return 0;
        int count = 0;
        Check(EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (IsWindowVisible(window)) {
                uint pid; GetWindowThreadProcessId(window, out pid);
                try {
                    using (var process = Process.GetProcessById((int)pid)) {
                        bool owned;
                        if (IsProcessInJob(process.Handle, ownedJob, out owned) && owned) count++;
                    }
                }
                catch (ArgumentException) { }
                catch (InvalidOperationException) { } // Window owner exited after GetProcessById.
                catch (Win32Exception) { } // Protected foreign processes cannot belong to this job.
            }
            return true;
        }, IntPtr.Zero), "EnumWindows");
        return count;
    }
    [STAThread] public static int Main(string[] args) {
        if (args[0] == "--fixture") {
            using (var ready = EventWaitHandle.OpenExisting(args[1]))
            using (var form = new Form()) {
                form.Shown += delegate { ready.Set(); };
                Application.Run(form);
            }
            return 0;
        }
        string output = Path.GetFullPath(args[1]); Directory.CreateDirectory(output);
        int baseline = 0, samples = 0, changes = 0, beforeCleanup = -1, afterCleanup = -1, result = 1;
        var host = new HarnessHost();
        var sync = new object();
        // Sampling is observational evidence, not synchronization for assertions.
        using (var timer = new System.Threading.Timer(delegate {
            lock (sync) { samples++; if (VisibleAppWindows(host.job) != baseline) changes++; }
        }, null, 0, 20)) {
            try {
                try { host.Start(Path.GetFullPath(args[0]), output, args.Length < 3 || args[2] != "--legacy"); result = host.Wait(); beforeCleanup = host.OwnedProcesses(); }
                finally { host.Dispose(); afterCleanup = 0; }
                if (args.Length > 2 && beforeCleanup != 0) result = 1;
            } catch (Exception error) { Console.Error.WriteLine(error); result = 1; }
            finally {
                using (var stopped = new ManualResetEvent(false)) { timer.Dispose(stopped); stopped.WaitOne(); }
            }
        }
        if (VisibleAppWindows(host.job) != baseline) changes++;
        var report = new { baselineVisibleWindows = baseline, windowSamples = samples, visibleWindowChanges = changes, processesBeforeCleanup = beforeCleanup, processesAfterCleanup = afterCleanup, exitCode = result };
        File.WriteAllText(Path.Combine(output, "containment.json"), new JavaScriptSerializer().Serialize(report));
        Console.Write(File.ReadAllText(Path.Combine(output, "worker.log")));
        Console.WriteLine(new JavaScriptSerializer().Serialize(report));
        return changes == 0 ? result : 1;
    }
}
