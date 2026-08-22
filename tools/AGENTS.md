# tools/AGENTS.md

Follow the root `AGENTS.md` first. This file only records module-level boundaries for `tools/`.

## Active tools

- `tools/dev` provides `@readable-studio/tools-dev` and the `tools-dev` bin. It is the only currently active local development lifecycle control plane.
- `pnpm tools-dev` manages daemon -> web -> desktop.
- `pnpm tools-dev run web` runs foreground daemon + web for the Playwright webServer flow.
- `pnpm tools-dev inspect desktop ...` inspects the desktop runtime through sidecar IPC.
- `tools/pack` provides `@readable-studio/tools-pack` and the `tools-pack` bin. It owns the local Windows portable ZIP build/start/stop/logs/cleanup/inspect lifecycle.

## Retired tools

- `tools/pr` / `@readable-studio/tools-pr` / `pnpm tools-pr` has been retired from this repository. Maintainer PR-duty workflows now live outside the product workspace in `PerishCode/duty`; do not restore an Readable Studio-local PR-duty tool without a new explicit maintainer decision.

## Packaging scope

- Keep `tools-pack` focused on local packaging and runtime control.
- Pack-specific Electron builder resources belong under `tools/pack/resources/`; do not reference app/docs/download assets directly from pack logic.
- Namespace controls packaged data/log/runtime/cache paths. Ports are transient transport details and must not participate in path decisions.
- There is no root `pnpm build` aggregate. Use package-scoped builds for source packages and `pnpm tools-pack ...` for local packaged build/runtime flows.

## Orchestration boundary

- Tool tests live in each tool's `tests/` directory, sibling to `src/`; keep `src/` source-only and do not add new `*.test.ts` or `*.test.tsx` files under `src/`.
- Orchestration layers must consume primitives from `@readable-studio/sidecar-proto`, `@readable-studio/sidecar`, and `@readable-studio/platform`.
- Do not hand-build `--readable-studio-stamp-*` args, process-scan regexes, runtime tokens, process roles, or duplicate namespace/source args in `tools/dev`, future `tools/pack`, or packaged launchers.
- Port flags are authoritative inputs: `--daemon-port` and `--web-port`. Internal env vars are `READABLE_PORT` and `READABLE_WEB_PORT`; do not introduce `NEXT_PORT`.

## Common tools commands

```bash
pnpm --filter @readable-studio/tools-dev typecheck
pnpm --filter @readable-studio/tools-dev build
pnpm --filter @readable-studio/tools-pack typecheck
pnpm --filter @readable-studio/tools-pack build
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev check
pnpm tools-pack win build
pnpm tools-pack win start
pnpm tools-pack win inspect --expr "document.title"
pnpm tools-pack win cleanup
```
