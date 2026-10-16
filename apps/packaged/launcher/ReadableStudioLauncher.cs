using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Security.Cryptography;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Collections.Generic;

namespace ReadableStudio.Launcher {
    public sealed class UpdateFailure : Exception {
        public readonly string Code;
        public UpdateFailure(string code, string message) : base(message) { Code = code; }
    }
    public sealed class Journal {
        public int schema = 1;
        public string id;
        public string target;
        public string launchNamespace = "rg";
        public int pid;
        public long started;
        public string step = "prepared";
        public string from;
        public string to;
        public bool done;
        public bool confirmed;
        public int readyPid;
        public string error;
    }
    public sealed class Receipt {
        public string id;
        public string version;
        public int pid;
    }
    // This assembly is also loaded by the PowerShell helper. Recovery therefore
    // has exactly one implementation and never depends on the replaceable app.
    public sealed class Transaction : IDisposable {
        public readonly string Root;
        public Journal State;
        public event Action ReadyObserved;
        readonly Mutex gate;
        bool held;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        public Transaction(string root) {
            Root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
            string key;
            using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Root.ToLowerInvariant()))).Replace("-", "");
            gate = new Mutex(false, "Global\\ReadableStudioUpdate-" + key);
        }
        public bool TryLock() {
            if (held) return true;
            try { held = gate.WaitOne(0); }
            catch (AbandonedMutexException) { held = true; }
            return held;
        }
        public void Unlock() { if (held) { held = false; gate.ReleaseMutex(); } }
        public void Dispose() { Unlock(); gate.Dispose(); }
        public string FileAt(string name) { return Path.Combine(Root, name); }
        public bool Exists(string name) { return Directory.Exists(FileAt(name)); }
        public Journal Read() {
            string path = FileAt("update-journal.json");
            if (!File.Exists(path)) return State = null;
            State = Json.Deserialize<Journal>(File.ReadAllText(path));
            Guid parsed;
            if (State == null || State.schema != 1 || !Guid.TryParse(State.id, out parsed) || String.IsNullOrEmpty(State.target))
                throw new UpdateFailure("invalid-journal", "업데이트 기록을 읽을 수 없습니다. 폴더를 보존하고 지원팀에 문의해 주세요.");
            return State;
        }
        public static bool Alive(Journal state) {
            if (state == null || state.pid <= 0) return false;
            try { using (var p = Process.GetProcessById(state.pid)) return !p.HasExited && p.StartTime.ToUniversalTime().Ticks == state.started; }
            catch (ArgumentException) { return false; }
        }
        public void Claim() {
            using (var p = Process.GetCurrentProcess()) { State.pid = p.Id; State.started = p.StartTime.ToUniversalTime().Ticks; }
            Save();
        }
        public void Save() {
            if (!held) throw new UpdateFailure("unlocked-write", "Update journal write requires the installation mutex.");
            string path = FileAt("update-journal.json"), temporary = path + ".tmp";
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(State));
            using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous");
            else File.Move(temporary, path);
        }
        // Pure, ordered decision table. "live" means a launchable app executable,
        // not just a directory. Process liveness is supplied separately for tests.
        public static string Decide(Journal state, bool helperAlive, bool live, bool old, bool staging, bool appRunning) {
            if (state == null) return live ? "launch" : "invalid";
            if (helperAlive) return "active";
            if (state.confirmed) return live ? (old || state.step != "finished" ? "cleanup" : "launch") : "invalid";
            if (!old && (state.step == "finished" || state.step == "rolled-back" || (state.step == "complete" && !staging)))
                return live ? "launch" : "invalid";
            if (state.step != "prepared" && state.step != "old-move" && state.step != "new-move" && state.step != "complete" &&
                state.step != "rollback-new" && state.step != "rollback-old" && state.step != "rolled-back") return "invalid";
            if (appRunning) return "running-incomplete";
            if (old) return "rollback";
            return live ? "cancel" : "invalid";
        }
        public static string Decision(Journal state, bool live, bool old, bool staging) {
            return Decide(state, Alive(state), live, old, staging, false);
        }
        public void Move(string step, string from, string to) {
            bool allowed = (from == "app" && (to == "app.old" || to == "app.failed")) ||
                (from == "app.staging" && to == "app") || (from == "app.old" && to == "app");
            if (!allowed) throw new UpdateFailure("invalid-move", "Unexpected payload move.");
            CheckDirectory(from); CheckDirectory(to);
            State.step = step; State.from = from; State.to = to; State.done = false; Save();
            Directory.Move(FileAt(from), FileAt(to));
            State.done = true; Save();
        }
        void CheckDirectory(string name) {
            if (Exists(name) && (File.GetAttributes(FileAt(name)) & FileAttributes.ReparsePoint) != 0)
                throw new UpdateFailure("reparse-point", "업데이트 폴더가 다른 위치로 연결되어 있습니다. 업데이트를 중단했습니다.");
        }
        public void Rollback() {
            if (State.confirmed) throw new UpdateFailure("confirmed-rollback", "Cannot reverse a confirmed update.");
            CheckDirectory("app"); CheckDirectory("app.old");
            // Reconcile actual names, not done: a crash can follow the rename
            // but precede the completion write, including during rollback.
            if (Exists("app.old")) {
                if (Exists("app")) Move("rollback-new", "app", "app.failed");
                Move("rollback-old", "app.old", "app");
            }
            if (!Exists("app")) throw new UpdateFailure("missing-payload", "실행할 앱을 찾을 수 없습니다. 업데이트 폴더를 보존해 주세요.");
            State.step = "rolled-back"; State.done = true; State.pid = 0; Save();
        }
        public void BeginCleanup() {
            Receipt receipt = ReadReceipt();
            if (Matches(receipt)) State.readyPid = receipt.pid;
            State.confirmed = true; State.step = "cleanup"; State.from = "app.old"; State.to = null; State.done = false; Save();
        }
        public void Cleanup() {
            if (State.step == "rolled-back") {
                if (!Ready()) throw new UpdateFailure("unconfirmed-recovery", "Restored startup must be confirmed before failed payload cleanup.");
                try { RemoveFailedPayload(); State.error = null; }
                catch (Win32Exception error) {
                    if (error.NativeErrorCode != 5 && error.NativeErrorCode != 32 && error.NativeErrorCode != 33) throw;
                    State.error = error.Message;
                    File.AppendAllText(FileAt("update-broker.log"), "failed payload cleanup pending: " + error + "\n");
                }
                State.pid = 0; Save();
                ClearAttemptFiles();
                return;
            }
            if (!State.confirmed) throw new UpdateFailure("unconfirmed-cleanup", "Successful startup must be confirmed before cleanup.");
            // Confirmation is irreversible. A locked old file is maintenance,
            // not an update failure; retain the journal and retry next launch.
            try {
                CheckDirectory("app.old");
                if (Exists("app.old")) PayloadDeletion.Remove(FileAt("app.old"));
            } catch (Win32Exception error) {
                if (error.NativeErrorCode != 5 && error.NativeErrorCode != 32 && error.NativeErrorCode != 33) throw;
                State.step = "cleanup"; State.done = false; State.pid = 0; State.error = error.Message; Save(); ClearAttemptFiles(); return;
            }
            State.step = "finished"; State.done = true; State.pid = 0; State.error = null; Save();
            ClearAttemptFiles();
        }
        public void ClearAttemptFiles() {
            if (!held) throw new UpdateFailure("unlocked-write", "Attempt cleanup requires the installation mutex.");
            // The daemon consumes the journal and owns .update-failed-apply.json.
            // Rollback receipts remain available until recovery is fully cleaned.
            foreach (string name in new[] { "update-helper-ready.json", "update-helper-ready.json.tmp", "update-helper-ready.json.previous", "update-ready.json.tmp",
                "update-journal.json.tmp", "update-journal.json.previous" }) File.Delete(FileAt(name));
            if (State != null && State.confirmed) {
                foreach (string name in new[] { "update-ready.json", "update-error.log", "update-launcher-error.log", "update-broker-error.log", "update-barrier-error.log" })
                    File.Delete(FileAt(name));
            }
        }
        void RemoveFailedPayload() {
            // Callers prove health either with a readiness receipt, or the
            // running payload process that requested the next update.
            if (State == null || State.step != "rolled-back" || Exists("app.old") || !File.Exists(FileAt("app\\Readable Studio.exe")))
                throw new UpdateFailure("unsafe-failed-cleanup", "Previous payload recovery is not complete.");
            CheckDirectory("app"); CheckDirectory("app.failed");
            if (Exists("app.failed")) {
                PayloadDeletion.Remove(FileAt("app.failed"));
                File.AppendAllText(FileAt("update-broker.log"), "removed failed payload after healthy rollback id=" + State.id + "\n");
            }
        }
        public void PrepareNextUpdate(int requestingPid) {
            if (State != null) {
                string decision = Decision(State, File.Exists(FileAt("app\\Readable Studio.exe")), Exists("app.old"), true);
                // Legacy handoff failures left "prepared" behind before any
                // rename. A dead owner and untouched app need no recovery swap.
                if (decision != "launch" && !(decision == "cancel" && State.step == "prepared"))
                    throw new UpdateFailure("unfinished-update", "An unfinished update must be recovered by the launcher first.");
            }
            if (Exists("app.failed") && State != null && State.step == "rolled-back") {
                bool healthy = Ready();
                if (!healthy && requestingPid > 0) {
                    try {
                        using (var process = Process.GetProcessById(requestingPid))
                            healthy = !process.HasExited && String.Equals(process.MainModule.FileName, FileAt("app\\Readable Studio.exe"), StringComparison.OrdinalIgnoreCase);
                    } catch (ArgumentException) { }
                }
                if (healthy) RemoveFailedPayload();
            }
            if (Exists("app.old") || Exists("app.failed"))
                throw new UpdateFailure("previous-payload", "A previous payload still needs recovery or removal.");
            ClearAttemptFiles();
        }
        public bool RecoverAndLaunch(int timeout) {
            if (!TryLock()) throw new UpdateFailure("recovery-locked", "Could not reclaim update mutex for recovery.");
            Read();
            if (State.confirmed) return true;
            RequireEmpty(45000);
            Rollback();
            // A distinct receipt proves the restored payload, never the failed
            // version's stale receipt. Its version comes from the restored app.
            var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(FileAt("app\\resources\\readable-studio-config.json")));
            State.target = (string)config["appVersion"];
            State.id = Guid.NewGuid().ToString(); Claim();
            var start = CreateStartInfo(FileAt("app\\Readable Studio.exe"), "", true);
            start.CreateNoWindow = true;
            start.EnvironmentVariables["READABLE_UPDATE_TRANSACTION"] = State.id;
            start.EnvironmentVariables["READABLE_UPDATE_TARGET"] = State.target;
            bool ready = StartAndWaitReady(start, timeout);
            if (!TryLock()) throw new UpdateFailure("recovery-locked", "Could not reclaim update mutex after recovery.");
            if (ready) Cleanup();
            return ready;
        }
        public bool FocusConfirmedApp() {
            if (State == null || !State.confirmed) return false;
            Receipt receipt = ReadReceipt();
            int pid = Matches(receipt) ? receipt.pid : State.readyPid;
            return pid > 0 && ExistingApp.Show(pid, FileAt("app\\Readable Studio.exe"));
        }
        Receipt ReadReceipt() {
            string path = FileAt("update-ready.json");
            try {
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    return Json.Deserialize<Receipt>(reader.ReadToEnd());
            } catch (FileNotFoundException) { return null; }
            catch (IOException error) {
                int code = error.HResult & 0xffff;
                if (code == 32 || code == 33) return null;
                throw;
            }
        }
        bool Matches(Receipt receipt) {
            return State != null && receipt != null && receipt.id == State.id && receipt.version == State.target;
        }
        public bool Ready() { return Matches(ReadReceipt()); }
        public ProcessStartInfo CreateStartInfo(string executable, string arguments, bool restoreNamespace) {
            var start = new ProcessStartInfo(executable, arguments) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root };
            if (String.Equals(executable, FileAt("app\\Readable Studio.exe"), StringComparison.OrdinalIgnoreCase)) {
                string launchNamespace = restoreNamespace ? State.launchNamespace : (Environment.GetEnvironmentVariable("READABLE_PACKAGED_NAMESPACE") ?? "rg");
                start.WorkingDirectory = FileAt(Path.Combine("ReadableStudioData", "namespaces", launchNamespace));
                Directory.CreateDirectory(start.WorkingDirectory);
            }
            if (restoreNamespace) {
                start.EnvironmentVariables["READABLE_PACKAGED_NAMESPACE"] = State.launchNamespace;
                File.AppendAllText(FileAt("update-broker.log"), "launcher relaunch namespace=" + State.launchNamespace + " image=" + executable + "\n");
            }
            return start;
        }
        public bool LaunchAndWaitReady(int timeout) {
            return StartAndWaitReady(CreateStartInfo(FileAt("Readable Studio.exe"), "--readable-update-start=" + State.id, true), timeout, true);
        }
        public bool StartAndWaitReady(ProcessStartInfo start, int timeout) {
            return StartAndWaitReady(start, timeout, false);
        }
        bool StartAndWaitReady(ProcessStartInfo start, int timeout, bool waitForStubExit) {
            using (var signal = new ManualResetEventSlim(false))
            using (var watcher = new FileSystemWatcher(Root, "update-ready.json")) {
                watcher.Created += delegate { signal.Set(); };
                watcher.Changed += delegate { signal.Set(); };
                watcher.Renamed += delegate { signal.Set(); };
                watcher.EnableRaisingEvents = true;
                Unlock();
                using (var child = new Process { StartInfo = start, EnableRaisingEvents = true }) {
                    child.Exited += delegate { signal.Set(); };
                    child.Start();
                    var deadline = Stopwatch.StartNew();
                    while (true) {
                        signal.Reset();
                        if (Ready()) {
                            if (ReadyObserved != null) ReadyObserved();
                            // Both helper and stub consume this receipt. Keep it
                            // until the stub has acknowledged startup and exited.
                            if (waitForStubExit && !child.WaitForExit(Math.Max(0, timeout - (int)deadline.ElapsedMilliseconds))) return false;
                            return true;
                        }
                        // Helper-driven stubs remain alive until readiness.
                        // Any earlier process exit is a failed startup, even 0.
                        if (child.HasExited) return false;
                        int remaining = timeout - (int)deadline.ElapsedMilliseconds;
                        if (remaining <= 0) return false;
                        // A rename notification can precede release of its sharing
                        // handle. Closing that handle emits no further file event.
                        signal.Wait(Math.Min(remaining, 100));
                    }
                }
            }
        }
        public void RequireEmpty(int timeout) {
            var info = new ProcessStartInfo(Path.Combine(Root, "Readable Studio.exe"), "--readable-barrier") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root };
            using (var child = Process.Start(info)) {
                if (!child.WaitForExit(timeout)) { child.Kill(); child.WaitForExit(); throw new UpdateFailure("barrier-timeout", "앱이 아직 실행 중입니다. 모든 Readable Studio 창을 닫고 다시 시도해 주세요."); }
                if (child.ExitCode != 0) throw new UpdateFailure("barrier-failed", "앱 종료를 확인하지 못했습니다. 모든 창을 닫고 다시 시도해 주세요.");
            }
        }
    }
    // Use the native Unicode extended-path APIs. Framework path quirks are
    // cached before our assembly loads in Windows PowerShell, so AppContext
    // switches cannot reliably enable long paths for the shared helper engine.
    public static class PayloadDeletion {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry {
            public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
            public uint high, low, reserved0, reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string alternate;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFile(string path, out Entry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool FindNextFile(IntPtr handle, out Entry entry);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool FindClose(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteFile(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool RemoveDirectory(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileAttributes(string path, uint attributes);
        public static void Remove(string path) { RemoveExtended(path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path); }
        static void RemoveExtended(string path) {
            Entry entry; IntPtr handle = FindFirstFile(path + @"\*", out entry);
            if (handle == new IntPtr(-1)) {
                int error = Marshal.GetLastWin32Error(); if (error != 2) throw new Win32Exception(error);
            } else try {
                do {
                    if (entry.name == "." || entry.name == "..") continue;
                    string child = path + @"\" + entry.name;
                    if ((entry.attributes & 0x10) != 0) {
                        if ((entry.attributes & 0x400) == 0) RemoveExtended(child);
                        else if (!RemoveDirectory(child)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    } else {
                        if ((entry.attributes & 1) != 0 && !SetFileAttributes(child, entry.attributes & ~1u)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        if (!DeleteFile(child)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                } while (FindNextFile(handle, out entry));
                int error = Marshal.GetLastWin32Error(); if (error != 18) throw new Win32Exception(error);
            } finally { FindClose(handle); }
            if (!RemoveDirectory(path)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
    public static class ExistingApp {
        delegate bool EnumProc(IntPtr window, IntPtr argument);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr argument);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
        [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
        public static bool Show(int pid, string executable) {
            try {
                using (var process = Process.GetProcessById(pid)) {
                    if (process.HasExited || !String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) return false;
                    // A confirmed app owns the launch already. Do not race its data
                    // lock with another Electron startup. Show without stealing focus.
                    EnumWindows(delegate(IntPtr window, IntPtr argument) {
                        int owner; GetWindowThreadProcessId(window, out owner);
                        if (owner != pid) return true;
                        var title = new StringBuilder(256); GetWindowText(window, title, title.Capacity);
                        if (title.ToString() == "Readable Studio") ShowWindowAsync(window, 4);
                        return true;
                    }, IntPtr.Zero);
                    return true;
                }
            } catch (ArgumentException) { return false; }
        }
    }
    public sealed class Notice : Form {
        [DllImport("user32.dll")] static extern IntPtr GetSystemMenu(IntPtr window, bool reset);
        [DllImport("user32.dll")] static extern uint EnableMenuItem(IntPtr menu, uint item, uint flags);
        readonly Label label;
        readonly ProgressBar progressBar;
        readonly Button close;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            EnableMenuItem(GetSystemMenu(Handle, false), 0xf060, close.Enabled ? 0u : 1u);
        }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
        public Notice(string message, bool progress) {
            Text = "Readable Studio 업데이트"; FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Malgun Gothic", 10); Icon = Icon.ExtractAssociatedIcon(typeof(Notice).Assembly.Location);
            label = new Label { Location = new Point(22, 22), AutoSize = true, UseMnemonic = false }; Controls.Add(label);
            progressBar = new ProgressBar { Style = ProgressBarStyle.Marquee }; Controls.Add(progressBar);
            close = new Button { Text = "확인", Size = new Size(82, 27) };
            close.Click += delegate { Close(); }; Controls.Add(close);
            SetMessage(message, progress);
        }
        public void SetMessage(string message, bool progress) {
            // Measure complete lines; do not give Label a wrapping width that
            // splits Korean words. Product notices supply their own line breaks.
            Size text = TextRenderer.MeasureText(message, Font, Size.Empty, TextFormatFlags.NoPrefix);
            label.Text = message;
            label.MinimumSize = text;
            int width = Math.Max(470, text.Width + 44), bottom = 22 + text.Height + 24;
            progressBar.Visible = progress; progressBar.Location = new Point(22, bottom); progressBar.Size = new Size(width - 44, 14);
            close.Visible = !progress; close.Enabled = !progress;
            if (progress) bottom += 30;
            close.Location = new Point(width - 104, bottom);
            ClientSize = new Size(width, bottom + 49);
            if (IsHandleCreated) EnableMenuItem(GetSystemMenu(Handle, false), 0xf060, progress ? 1u : 0u);
            if (IsHandleCreated && !Visible) Show();
        }
    }
    public static class Barrier {
        [StructLayout(LayoutKind.Sequential)] public struct Unique { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct Info {
            public Unique process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
            public uint type, status, session; [MarshalAs(UnmanagedType.Bool)] public bool restartable;
        }
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] files, uint np, Unique[] processes, uint ns, string[] services);
        [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint need, ref uint count, [In, Out] Info[] info, ref uint reasons);
        [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint length);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        public static int[] Holders(string folder) {
            if (!Directory.Exists(folder)) return new int[0];
            var ids = new HashSet<int>(); string prefix = folder.TrimEnd('\\') + "\\";
            foreach (var p in Process.GetProcesses()) using (p) {
                IntPtr handle = OpenProcess(0x1000, false, p.Id);
                if (handle == IntPtr.Zero) {
                    int code = Marshal.GetLastWin32Error();
                    // Access denied for protected system processes, or a PID
                    // that exited since enumeration. RM still covers our files.
                    if (code == 5 || code == 87) continue;
                    throw new Win32Exception(code);
                }
                try {
                    uint size = 32768; var name = new StringBuilder((int)size);
                    if (!QueryFullProcessImageName(handle, 0, name, ref size)) {
                        int code = Marshal.GetLastWin32Error();
                        if (code == 5 || code == 87 || code == 31) continue;
                        throw new Win32Exception(code);
                    }
                    if (name.ToString().StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) ids.Add(p.Id);
                } finally { CloseHandle(handle); }
            }
            var files = Directory.GetFiles(folder).ToList();
            string node = Path.Combine(folder, "resources", "readable-studio", "bin", "node.exe");
            if (File.Exists(node)) files.Add(node);
            uint h; int error = RmStartSession(out h, 0, new StringBuilder(33));
            if (error != 0) throw new Win32Exception(error);
            try {
                error = RmRegisterResources(h, (uint)files.Count, files.ToArray(), 0, null, 0, null);
                if (error != 0) throw new Win32Exception(error);
                uint need, count = 0, reason = 0;
                error = RmGetList(h, out need, ref count, null, ref reason);
                for (int attempt = 0; error == 234 && attempt < 4; attempt++) {
                    count = need; var results = new Info[count]; error = RmGetList(h, out need, ref count, results, ref reason);
                    if (error == 0) foreach (var item in results.Take((int)count)) ids.Add((int)item.process.pid);
                }
                if (error != 0) throw new Win32Exception(error);
            } finally { int result = RmEndSession(h); if (result != 0) throw new Win32Exception(result); }
            return ids.ToArray();
        }
        public static void Wait(string root) {
            var deadline = Stopwatch.StartNew();
            while (true) {
                if (deadline.ElapsedMilliseconds >= 45000) throw new UpdateFailure("barrier-timeout", "Payload holders did not release within 45 seconds.");
                var ids = Holders(Path.Combine(root, "app")).Concat(Holders(Path.Combine(root, "app.old"))).Distinct().ToArray();
                if (ids.Length == 0) return;
                foreach (int id in ids) {
                    // .NET Framework WaitForExit also requests QUERY_INFORMATION,
                    // which sandboxed Electron children need not grant. Waiting
                    // only needs SYNCHRONIZE, not access to their modules/token.
                    IntPtr handle = OpenProcess(0x100000, false, id);
                    if (handle == IntPtr.Zero) {
                        int code = Marshal.GetLastWin32Error();
                        if (code == 87) continue;
                        // A protected scanner may hold a registered file without
                        // granting SYNCHRONIZE. It is still a holder: re-query RM
                        // until it releases the file, or fail the bounded barrier.
                        if (code == 5) continue;
                        throw new Win32Exception(code, "Cannot wait for payload PID " + id);
                    }
                    try {
                        uint result = WaitForSingleObject(handle, 250);
                        if (result != 0 && result != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                    finally { CloseHandle(handle); }
                }
            }
        }
    }
    public static class Program {
        // CommandLineToArgvW-compatible quoting preserves spaces, empty args,
        // quotes and trailing backslashes instead of using shell interpolation.
        public static string Quote(string value) {
            var b = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                b.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); b.Append(c); slashes = 0;
            }
            b.Append('\\', slashes * 2); return b.Append('"').ToString();
        }
        public static void Show(string message, bool progress) { Application.Run(new Notice(message, progress)); }
        static void WaitForUpdate(Transaction tx) {
            tx.Unlock();
            File.AppendAllText(tx.FileAt("update-broker.log"), "manual launch deferred during update\n");
            using (var notice = new Notice("업데이트 진행 중\n완료되면 앱이 다시 시작됩니다.", true))
            using (var timer = new System.Windows.Forms.Timer { Interval = 100 }) {
                timer.Tick += delegate {
                    var state = tx.Read();
                    if (Transaction.Alive(state) || !tx.TryLock()) return;
                    tx.Unlock(); notice.Close();
                };
                timer.Start();
                Application.Run(notice);
            }
        }
        [STAThread] public static int Main(string[] args) {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            bool helperStart = args.Length > 0 && args[0].StartsWith("--readable-update-start=", StringComparison.Ordinal);
            Application.EnableVisualStyles();
            try {
                if (args.Length == 1 && args[0] == "--readable-barrier") { Barrier.Wait(root); return 0; }
                using (var tx = new Transaction(root)) {
                    if (!tx.TryLock()) {
                        if (helperStart) return 1;
                        WaitForUpdate(tx); return Main(args);
                    }
                    Journal state = tx.Read();
                    bool internalStart = state != null && state.step == "complete" && args.Length > 0 && args[0] == "--readable-update-start=" + state.id && Transaction.Alive(state);
                    if (helperStart && !internalStart) return 1;
                    bool restoreNamespace = internalStart;
                    if (internalStart) args = args.Skip(1).ToArray();
                    else {
                        // A valid ready receipt can precede BeginCleanup's durable
                        // write. Promote it before considering any reverse move.
                        if (state != null && !Transaction.Alive(state) && !state.confirmed && tx.Ready()) {
                            if (state.step == "rolled-back") tx.Cleanup();
                            else tx.BeginCleanup();
                        }
                        string decision = Transaction.Decision(state, File.Exists(tx.FileAt("app\\Readable Studio.exe")), tx.Exists("app.old"), tx.Exists("app.staging"));
                        if (decision == "active") { WaitForUpdate(tx); return Main(args); }
                        if (decision == "invalid") throw new UpdateFailure("invalid-layout", "업데이트 상태: " + (state == null ? "기록 없음" : state.step) + ". 앱 폴더를 보존하고 지원팀에 문의해 주세요.");
                        if (decision == "cleanup") { restoreNamespace = true; tx.Claim(); tx.BeginCleanup(); tx.Cleanup(); }
                        else if (decision != "launch") {
                            restoreNamespace = true;
                            if (Barrier.Holders(tx.FileAt("app")).Length != 0 || Barrier.Holders(tx.FileAt("app.old")).Length != 0)
                                throw new UpdateFailure("running-incomplete", "업데이트 상태: " + state.step + ". 실행 중인 Readable Studio를 닫고 다시 실행해 주세요.");
                            tx.Claim();
                            if (!tx.RecoverAndLaunch(180000)) throw new UpdateFailure("recovery-start-failed", "Restored payload did not confirm startup.");
                            tx.Unlock();
                            Show("업데이트를 적용하지 못해 이전 버전으로 되돌렸습니다.\n작업 내역은 그대로입니다.", false);
                            return 0;
                        }
                        if (tx.FocusConfirmedApp()) return 0;
                    }
                    string exe = tx.FileAt("app\\Readable Studio.exe");
                    if (!File.Exists(exe)) throw new UpdateFailure("missing-exe", "app 폴더에서 실행 파일을 찾을 수 없습니다.");
                    var start = tx.CreateStartInfo(exe, String.Join(" ", args.Select(Quote)), restoreNamespace);
                    if (internalStart) {
                        start.EnvironmentVariables["READABLE_UPDATE_TRANSACTION"] = state.id; start.EnvironmentVariables["READABLE_UPDATE_TARGET"] = state.target;
                        return tx.StartAndWaitReady(start, 180000) ? 0 : 1;
                    }
                    using (var child = Process.Start(start)) { }
                }
                return 0;
            } catch (Exception error) {
                if (args.Length == 1 && args[0] == "--readable-barrier") {
                    File.WriteAllText(Path.Combine(root, "update-barrier-error.log"), error.ToString()); return 1;
                }
                File.WriteAllText(Path.Combine(root, "update-launcher-error.log"), error.ToString());
                // The waiting helper owns the progress UI and automatic
                // recovery. Do not block its failure signal behind a dialog.
                if (helperStart) return 1;
                Show("앱을 시작하지 못했습니다.\nReadable Studio를 다시 실행해 주세요. 작업 내역은 그대로입니다.", false); return 1;
            }
        }
    }
}
