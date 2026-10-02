# No implicit design-system selection

## Mechanism and full fallback audit
- `apps/web/src/App.tsx`: startup effect waited for daemon config and the registry, then treated null as empty, chose `default` or the first registry item, and wrote it to browser storage and daemon config. Removed this effect. Runtime red reproduced missing and null -> `default`.
- `apps/daemon/src/cli.ts`: `run redesign` used `flags['design-system'] ?? 'default'`, forwarding the invented choice to folder import and run creation. Changed to null. Actual CLI subprocess red captured `default` in POST /api/runs; green captures null. Explicit `--design-system default` still captures default.
- Picker `DesignSystemPicker.tsx`: selected lookup returns null; none row is selected for null; trigger uses existing typed en/ko `designSystemPicker.noneTitle` (No design system / 디자인 시스템 없음). No default substitution. DesignSystemsTab uses exact ID equality, not first-item selection.
- EntryShell passes config ID unchanged. Hub HomeView starts with that ID and submits it unchanged. project-create template helper forwards it unchanged.
- Web config default is null and daemon merge preserves supplied choices. Daemon app-config normalization accepts string/null without converting them.
- HTTP validation in server.ts maps missing/null/empty to null; project-routes uses the validated ID; db.ts persists null. Route tests now read back missing, null, and explicit default.
- System prompt loads design assets only for a truthy effective ID; no default substitution. Added explicit `Active design system: none` guidance when no design body is active. Finalization already uses a `none` header.
- History: `git log -S 'Auto-pick the default design system'` points to initial release `8a15f1e`. Old saved `default` can therefore have been written automatically OR chosen explicitly; provenance is unavailable. Preserve all saved choices rather than destructively guessing.
- Design-system catalogue unchanged.

## Red -> green
- Web bootstrap red: expected `none`, received `default` for both missing and null. Explicit default/custom cases passed. One existing broad query was narrowed after adding the new rendered probe.
- CLI red: expected null, received `default`; explicit default passed.
- Final web focused run: 4 files, 77 tests passed (App bootstrap, picker, HomeView prefill, config).
- Daemon focused run: 4 files, 119 tests passed (CLI redesign, design-system routes, prompt composer, app-config).
- After correcting test-only type annotations, final rerun of changed daemon tests: 2 files, 13 tests passed.
- Web typecheck passed. Daemon typecheck passed after correcting the new test types.
- `pnpm guard`: passed; 105 capability assertions; chained tests 54 passed, 0 failed.
- LSP unavailable (`typescript-language-server` not installed); package typechecks used instead.

## Headless QA and limitations
- Used staged omowright with installed Chrome, headless, task-owned profiles (removed in finally).
- Real source web/daemon launched through tools-dev in namespace fix-ds-default.
- First snapshot observed `Loading Readable Studio…`. Second attempt could not observe the composer design-system control within 20 seconds. Browser flow is NOT fully verified; component/route/CLI runtime tests provide the passing behavioral evidence.
- An initial pnpm test invocation with `--` accidentally started the full web suite and timed out before production edits. It exposed unrelated FileViewer failures and `log.scrollTo is not a function` in queued-question tests. These were not modified or suppressed. Focused commands use `pnpm --filter ... exec vitest run`.
- Required daemon typecheck internally executes contracts/registry-protocol build scripts; no application build, version bump, or push was run.
- Pre-existing `apps/web/next-env.d.ts` edit preserved and excluded from commit.
