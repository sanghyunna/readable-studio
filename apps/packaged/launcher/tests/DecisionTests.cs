using System;
using System.IO;
using ReadableStudio.Launcher;
public static class DecisionTests {
    static int count;
    static void Check(string expected, Journal state, bool active, bool app, bool old, bool stage, bool running) {
        string actual = Transaction.Decide(state, active, app, old, stage, running);
        if (actual != expected) throw new Exception("Expected " + expected + ", got " + actual + " at " + (state == null ? "no-journal" : state.step));
        count++;
    }
    public static int Main(string[] args) {
        Check("launch", null, false, true, false, false, false);
        Check("launch", null, false, true, false, false, true);
        Check("invalid", null, false, false, false, false, false);
        var state = new Journal { step = "complete" };
        Check("launch", state, false, true, false, false, true);
        Check("active", state, true, true, true, false, true);
        foreach (string step in new[] { "prepared", "old-move", "new-move", "rollback-new", "rollback-old" }) {
            state.step = step;
            Check("rollback", state, false, true, true, false, false);
            Check("running-incomplete", state, false, true, true, false, true);
        }
        state.step = "prepared";
        Check("cancel", state, false, true, false, true, false);
        Check("invalid", state, false, false, false, true, false);
        state.step = "unknown";
        Check("invalid", state, false, true, true, true, false);
        state.confirmed = true;
        foreach (string step in new[] { "cleanup", "complete", "finished", "unknown" }) {
            state.step = step;
            Check("cleanup", state, false, true, true, false, true);
            Check("invalid", state, false, false, true, false, false);
        }
        state.step = "finished";
        Check("launch", state, false, true, false, false, true);
        // Exercise the real deletion/journal engine with a Windows sharing lock.
        string root = Path.GetFullPath(args[0]); Directory.CreateDirectory(root);
        Directory.CreateDirectory(Path.Combine(root, "app.old"));
        string locked = Path.Combine(root, "app.old", "locked.bin"); File.WriteAllText(locked, "unchanged");
        using (var tx = new Transaction(root)) {
            if (!tx.TryLock()) throw new Exception("Test mutex unavailable");
            tx.State = new Journal { id = Guid.NewGuid().ToString(), target = "1.2.2", confirmed = true, step = "cleanup" };
            tx.Save();
            using (var holder = new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                tx.Cleanup();
                if (!tx.State.confirmed || tx.State.step != "cleanup" || tx.State.done || tx.State.pid != 0 || !File.Exists(locked)) throw new Exception("Locked cleanup must remain successful and pending");
                count++;
            }
            tx.Cleanup();
            if (!tx.State.confirmed || tx.State.step != "finished" || !tx.State.done || Directory.Exists(Path.Combine(root, "app.old"))) throw new Exception("Cleanup retry did not finish");
            count++;
            try { tx.Rollback(); throw new Exception("Confirmed rollback allowed"); }
            catch (UpdateFailure e) { if (e.Code != "confirmed-rollback") throw; count++; }
        }
        Console.WriteLine("PASS: " + count + " launcher assertions"); return 0;
    }
}
