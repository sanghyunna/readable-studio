# Settings update failure localization

## Mechanism and scope

UpdateSection previously threw the daemon apply result's error string and rendered Error.message directly as the alert. UpdateApplyError.error is string, not an apply-failure reason union. The daemon catches arbitrary transport, filesystem, extraction, process, and helper errors and returns their message. Therefore a finite exhaustive apply-code union would be incorrect: the UI now classifies known failures into typed dictionary keys and handles all other strings through a localized generic fallback. Raw text is available only in collapsed technical details, never as the primary message.

Read-only sources: packages/contracts/src/api/update.ts; apps/daemon/src/update-routes.ts; apps/daemon/src/update-apply-routes.ts; apps/daemon/src/update-handoff.ts. Daemon/packaged/contracts were not edited by this lane. The locale files were clean before editing. Keys were added to types.ts before either dictionary.

## Complete daemon reason inventory

- Check contract (also returned by apply's initial check): offline, rate-limited, malformed, timeout, disabled.
- Apply explicit responses: unsupported-layout, update-in-progress, already-current, checksum-mismatch. The latter covers both final digest mismatch and final short-size mismatch in the existing daemon.
- Download non-OK/missing-body: `download failed: HTTP <status>` -> download-failed.
- Download overflow: `download exceeds expected size` -> size-mismatch.
- Extraction's explicit PowerShell exceptions: `Invalid ZIP path`, `ZIP path escaped payload` -> invalid-payload when returned directly; wrapped process-command errors are generic technical details.
- Handoff readiness timeout: `업데이트 준비를 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.` -> helper-not-acknowledged.
- Handoff broker nonzero/null exit: `업데이트 준비 프로세스가 종료되었습니다 (<code>).` -> helper-not-acknowledged.
- Handoff namespace mismatch: `업데이트 시작 환경을 확인하지 못했습니다. 앱을 종료하지 않고 다시 시도해 주세요.` -> helper-environment.
- Arbitrary thrown errors from current-version lookup, fetch/client creation, response-body streaming, mkdir/mkdtemp/write/rename/access, PowerShell execution, process spawn, fs.watch/read, or injected dependencies: generic fallback unless recognized below. This is an open string set, not a finite daemon reason union.
- Recognized transport text (case-insensitive): terminated, ECONNRESET, ETIMEDOUT, aborted, AbortError, TimeoutError, fetch failed -> download-interrupted.
- Forward-compatible aliases supported: size-mismatch, download-failed, helper-not-acknowledged.
- Future check reason strings and all other apply strings -> unknown, with the original string only in collapsed details. Empty apply errors still show the generic message.

## Verification

- Red: `pnpm --filter @readable-studio/web test tests/components/UpdateSection.locale.test.tsx`: 1 file, 34 failed before implementation.
- Green: `pnpm --filter @readable-studio/web test tests/components/UpdateSection.test.tsx tests/components/UpdateSection.locale.test.tsx`: 2 files, 48 passed, 0 failed (35 Korean localized-render cases + 13 existing tests).
- `pnpm --filter @readable-studio/web typecheck`: passed (includes html-edit production/test checking and web tsc -b --noEmit).
- `pnpm guard`: passed; home capability guard 105 controls/105 assertions, Node test suite 54 passed/0 failed/0 skipped.
- Headless UI exercise: tests mount the actual UpdateSection with the actual I18nProvider(initial=ko), click Check, Apply, and confirmation, and assert shipped Korean-copy equality, Korean text, absence of raw text from the primary message, and collapsed raw technical details. Includes daemon `error: terminated`, TypeError: terminated, and rejected-fetch TypeError('terminated'). No fixed sleeps or polling.
- CSS: existing UpdateSection.module.css `.section` has `word-break: keep-all`; alert remains inside that section. CSS required no edits.
- LSP diagnostics unavailable: typescript-language-server is not installed. No dependency changes were made; required TypeScript compiler validation passed instead.
- No packaged rebuild, live packaged-app rerun, version bump, push, or release was performed, as requested. Original packaged screenshots were supplied as symptom evidence, not claimed as post-fix evidence.

## Reason to shipped copy

Every key below is declared in Dict and present in both en and ko. Keys are prefixed with `update.reason.`.

| Reason/key | English | Korean |
| --- | --- | --- |
| offline | Could not connect to the release service. Check your network connection and try again. | 릴리스 서비스에 연결하지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요. |
| rate-limited | GitHub’s request limit has been reached. Try again later. | GitHub 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요. |
| malformed | The release information or checksum is invalid. Try checking again later. Your current version is unchanged. | 릴리스 정보 또는 체크섬이 올바르지 않습니다. 잠시 후 다시 확인해 주세요. 현재 버전은 그대로 유지됩니다. |
| timeout | Checking for updates timed out. Check your network connection and try again. | 업데이트 확인 시간이 초과되었습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요. |
| disabled | Automatic update checks are disabled. Use Check for updates to check manually. | 자동 업데이트 확인이 꺼져 있습니다. 업데이트 확인 버튼으로 직접 확인해 주세요. |
| unsupported-layout | This installation does not support automatic updates, including older flat-extracted folders. Download the latest portable ZIP and extract it into a new folder. Keep your existing folder and data. | 이 설치 폴더는 자동 업데이트를 지원하지 않습니다. 이전 방식으로 파일을 바로 풀어 놓은 폴더도 해당합니다. 최신 포터블 ZIP을 새 폴더에 풀어 주세요. 기존 폴더와 작업 내역은 보관해 주세요. |
| update-in-progress | An update is already in progress. Wait for it to finish before trying again. | 업데이트가 이미 진행 중입니다. 완료될 때까지 기다린 뒤 다시 시도해 주세요. |
| already-current | You already have the latest version. No update is needed. | 이미 최신 버전입니다. 업데이트할 필요가 없습니다. |
| checksum-mismatch | The downloaded file is damaged. Try again. Your current version is unchanged. | 내려받은 파일이 손상되었습니다. 다시 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| size-mismatch | The downloaded file has an unexpected size. Try downloading again. Your current version is unchanged. | 내려받은 파일의 크기가 예상과 다릅니다. 다시 내려받아 주세요. 현재 버전은 그대로 유지됩니다. |
| download-failed | The update file could not be downloaded. Check your network connection and try again. Your current version is unchanged. | 업데이트 파일을 내려받지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| download-interrupted | The update download was interrupted or timed out. Check your network connection and try again. Your current version is unchanged. | 업데이트 파일을 내려받는 중 연결이 끊어졌거나 시간이 초과되었습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| helper-not-acknowledged | The update helper did not confirm it was ready. Keep the app open and try again. Your current version is unchanged. | 업데이트 도우미가 준비되었다는 응답을 받지 못했습니다. 앱을 종료하지 말고 다시 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| helper-environment | The update helper’s launch environment could not be verified. Keep the app open and try again. Your current version is unchanged. | 업데이트 도우미의 실행 환경을 확인하지 못했습니다. 앱을 종료하지 말고 다시 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| invalid-payload | The update archive could not be safely extracted. Download it again and retry. Your current version is unchanged. | 업데이트 압축 파일을 안전하게 풀지 못했습니다. 파일을 다시 내려받아 시도해 주세요. 현재 버전은 그대로 유지됩니다. |
| unknown | The update could not be completed. Try again; if it still fails, check the technical details. Your current version is unchanged. | 업데이트를 완료하지 못했습니다. 다시 시도해 주세요. 계속 실패하면 기술적 세부 정보를 확인해 주세요. 현재 버전은 그대로 유지됩니다. |
