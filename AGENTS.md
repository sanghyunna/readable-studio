# Directory guide

Repository-wide rules and routing. Read this first, then the `AGENTS.md` for the
directory you are editing — the nearest file wins on conflict, and explicit user
instructions override both. Product language lives in `CONTEXT.md`; a narrative tour of
the codebase lives in `HANDOFF.md`.

## Routing

| Working on | Read first |
|---|---|
| Daemon API, CLI, agents, prompts | `apps/AGENTS.md`, `apps/daemon/AGENTS.md` |
| Adding/altering an agent CLI or stream parser | `apps/daemon/src/runtimes/AGENTS.md`, `mocks/AGENTS.md` |
| Web UI, preview, chat, i18n, CSS | `apps/AGENTS.md`, `apps/web/AGENTS.md` |
| Direct editing | `apps/web/src/edit-mode/AGENTS.md` |
| Shared packages and boundaries | `packages/AGENTS.md` |
| Lifecycle and packaging | `tools/AGENTS.md`, `tools/pack/AGENTS.md` |
| End-to-end tests | `e2e/AGENTS.md` |
| Plugins, skills, templates, brands, craft | `plugins/AGENTS.md`, `skills/AGENTS.md`, `design-templates/AGENTS.md`, `design-systems/AGENTS.md`, `craft/AGENTS.md` |
| Repo checks and generators | `scripts/AGENTS.md` |

Deeper references: `docs/spec.md`, `docs/architecture.md`, `docs/skills-protocol.md`,
`docs/agent-adapters.md`, `docs/modes.md`, `docs/code-review-guidelines.md`,
`docs/bug-follow-up-workflow.md`, `specs/current/maintainability-roadmap.md`.
Onboarding: `README.md`, `QUICKSTART.md`, `CONTRIBUTING.md`, `docs/i18n/*.ko.md`.

## Workspace directories

- Workspace packages come from `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tools/*`, `e2e`.
- `apps/web` (Next.js 16 + React 18 UI), `apps/daemon` (Express + SQLite API, agent
  spawner, `readable` bin), `apps/desktop` (Electron shell), `apps/packaged` (packaged
  Electron entry).
- Content roots: `skills/`, `design-templates/`, `design-systems/`, `craft/`, `plugins/`,
  `mocks/`.
- `apps/nextjs` and `packages/shared` have been removed; do not recreate or reference them.
- `.readable-studio/`, `.tmp/`, `ReadableStudioData/`, Playwright reports and agent
  scratch directories are local runtime data and stay out of git.

## Repository discovery

- **Hard rule: use `fd` for every filename or path discovery command.** POSIX `find`,
  `find.exe`, recursive `Get-ChildItem`, `dir /s` and custom filesystem walkers are
  forbidden, even when several bounded `fd` calls are needed. If `fd` cannot express the
  query, stop and report the blocker rather than falling back.
- Every delegated coding-agent prompt must repeat this rule. An agent that runs a
  forbidden command must stop it, disclose the violation, and replace it with `fd`.
- Bound discovery with roots, extensions, globs and excludes before reading contents.

## Environment baseline

- Node `~24` and `pnpm@10.33.2`. Node 22 is not supported: `engines` pins `~24`, and the
  lockfile's `better-sqlite3@11.10.0` is untested there.
- On Windows `corepack enable` fails with EPERM (cannot write shims to `Program Files`);
  use `npm install -g pnpm@10.33.2`.
- `better-sqlite3` has no win32/Node 24 prebuild and compiles from source (~2 min) via
  node-gyp; Visual Studio Build Tools 2022+ is required. That compile is expected.
- Run `pnpm install` after changing package manifests, workspace layout, command
  entrypoints, or bin/link content.
- Project-owned entrypoints, modules, scripts, tests, reporters and configs are
  TypeScript-first. New `.js`/`.mjs`/`.cjs` needs a documented generated/vendor/compat
  reason and must pass `pnpm guard`.

## Windows product boundary

Windows 10/11 x64 is the only supported product platform. The artifact is a portable ZIP
downloaded manually from GitHub Releases, extracted, and started with
`Readable Studio.exe`. Do not add website, installer, updater, macOS, Linux, WSL or Nix
product claims. Historical friction is documented in closed issues #10, #96, #100, #203
and #315.

## Command boundary

- `pnpm tools-dev` is the only local lifecycle entry point. Do not add or restore root
  `pnpm dev`, `dev:all`, `daemon`, `preview` or `start`. Ports come from `--daemon-port`
  and `--web-port`; `tools-dev` exports `READABLE_PORT` and `READABLE_WEB_PORT` (never
  `NEXT_PORT`).
