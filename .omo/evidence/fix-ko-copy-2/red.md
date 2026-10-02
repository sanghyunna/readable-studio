
> @readable-studio/web@1.2.1 test D:\readable-studio\apps\web
> vitest run -c vitest.config.ts "tests/components/useOpenFolderImport.test.tsx" "tests/components/HomeView.import-errors.test.tsx" "tests/components/SettingsDialog.error-copy.test.tsx" "--maxWorkers=2"


 RUN  v4.1.6 D:/readable-studio/apps/web

 ❯ tests/components/useOpenFolderImport.test.tsx (4 tests | 4 failed) 156ms
     × web-error keeps technical errors secondary 122ms
     × web-non-error keeps technical errors secondary 8ms
     × host-result keeps technical errors secondary 7ms
     × host-thrown keeps technical errors secondary 18ms
 ❯ tests/components/SettingsDialog.error-copy.test.tsx (3 tests | 3 failed) 684ms
     × cli localizes non-Error test fallback 245ms
     × api localizes non-Error test fallback 100ms
     × localizes a non-Error model request fallback through automatic discovery 338ms
 ❯ tests/components/HomeView.import-errors.test.tsx (3 tests | 1 failed) 288ms
     × localizes a error creation failure 202ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/components/HomeView.import-errors.test.tsx > Home template failure headline > localizes a error creation failure
AssertionError: expected 'Failed to create project from template' to contain '이 템플릿으로 프로젝트를 만들지 못했어요. 다시 시도해 주세요.'

