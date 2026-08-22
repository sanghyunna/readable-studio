# Chat rollback implementation DAG

Status: active implementation map for `chat-rollback-checkpoints-plan.md`.

## Node graph

```text
A0 repo-state audit
  -> A1 contracts
  -> A2 daemon DB metadata
  -> A3 daemon checkpoint service

A1 contracts
  -> A4 daemon routes
  -> A7 CLI surface
  -> A8 web provider/state

A2 daemon DB metadata
  -> A3 daemon checkpoint service
  -> A4 daemon routes

A3 daemon checkpoint service
  -> A4 daemon routes
  -> A5 run/message capture hooks
  -> A6 daemon tests

A4 daemon routes
  -> A6 daemon tests
  -> A7 CLI surface
  -> A8 web provider/state

A5 run/message capture hooks
  -> A6 daemon tests

A8 web provider/state
  -> A9 web UI
  -> A10 web tests

A7 CLI surface
  -> A11 CLI tests

A6 daemon tests
A10 web tests
A11 CLI tests
  -> A12 validation gates
  -> A13 critical review
```

## Node boundaries

### A0 repo-state audit

Owner: main agent.

Purpose:

- Re-read `AGENTS.md`, `apps/AGENTS.md`, `packages/AGENTS.md`, and the rollback
  plan.
- Identify current dirty files and avoid reverting unrelated work.
- Confirm existing route, DB, CLI, web, and i18n patterns.

Writes:

- This DAG file only.

Done when:

- The dependency graph is explicit.
- Worker scopes can be assigned without overlapping write sets.

### A1 contracts

Owner: contracts worker or main agent.

Purpose:

- Add pure TypeScript checkpoint and rollback DTOs.
- Export them from the contracts package.

Likely write set:

- `packages/contracts/src/api/checkpoints.ts`
- `packages/contracts/src/api/index.ts` or the current API barrel.
- Any package-local contract type test if one already exists.

Boundaries:

- No Node, Express, SQLite, filesystem, browser, or daemon imports.
- Types only.

Done when:

- Web, daemon, and CLI can import shared checkpoint DTOs.
- `pnpm --filter @readable-studio/contracts typecheck` passes.

### A2 daemon DB metadata

Owner: daemon worker or main agent.

Purpose:

- Add checkpoint metadata and restore audit tables.
- Add helpers for checkpoint metadata, message pruning, and agent-session
  clearing.

Likely write set:

- `apps/daemon/src/db.ts`
- `apps/daemon/tests/db-checkpoints.test.ts`

Boundaries:

- Do not implement filesystem snapshot logic here.
- Do not add route handlers here.

Done when:

- Checkpoint metadata can be inserted/listed/read.
- Restore audit can be recorded.
- Messages after a target position can be deleted.
- All agent sessions for a conversation can be cleared.

### A3 daemon checkpoint service

Owner: main agent.

Purpose:

- Implement file snapshot, manifest/blob storage, diff, conflict detection,
  safety checkpoint, and restore.

Likely write set:

- `apps/daemon/src/project-checkpoints.ts`
- `apps/daemon/tests/project-checkpoints.test.ts`

Boundaries:

- Use existing project root and ignored-directory helpers.
- Do not write route handlers.
- Do not directly know web UI state.
- Never touch `.git`.

Done when:

- Service tests cover capture, restore, conflicts, `.live-artifacts`, ignored
  dirs, root escape prevention, and safety checkpoints.

### A4 daemon routes

Owner: daemon worker or main agent.

Purpose:

- Expose checkpoint list, checkpoint diff, and rollback endpoints under project
  routes.

Likely write set:

- `apps/daemon/src/project-routes.ts`
- `apps/daemon/src/server.ts` only for dependency injection/wiring if needed.
- `apps/daemon/tests/projects-routes.test.ts` or focused route test.

Boundaries:

- Do not put domain route bodies in `server.ts`.
- Routes call service/DB helpers.
- Routes return contract DTO shapes.

Done when:

- UI and CLI can call the same HTTP endpoints.
- Route tests cover not found, conflict, mode behavior, and ownership checks.

### A5 run/message capture hooks

Owner: main agent.

Purpose:

