# Folder, template, and Settings error localization

## Delivered scope

- `useOpenFolderImport` now always uses typed `hubImport.folderFailed` for both web and host failure headlines. Web exceptions preserve `Error.message` only in the existing Toast details line. Host returned failures still delegate to `formatPickAndImportFailure`, but its English wrapper/message and structured daemon details are moved to the Toast details line. Host picker/callback exceptions now use the same localized error surface instead of escaping as unhandled rejections. Cancellation and success behavior remain unchanged.
- `HomeView` template creation always uses the existing `hubImport.templateCreateFailed` headline for false results and thrown values. Its existing composer alert has no secondary-detail surface, so technical exceptions are not displayed there.
- `SettingsDialog` localizes the two test-request fallback occurrences with `settings.testRequestFailed` and the model-list fallback with `settings.modelListRequestFailed`. Raw Error messages remain the existing detail following the localized test/model failure prefix; no unrelated result mapping was changed.
- Home and Settings roots inherit `word-break: keep-all`; folder Toast headlines already have that rule from `ce20ee0`. No stylesheet outside the owned paths was edited.
- MCP installation interpolation and Home analytics metadata were left unchanged, as requested. The other Settings info-error finding was not included in this request and remains unchanged.

## Typed copy

| Key | English | Korean |
| --- | --- | --- |
| `hubImport.folderFailed` | Could not import the folder. Check the folder and connection, then try again. | 폴더를 가져오지 못했습니다. 폴더와 연결을 확인한 후 다시 시도하세요. |
| `settings.testRequestFailed` | Test request failed | 테스트 요청에 실패했습니다 |
| `settings.modelListRequestFailed` | Model list request failed | 모델 목록 요청에 실패했습니다 |

`types.ts` was edited before the English and Korean dictionaries. `git status --porcelain` on the locale files was empty before editing them, so no wait for another lane was necessary.

## Regression evidence

Initial red command:

`pnpm --filter @readable-studio/web test tests/components/useOpenFolderImport.test.tsx tests/components/HomeView.import-errors.test.tsx tests/components/SettingsDialog.error-copy.test.tsx --maxWorkers=2`

Parsed red counts: **3 files failed; 8 tests failed, 2 passed; 10 total; 1 unhandled error**. The unhandled error was the host picker exception. The output reproduces raw folder/template headlines and English Settings fallback details. Full output: `red.md`.

Final green command:

`pnpm --filter @readable-studio/web test tests/components/useOpenFolderImport.test.tsx tests/components/HomeView.import-errors.test.tsx tests/components/SettingsDialog.error-copy.test.tsx tests/components/Toast.test.tsx --maxWorkers=2`

Parsed green counts: **4 files passed; 21 tests passed; 0 failed; 0 unhandled errors**. Full output: `green.md`.

Coverage renders the Korean locale through real Home/Settings controls and the real Toast: web Error/non-Error folder failures; returned/thrown host failures with nested daemon details; template Error/non-Error/false outcomes; CLI and API Error/non-Error test failures; automatic model discovery Error/non-Error failures. Assertions compare shipped locale copy, rather than pinning prose. The discovery tests subscribe to the exact mocked provider invocation before mounting and await that signal with a bounded timeout. No sleeps or polling were added.

`pnpm --filter @readable-studio/web typecheck`: **exit 0**, including html-edit dependency typechecks. Full final output: `typecheck.md`. The initial typecheck found three test-fixture/type issues (template updatedAt, CLI mode spelling, and unsupported role-query option); all were corrected before the final run.

Scoped `git diff --check`: **exit 0**. Diagnostics were attempted on every changed source/test file but `typescript-language-server` is not installed; the actual TypeScript checker above is the verification instead. Verification is headless jsdom UI interaction, not a packaged desktop or visual screenshot exercise.

## Assumptions and boundaries

The shared host formatter cannot be changed under the owned-file restriction, so localization belongs at the hook caller and its full output is retained as technical detail. Settings already supplies localized prefixes and interpolated details; only the requested English fallback details were changed. Template errors have no pre-existing details surface, so no new UI was introduced. Unrelated concurrent changes were not staged. No build, bump, push, release, stash, worktree, clean, or path checkout was performed.

The conventional commit SHA and parsed counts are reported in the final handoff. The commit is limited to the nine owned source/test paths and these Markdown evidence files.
