# Updater apply lane: blocked by the mandatory in-place swap layout

Reported 2026-10-01, within the 40-minute reporting budget. Task `st_01a0f5c9` started at approximately 13:45 +09:00.

## Outcome

**Do not expose Apply yet.** The Electron-parent survival gate is resolved. The next two prerequisites were exercised in order. A lingering bundled-Node process is detectable, but the required per-entry swap cannot guarantee recovery from the original executable on next launch. The actual published executable was tested in both broken states, not merely modeled.

No production source, apply endpoint, helper packaging, or version was changed. No portable build, release, push, installation, registry entry, or owner's installation was touched. This is a blocker report, **not a completed updater implementation**.

The transport correction is accepted: implementation must use Node `fetch`, streaming the response to a staging file while hashing. No main-process Electron-network bridge is needed or was built.

## Required decision

Authorize an **immutable bootstrap at the user-facing executable path, outside the replaceable/versioned Electron payload**, instead of the mandatory in-place top-level moves. That bootstrap must remain launchable without the payload's DLLs, `resources`, or application JS. It can read the installation-scoped transaction and launch the external PowerShell recovery helper or display the active-update message.

Keeping the current Electron executable at the user-facing path while moving its dependencies away cannot meet the requested guarantee. Adding a journal reader to `apps/packaged/src/launch.ts` does not solve this: that code lives inside the resources being moved and runs only after Electron's native bootstrap succeeds. Retaining an external `.ps1` recovery file is useful for manual repair, but does not make double-clicking the original `.exe` recover. A watchdog alone also fails after power loss or simultaneous helper death.

The exact mandatory order creates these unavoidable interruption points:

1. Old non-exe entries, including `resources` and DLLs, move aside while the old exe is still present. The startup journal reader may already be unavailable.
2. Old exe moves last. Before the staged exe moves first, the original executable path is absent.
3. Staged exe moves first, before its dependencies/resources arrive. It is not yet a complete runnable Electron payload capable of reading the journal.

A durable move journal can restore these states **when an independent recovery program is invoked**. It cannot invoke itself through an absent executable or missing Electron bootstrap dependencies. Changing only the journal format, adding retries, or reducing the interval does not remove these crash states.

## 1. Real Electron-parent survival: PASS via broker

Published v1.2.1 ZIP was extracted to `.tmp/updater-swap/app/`, with namespace `updater-swap`. Its SHA-256 matched the prototype's published digest:

`5de3898f60f3351eb8cde0723539e3eaa8c258bcc90e8effa7c1a63f43d4dd63`

See `artifact.json`. The isolated `resources/app/main.cjs` was instrumented to expose a named-pipe trigger, then require the original main entry. This ran the actual published Electron 41.3.0 app and its desktop/sidecars, not an `ELECTRON_RUN_AS_NODE` process. The desktop IPC returned `ok:true`, `state:running`, version 1.2.1 (`gate-running-status.json`). The test then triggered child creation from that Electron main and requested real desktop IPC shutdown (`gate-shutdown.json`).

Observed alternatives:

- Direct Node spawn with `detached:true`, `windowsHide:true`: PowerShell exited with code 0 before the script's first statement. `detached-direct-exit.json` preserves the exit result. This is not evidence of a job-object failure; its cause was not established.
- Direct spawn with `detached:false`, `windowsHide:true`: the helper acknowledged that it had drawn its window, but no post-parent-exit completion arrived and the helper was absent afterward. The mechanism causing its death was not established.
- **Working:** Electron launches an attached, hidden PowerShell broker; that broker uses `Start-Process -WindowStyle Hidden -PassThru` to launch the helper, with no `cmd` shim. The broker exits. The helper survives the real Electron parent's clean shutdown.

Final WPF run, `electron-parent-survival.json`:

- Electron PID 16632 exited.
- Helper PID 32564 remained alive, after broker PID in `gate-broker.json` had launched it.
- `survived:true`, `parentExited:true`, `windowVisible:true`.
- `consoleVisible:false`. A hidden console handle exists; this proves no visible console at capture, not that the process has no console object.
- WPF `ShowActivated:false` plus native `WS_EX_NOACTIVATE` on `SourceInitialized`.
- Progress HWND 853828; foreground HWND 462916: the helper was not foreground at capture.
- Korean WPF window: `electron-parent-progress.png`.

Important experiment correction: WPF `ShowDialog()` still made the progress window foreground despite `ShowActivated:false`. The final run uses `Show()`, a dispatcher loop, and `WS_EX_NOACTIVATE`; that run is the evidence above. Continuous focus preservation, production UI responsiveness, and relaunch were not proved by this gate experiment.

Reproducers are under `.tmp/updater-swap/`: `gate-run.ps1`, `gate-broker.ps1`, `gate-helper.ps1`, and the isolated app's instrumented `main.cjs`. Named events were created before triggering the action and awaited with bounded timeouts. No fixed sleeps were used.

## 2. Lingering sidecar after main-only forced kill: PASS, controlled reproduction

The actual Electron main spawned an additional plain-Node sidecar using the build's own `resources/readable-studio/bin/node.exe`, `detached:true`, and `windowsHide:true`. This controlled sidecar kept the app exe open and exposed a named-pipe readiness/stop protocol. It is an intentionally lingering sidecar, **not a claim that an ordinary daemon/web shutdown leaked a child**.