Expected: "이 템플릿으로 프로젝트를 만들지 못했어요. 다시 시도해 주세요."
Received: "Failed to create project from template"

 ❯ tests/components/HomeView.import-errors.test.tsx:22:31
     20|     await act(async () => { fireEvent.click(screen.getByTestId('compos…
     21|     const alert = screen.getByRole('alert');
     22|     expect(alert.textContent).toContain(getKo()['hubImport.templateCre…
       |                               ^
     23|     expect(alert.textContent).not.toContain(getEn()['hubImport.templat…
     24|     expect(alert.textContent).not.toContain(raw);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/8]⎯

 FAIL  tests/components/SettingsDialog.error-copy.test.tsx > Settings Korean request failure copy > cli localizes non-Error test fallback
 FAIL  tests/components/SettingsDialog.error-copy.test.tsx > Settings Korean request failure copy > api localizes non-Error test fallback
AssertionError: expected '테스트 실패: Test request failed' to contain '테스트 실패: undefined'

Expected: "테스트 실패: undefined"
Received: "테스트 실패: Test request failed"

 ❯ tests/components/SettingsDialog.error-copy.test.tsx:26:31
     24|     await act(async () => { fireEvent.click(screen.getByRole('button',…
     25|     const alert = screen.getByRole('alert');
     26|     expect(alert.textContent).toContain(getKo()['settings.testUnknown'…
       |                               ^
     27|     expect(alert.textContent).not.toContain(getEn()['settings.testRequ…
     28|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/8]⎯

 FAIL  tests/components/SettingsDialog.error-copy.test.tsx > Settings Korean request failure copy > localizes a non-Error model request fallback through automatic discovery
AssertionError: expected '모델을 가져올 수 없습니다: Model list request fa…' to contain '모델을 가져올 수 없습니다: undefined'

Expected: "모델을 가져올 수 없습니다: undefined"
Received: "모델을 가져올 수 없습니다: Model list request failed"

 ❯ tests/components/SettingsDialog.error-copy.test.tsx:43:31
     41|     } finally { clearTimeout(timeout); }
     42|     const alert = screen.getByRole('alert');
     43|     expect(alert.textContent).toContain(getKo()['settings.fetchModelsF…
       |                               ^
     44|     expect(alert.textContent).not.toContain(getEn()['settings.modelLis…
     45|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/8]⎯

 FAIL  tests/components/useOpenFolderImport.test.tsx > folder import Korean errors > web-error keeps technical errors secondary
 FAIL  tests/components/useOpenFolderImport.test.tsx > folder import Korean errors > web-non-error keeps technical errors secondary
AssertionError: expected 'Failed to import folder' to be undefined // Object.is equality

- Expected:
undefined

+ Received:
"Failed to import folder"

 ❯ tests/components/useOpenFolderImport.test.tsx:27:73
     25|     await act(async () => { fireEvent.click(screen.getByText('Import')…
     26|     const alert = screen.getByRole('alert');
     27|     expect(alert.querySelector('.readable-toast-message')?.textContent…
       |                                                                         ^
     28|     expect(alert.querySelector('.readable-toast-message')?.textContent…
     29|     expect(alert.querySelector('.readable-toast-message')?.textContent…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/8]⎯

 FAIL  tests/components/useOpenFolderImport.test.tsx > folder import Korean errors > host-result keeps technical errors secondary
AssertionError: expected 'Open folder failed: Failed to import …' to be undefined // Object.is equality

- Expected:
undefined

+ Received:
"Open folder failed: Failed to import folder"

 ❯ tests/components/useOpenFolderImport.test.tsx:27:73
     25|     await act(async () => { fireEvent.click(screen.getByText('Import')…
     26|     const alert = screen.getByRole('alert');
     27|     expect(alert.querySelector('.readable-toast-message')?.textContent…
       |                                                                         ^
     28|     expect(alert.querySelector('.readable-toast-message')?.textContent…
     29|     expect(alert.querySelector('.readable-toast-message')?.textContent…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/8]⎯

 FAIL  tests/components/useOpenFolderImport.test.tsx > folder import Korean errors > host-thrown keeps technical errors secondary
TestingLibraryElementError: Unable to find an accessible element with the role "alert"

Here are the accessible roles:

  button:

  Name "Import":
  [36m<button />[39m

  --------------------------------------------------

Ignored nodes: comments, script, style
[36m<body>[39m
  [36m<div>[39m
    [36m<button>[39m
      [0mImport[0m
    [36m</button>[39m
  [36m</div>[39m
[36m</body>[39m
 ❯ Object.getElementError ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/config.js:37:19
 ❯ ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/query-helpers.js:76:38
 ❯ ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/query-helpers.js:52:17
 ❯ ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/query-helpers.js:95:19
 ❯ tests/components/useOpenFolderImport.test.tsx:26:26
     24|     render(<I18nProvider initial="ko"><Harness failure={mode === 'web-…
     25|     await act(async () => { fireEvent.click(screen.getByText('Import')…
     26|     const alert = screen.getByRole('alert');
       |                          ^
     27|     expect(alert.querySelector('.readable-toast-message')?.textContent…
     28|     expect(alert.querySelector('.readable-toast-message')?.textContent…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/8]⎯

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: Failed to import folder
 ❯ tests/components/useOpenFolderImport.test.tsx:22:60
     20|     hostAvailable.mockReturnValue(mode.startsWith('host'));
     21|     localPick.mockResolvedValue('/project');
     22|     if (mode === 'host-thrown') hostPick.mockRejectedValue(new Error(r…
       |                                                            ^
     23|     else hostPick.mockResolvedValue({ ok: false, reason: raw, details:…
     24|     render(<I18nProvider initial="ko"><Harness failure={mode === 'web-…
 ❯ ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:2027:60
 ❯ ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11
 ❯ ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:26
 ❯ ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:2326:20
 ❯ runWithCancel ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10
 ❯ ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:2305:20
 ❯ runWithTimeout ../../node_modules/.pnpm/@vitest+runner@4.1.6/node_modules/@vitest/runner/dist/chunk-artifact.js:2272:10

This error originated in "tests/components/useOpenFolderImport.test.tsx" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
The latest test that might've caused the error is "host-thrown keeps technical errors secondary". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  3 failed (3)
      Tests  8 failed | 2 passed (10)
     Errors  1 error
   Start at  10:38:08
   Duration  7.30s (transform 2.44s, setup 75ms, import 4.50s, tests 1.13s, environment 5.87s)

D:\readable-studio\apps\web:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @readable-studio/web@1.2.1 test: `vitest run -c vitest.config.ts "tests/components/useOpenFolderImport.test.tsx" "tests/components/HomeView.import-errors.test.tsx" "tests/components/SettingsDialog.error-copy.test.tsx" "--maxWorkers=2"`
Exit status 1