- Create `before_run` checkpoints before agent execution.
- Create `after_run_unfinalized` fallback checkpoints.
- Create or refresh `after_message` checkpoints during finalized message PUT.

Likely write set:

- `apps/daemon/src/server.ts`
- `apps/daemon/src/project-routes.ts`
- Tests under `apps/daemon/tests/`

Boundaries:

- Only unavoidable run-capture hook belongs in `server.ts`.
- Message-finalization hook belongs in project routes.
- Checkpoint finalization must be independent from telemetry enablement.

Done when:

- Headless run creates a usable checkpoint.
- Web finalization captures files after web-side artifact persistence.

### A6 daemon tests

Owner: daemon test worker or main agent.

Purpose:

- Cover service, DB, routes, capture hooks, conflicts, and agent-session
  clearing.

Likely write set:

- `apps/daemon/tests/*checkpoint*.test.ts`
- Existing daemon route/run tests only if needed.

Boundaries:

- Tests live under `apps/daemon/tests/`, never `src/`.
- Do not import web private code.

Done when:

- `pnpm --filter @readable-studio/daemon test` passes or failures are understood and
  unrelated.

### A7 CLI surface

Owner: CLI worker.

Purpose:

- Add `readable chat checkpoints`, `readable chat checkpoint diff`, and `readable chat rollback`.

Likely write set:

- `apps/daemon/src/cli.ts`
- CLI-focused tests under `apps/daemon/tests/` if existing patterns support it.

Boundaries:

- CLI calls daemon HTTP endpoints only.
- CLI does not read SQLite or checkpoint files.
- Support `--json`.

Done when:

- CLI commands produce machine-readable JSON and useful human output.

### A8 web provider/state

Owner: web worker.

Purpose:

- Add web fetch helpers for checkpoint list, diff, and rollback.

Likely write set:

- `apps/web/src/state/projects.ts` or a focused app-local provider module.
- Web state tests if current patterns exist.

Boundaries:

- Use contracts DTOs.
- Do not import daemon private code.

Done when:

- UI code can call typed helpers for list/diff/rollback.

### A9 web UI

Owner: web worker.

Purpose:

- Add rollback action near Fork, modal, mode selection, conflict display, and
  post-success refresh.

Likely write set:

- `apps/web/src/components/AssistantMessage.tsx`
- `apps/web/src/components/ProjectView.tsx`
- A focused rollback modal component/CSS module if needed.
- `apps/web/src/i18n/types.ts`
- all `apps/web/src/i18n/locales/*.ts`

Boundaries:

- Reuse app primitives/icons where possible.
- Add all i18n keys in all locale files.
- Do not add global CSS unless existing component pattern requires it.

Done when:

- Users can discover rollback from a previous assistant message.
- Success refreshes messages/files/comments.

### A10 web tests

Owner: web worker or main agent.

Purpose:

- Cover assistant footer action, modal behavior, conflict rendering, and success
  refresh.

Likely write set:

- `apps/web/tests/**/*rollback*.test.tsx`

Boundaries:

- Tests under `apps/web/tests/`.
- No Playwright unless required.

Done when:

- `pnpm --filter @readable-studio/web test` passes or failures are understood and
  unrelated.

### A11 CLI tests

Owner: CLI worker or main agent.

Purpose:

- Verify the new CLI commands call endpoints and format JSON/human output.

Likely write set:

- `apps/daemon/tests/*cli*.test.ts`

Done when:

- CLI coverage proves endpoint parity.

### A12 validation gates

Owner: main agent.

Purpose:

- Run required package checks and broader repo checks from the plan.

Commands:

```bash
pnpm --filter @readable-studio/contracts typecheck
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/web test
pnpm guard
pnpm typecheck
```

Done when:

- Required gates pass, or failures are documented as pre-existing with evidence.

### A13 critical review

Owner: critical review subagent.

Purpose:

- Inspect the finished diff against `chat-rollback-checkpoints-plan.md`.
- Try to find correctness, security, data integrity, boundary, test, and UX
  issues.

Done when:

- The review subagent has thoroughly inspected the code and returns the exact
  success sentence required by the active goal, or findings are fixed and the
  review is repeated.

