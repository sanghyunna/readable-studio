using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using ReadableStudio.Launcher;

public static class RecoveryTests {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "CreateHardLinkW", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern bool CreateHardLink(string link, string existing, IntPtr security);
    static int passed, failed;
    static void Test(string name, Action action) {
        try { action(); passed++; Console.WriteLine("PASS " + name); }
        catch (Exception error) { failed++; Console.WriteLine("FAIL " + name + ": " + error); }
    }
    static void Require(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
    [STAThread] public static int Main(string[] args) {
        if (Environment.GetEnvironmentVariable("F11B_PAYLOAD") == "1") {
            string top = Environment.GetEnvironmentVariable("F11B_ROOT");
            string ready = Path.Combine(top, "update-ready.json");
            File.WriteAllText(ready + ".tmp", new JavaScriptSerializer().Serialize(new {
                id = Environment.GetEnvironmentVariable("READABLE_UPDATE_TRANSACTION"),
                version = Environment.GetEnvironmentVariable("READABLE_UPDATE_TARGET")
            }));
            // Publish the closed file without File.Move's transient rename
            // handle: the watcher can observe its event before that handle
            // releases its sharing lock. A hard link is atomically readable.
            if (!CreateHardLink(ready, ready + ".tmp", IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
            return 0;
        }
        string root = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(root);
        Test("readiness tolerates a controllable shared writer", delegate {
            using (var tx = new Transaction(root)) {
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4" };
                string json = new JavaScriptSerializer().Serialize(new { id = tx.State.id, version = tx.State.target });
                using (var writer = new FileStream(tx.FileAt("update-ready.json"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) {
                    byte[] bytes = System.Text.Encoding.UTF8.GetBytes(json);
                    writer.Write(bytes, 0, bytes.Length); writer.Flush();
                    Require(tx.Ready());
                }
            }
        });
        Test("readiness treats exclusive writer as pending", delegate {
            using (var tx = new Transaction(root)) {
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4" };
                using (var writer = new FileStream(tx.FileAt("update-ready.json"), FileMode.Create, FileAccess.Write, FileShare.None))
                    Require(!tx.Ready());
                File.WriteAllText(tx.FileAt("update-ready.json"), new JavaScriptSerializer().Serialize(new { id = tx.State.id, version = tx.State.target }));
                Require(tx.Ready());
            }
            File.Delete(Path.Combine(root, "update-ready.json"));
        });
        Test("successful cleanup removes receipts and stale error logs only", delegate {
            string successRoot = root + "-success"; Directory.CreateDirectory(successRoot);
            using (var tx = new Transaction(successRoot)) {
                Require(tx.TryLock());
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4", confirmed = true, step = "cleanup" };
                foreach (string name in new[] { "update-ready.json", "update-error.log", "update-launcher-error.log", "update-broker-error.log", "update-barrier-error.log", ".update-failed-apply.json" })
                    File.WriteAllText(tx.FileAt(name), "stale");
                File.WriteAllText(tx.FileAt("update-ready.json"), new JavaScriptSerializer().Serialize(new { id = tx.State.id, version = tx.State.target, pid = 1234 }));
                tx.BeginCleanup();
                tx.Cleanup();
                foreach (string name in new[] { "update-ready.json", "update-error.log", "update-launcher-error.log", "update-broker-error.log", "update-barrier-error.log" })
                    Require(!File.Exists(tx.FileAt(name)));
                Require(File.Exists(tx.FileAt(".update-failed-apply.json")) && File.Exists(tx.FileAt("update-journal.json")));
                Require(tx.Read().readyPid == 1234);
            }
        });
        Test("rollback cleanup requires restored readiness", delegate {
            using (var tx = new Transaction(root)) {
                Require(tx.TryLock());
                Directory.CreateDirectory(tx.FileAt("app"));
                File.WriteAllText(tx.FileAt("app\\Readable Studio.exe"), "healthy");
                Directory.CreateDirectory(tx.FileAt("app.failed"));
                File.WriteAllText(tx.FileAt("app.failed\\broken"), "failed");
                Directory.CreateDirectory(tx.FileAt("ReadableStudioData"));
                File.WriteAllText(tx.FileAt("ReadableStudioData\\marker"), "keep");
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.3", step = "rolled-back" };
                tx.Save();
                try { tx.Cleanup(); } catch (UpdateFailure) { }
                Require(tx.Exists("app.failed"));
                File.WriteAllText(tx.FileAt("update-ready.json"), new JavaScriptSerializer().Serialize(new { id = tx.State.id, version = tx.State.target }));
                tx.Cleanup();
                Require(!tx.Exists("app.failed"));
                Require(File.ReadAllText(tx.FileAt("app\\Readable Studio.exe")) == "healthy");
                Require(File.ReadAllText(tx.FileAt("ReadableStudioData\\marker")) == "keep");
            }
        });
        Test("next update can swap and roll back again", delegate {
            using (var tx = new Transaction(root)) {
                Require(tx.TryLock()); tx.Read();
                Require(!tx.Exists("app.failed"));
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4" }; tx.Save();
                Directory.CreateDirectory(tx.FileAt("app.staging"));
                File.WriteAllText(tx.FileAt("app.staging\\Readable Studio.exe"), "next");
                tx.Move("old-move", "app", "app.old"); tx.Move("new-move", "app.staging", "app");
                tx.Rollback();
                Require(File.ReadAllText(tx.FileAt("app\\Readable Studio.exe")) == "healthy");
                Require(File.ReadAllText(tx.FileAt("app.failed\\Readable Studio.exe")) == "next");
            }
        });
        Test("notice measures Korean text without wrapping", delegate {
            string message = new string('\uac00', 70);
            using (var notice = new Notice(message, false)) {
                Label label = null;
                foreach (Control control in notice.Controls) if (control is Label) label = (Label)control;
                Require(label != null);
                Size measured = TextRenderer.MeasureText(message, notice.Font, Size.Empty, TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                Require(label.Width >= measured.Width);
                Require(label.Right <= notice.ClientSize.Width);
            }
        });
        Test("next helper attempt safely clears a legacy failed payload", delegate {
            using (var tx = new Transaction(root)) {
                Require(tx.TryLock()); tx.Read();
                File.Delete(tx.FileAt("update-ready.json"));
                var prepare = typeof(Transaction).GetMethod("PrepareNextUpdate");
                Require(prepare != null);
                try { prepare.Invoke(tx, new object[] { 0 }); throw new Exception("Unproven app allowed failed payload deletion"); }
                catch (System.Reflection.TargetInvocationException error) { Require(error.InnerException is UpdateFailure); }
                Require(tx.Exists("app.failed"));
                File.WriteAllText(tx.FileAt("update-ready.json"), new JavaScriptSerializer().Serialize(new { id = tx.State.id, version = tx.State.target }));
                prepare.Invoke(tx, new object[] { 0 });
                Require(!tx.Exists("app.failed"));
                Require(File.Exists(tx.FileAt("app\\Readable Studio.exe")));
                Require(File.Exists(tx.FileAt("ReadableStudioData\\marker")));
            }
        });
        Test("failed startup restores and starts previous payload immediately", delegate {
            string recoveryRoot = root + "-automatic"; Directory.CreateDirectory(recoveryRoot);
            File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), Path.Combine(recoveryRoot, "Readable Studio.exe"), true);
            using (var tx = new Transaction(recoveryRoot)) {
                Require(tx.TryLock());
                Directory.CreateDirectory(tx.FileAt("app"));
                File.WriteAllText(tx.FileAt("app\\Readable Studio.exe"), "not executable");
                Directory.CreateDirectory(tx.FileAt("app.old\\resources"));
                File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location, tx.FileAt("app.old\\Readable Studio.exe"), true);
                File.Copy(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Readable Studio.exe"), tx.FileAt("app.old\\Readable Studio.dll"), true);
                File.WriteAllText(tx.FileAt("app.old\\resources\\readable-studio-config.json"), "{\"appVersion\":\"1.3.3\"}");
                tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.3.4", step = "complete" }; tx.Save();
                tx.Claim();
                Require(!tx.LaunchAndWaitReady(10000));
                Require(tx.TryLock());
                Environment.SetEnvironmentVariable("F11B_PAYLOAD", "1");
                Environment.SetEnvironmentVariable("F11B_ROOT", recoveryRoot);
                try {
                    bool observed = false;
                    tx.ReadyObserved += delegate { observed = true; Require(tx.Exists("app.failed")); };
                    var recover = typeof(Transaction).GetMethod("RecoverAndLaunch");
                    Require(recover != null);
                    Require((bool)recover.Invoke(tx, new object[] { 10000 }));
                    Require(observed);
                    Require(tx.State.step == "rolled-back" && tx.Ready());
                    Require(!tx.Exists("app.failed") && !tx.Exists("app.old"));
                } finally {
                    Environment.SetEnvironmentVariable("F11B_PAYLOAD", null);
                    Environment.SetEnvironmentVariable("F11B_ROOT", null);
                }
            }
        });
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { total = passed + failed, passed = passed, failed = failed }));
        return failed == 0 ? 0 : 1;
    }
}
