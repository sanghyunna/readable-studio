# Readable Studio — engineering handoff

Read this first, then `AGENTS.md` for the binding rules and `CONTEXT.md` for product
language. This document explains **what the repository is and how it actually works**,
with real file paths and identifiers so you can navigate without archaeology.

---

## 1. What this product is

Readable Studio turns **source text into a polished, self-contained HTML document**, and
then lets the user edit that document directly — click an element, change its text,
colour, size or position — the way they would in PowerPoint.

```
Source Text  ->  AI Generation  ->  Direct Editing  ->  Standalone HTML
```

The reason the product exists is the last two steps. Tools that only generate force the
user back into a prompt-and-wait loop for every trivial revision ("make that heading
smaller", "move the card left"). Here those take seconds and no model call. The intended
user is an office worker producing AI-readable company documents: DOCX/PPTX aren't
machine-readable enough, Markdown isn't presentable enough, HTML is both — provided
someone makes it editable. That is this repository's job.

**Shipping shape:** a Windows 10/11 x64 **portable ZIP**, downloaded manually from GitHub
Releases, extracted, and run as `Readable Studio.exe`. There is deliberately **no
installer, no updater, no website, and no macOS/Linux/Nix packaging**. This is enforced
by `pnpm guard`, not just documented — don't add claims about them to copy or docs.

---

## 2. The four processes

| App | Role |
|---|---|
| `apps/daemon` | Local Express + SQLite API, agent spawner, and the `readable` CLI. The single source of truth for all behavior. |
| `apps/web` | Next.js App Router UI. Talks to the daemon over HTTP only. |
| `apps/desktop` | Electron shell. Discovers the web URL via **sidecar IPC** — it never guesses ports. |
| `apps/packaged` | Thin packaged Electron entry. Starts the daemon and web sidecars, waits for status, registers `readable-studio://`, hands off to desktop. |

The daemon binds `127.0.0.1:7456` by default (`--port/-p` > sidecar `DAEMON_PORT` env >
`7456`; host via `--host` > `READABLE_BIND_HOST` > `127.0.0.1`). Port `0` is supported and
the resolved URL is returned. In dev, `apps/web/next.config.ts` proxies `/api/*`,
`/artifacts/*` and `/frames/*` to that daemon, so the browser calls relative URLs.

### Sidecars, stamps and namespaces

Three packages, deliberately layered — keep the boundary:

- `packages/sidecar-proto` — the **product** protocol: app/mode/source constants, IPC
  message and status schemas, namespace validation, stamp semantics, errors.
- `packages/sidecar` — **generic** runtime: bootstrap, IPC transport, path resolution,
  launch env, JSON runtime files.
- `packages/platform` — **generic** OS primitives: process stamp serialization, command
  parsing, process matching and stopping.

A `SidecarStamp` has **exactly five fields**: `app`, `mode`, `namespace`, `ipc`, `source`.
A **namespace** is a validated isolated runtime identity (no path separators, ≤128 chars)
so two instances — say a dev run and a portable run — never collide in IPC, logs, state or
process scans. Orchestration layers must call these primitives; never hand-build
`--readable-studio-stamp-*` args or process-scan regexes.

`packages/product-identity` centralises identity so it cannot drift: `PRODUCT_NAME`,
`PRODUCT_ID`, `DESKTOP_APP_ID`, `CLI_NAME`, `URL_SCHEME` (`readable-studio://`),
`PROJECT_DATA_DIR_NAME` (`.readable-studio`), `USER_DATA_DIR_NAME`, env prefix, package
scope. Windows pipe names are derived from `productId` by the sidecar contract.

### Native helper

`packages/platform/native/win32/agent-isolator.cpp` provides Windows AppContainer
isolation: ACLs, broker named pipes, loopback denial, kill-on-job-close. Built by
`build.ps1` with MSVC C++20 x64 against `advapi32`, `bcrypt`, `userenv`, `ws2_32`.
Without it, isolated-agent support reports unavailable — ordinary sidecar startup is
unaffected. Note: spawning a contained child requires privileges a normal non-elevated
session may not have; a failure there is usually an OS permission limitation, not a bug.

---

## 3. The daemon — where behavior lives

Entry: `apps/daemon/src/cli.ts` → `daemon-startup.ts` (`runDaemonCliStartup()`) →
`server.ts` (`startServer()`). Routes register in `server.ts`; capability families live in
`*-routes.ts`:

| Module | Owns |
|---|---|
| `project-routes.ts` | Projects, conversations, messages, checkpoints/rollback, tabs, templates, files, folders, uploads, artifact save/lint |
| `chat-routes.ts` | Runs, event streams, cancel, feedback, provider models, connection tests, BYOK streaming proxies |
| `import-export-routes.ts` | Working directories, folder import, archives, export manifests, PDF, finalize |
| `mcp-routes.ts` | MCP install-info, Codex install, external MCP server config, OAuth |
| `media-routes.ts` | App config, folder dialog, research search |
| `terminal-routes.ts` | Project terminals, streams, stdin, resize, kill |
| `social-share-routes.ts`, `design-system-tool.ts`, `deploy.ts`, `handoff.ts`, `active-context.ts`, `routine.ts` | Sharing, design systems, deployment, handoff, active context, automations |

`POST /api/runs` and `POST /api/chat` live directly in `server.ts`.

### How an agent run executes

`RuntimeAgentDef` (`apps/daemon/src/runtimes/types.ts`) declares a coding-agent CLI:
binary, argument builder, stream format and parser, stdin/file prompt behavior, models,
capabilities, MCP injection. Definitions live in `runtimes/defs/` (Claude, Codex, Gemini,
Copilot, Cursor, OpenCode, Qoder, Pi, Kimi, Kiro, Hermes, Vibe, AMR, …).

The daemon spawns the child via `spawnIsolatedAgent()` or plain `spawn(..., {shell:false})`
and feeds it the composed prompt. `promptInputFormat` decides stdin behavior:

- `'text'` (everything except Claude) — write the prompt, close stdin immediately.
- `'stream-json'` (Claude) — write one JSONL user message and **keep stdin open** so
  further user messages can be streamed mid-turn. `applyClaudeStreamJsonRunBookkeeping`
  closes stdin on a `turn_end`/`usage` event whose `stop_reason` is not `tool_use`;
  `tool_use` means the model paused inside a tool, and closing there would truncate the
  reply. `claude-stream.ts` emits `turn_end` **after** iterating content blocks so the
  final `stop_reason` is visible before that decision.

Stream adapters — `claude-stream.ts`, `copilot-stream.ts`, `qoder-stream.ts`,
`json-event-stream.ts` — normalise frames into status / text / thinking / tool-use /
tool-result / usage / error events.

### Persistence

`db.ts` opens `<dataRoot>/app.sqlite` via `better-sqlite3`. Default data root is
`<projectRoot>/.readable-studio`; `READABLE_DATA_DIR` overrides it (with `~` expansion and
project-relative resolution), and `READABLE_MEDIA_CONFIG_DIR` narrowly relocates only the
media credentials file. Main tables: `projects`, `templates`, `conversations`,
`agent_sessions`, `messages`, `preview_comments`, `tabs`, `tabs_state`, `deployments`,
`routines`, `routine_runs`, plus checkpoint, critique and plugin tables. Project working
directories are `<dataRoot>/projects/<project-id>/`; artifacts in `<dataRoot>/artifacts/`
and `critique-artifacts/`.

### CLI and MCP

Bin: `"readable": "./apps/daemon/bin/readable.mjs"`. `SUBCOMMAND_MAP` in `cli.ts` groups:
`export`, `artifacts`, `mcp`, `research`, `plugin`, `ui`, `marketplace`, `share`,
`project`, `automation(s)`, `memory`, `run`, `files`, `templates`, `conversation`, `chat`,
`daemon`, `atoms`, `skills`, `design-systems`, `craft`, `fonts`, `diagnostics`, `status`,
`version`, `doctor`, `config`, `system-prompts`, `agent`, `provider`. `--json` gives machine-readable output;
prompt-bearing commands accept `--prompt-file <path|->`.

`mcp.ts` exposes: `list_projects`, `get_active_context`, `get_artifact`, `get_project`,
`get_file`, `search_files`, `list_files`, `create_artifact`, `write_file`, `delete_file`,
`delete_project`, `create_project`, `list_skills`, `list_plugins`, `start_run`, `get_run`,
`cancel_run`, `list_agents`.

> **Dual-track rule.** Every user-facing capability needs **both** a web UI surface and a
> `readable <capability>` subcommand, hitting the same `/api/*` endpoint with a DTO in
> `packages/contracts`. Land all three in one change. The CLI is the embeddability
> contract for external agents that never render the UI.

---

## 4. The web UI — preview, editing, export

One optional catch-all route, `apps/web/app/[[...slug]]/page.tsx`, emits a single SPA
shell; `src/router.ts` does runtime routing and `client-app.tsx` disables SSR for the
product tree. `FileWorkspace.tsx` is the workspace (file tabs, Design Files, Design
System, Questions, browser, terminal); `FileViewer.tsx` renders the active file.

### URL-load vs srcDoc — the decision that governs every preview feature

`src/components/file-viewer-render-mode.ts` chooses how the preview iframe loads:

- **URL load** (default): `iframe src=/api/projects/:id/raw/:file`. Real asset requests,
  source maps, DevTools names, HTTP caching.
- **srcDoc** (`runtime/srcdoc.ts` / `buildSrcdoc`): required whenever the host must
  **inject a bridge** — decks, inspect, active palette/draw/tweaks, comments without an
  artifact bridge, direct edit without `readable-direct-edit.js`, focus-guard, sandbox
  shim, `forceInline=1`.

Bridges cannot be injected into a raw URL iframe. **If you add a feature needing a bridge,
add a disqualifier to `UrlLoadDecision`** — otherwise it silently won't work in URL mode.
Both iframes stay mounted and are swapped by CSS visibility to avoid reload flash, so
`iframeRef.current` must stay aligned with the active iframe; receive filters use
`isOurIframe(ev.source)`, and signals that may only come from the active iframe re-check
`ev.source === iframeRef.current?.contentWindow`.

Host↔iframe messaging is `window.postMessage` with `readable-studio:*` and
`readable-edit-*` events (`readable-studio:comment-targets`,
`readable-studio:inspect-overrides`, `readable-studio:tweaks-available`,
`readable-edit-targets`, `readable-edit-select`, `readable-edit-preview-style-applied`, …).

### Direct editing (`src/edit-mode/`)

This is the product's differentiator. `bridge.ts` runs inside the iframe, discovers
source-mappable DOM targets via stable `data-readable-id` identities, and reports
`ManualEditTarget` objects: kind (`text`, `link`, `image`, `container`, `token`),
hierarchy, geometry, attributes, computed vs authored sizing, fields, style snapshot.

Patches supported: text, link, image, inline styles, attributes, inner/outer HTML, CSS
tokens, remove, undo/redo, duplicate-and-move, full-source replacement. Styles cover
typography, colour, size, alignment, spacing, borders, opacity, flex layout and
`translate` placement. Rich text uses contenteditable + selection state.

Crucially, `source-patches.ts` applies the patch to the **canonical HTML source** — parse,
locate by ID, apply and sanitize, serialize, return new source — with before/after
snapshots for history. Edits persist into the document, not just the iframe's pixels.

### Export

`runtime/exports.ts` posts to `/api/exports/standalone-html`; the daemon returns one HTML
blob plus headers reporting external references, missing local references and skipped
system fonts. Statically discoverable local dependencies are inlined; unresolved ones are
reported rather than silently dropped. Browser-side: PDF via print, ZIP via `buildZip`,
Markdown as verbatim source, image snapshot, JSX/React. PPTX is server/agent conversion
(`ProjectView.tsx`).

### Chat conventions

- **Clarifying questions** use exactly one mechanism: the `<question-form>` markdown
  artifact the model emits inline. `AssistantMessage.tsx` shows a `QuestionsBanner`; the
  form renders in the Questions tab (`QuestionsPanel` + `QuestionFormView`); answers come
  back as the next user message via `formatFormAnswers` → `POST /api/chat`. There is **no**
  `AskUserQuestion` tool, no tool-result return path, and no inline interactive card.
  Valid on any turn, not just discovery.
- **TodoWrite** renders as one pinned card above the composer (`PinnedTodoSlot` in
  `ChatPane.tsx`, state from `runtime/todos.ts`); `stripTodoToolGroups` removes per-message
  duplicates. The slot lives outside `.chat-log`, so auto-scroll needs the `ResizeObserver`
  + pane-level `MutationObserver` wiring already there — don't break it.
- `dedupeSnapshotToolRetries` collapses snapshot-style tools (`SNAPSHOT_TOOL_NAMES`).

### i18n and CSS

`src/i18n/types.ts` defines `Locale`, `LOCALES` and the flat typed `Dict`. **Maintained
locales are exactly two: `en` and `ko`.** Every `Dict` key must exist in both — add it to
`types.ts` first; a missing translation is a typecheck error. (`AGENTS.md` still mentions
an 18-locale list; the code is authoritative — verify before trusting either.)

`src/index.css` is **import-only** — no selectors there. Global styles live in
`src/styles/**`; new component styling should be CSS Modules next to the component. Shared
primitives belong in `packages/components` (`@readable-studio/components`) — use `Button`,
`VisuallyHidden` etc. rather than raw `primary`/`ghost`/`sr-only` classes, which are legacy
compatibility surface.

**Animation defaults:** ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; enter ~200ms, exit
~140ms; accordions use `grid-template-rows: 0fr -> 1fr` via `.accordion-collapsible`; never
animate from `scale(0)`; keep conditional elements mounted and toggle a class so exits
actually play.

---

## 5. The content ecosystem — what the product can produce

These four directories decide output quality far more than app code does. Counts measured
in this checkout:

| Directory | Count | What it is |
|---|---|---|
| `plugins/_official/**` | **315** sidecar manifests | Bundled first-party workflows, scanned at daemon startup as `source_kind='bundled'` |
| `skills/` | **154** | Functional capabilities invoked mid-task (utilities, briefs, packagers) |
| `design-templates/` | **99** `SKILL.md` | Rendering catalogue; modes are exactly `prototype`, `deck`, `template`, `image`, `video`, `audio` |
| `design-systems/` | **150** `DESIGN.md` | Brand systems (prose + token files) |
| `craft/` | **12** | Brand-agnostic craft rulebooks, opt-in via `readable.craft.requires` |

A **plugin** is a portable folder: `SKILL.md` carries agent-facing frontmatter and body
(`name`, `description`, `triggers`, mode/platform/scenario, inputs, outputs, workflow);
optional `readable-studio.json` carries product metadata (localized titles, version,
license, author, tags, `compat.agentSkills`, `readable.kind`, `taskKind`, preview,
example outputs, inputs, references, stages, `capabilities`).
`plugins/registry/official/readable-studio-marketplace.json` is **generated** —
`scripts/readable-plugin-catalog.ts` has `check` / `generate` / `audit`, and `check`
compares bytes. If it reports *stale*, run `generate` and commit; don't hand-edit.

**Design systems** carry `DESIGN.md` prose plus, for rich systems, `tokens.css`,
`design-tokens.json`, `manifest.json`, `components.html`, previews and source evidence.
The shared schema is `packages/contracts/src/design-systems/token-schema.ts` (re-exported
by `design-systems/_schema/tokens.schema.ts`). Guard enforces A1 identity/structure, all
A2 tokens (fallbacks mirroring `_schema/defaults.css`), and all B-slot tokens (may alias
with `var(...)`).

**How it composes into a run:** `composeSystemPrompt()` in `apps/daemon/src/prompts/system.ts`
stacks injection resistance → official prompt → discovery → memory → `DESIGN.md` → usage /
tokens / component fixtures or manifest → craft → active skill, with the deck framework
appended last when applicable. Design systems resolve through `designSystemId` in
`design-systems.ts`; craft slugs resolve in `craft.ts` (unknown slugs are ignored silently).

**Mocks.** `mocks/` replays recorded agent sessions through native stdout, JSON-RPC ACP or
AMR protocols — no tokens burned. `mocks/bin` holds **18** PATH-overlay wrappers. Activate
with `PATH="$PWD/mocks/bin:$PATH"` plus `READABLE_MOCKS_TRACE`,
`READABLE_MOCKS_NO_DELAY`, and optionally `READABLE_MOCKS_BY_PROMPT_HASH`,
`READABLE_MOCKS_POOL`, `READABLE_MOCKS_SEED`. **Use this for any stream/parser change** —
it is the cheap, deterministic way to verify event shapes round-trip.

---

## 6. Working in this repo

### Setup

Node `~24` and `pnpm@10.33.2` (`mise.toml` pins both). On Windows `corepack enable` fails
with EPERM — use `npm install -g pnpm@10.33.2`. `better-sqlite3` has no win32/Node 24
prebuild and compiles from source (~2 min), so Visual Studio Build Tools 2022+ and Python 3
are required. That compile is expected, not a version mismatch. **Node 22 is not supported.**

```powershell
pnpm install
pnpm typecheck
pnpm guard
pnpm tools-dev
```

### Command surface

Root scripts are intentionally minimal: `guard`, `typecheck`, `tools-dev`, `tools-pack`,
`i18n:check`, `i18n:coverage`, plus seed/backfill utilities and `postinstall`. There is
**no root `pnpm dev`, `pnpm build` or `pnpm test`** — that is a deliberate boundary, not an
omission. Use package scope instead:

```powershell
pnpm --filter @readable-studio/web test
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/web typecheck
```

Lifecycle is only ever `pnpm tools-dev` (`start`, `run`, `restart`, `status`, `logs`,
`stop`, `inspect`, `check`; `--daemon-port` / `--web-port`; exports `READABLE_PORT` and
`READABLE_WEB_PORT`; state and logs under `.tmp/tools-dev/<namespace>/`). Typical loop:

```powershell
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
pnpm tools-dev status --json
pnpm tools-dev logs --namespace <name> --json
pnpm tools-dev inspect desktop status --json
pnpm tools-dev stop
```

Packaging is `pnpm tools-pack win <build|start|inspect|logs|stop|cleanup>`; the root
`build-portable.ps1` wraps `tools-pack win build` and produces
`Readable Studio-<namespace>-portable.zip`. Artifacts land under
`.tmp/tools-pack/out/win/namespaces/<namespace>/`; after extraction, user data, logs, cache
and Chromium data live beside the exe under
`<exeDir>\ReadableStudioData\namespaces\<namespace>\`.

### `pnpm guard` — the safety net

Run it before calling anything done. It enforces, by name: readable workspace identity;
residual JavaScript; bundled copy language; package dependency specs; product neutrality;
daemon Windows footguns; cross-app imports; test layout; e2e layout; web test layout;
tools layout; web theme token parity; style policy; and a family of design-system checks
(manifests, package quality, component fixture report, token-fixture sync, A1/A2/B-slot
required tokens, unknown-token allowlist, A2 defaults parity, flag parity, component
manifest extraction). It then chains `scripts/style-policy.test.ts`,
`product-neutrality.test.ts`, `check-cross-app-imports.test.ts`, `postinstall.test.ts`,
`bundled-copy-language.test.ts`, `json-resources.test.ts`.

Note `json-resources.test.ts` pins an exact shipped-JSON count — if you add or remove a
JSON resource it will fail, and updating that pin to the newly measured value is the
correct fix.

### Tests

Tests live in a package-level `tests/` directory **sibling to `src/`** — never under
`src/`. Most packages use Vitest; `@readable-studio/tools-dev` uses `node:test`.
`e2e/tests/` and `e2e/specs/` are Vitest at the daemon HTTP boundary for cross-app
behavior; `e2e/ui/` is flat Playwright UI automation (`pnpm test:ui`, `pnpm test:ui:p0`
from `e2e/`).

Prefer the cheapest layer that can still see the symptom: e2e Vitest at the HTTP boundary →
app-local Vitest → Playwright → platform-native harness. For a bug fix, lead with a red
spec that fails before the change.

### Rules you will trip over

1. **`fd` only** for filename/path discovery. `find`, recursive `Get-ChildItem`, `dir /s`
   and custom walkers are forbidden — bound queries with roots, extensions and globs.
2. `apps/web/**` must never import `apps/daemon/src/**`. Integration goes through HTTP,
   `packages/contracts`, and app-local providers.
3. `packages/contracts` stays **pure TypeScript** — no Next.js, Express, Node fs/process,
   browser APIs, SQLite, daemon internals or sidecar protocol.
4. New capability = HTTP endpoint + contract type + web UI + `readable` subcommand, in one
   change.
5. TypeScript-first. New `.js`/`.mjs`/`.cjs` needs a documented generated/vendor/compat
   reason and must pass guard.
6. App business logic must not know about sidecars; keep that in `apps/<app>/sidecar`.
7. Commits must not carry `Co-authored-by` or other co-author trailers.
8. `.readable-studio/`, `.tmp/`, `ReadableStudioData/` and Playwright reports are local
   runtime data — keep them out of git.

### Where to look first

| Task | Start here |
|---|---|
| API behavior | `apps/daemon/src/server.ts` + the matching `*-routes.ts` |
| Add a CLI command | `apps/daemon/src/cli.ts` (`SUBCOMMAND_MAP`) |
| Agent/model support | `apps/daemon/src/runtimes/defs/`, `runtimes/types.ts` |
| Stream parsing bug | `claude-stream.ts` / `json-event-stream.ts` + `mocks/` replay |
| Preview won't show a feature | `file-viewer-render-mode.ts` (add a disqualifier), `runtime/srcdoc.ts` |
| Editing behavior | `apps/web/src/edit-mode/` (`bridge.ts`, `source-patches.ts`, `types.ts`) |
| Export | `apps/web/src/runtime/exports.ts` + daemon `/api/exports/standalone-html` |
| Prompt composition | `apps/daemon/src/prompts/system.ts` |
| Output quality | `design-systems/`, `design-templates/`, `craft/`, `plugins/_official/` |
| Process/lifecycle | `tools/dev/src/`, `packages/sidecar*`, `packages/platform` |

---

## 7. Notes and known rough edges

- `AGENTS.md` lists 18 i18n locales; the code ships **2** (`en`, `ko`). Trust the code and
  fix the doc when you touch it.
- Some daemon tests fail on a normal non-elevated Windows session because they spawn a
  contained AppContainer child (`ERROR_ACCESS_DENIED`). That is a host privilege
  limitation. Confirm against a clean baseline before treating such a failure as yours.
- `docs/` holds the deeper references: `spec.md`, `architecture.md`, `skills-protocol.md`,
  `agent-adapters.md`, `modes.md`, `code-review-guidelines.md`. Directory-level `AGENTS.md`
  files under `apps/`, `packages/`, `tools/`, `e2e/`, `plugins/`, `skills/`,
  `design-templates/` carry the local rules — read the one for the directory you're editing.