After its exact ready acknowledgement, only the Electron main PID was killed. The test did not terminate unrelated PIDs.

`linger-after-main-kill.json`:

- Main PID 31968, child PID 39736, with CIM parent identity recorded.
- Child remained alive after main-only kill.
- Executable-image prefix query detected it.
- Narrow Restart Manager registration detected it.
- 19 registered files: top-level payload files plus bundled `node.exe`.
- Detection snapshot elapsed 1537.237 ms from the main-only kill.

After an explicit stop request to that child and waiting for its exit event, the same barrier reported empty in one round, **513.6438 ms**, `linger-barrier-released.json`.

This demonstrates why waiting only for the window PID is unsafe. It does **not** establish a universal handle census or strict bounded enumeration: the inherited spike's Restart Manager/image/CIM queries are synchronous and can consume their own time. A production barrier still needs a supervised worker deadline and a typed query/timeout failure. No production barrier was added.

Reproducers: `.tmp/updater-swap/linger-sidecar.cjs`, `linger-run.ps1`, and the instrumented main trigger.

## 3. Mid-swap helper kill: FAILS automatic next-launch recovery

The app was quiescent first (`crash-preflight-barrier.json`, narrow registration empty). An external test helper wrote a flushed journal before each move, moved the entries, marked each step done, then signaled a named checkpoint. The controller killed **only that helper PID** at the checkpoint and exercised the original executable's launch surface.

### A. Kill after moving `resources`, with the original exe still present

`crash-resources-journal.json` has the completed move from `app/resources` to `app.old/resources`.

`crash-resources-next-launch.json`:

- Helper PID 42252 killed at the exact checkpoint.
- Original exe still exists; `resources` no longer exists there.
- Launch started PID 26880, then exited with **code 1**.
- No matching Windows dialog event was captured within the bounded observation.
- No application startup recovery ran.

This directly reproduces the dangerous silent-launch case. No screenshot of a nonexistent dialog is claimed.

### B. Kill after all old entries move aside, exe last

`crash-exe-gap-journal.json` records the complete old-payload move sequence, with `Readable Studio.exe` last. `ReadableStudioData` is excluded from every move.

`crash-exe-gap-next-launch.json`:

- Helper PID 42548 killed at the checkpoint.
- Original exe and resources paths are absent.
- Explorer's `Shell.Application.ShellExecute(..., 'open', ...)` produced the Windows file-not-found dialog, captured via an event subscription installed before launch.
- `crash-exe-gap-next-launch.png` shows the Korean Windows error.
- No application startup recovery can run from an absent exe.

This is the Explorer shell-open surface, not a physical mouse double-click. There was no custom `업데이트 진행 중` message in either interrupted state.

### Restoration and data preservation

After recording each failure, the **external experiment harness**, not the app, reversed moves from the journal. It restored the original exe and resources. `crash-restore.json` identifies the restorer explicitly.

83 pre-existing `ReadableStudioData` files had identical relative-path/SHA-256 manifests before and after these crash/move/restore experiments:

- `data-before-crash.json`
- `data-after-crash.json`
- `crash-restore.json`: `dataUnchanged:true`

Updater journal/temp/previous-journal files are excluded from that user-data comparison and were removed by the harness. The app was not normally relaunched between those two manifests; no equality across ordinary runtime writes is claimed.

### Journal lesson found while building the experiment

The first harness revision moved `resources` successfully but failed while marking its durable record done. `journal-write-failure.json` preserves `done:false` even though the destination existed. This demonstrates an essential recovery rule: a pending move cannot simply be ignored. Reconcile `from`/`to` existence and transaction ownership, then reverse or finish deterministically. Reverse-recovery operations themselves also need durable intent/completion records.

The initial harness used PowerShell `[IO.File]::Replace(..., $null)`; using a nonempty previous-journal path corrected that experiment failure. Its cleanup was also corrected to reconcile actual paths, not only `done:true`. These are harness corrections, not shipped implementation.

## What remains undone

All production apply work remains blocked: Node-fetch download/hash/staging, transaction ownership across namespaces, production journal state machine/tests, startup journal/data-lock gate, supervised all-writers barrier, shipping helper manifest/cache inputs and absence test, apply HTTP integration, version-confirmed relaunch and `.old` retirement. No modified staged version, full successful apply, or automatic recovery was demonstrated. No new tests/build/typecheck were claimed; there are no production-code changes to validate.

I stopped rather than ship a partially safe updater, a placeholder apply endpoint, or an implementation that only passes the success path. The proven gate mechanism and exact crash evidence are reusable once the immutable-launcher/layout decision is made.

## Experiment hygiene

All payload modifications were confined to `.tmp/updater-swap/`; only PIDs started by these experiments were terminated. Only filename discovery via `fd` was used. One manual negative probe initially sourced the prototype's hard-coded evidence variable and wrote its own error log into the prototype evidence directory; that newly created file was immediately moved to this lane as `manual-helper-probe-error.log`, and subsequent runs used a path-corrected common script. No original prototype evidence was edited. Some exploratory harness commands failed (wrong IPC-envelope assertion; a shell-quoted process listing; missing checkpoint cleanup); these were corrected and are not counted as successful evidence.
