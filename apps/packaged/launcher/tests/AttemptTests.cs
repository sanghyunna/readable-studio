using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using ReadableStudio.Launcher;

public static class AttemptTests {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string link, string existing, IntPtr security);
    static int passed, failed;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Require(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    static void Test(string name, Action action) {
        try { action(); passed++; Console.WriteLine("PASS " + name); }
        catch (Exception error) { failed++; Console.WriteLine("FAIL " + name + ": " + error); }
    }
    static void SeedMarkers(Transaction tx) {
        foreach (string name in new[] { "update-helper-ready.json", "update-helper-ready.json.tmp", "update-helper-ready.json.previous", "update-ready.json.tmp", "update-journal.json.tmp", "update-journal.json.previous" })
            File.WriteAllText(tx.FileAt(name), "stale");
    }
    static void NoMarkers(Transaction tx) {
        foreach (string name in new[] { "update-helper-ready.json", "update-helper-ready.json.tmp", "update-helper-ready.json.previous", "update-ready.json.tmp", "update-journal.json.tmp", "update-journal.json.previous" })
            Require(!File.Exists(tx.FileAt(name)), "Stale attempt file: " + name);
    }
    static void Receipt(Transaction tx) {
        File.WriteAllText(tx.FileAt("update-ready.json"), Json.Serialize(new { id = tx.State.id, version = tx.State.target }));
    }
    static void Cycle(string root, bool rollback) {
        Directory.CreateDirectory(root);
        using (var tx = new Transaction(root)) {
            Require(tx.TryLock(), "mutex");
            Directory.CreateDirectory(tx.FileAt("app"));
            File.WriteAllText(tx.FileAt("app\\Readable Studio.exe"), "original");
            for (int attempt = 0; attempt != 3; attempt++) {
                tx.Read(); tx.PrepareNextUpdate(0);
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3." + (4 + attempt) }; tx.Save();
                Directory.CreateDirectory(tx.FileAt("app.staging"));
                File.WriteAllText(tx.FileAt("app.staging\\Readable Studio.exe"), "payload-" + attempt);
                tx.Move("old-move", "app", "app.old"); tx.Move("new-move", "app.staging", "app");
                SeedMarkers(tx);
                if (rollback) { tx.Rollback(); Receipt(tx); tx.Cleanup(); }
                else { Receipt(tx); tx.BeginCleanup(); tx.Cleanup(); }
                NoMarkers(tx);
                Require(!tx.Exists("app.old") && !tx.Exists("app.failed"), "Previous payload remains");
            }
        }
    }
    [STAThread] public static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "--helper") {
            using (var release = System.Threading.EventWaitHandle.OpenExisting(args[1]))
                return release.WaitOne(15000) ? 0 : 1;
        }
        string payloadSignal = Environment.GetEnvironmentVariable("F17_PAYLOAD_SIGNAL");
        if (!String.IsNullOrEmpty(payloadSignal)) {
            using (var signal = System.Threading.EventWaitHandle.OpenExisting(payloadSignal)) signal.Set();
            return 0;
        }
        string readyRoot = Environment.GetEnvironmentVariable("F17_READY_ROOT");
        if (!String.IsNullOrEmpty(readyRoot)) {
            File.WriteAllText(Path.Combine(readyRoot, "payload-cwd.txt"), Environment.CurrentDirectory);
            using (var started = System.Threading.EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("F17_STARTED_EVENT")))
            using (var release = System.Threading.EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("F17_READY_EVENT"))) {
                started.Set();
                Require(release.WaitOne(10000), "Readiness controller did not release payload");
            }
            string ready = Path.Combine(readyRoot, "update-ready.json");
            File.WriteAllText(ready + ".tmp", Json.Serialize(new { id = Environment.GetEnvironmentVariable("READABLE_UPDATE_TRANSACTION"), version = Environment.GetEnvironmentVariable("READABLE_UPDATE_TARGET") }));
            File.Delete(ready);
            Require(CreateHardLink(ready, ready + ".tmp", IntPtr.Zero), "Publish ready receipt");
            return 0;
        }
        if (Environment.GetEnvironmentVariable("F17_EXIT_PAYLOAD") == "1") return 0;
        Application.EnableVisualStyles();
        string root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
        Test("rollback then consecutive retries clear attempt markers", delegate { Cycle(Path.Combine(root, "rollback"), true); });
        Test("success then consecutive updates clear attempt markers", delegate { Cycle(Path.Combine(root, "success"), false); });
        Test("legacy terminal journal tolerates stale acknowledgement", delegate {
            using (var tx = new Transaction(Path.Combine(root, "rollback"))) {
                Require(tx.TryLock(), "mutex"); tx.Read(); SeedMarkers(tx);
                tx.PrepareNextUpdate(0); NoMarkers(tx);
            }
        });
        Test("legacy abandoned preparation permits a clean retry", delegate {
            string legacyRoot = Path.Combine(root, "legacy-prepared"); Directory.CreateDirectory(legacyRoot);
            using (var tx = new Transaction(legacyRoot)) {
                Require(tx.TryLock(), "mutex");
                Directory.CreateDirectory(tx.FileAt("app"));
                File.WriteAllText(tx.FileAt("app\\Readable Studio.exe"), "unchanged app");
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4" }; tx.Save();
                SeedMarkers(tx);
                tx.PrepareNextUpdate(0);
                NoMarkers(tx);
                Require(File.ReadAllText(tx.FileAt("app\\Readable Studio.exe")) == "unchanged app", "Preparation touched running payload");
            }
        });
        Test("recovery retains helper ownership until restored readiness", delegate {
            string recoveryRoot = Path.Combine(root, "recover-owner"); Directory.CreateDirectory(recoveryRoot);
            File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(recoveryRoot, "Readable Studio.exe"), true);
            Directory.CreateDirectory(Path.Combine(recoveryRoot, "app"));
            File.WriteAllText(Path.Combine(recoveryRoot, "app\\Readable Studio.exe"), "broken");
            Directory.CreateDirectory(Path.Combine(recoveryRoot, "app.old\\resources"));
            File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location, Path.Combine(recoveryRoot, "app.old\\Readable Studio.exe"), true);
            File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(recoveryRoot, "app.old\\Readable Studio.dll"), true);
            File.WriteAllText(Path.Combine(recoveryRoot, "app.old\\resources\\readable-studio-config.json"), "{\"appVersion\":\"1.3.3\"}");
            string startedName = "Local\\F17-recovery-started-" + Guid.NewGuid(), releaseName = "Local\\F17-recovery-ready-" + Guid.NewGuid();
            using (var started = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.ManualReset, startedName))
            using (var release = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.ManualReset, releaseName))
            using (var tx = new Transaction(recoveryRoot)) {
                Require(tx.TryLock(), "mutex");
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4", step = "complete" }; tx.Claim();
                Exception controllerError = null;
                var controller = new System.Threading.Thread(delegate() {
                    try {
                        Require(started.WaitOne(10000), "Restored process did not start");
                        using (var observer = new Transaction(recoveryRoot)) Require(Transaction.Alive(observer.Read()), "Manual launch could overtake recovery");
                    } catch (Exception error) { controllerError = error; }
                    finally { release.Set(); }
                });
                Environment.SetEnvironmentVariable("F17_READY_ROOT", recoveryRoot);
                Environment.SetEnvironmentVariable("F17_STARTED_EVENT", startedName);
                Environment.SetEnvironmentVariable("F17_READY_EVENT", releaseName);
                controller.Start();
                try {
                    Require(tx.RecoverAndLaunch(10000), "Recovery did not become ready");
                    Require(controller.Join(10000), "Controller did not finish");
                    if (controllerError != null) throw controllerError;
                    Require(tx.State.pid == 0 && tx.Ready(), "Recovery did not release ownership");
                    Require(File.ReadAllText(tx.FileAt("payload-cwd.txt")) == tx.FileAt("ReadableStudioData\\namespaces\\rg"), "Restored process cwd escaped data");
                } finally {
                    release.Set(); Require(controller.Join(10000), "Controller leak");
                    Environment.SetEnvironmentVariable("F17_READY_ROOT", null);
                    Environment.SetEnvironmentVariable("F17_STARTED_EVENT", null);
                    Environment.SetEnvironmentVariable("F17_READY_EVENT", null);
                }
            }
        });
        string launchRoot = Path.Combine(root, "launch"); Directory.CreateDirectory(launchRoot);
        File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(launchRoot, "Readable Studio.exe"), true);
        using (var tx = new Transaction(launchRoot)) {
            Require(tx.TryLock(), "mutex");
            Directory.CreateDirectory(tx.FileAt("app"));
            File.WriteAllText(tx.FileAt("app\\Readable Studio.exe"), "broken executable");
            tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4", step = "complete" }; tx.Claim();
            Test("helper driven mutex contention never opens a launcher notice", delegate {
                var start = tx.CreateStartInfo(tx.FileAt("Readable Studio.exe"), "--readable-update-start=" + tx.State.id, true);
                using (var child = Process.Start(start)) {
                    try { Require(child.WaitForExit(5000), "Helper-driven launcher showed progress instead of reporting contention"); Require(child.ExitCode == 1, "Contention was not reported"); }
                    finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
                }
            });
            Test("helper driven launch exits on invalid executable without notice", delegate {
                var start = tx.CreateStartInfo(tx.FileAt("Readable Studio.exe"), "--readable-update-start=" + tx.State.id, true);
                tx.Unlock();
                try {
                    using (var child = Process.Start(start)) {
                        try { Require(child.WaitForExit(5000), "Launcher blocked behind its own notice"); Require(child.ExitCode == 1, "Failure not reported"); }
                        finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
                    }
                } finally { Require(tx.TryLock(), "reclaim mutex"); }
            });
            Test("payload relaunch uses writable data directory not install root", delegate {
                var start = tx.CreateStartInfo(tx.FileAt("app\\Readable Studio.exe"), "", true);
                string expected = tx.FileAt("ReadableStudioData\\namespaces\\rg");
                Require(String.Equals(start.WorkingDirectory, expected, StringComparison.OrdinalIgnoreCase), "Relaunch inherits install root as cwd");
                Require(Directory.Exists(expected), "Data working directory missing");
            });
            Test("payload exit before readiness promptly fails helper driven launch", delegate {
                File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location, tx.FileAt("app\\Readable Studio.exe"), true);
                File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), tx.FileAt("app\\Readable Studio.dll"), true);
                Environment.SetEnvironmentVariable("F17_EXIT_PAYLOAD", "1");
                try {
                    tx.Claim();
                    var start = tx.CreateStartInfo(tx.FileAt("Readable Studio.exe"), "--readable-update-start=" + tx.State.id, true);
                    tx.Unlock();
                    using (var child = Process.Start(start)) {
                        try { Require(child.WaitForExit(5000), "Payload exit was not signaled"); Require(child.ExitCode == 1, "Early payload exit incorrectly succeeded"); }
                        finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
                    }
                } finally { Environment.SetEnvironmentVariable("F17_EXIT_PAYLOAD", null); Require(tx.TryLock(), "reclaim mutex"); }
            });
        }
        Test("manual launch waits for apply and starts the settled payload", delegate {
            string manualRoot = Path.Combine(root, "manual"); Directory.CreateDirectory(manualRoot);
            File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(manualRoot, "Readable Studio.exe"), true);
            Directory.CreateDirectory(Path.Combine(manualRoot, "app"));
            File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location, Path.Combine(manualRoot, "app\\Readable Studio.exe"), true);
            File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(manualRoot, "app\\Readable Studio.dll"), true);
            string releaseName = "Local\\F17-release-" + Guid.NewGuid(), readyName = "Local\\F17-started-" + Guid.NewGuid();
            using (var release = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.ManualReset, releaseName))
            using (var ready = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.ManualReset, readyName))
            using (var deferred = new System.Threading.ManualResetEventSlim(false))
            using (var watcher = new FileSystemWatcher(manualRoot, "update-broker.log"))
            using (var helper = Process.Start(new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--helper " + Program.Quote(releaseName)) { UseShellExecute = false, CreateNoWindow = true }))
            using (var tx = new Transaction(manualRoot)) {
                Process launcher = null;
                try {
                    Require(tx.TryLock(), "mutex");
                    tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4", pid = helper.Id, started = helper.StartTime.ToUniversalTime().Ticks };
                    tx.Save(); tx.Unlock();
                    var start = tx.CreateStartInfo(tx.FileAt("Readable Studio.exe"), "", false);
                    start.EnvironmentVariables["F17_PAYLOAD_SIGNAL"] = readyName;
                    File.WriteAllText(tx.FileAt("update-broker.log"), "");
                    watcher.Changed += delegate { deferred.Set(); }; watcher.EnableRaisingEvents = true;
                    launcher = Process.Start(start);
                    Require(deferred.Wait(5000), "No deferred launch signal");
                    Require(!ready.WaitOne(0), "Payload launched during apply");
                    Require(tx.TryLock(), "Manual launcher blocked helper mutex");
                    tx.State.step = "finished"; tx.State.pid = 0; tx.State.done = true; tx.Save(); tx.Unlock();
                    release.Set();
                    Require(launcher.WaitForExit(5000), "Manual progress notice never follows settled apply");
                    Require(ready.WaitOne(5000), "Settled payload never started");
                    Require(launcher.ExitCode == 0, "Manual launch failed");
                } finally {
                    release.Set();
                    if (launcher != null) { if (!launcher.HasExited) { launcher.Kill(); launcher.WaitForExit(); } launcher.Dispose(); }
                    if (!helper.WaitForExit(5000)) { helper.Kill(); helper.WaitForExit(); }
                }
            }
        });
        Test("Korean notice renders on the private desktop", delegate {
            using (var notice = new Notice("업데이트를 적용하지 못해 이전 버전으로 되돌렸습니다.\n작업 내역은 그대로입니다.", false)) {
                notice.Show();
                using (var bitmap = new Bitmap(notice.Width, notice.Height)) { notice.DrawToBitmap(bitmap, new Rectangle(Point.Empty, notice.Size)); bitmap.Save(Path.Combine(root, "korean-notice.png")); }
            }
        });
        Test("progress notice hides acknowledgement until complete", delegate {
            using (var notice = new Notice("업데이트 진행 중\n앱을 종료하고 새 버전을 준비하고 있습니다.", true)) {
                notice.Show();
                foreach (Control c in notice.Controls) if (c is Button) Require(!c.Visible && !c.Enabled, "Progress acknowledgement is actionable");
                notice.SetMessage("업데이트를 적용하지 못해 이전 버전으로 되돌렸습니다.\n작업 내역은 그대로입니다.", false);
                foreach (Control c in notice.Controls) if (c is Button) Require(c.Visible && c.Enabled, "Final notice cannot be dismissed");
                using (var bitmap = new Bitmap(notice.Width, notice.Height)) { notice.DrawToBitmap(bitmap, notice.ClientRectangle); bitmap.Save(Path.Combine(root, "notice.png")); }
            }
        });
        Console.WriteLine(Json.Serialize(new { total = passed + failed, passed = passed, failed = failed }));
        return failed == 0 ? 0 : 1;
    }
}