- Root scripts stay limited to repo-level checks and tool control planes: `pnpm guard`,
  `pnpm typecheck`, `pnpm tools-dev`, `pnpm tools-pack`. No root aggregate `build`/`test`
  aliases and no root e2e aliases — use `pnpm --filter <package> ...` or
  `pnpm tools-pack ...`.
- When asked to build this workspace without naming a package, run the project-root
  `build-portable.ps1`. `tools-pack` is a local build and validation surface only; this
  repository has no release-publishing workflow.
- There is no maintainer PR-duty control plane here; `pnpm tools-pr` moved to the
  standalone `PerishCode/duty` project. Do not recreate `tools/pr`.

## Boundary constraints

- Tests live in a package/app/tool-level `tests/` directory sibling to `src/`; keep
  `src/` source-only. Playwright UI automation belongs to `e2e/ui/`.
- `apps/web/**` must not import `apps/daemon/src/**`, and no app may import another app's
  private `src/`/`tests/`. Integration goes through HTTP, `packages/contracts`, and
  app-local providers. Cross-app consistency checks belong in `e2e/tests/`.
- Keep shared API DTOs, SSE event unions, error shapes and example payloads in
  `packages/contracts`, and keep that package pure TypeScript — no Next.js, Express, Node
  fs/process, browser APIs, SQLite, daemon internals or sidecar control-plane deps.
- App business logic must not know about sidecars; keep that in `apps/<app>/sidecar`.
  Sidecar stamps have exactly five fields: `app`, `mode`, `namespace`, `ipc`, `source`.
  Orchestration layers call package primitives instead of hand-building
  `--readable-studio-stamp-*` args or process-scan regexes.
- Packaged runtime paths are namespace-scoped and independent of ports. Portable user
  data lives under `<exeDir>\ReadableStudioData\namespaces\<namespace>\...`; source daemon
  data defaults to `<project-root>\.readable-studio\...`; dev control-plane state under
  `<project-root>\.tmp\<source>\<namespace>\...`.

## Capability exposure (UI/CLI dual-track)

Every user-facing capability must be reachable through both the web UI **and** the
`readable` CLI. The CLI is the embeddability contract: external agents and packaged
runtimes drive Readable Studio through subcommands and never render the UI.

Adding a capability is one three-step change, landed together: HTTP endpoint in
`apps/daemon/src/*-routes.ts` with a contract type in `packages/contracts/src/api/`, UI
surface in `apps/web/src/`, and a `readable <capability>` subcommand registered through
`SUBCOMMAND_MAP` in `apps/daemon/src/cli.ts`. Both surfaces call the same `/api/*`
endpoint. The CLI form supports `--json` and accepts `--prompt-file <path|->`. Reference
shapes: `readable automation`, `plugin`, `ui`, `project`, `media`, `mcp`, `research`.

The PR template's Surface area checklist must reflect both surfaces, or explain why one
is genuinely not applicable. "I'll do the CLI later" is not a valid reason.

## Validation

- Before marking work ready run at least `pnpm guard` and `pnpm typecheck`, plus the
  package-scoped tests/builds matching the files changed.
- `pnpm guard` enforces workspace identity, residual JavaScript, bundled copy language,
  dependency specs, product neutrality, daemon Windows footguns, cross-app imports, test
  layout, theme token parity, the checkbox UI ban, style policy and the design-system check family, then
  chains six `node --test` files. See `scripts/AGENTS.md`.
- Stream/parser changes replay through `mocks/`. Stamp/namespace changes validate two
  concurrent namespaces plus desktop `inspect eval` and `inspect screenshot`. Path/log
  changes confirm `pnpm tools-dev logs --namespace <name> --json` resolves under
  `.tmp/tools-dev/<namespace>/`.
- For bug fixes, lead with a red spec at the cheapest layer that can see the symptom:
  `docs/bug-follow-up-workflow.md`.

## Pull requests and review

- `.github/pull_request_template.md` — fill every section. "Why" answers both your use
  case and the pain addressed; "What users will see" is written from the user's
  perspective. Link the issue with `Fixes #N` so release-time lookup has a chain.
- If a UI surface is checked, attach screenshots showing the entry point, not just the
  feature in isolation.
- `CONTRIBUTING.md` covers PR scope, title format, dependency policy and the issue-first
  rule. `docs/code-review-guidelines.md` is the reviewer-facing standard; this file wins
  where the two disagree.
- Git commits must not include `Co-authored-by` or any other co-author metadata, and are
  never created unless explicitly requested.

## Common commands

```bash
pnpm install
pnpm guard
pnpm typecheck
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
pnpm tools-dev status --json
pnpm tools-dev stop
pnpm --filter @readable-studio/web test
pnpm --filter @readable-studio/daemon test
```

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win cleanup
```
