# Immutable Windows launcher

Build `ReadableStudioLauncher.cs` with inbox Framework64 v4.0.30319 `csc.exe`,
`/target:winexe /platform:x64`, the product icon, and references to
`System.Windows.Forms.dll`, `System.Drawing.dll`, and `System.Web.Extensions.dll`.
The output is `<top>\Readable Studio.exe`; payload is `app\Readable Studio.exe`.

The PowerShell files must be adjacent to one another. They can be packaged under
`app\resources\update-helper`; all script contents and the shared launcher
assembly are loaded before moving the payload. The broker detaches the helper:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File update-broker.ps1 -Root <top> -Staging <top>\app.staging -TargetVersion <x.y.z> -WaitPid <electron-main-pid>
```

The helper waits for that PID and an all-payload-holders barrier before renaming.
Journal writes are atomic replacements under a per-installation named mutex.
Process ownership uses PID plus process start time, not PID alone.

## Startup confirmation contract

The helper launches the top-level stub with `--readable-update-start=<journal-id>`.
Only a live helper in journal step `complete` authorizes that internal launch.
The payload receives `READABLE_UPDATE_TRANSACTION` and `READABLE_UPDATE_TARGET`.
After real desktop readiness it must atomically write `<top>\update-ready.json`:

```json
{"id":"<journal-id>","version":"<target-version>","pid":1234}
```

The helper waits for the exact matching receipt, then persists `confirmed:true`
before deleting any old payload. Confirmation is irreversible. Old files locked
by Windows leave `cleanup` pending for the next launch; this is not a failure.
An existing receipt-identified process is reused only if its executable path
matches this installation's `app\Readable Studio.exe`. Its window is shown
without activating it. This avoids a second Electron startup racing the
published payload's data lock (which precedes its single-instance lock).

## Ordered decision table

| State | Action |
| --- | --- |
| No journal; app executable exists | Launch normally; no running-app barrier |
| Live helper (PID and start time match), or mutex held | Korean progress window; wait for ownership to end, then launch the settled payload |
| Confirmed, app exists, cleanup pending | Delete old payload or defer locked cleanup; reuse confirmed live app or launch; no recovery/failure notice |
| Confirmed and finished, nothing pending | Reuse confirmed live app or launch normally |
| Complete with no old/staging payload, or finished/rolled-back with no old payload | Launch normally; no running-app barrier |
| Known incomplete state, helper dead, no running payload | Restore old if present, otherwise retain current app; Korean rollback notice; launch |
| Known incomplete state, payload still running | Korean notice naming state and asking user to close app and retry; no destructive operation |
| Unknown/corrupt state or missing launchable app | Korean state/action notice; preserve all payload directories |

If a new payload fails to start, the helper restores and immediately starts the
previous payload while keeping the progress notice visible. Recovery uses a new
receipt ID and the restored payload's configured version. Only that successful
startup permits deletion of `app.failed`; locked files remain pending for the
next launch. Legacy failed-payload leftovers can also be removed before another
update when its requesting process is verified as this installation's running
app. The rollback notice replaces the progress text in the existing message
loop, and technical failures stay in the update logs.

`app.old` and `app.failed` must be resolved before beginning another update.
Completed and rolled-back attempts remove handoff receipts, temporary files and
the journal backup, while retaining the durable journal and app-ready receipt.
Helper-driven launcher stubs remain alive until readiness or process exit and
never open a second failure notice. The 180-second timeout is only the ceiling
for a process that remains alive without confirming readiness.

Payload processes use `ReadableStudioData\namespaces\<namespace>` as their working
directory, including normal launches, so relative driver/cache writes cannot land
in the portable install root. The launcher creates that directory if needed; it
does not enumerate or change existing user data.

## Tests

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/packaged/launcher/tests/run.ps1 -OutputDirectory .tmp/stub-fix/validation
```

The harness compiles the shipped launcher, tests its decision table and the real
Windows locked-file cleanup/retry behavior, and rejects confirmed rollback.
Recovery tests exercise an invalid executable through the real launcher, start
a receipt-writing fake previous payload, verify failed-payload cleanup and the
next update, and render notice labels only on the private desktop. Helper
tests invoke the shipped timer callback with controllable worker/form fakes.
Attempt tests cover consecutive successful and rolled-back swaps, legacy handoff
debris, early payload exit, manual launches during apply, icon ownership and
disabled progress acknowledgement. The private-desktop host contains every
descendant in a kill-on-close job and audits the job and interactive desktop.
All assertion groups emit JSON counts.
Integration-only checkpoints use `READABLE_UPDATE_TEST_ID` and
`READABLE_UPDATE_TEST_POINT` with named event handles installed by the controller
before helper launch; normal launches do not set these variables.
