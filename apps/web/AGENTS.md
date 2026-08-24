# apps/web

Parent: `apps/AGENTS.md`. This app owns the UI conventions below; the root file does not
repeat them.

## Commands

```bash
pnpm --filter @readable-studio/web test
pnpm --filter @readable-studio/web typecheck
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

## The preview render-mode trap

`src/components/file-viewer-render-mode.ts` decides URL-load vs srcDoc.
**Host-injected bridges only exist on the srcDoc path.** If your feature needs one, add a
field to `UrlLoadDecision` and a disqualifier in `shouldUrlLoadHtmlPreview`, then pass it
from `FileViewer.tsx` (source-content heuristics like `hasTweaksTemplate` belong there).
Skip this and the feature works by luck in dev and silently no-ops on multi-file
artifacts.

Existing disqualifiers: deck, comment (without a URL bridge), inspect, edit (without
`urlModeBridge`), palette, draw, tweaks, `forceInline`, focus-guard, sandbox-shim.

Both iframes stay mounted and swap by CSS visibility to avoid a reload flash, so
`iframeRef.current` must stay aligned with the active iframe. Receive filters use
`isOurIframe(ev.source)`; signals that may only come from the active iframe (e.g.
`readable:tweaks-available`) re-check `ev.source === iframeRef.current?.contentWindow`.

## Chat conventions

- **Clarifying questions** use exactly one mechanism: the `<question-form>` markdown
  artifact the model emits inline. `AssistantMessage.tsx` renders a `QuestionsBanner`;
  the form itself renders in the Questions tab (`QuestionsPanel` + `QuestionFormView`);
  answers return as the next user message via `formatFormAnswers`
  (`src/artifacts/question-form.ts`) → `POST /api/chat`. Valid on any turn, not just
  discovery. There is no inline interactive tool card — do not build one.
- **TodoWrite** renders as one pinned card above the composer (`PinnedTodoSlot` in
  `ChatPane.tsx`, snapshot from `src/runtime/todos.ts`);
  `AssistantMessage.stripTodoToolGroups` removes per-message duplicates. Progress counts
  `completed` + `in_progress`. Dismissal is keyed on the snapshot JSON, so a fresh
  TodoWrite re-shows the card. The slot sits **outside** `.chat-log`, so auto-scroll
  depends on `ChatPane`'s `ResizeObserver` accepting the slot's `containerRef` plus a
  pane-level `MutationObserver` re-syncing on mount/unmount. Don't break that pair.
- `dedupeSnapshotToolRetries` collapses snapshot-style tools listed in
  `SNAPSHOT_TOOL_NAMES` (each call is a state replace); other tools pass through.

## Two locale sets

- `src/i18n/locales/` — product UI, exactly `en` + `ko`. Every key in the typed `Dict`
  must exist in both; add it to `src/i18n/types.ts` first or typecheck fails.
- `src/i18n/hosted-locales/` — 18 locales for the hosted surface, consumed by
  `src/i18n/hosted.tsx`. A different axis. Do not "fix" the mismatch by adding 16
  product locales.

## CSS ownership

- `src/index.css` is import-only. No selectors, no declarations — add an import only for
  a genuinely global stylesheet, and keep import order intentional.
- Global styles live in `src/styles/**`, grouped by owner (`styles/viewer/`,
  `styles/workspace/`). New component styling defaults to a CSS Module beside the
  component. Global class names are for deliberate shared contracts only.
- Refactors must preserve cascade semantics: for mechanical splits verify expanded
  import content and order; for Module migrations run the web typecheck plus a focused
  visual check. Don't mix a mechanical move with a styling change in one patch.

## Component reuse

Reuse `@readable-studio/components` primitives (`Button`, `VisuallyHidden`, …) instead of
styling raw elements. `primary`, `primary-ghost`, `ghost`, `subtle`, `icon-btn` and
`sr-only` are legacy compatibility surface — do not add new markup that uses them. A
missing primitive belongs in `packages/components` with colocated CSS Modules; product
layout and workflow styling stay here. `apps/web` transpiles that package from source,
so edits work through the normal dev loop.

## Animation

Ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; enter ~200ms, exit ~140ms. `ease-in` is
forbidden for UI. Accordions use `grid-template-rows: 0fr -> 1fr` via the shared
`.accordion-collapsible` + `.accordion-collapsible-inner` pair. Never animate from
`scale(0)` — start at `scale(0.9)` with `opacity: 0`. Keep conditional elements mounted
and toggle a class (e.g. `.chat-jump-btn-active`); React unmounts skip the exit
transition.
