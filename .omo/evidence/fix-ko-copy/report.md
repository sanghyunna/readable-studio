# Korean Settings diagnostics and Claude ZIP import copy

## Scope and mechanism

The daemon does not send its internal model-discovery `kind` to the UI. `AgentDiagnostic` (re-exported by `apps/daemon/src/runtimes/types.ts` from `packages/contracts/src/api/registry.ts`) sends the eight `reason` values below. The web now selects a typed locale key from that reason, rather than rendering daemon prose as the headline. No daemon or desktop files were edited.

Internal discovery kinds map in `detection-probe.ts` as follows: `auth-required` -> `auth-missing`; `adapter-incompatible` -> `not-executable`; `discovery-failed` -> `discovery-failed` when an authenticated CLI-owned default remains usable, otherwise `auth-unknown`; `unverified` -> `auth-unknown`. Because the wire contract merges these states, the `not-executable` and `auth-unknown` copy deliberately covers both states without parsing English diagnostic prose. Databricks `auth-unknown` retains its existing model-configuration-specific override and Settings action.

## Kind/reason -> shipped copy

Key prefix: `settings.agentDiagnostic.`

| Wire reason / override | English | Korean |
| --- | --- | --- |
| `not-on-path` | CLI not found on PATH. Install it or check its executable path, then rescan. | PATH에서 CLI를 찾을 수 없습니다. CLI를 설치하거나 실행 파일 경로를 확인한 후 다시 스캔하세요. |
| `not-executable` | The CLI could not run or is incompatible with this adapter. Check its version, executable path, and permissions, then rescan. | CLI를 실행할 수 없거나 현재 어댑터와 호환되지 않습니다. 버전, 실행 파일 경로, 실행 권한을 확인한 후 다시 스캔하세요. |
| `shim-broken` | The CLI wrapper points to a missing executable. Reinstall the CLI or select a valid executable, then rescan. | CLI 래퍼가 가리키는 실행 파일이 없습니다. CLI를 다시 설치하거나 올바른 실행 파일을 선택한 후 다시 스캔하세요. |
| `configured-bin-invalid` | The configured CLI executable is missing or cannot run. Correct or clear the binary path override, then rescan. | 설정한 CLI 실행 파일이 없거나 실행할 수 없습니다. 실행 파일 경로 설정을 수정하거나 지운 후 다시 스캔하세요. |
| `auth-missing` | CLI sign-in required. Sign in with the CLI in a terminal, then rescan. | CLI 로그인이 필요합니다. 터미널에서 CLI에 로그인한 후 다시 스캔하세요. |
| `auth-unknown` | CLI usability could not be verified. Check sign-in, model configuration, and connection, then rescan online. | CLI 사용 가능 여부를 확인하지 못했습니다. 로그인 상태, 모델 설정, 연결을 확인한 후 온라인 상태에서 다시 스캔하세요. |
| `discovery-failed` | Live model discovery failed. Check the CLI configuration and connection, then rescan. | 사용 가능한 모델을 불러오지 못했습니다. CLI 설정과 연결을 확인한 후 다시 스캔하세요. |
| `probe-timeout` | CLI verification timed out. Check the CLI and connection, then rescan. | CLI 확인 시간이 초과되었습니다. CLI와 연결을 확인한 후 다시 스캔하세요. |
| Databricks `auth-unknown` (`databricks-no-models`) | No Databricks models are configured. Add or configure models in Settings > Databricks. | 설정된 Databricks 모델이 없습니다. 설정 > Databricks에서 모델을 추가하거나 구성하세요. |

Daemon raw messages remain only in the existing diagnostic tooltip when they differ from the localized headline and its English equivalent; identical English guidance is omitted as redundant. Probe details and searched directories remain intact. Technical names, paths, and environment variables are not translated.

Claude ZIP errors use `hubImport.claudeZipInvalid` for recognizable invalid-ZIP/central-directory failures: "올바른 Claude 디자인 ZIP 파일이 아닙니다. Claude에서 디자인을 ZIP으로 내보낸 후 해당 파일을 다시 선택하세요." Other failures use `hubImport.claudeZipFailed`: "Claude 디자인 ZIP을 가져오지 못했습니다. 파일과 연결을 확인한 후 다시 시도하세요." The existing Toast secondary-details line retains the original error and any callback details. Recognizing invalid ZIP failures from error text is necessary because the existing callback outcome exposes only message/details, not a machine error code. Generic connection errors are not mislabeled as invalid ZIPs.

Both diagnostic headlines and Toast headlines now have `word-break: keep-all`; `overflow-wrap: anywhere` remains an emergency fallback for long technical tokens.

## Other Settings / Hub import findings (not changed)

- `useOpenFolderImport.ts:57`: the web-folder import toast exposes `err.message` directly; its fallback is the English sentence `Failed to import folder`. The host branch also delegates to `formatPickAndImportFailure`. Different files/flow, outside the requested trivial-same-file fix scope.
- `HomeView.tsx:1331`: template-creation errors expose `err.message` directly; the no-Error fallback is already localized (`hubImport.templateCreateFailed`).
- `SettingsDialog.tsx:1540,1670,1875`: test/model-list errors preserve raw `err.message` as detail, with English fallback details `Test request failed` / `Model list request failed`.
- `SettingsDialog.tsx:4428`: MCP installation uses a translated sentence but interpolates a raw error. `SettingsDialog.tsx:4636`: the info error state takes raw `err.message` directly.
- `byok/validation.ts:132,141,158,166,176` contains English issue messages, but these are NOT direct UI leaks in Settings: `byokDraftIssueMessage` translates their machine codes exhaustively before rendering.
- The `HomeView.tsx:1885` raw error occurrence is analytics metadata, not user-visible copy.
- No other trivial English-prose toast/alert leak exists in the two targeted component files after this fix.

## Verification

Locale files were clean before edits; the typed keys were added to `types.ts` before both locale dictionaries. Other lanes' changes were left untouched.

Red command:

`pnpm --filter @readable-studio/web test tests/components/AgentDiagnosticRow.test.tsx tests/components/useClaudeZipImport.test.tsx --maxWorkers=2`

Parsed result: **2 files failed; 15 tests failed, 3 passed; 18 total**. Failures reproduced verbatim daemon headlines and `Import failed: Error: invalid zip: missing central directory`.

Final green command:

`pnpm --filter @readable-studio/web test tests/components/AgentDiagnosticRow.test.tsx tests/components/useClaudeZipImport.test.tsx tests/components/App.new-project-navigates.test.tsx tests/components/Toast.test.tsx --maxWorkers=2`

Parsed result: **4 files passed; 41 tests passed; 0 failed**. Korean renders exercise all eight reasons, Databricks guidance, both returned/thrown invalid-ZIP outcomes, and generic connection failures through the real Toast component. Assertions use shipped-copy equality, not pinned prose. The App suite exercises import failure, staying on the Hub, and successful retry navigation. Tests use React act around the exact import action, with no sleeps or polling added.

`pnpm --filter @readable-studio/web typecheck`: **exit 0** (including html-edit dependency typechecks). A transient TS7053 introduced while removing redundant details was fixed by preserving the template key's literal type; the final typecheck is clean.

Scoped `git diff --check`: **exit 0**. Repository-wide diff checking reports pre-existing/unrelated CRLF trailing-whitespace changes in `vendor/offline-cdn/chartjs/2/LICENSE.md`; not changed here. LSP diagnostics were unavailable because `typescript-language-server` is not installed; the actual TypeScript checker was run instead. No build, version bump, push, release, stash, worktree, clean, or checkout was performed. Verification is headless jsdom/App integration, not packaged screenshot rerendering.
