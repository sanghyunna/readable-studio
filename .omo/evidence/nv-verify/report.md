# nv-verify report

Exit codes are the captured process codes in `*.exit`; counts are parsed from the vitest/node:test summary lines in `*.log`. Source was not modified.

## Git state
```
91df2d0 feat(web): hide Hub template brief behind a removable chip in the composer and chat bubble
3d61452 feat(web): add favorite star to Hub template carousel cards with favorites-first ordering
dba2bc3 feat(config): persist template favorites in app config and add templates favorites CLI
cdff7a6 fix(daemon): keep Pi session root in scope for run-close persistence
08eaff3 feat(web): add vertical type tabs to the Hub template carousel
3930d85 fix: recover packaged daemon death and reconnect conversations
ecfbeef fix(daemon): log fatal failures before exiting
9fce49d fix(daemon): scope probe shutdown to server lifetime
dd34e6b fix(desktop): preserve absent scrollbar gutter during image export
d87c649 fix(packaged): put newer-schema refusal details on separate lines
0a7d9f3 fix: hide child-process windows in probe cleanup and pack tooling
7b44dc9 fix: honor explicit chat choices with session selection
---
```
(git status --porcelain printed nothing after the "---" line if the tree was clean; see git.log)

## Gates
| Gate | Command | Exit | Parsed counts | Log |
|---|---|---|---|---|
| guard | pnpm guard | 0 | node:test tests 54, pass 54, fail 0 (home-capabilities and guard.ts steps also passed, since the chain reached the tests) | guard.log |
| typecheck | pnpm typecheck (root) | 0 | no "error TS" lines; every package printed Done | typecheck.log |
| web full | pnpm --filter @readable-studio/web exec vitest run --pool=threads --maxWorkers=8 --fileParallelism | 1 | Test Files  7 failed | 539 passed (546); Tests  66 failed | 5206 passed | 1 skipped (5273) | web.log |
| contracts | pnpm --filter @readable-studio/contracts test | 0 | Test Files  35 passed (35); Tests  436 passed (436) | contracts.log |
| daemon (17 files, --maxWorkers=1) | vitest run -c vitest.config.ts --maxWorkers=1 <files in daemon-files.txt> | 1 | Test Files  3 failed | 14 passed (17); Tests  4 failed | 191 passed (195) | daemon.log |
| rerun web reachability alone | vitest run tests/styles/interactive-reachability-contracts.test.ts | 1 | 1 failed, 11 passed (12) | rerun-web-reachability.log |
| rerun 3 daemon files alone | vitest run the 3 failing files, --maxWorkers=1 | 1 | Test Files 1 failed, 2 passed (3); Tests 2 failed, 30 passed (32) | rerun-daemon.log |

Daemon file set: the 3 src files changed since 9fce49d are app-config.ts, cli.ts, server.ts. The set is the 4 changed tests (app-config.test, app-config-template-favorites.test, fatal-daemon-log.test, pi-run-completion.test), plus tests importing ../src/app-config or ../src/cli (found with fd + grep, 13 files), plus app-config-cli.test and cli-templates.test added by name. 17 files in total. Tests that reach app-config or cli only through server.ts were not included. Full list in daemon-files.txt.

## Failure table
| File | Failed | Gate | Classification | First error | Introducing commit |
|---|---|---|---|---|---|
| web FileViewer.manual-edit-dirty | 11 | web | KNOWN pre-existing | clickManualTool (test line 26) | n/a |
| web FileViewer.manual-edit-save-flush | 20 | web | KNOWN pre-existing | not re-inspected | n/a |
| web FileViewer.manual-edit | 10 | web | KNOWN pre-existing | clickManualTool (test line 24) | n/a |
| web FileViewer.edit-cost | 1 | web | KNOWN pre-existing | not re-inspected | n/a |
| web FileViewer.manual-edit-gesture-refresh | 6 | web | KNOWN pre-existing | not re-inspected | n/a |
| web ProjectView.queued-question-roundtrip | 17 | web | KNOWN pre-existing | not re-inspected | n/a |
| web tests/styles/interactive-reachability-contracts.test.ts "pairs pointer-events with opacity in every applied keyframe" | 1 | web | **NEW** (fails alone, exit 1) | keyframe that reaches opacity 0 must declare pointer-events in the same step; offender: `home-hero-fav-pop (styles/home/home-hero.css)` | 3d61452 feat(web): add favorite star to Hub template carousel cards (introduced the favorite star UI; the keyframe is at home-hero.css:2752). Other commits touching this file since 9fce49d: 91df2d0, 08eaff3. I did not run git blame, so which of the three added the keyframe is unconfirmed. |
| daemon tests/low-spec-background-detection.test.ts "initializes cold Claude streaming capabilities on demand" (full and low) | 2 | daemon | **NEW by the stated rule** (fails alone, exit 1) | expected SSE body to contain `partialMessages":true`, received `{"partialMessages":false}` | Not determined. Between 9fce49d and HEAD, the commits touching server.ts are ecfbeef (fatal log write) and cdff7a6 (piSessionRoot moved). Neither diff touches capability or partialMessages logic. The test file was last changed in afd2dcf (1.1.0). I could not bisect: checking out the base commit is banned for this task. It is likely pre-existing or environment-dependent, but this is not verified. |
| daemon tests/databricks/pi-turn.test.ts "registered anthropic-messages ..." | 1 | daemon | **LOAD-ONLY** (passes alone, rerun file passed) | Pi turn 1 failed, DATABRICKS_UPSTREAM_UNAVAILABLE | n/a |
| daemon tests/integrations/vela.routes.test.ts "returns an error when the login subprocess exits immediately with stderr" | 1 | daemon | **LOAD-ONLY** (passes alone, rerun file passed) | expected 202 to be 500 | n/a |

The web gate ran concurrently with the contracts and daemon gates. The load-only classifications rest on that.

Web file counts (from FAIL lines) sum to 66 = 11+20+10+1+6+17+1, matching "66 failed". I did not individually re-run the six known files, as the task says they are known.
