# apps/daemon

Parent: `apps/AGENTS.md` (router layout, test layout). This file covers only what
surprises people about this app.

## Commands

```bash
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/daemon typecheck
pnpm --filter @readable-studio/daemon test -- tests/handoff-route.test.ts
```

## Two servers, not one

- `src/server.ts` (~14k lines) is the local single-user daemon. Never read it top to
  bottom — `rg -n "app\.(get|post)\('/api/<path>" src/server.ts`, or find the
  `register*Routes` import block near line 462.
- `src/hosted-server.ts` is a **separate** Express app for the multi-tenant hosted
  runtime, with its own registrars in `src/routes/hosted-*.ts` and ~35 `src/hosted-*.ts`
  modules. It is not reachable from the local daemon's route table. Changing local
  behavior does not change hosted behavior, and vice versa.
  Context: `docs/hosted-pi-third-party.md`, `specs/current/hosted-readiness.md`.

## Where state lives

- `src/db.ts` creates 14 tables. Plugin tables are in `src/plugins/persistence.ts`;
  hosted receipts in `src/hosted-run-receipts.ts`. Grep all three before assuming a
  table is missing.
- Data root precedence: `READABLE_MEDIA_CONFIG_DIR` (media credentials only) >
  `READABLE_DATA_DIR` (everything) > `<projectRoot>/.readable-studio`. Both env paths
  resolve `~/` and anchor relative paths to the project root.
- Layout under the data root: `app.sqlite`, `projects/<project-id>/` agent CWDs,
  `artifacts/`, `critique-artifacts/`, `media-config.json`, `memory/*.md`.

## Prompt composition

`src/prompts/system.ts` — injection resistance → official prompt → discovery → memory →
`DESIGN.md` → usage/tokens/component fixtures → craft → active skill, with the deck
framework appended last. Order is load-bearing: later sections lose on conflict. The
base readability block must stay byte-identical to the mirror in
`packages/contracts/src/prompts/system.ts`.

## Clarifying questions

The daemon's half of the `<question-form>` mechanism: guidance is authored in
`src/prompts/system.ts` and `src/prompts/discovery.ts`, and
`src/run-artifacts.ts:runAskedUserQuestion` powers the `run_finished.asked_user_question`
signal by scanning streamed text for a `<question-form` marker reassembled across
`text_delta` chunks. There is no `AskUserQuestion` tool, no
`/api/runs/:id/tool-result` endpoint, and no host-answer return path — do not add one.
The rendering half lives in `apps/web/AGENTS.md`.

## Known host limitation

Tests that spawn an AppContainer child fail with `ERROR_ACCESS_DENIED` on a normal
non-elevated Windows session. Baseline against a clean checkout before treating such a
failure as yours.
