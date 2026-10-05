# P0 daemon-death recovery UX - 2026-10-05

## Scope and environment

Owner baseline: `9fce49d`; Windows, Node `v24.16.0`, pnpm `10.33.2`.
Another lane committed daemon fatal-error observability as `ecfbeef` during this work. This lane did not edit daemon source or the owner's portable installation. No builds, GUI launches, pushes, stashes, worktrees, clean, or checkout-path commands were run. Only this lane's test/fixture/browser processes were terminated.

## Mechanism and fix

- Packaged supervision previously removed its child exit listener after startup readiness. A daemon death thereafter had no restart or user-facing failure path.
- `listConversations` flattened failed reads to `[]`; ProjectView interpreted this as an empty project and attempted creation. Its null-create error was unrelated English copy.
- Shortcut delivery retried and logged an unreachable fetch every second. Owner evidence: `.tmp/EMERGENCY-backup-rg-full-131354/logs/desktop/latest.log` lines 22-24 contain `shortcut loop: {}` at `04:08:19.457`, `04:08:20.469`, and `04:08:21.479` UTC.

The packaged launcher now watches the daemon's exit event throughout its lifetime, logs PID/code/signal, and restarts on the original port with the same five-field stamp, namespace, data root, approval bearer and managed environment. Three attempts use 1/2/4-second backoff and a maximum 30-second readiness budget each. Three minutes of stable service reset the retry budget. Runtime restart logs append; initial startup preserves existing log initialization behavior. Shutdown cancels supervision and drains any in-flight restart.

Exhaustion invokes the packaged entry's existing error-dialog pattern, using a typed `DAEMON_STOPPED` error and Korean service-stopped copy with Retry/Quit. Retry resets the restart budget; Quit delegates normal desktop shutdown.

ProjectView uses strict, abortable listing, presents typed `connection.reconnecting` copy (`연결이 끊겼습니다 - 다시 연결 중` in Korean), and retries reads with bounded backoff. Every automatic seed retry lists first. A lost create response followed by an existing conversation is reused, not POSTed again. Explicit new-conversation failure reloads the authoritative list rather than blindly replaying the mutation. Shortcut failures log serializable details once per outage and exponentially back off to 30 seconds, resetting after success.

## Red before fix

- Packaged child-death regressions: **2 failed**. Both timed out awaiting `daemon-restart-ready` after terminating fixture children.
- ProjectView reconnect regression: **1 failed**. `expected 'Failed to fetch' to be undefined` because no typed reconnect key existed; the old path did not retry.
- Shortcut backoff regression: **1 failed**. `expected vi.fn() to be called 2 times, but got 3 times` after two seconds of unreachable service.

## Final validation

All commands were executed headlessly. Packaged package scripts transitively build desktop, so their underlying validators were invoked directly instead.

| Validator | Result |
|---|---|
| `pnpm --filter @readable-studio/packaged exec vitest run -c vitest.config.ts --maxWorkers=1 --testTimeout=15000` | **246 passed**, 22 files |
| `pnpm --filter @readable-studio/desktop test` | **192 passed**, 34 files |
| Web related tests, six files, `--maxWorkers=1` | **62 passed**, 6 files |
| Packaged `tsc -p tsconfig.json --noEmit` and `tsconfig.tests.json` | Passed |
| Desktop `typecheck` | Passed |
| Web `typecheck` | Passed |
| `pnpm guard` | Structural checks passed; **54 passed**, 0 failed |
| `git diff --check` | Passed |

Web related files: `ProjectView.bounded-history`, `ProjectView.deleteConversation`, `ProjectView.api-empty-response`, `ProjectView.pendingPrompt`, `ProjectView.first-turn-hydration`, and `state/projects`.

Total passing scoped app tests: **500**. Guard adds **54**.

Real-child tests kill only their own fixture daemon PID and subscribe to the exact restart event before killing it. Assertions verify a new daemon PID, unchanged URL/port/data-root/namespace/IPC, and only one web spawn. Four successive fixture daemon deaths exhaust three restart attempts and invoke the failure callback with `DAEMON_STOPPED`; dialog machine fields verify Retry/Quit/default/cancel semantics. Fake-clock web tests verify failed listing causes no create, shipped Korean-copy equality, automatic recovery, and one POST when a created conversation's response is lost. Transport tests cover network errors, HTTP 500 and proxy 502. Shortcut fake-clock tests verify backoff and one log per outage.

Real source-daemon shutdown fixture output from final suite:

```json
{"sourceDaemon":true,"daemonPid":40268,"probePid":27876,"daemonAliveAfter":false,"probeAliveAfter":false,"elapsedMs":79.95389999999679,"forced":false}
```

## Broader validation limitations

The full web suite was attempted with four workers but exceeded a 500-second budget. It emitted failures outside this change's scope, including FileViewer manual-edit tests and `TypeError: log.scrollTo is not a function` in queued-question tests. No failing tests were deleted, skipped, or changed. That run's recorded PIDs `40436` and `42264` were terminated after checking their command lines. No final full-web-suite green claim is made.

Parallel validation initially produced packaged data-import/startup timeout failures. Serial, bounded-worker final validation passed all 246 without changing those tests. A later related-web run exceeded its budget under concurrent load; its recorded PID `15632` was terminated after command-line verification. Final serial related-web validation passed 62.

LSP diagnostics could not run because `typescript-language-server` is absent; compiler checks above passed.

A real Chrome headless browser was driven through omowright against the existing local `.next` output, served by a task-owned HTTP fixture. Observed proxy response: **502**, POST count at snapshot: **0**; the Korean shell showed `세션을 불러올 수 없습니다.` and a Retry button. This is only baseline/browser-surface evidence: the existing build is not rebuilt source and the snapshot was still loading the workspace. Freshly built ProjectView reconnect rendering and a real Electron Retry/Quit interaction remain **unverified**, respecting the explicit build/GUI bans. The source behavior is verified by the regression and real-child tests above.

## Assumptions resolved from context

- Keep the original daemon port: the surviving web sidecar's proxy is pinned to that upstream. Port changes would require restarting web, contrary to seamless recovery.
- Keep the existing soft listing contract for other callers; strict reads are opt-in at ProjectView.
- Do not replay an uncertain explicit create mutation: the contract has no client idempotency key. Reconnect by authoritative listing instead.
- Native dialog localization follows the existing OS-locale pattern; product UI localization follows the existing typed Korean/English dictionary.

## Cleanup

Temporary scripts/logs and the debug journal are removed after promotion to this MD. The browser was headless with a task-owned profile, not the owner's browser/profile. Existing portable and unrelated processes were not terminated. The commit contains only explicit packaged/desktop/web fix and test paths plus this evidence document.
