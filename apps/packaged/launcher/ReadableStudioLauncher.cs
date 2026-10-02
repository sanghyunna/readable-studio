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
            State.confirmed = true; State.step = "cleanup"; State.from = "app.old"; State.to = null; State.done = false; Save();
        }
        public void Cleanup() {
            if (!State.confirmed) throw new UpdateFailure("unconfirmed-cleanup", "Successful startup must be confirmed before cleanup.");
            // Confirmation is irreversible. A locked old file is maintenance,
            // not an update failure; retain the journal and retry next launch.
            try {
                CheckDirectory("app.old");
                if (Exists("app.old")) PayloadDeletion.Remove(FileAt("app.old"));
            } catch (Win32Exception error) {
                if (error.NativeErrorCode != 5 && error.NativeErrorCode != 32 && error.NativeErrorCode != 33) throw;
                State.step = "cleanup"; State.done = false; State.pid = 0; State.error = error.Message; Save(); return;
            }
            State.step = "finished"; State.done = true; State.pid = 0; State.error = null; Save();
        }
        public bool FocusConfirmedApp() {
            if (State == null || !State.confirmed || !Ready()) return false;
            Receipt receipt = Json.Deserialize<Receipt>(File.ReadAllText(FileAt("update-ready.json")));
            return ExistingApp.Show(receipt.pid, FileAt("app\\Readable Studio.exe"));
        }
        public bool Ready() {
            string path = FileAt("update-ready.json");
            if (!File.Exists(path)) return false;
            Receipt receipt = Json.Deserialize<Receipt>(File.ReadAllText(path));
            return receipt != null && receipt.id == State.id && receipt.version == State.target;
        }
        public ProcessStartInfo CreateStartInfo(string executable, string arguments, bool restoreNamespace) {
            var start = new ProcessStartInfo(executable, arguments) { UseShellExecute = false, WorkingDirectory = Root };
            if (restoreNamespace) {
                start.EnvironmentVariables["READABLE_PACKAGED_NAMESPACE"] = State.launchNamespace;
                File.AppendAllText(FileAt("update-broker.log"), "launcher relaunch namespace=" + State.launchNamespace + " image=" + executable + "\n");
            }
            return start;
        }
        public bool LaunchAndWaitReady(int timeout) {
            using (var signal = new ManualResetEventSlim(false))
            using (var watcher = new FileSystemWatcher(Root, "update-ready.json")) {
                watcher.Created += delegate { signal.Set(); };
                watcher.Changed += delegate { signal.Set(); };
                watcher.Renamed += delegate { signal.Set(); };
                watcher.EnableRaisingEvents = true;
                Unlock();
                var start = CreateStartInfo(FileAt("Readable Studio.exe"), "--readable-update-start=" + State.id, true);
                using (var child = Process.Start(start)) { }
                var deadline = Stopwatch.StartNew();
                while (true) {
                    signal.Reset();
                    if (Ready()) return true;
                    int remaining = timeout - (int)deadline.ElapsedMilliseconds;
                    if (remaining <= 0 || !signal.Wait(remaining)) return false;
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
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
        public Notice(string message, bool progress) {
            Text = "Readable Studio 업데이트"; ClientSize = new Size(470, 175); FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Malgun Gothic", 10); Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            var label = new Label { Text = message, Location = new Point(22, 22), Size = new Size(425, 82) }; Controls.Add(label);
            if (progress) Controls.Add(new ProgressBar { Style = ProgressBarStyle.Marquee, Location = new Point(22, 108), Size = new Size(425, 14) });
            var close = new Button { Text = "확인", Location = new Point(365, 138), Size = new Size(82, 27) };
            close.Click += delegate { Close(); }; Controls.Add(close);
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
        [STAThread] public static int Main(string[] args) {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            Application.EnableVisualStyles();
            try {
                if (args.Length == 1 && args[0] == "--readable-barrier") { Barrier.Wait(root); return 0; }
                using (var tx = new Transaction(root)) {
                    if (!tx.TryLock()) { Show("업데이트 진행 중\n완료되면 앱이 다시 시작됩니다.", true); return 0; }
                    Journal state = tx.Read();
                    bool internalStart = state != null && state.step == "complete" && args.Length > 0 && args[0] == "--readable-update-start=" + state.id && Transaction.Alive(state);
                    bool restoreNamespace = internalStart;
                    if (internalStart) args = args.Skip(1).ToArray();
                    else {
                        // A valid ready receipt can precede BeginCleanup's durable
                        // write. Promote it before considering any reverse move.
                        if (state != null && !Transaction.Alive(state) && !state.confirmed && tx.Ready()) tx.BeginCleanup();
                        string decision = Transaction.Decision(state, File.Exists(tx.FileAt("app\\Readable Studio.exe")), tx.Exists("app.old"), tx.Exists("app.staging"));
                        if (decision == "active") { tx.Unlock(); Show("업데이트 진행 중\n완료되면 앱이 다시 시작됩니다.", true); return 0; }
                        if (decision == "invalid") throw new UpdateFailure("invalid-layout", "업데이트 상태: " + (state == null ? "기록 없음" : state.step) + ". 앱 폴더를 보존하고 지원팀에 문의해 주세요.");
                        if (decision == "cleanup") { restoreNamespace = true; tx.Claim(); tx.BeginCleanup(); tx.Cleanup(); }
                        else if (decision != "launch") {
                            restoreNamespace = true;
                            if (Barrier.Holders(tx.FileAt("app")).Length != 0 || Barrier.Holders(tx.FileAt("app.old")).Length != 0)
                                throw new UpdateFailure("running-incomplete", "업데이트 상태: " + state.step + ". 실행 중인 Readable Studio를 닫고 다시 실행해 주세요.");
                            tx.RequireEmpty(45000);
                            tx.Claim(); tx.Rollback();
                            Show("중단된 업데이트를 되돌렸습니다.\n기존 버전으로 시작합니다. 데이터는 보존되었습니다.", false);
                        }
                        if (tx.FocusConfirmedApp()) return 0;
                    }
                    string exe = tx.FileAt("app\\Readable Studio.exe");
                    if (!File.Exists(exe)) throw new UpdateFailure("missing-exe", "app 폴더에서 실행 파일을 찾을 수 없습니다.");
                    var start = tx.CreateStartInfo(exe, String.Join(" ", args.Select(Quote)), restoreNamespace);
                    start.WorkingDirectory = Environment.CurrentDirectory;
                    if (internalStart) { start.EnvironmentVariables["READABLE_UPDATE_TRANSACTION"] = state.id; start.EnvironmentVariables["READABLE_UPDATE_TARGET"] = state.target; }
                    using (var child = Process.Start(start)) { }
                }
                return 0;
            } catch (Exception error) {
                if (args.Length == 1 && args[0] == "--readable-barrier") {
                    File.WriteAllText(Path.Combine(root, "update-barrier-error.log"), error.ToString()); return 1;
                }
                Show("업데이트를 완료하지 못했습니다. 데이터는 보존되었습니다.\n" + error.Message, false); return 1;
            }
        }
    }
}
