# Adjacent Codex summary duplicate regression

## Capture attempt

Four sequential headless gpt-6-luna/xhigh app-server turns completed successfully using codexAgentDef.buildArgs and createAgentCommandInvocation with the resolved npm codex.cmd shim. Spawn options matched the daemon (piped stdio, windowsHide, windowsVerbatimArguments); attachCodexAppServerSession performed the daemon's actual initialize/thread/start/turn/start handshake. The task was the packaged attempt3 Korean read-index.html prompt, in `.tmp/codex-dup/` with a small Korean title/h1 HTML file. No concurrent Codex processes were launched.

The initial unresolved `codex` spawn returned ENOENT before launching a process; resolving `%APPDATA%/npm/codex.cmd` fixed that invocation.

Completed reasoning summaries per successful attempt: 3, 6, 5, 5. No exact adjacent duplicate was captured. Some individual item IDs contained two different summaries. Raw stdout and stderr remain local at `.tmp/codex-dup/codex-dup-attempt{1,2,3,4}.{jsonl,log}`. Therefore the packaged failure's original item identities, and whether it was a distinct-item duplicate or an uncovered replay, remain unknown.

Free physical/free commit memory before capture: 14.09/15.89 GiB; before verification: 14.32/16.05 GiB.

## Regression source and intended change

`codex-duplicate-attempt3.events.json` contains the parsed agent data from `.omo/evidence/test-build-head/attempt3-smoke-run-events-raw.log`. This is captured SSE, not raw Codex wire. The test assigns distinct synthetic item IDs to the summary events: an explicit assumption exercising the case that identity-only dedupe cannot cover, not a claim about the real IDs.

The Codex adapter is the narrowest runtime-specific layer with actual summary-part boundaries. It now compares adjacent complete summary parts after trim within a contiguous thinking block, withholding only possible duplicate prefixes while preserving normal streaming once they differ. Text and tool events reset the comparison. Identical chunks within one summary, different summaries, non-adjacent repeats, and repeats across blocks remain. No shared web renderer or other runtime was changed.

New golden `codex-duplicate-attempt3.events.json` projects thinking/text events from this replay. Relative to the original SSE projection, its only removed event is the second identical summary (SSE id 5). The later summary and every text delta remain equal to the source. Existing `codex-luna-index.events.json` has no diff, and no existing golden was changed.

## Verification

RED command: daemon vitest with codex-reasoning-capture, codex-app-server, mocks-golden, cursor-stream-replay, and runtimes/thinking-replay: **35 passed, 5 failed, 40 total**. All five failures were the intended adjacent-dedupe regressions. One completed-only/shorter-prefix test was subsequently added.

GREEN same five-file command: **41 passed, 0 failed**. Runtime golden/mock replay suites specifically (mocks-golden, cursor-stream-replay, thinking-replay): **25 passed before and 25 passed after**, covering Claude, Codex, OpenCode, and Cursor. Additional focused codex-streaming-route verification: **1 passed**, for a combined daemon focused result of **42 passed, 0 failed**.

Web thinking-token-ordering and AssistantMessage tests: **27 passed, 0 failed**; the new test feeds the daemon golden through createBufferedTextUpdates and renders/expands the actual AssistantMessage thinking blocks. It checks one paragraph in the first block, preservation of the later block, and shipped-copy equality of answer text.

Daemon source/test tsc --noEmit: exit 0. Web tsc -b --noEmit: exit 0 after fixing an undefined-index error in the new test. Daemon build (tsc): exit 0. LSP diagnostics could not run because typescript-language-server is not installed; package TypeScript validators were run instead.
