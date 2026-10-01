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
| Live helper (PID and start time match), or mutex held | Korean progress window; no launch |
| Confirmed, app exists, cleanup pending | Delete old payload or defer locked cleanup; reuse confirmed live app or launch; no recovery/failure notice |
| Confirmed and finished, nothing pending | Reuse confirmed live app or launch normally |
| Complete with no old/staging payload, or finished/rolled-back with no old payload | Launch normally; no running-app barrier |
| Known incomplete state, helper dead, no running payload | Restore old if present, otherwise retain current app; Korean rollback notice; launch |
| Known incomplete state, payload still running | Korean notice naming state and asking user to close app and retry; no destructive operation |
| Unknown/corrupt state or missing launchable app | Korean state/action notice; preserve all payload directories |

`app.old` and `app.failed` must be resolved before beginning another update.
The updater never enumerates or changes `ReadableStudioData`.

## Tests

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/packaged/launcher/tests/run.ps1 -OutputDirectory .tmp/stub-fix/validation
```

The harness compiles the shipped launcher, tests its decision table and the real
Windows locked-file cleanup/retry behavior, and rejects confirmed rollback.
Integration-only checkpoints use `READABLE_UPDATE_TEST_ID` and
`READABLE_UPDATE_TEST_POINT` with named event handles installed by the controller
before helper launch; normal launches do not set these variables.
