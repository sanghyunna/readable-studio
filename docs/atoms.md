# First-party atom catalog

> The atomic capabilities Readable Studio exposes to plugins.
> Source of truth: [`apps/daemon/src/plugins/atoms.ts`](../apps/daemon/src/plugins/atoms.ts).
> Live discovery: `GET /api/atoms`.

A **plugin** assembles atoms into ordered stages (`readable.pipeline.stages[].atoms[]`).
The Readable Studio daemon is responsible for resolving each atom into a system-prompt
fragment, tool gating, and (when applicable) GenUI surface declarations. Plugins
never own the atom implementations; they only reference them by id.

## Reading this document

- **id** - what you write inside `readable.pipeline.stages[*].atoms[]` and
  `readable.context.atoms[]`. Stable across daemon versions.
- **status** - `implemented` means the id is accepted by the daemon catalog.
- **task kinds** - which product scenarios (`new-generation`, `code-migration`,
  `figma-migration`, `tune-collab`) the atom is intended for. Plugins may
  reference an atom outside its declared task kinds, but doctor flags this as
  suspicious.

## Implemented atoms (v1)

| id | label | task kinds |
| --- | --- | --- |
| `discovery-question-form` | Discovery question form - turn-1 question form for ambiguous briefs. | `new-generation`, `tune-collab` |
| `direction-picker` | Direction picker - 3-5 direction picker before final. | `new-generation`, `tune-collab` |
| `todo-write` | Todo write - TodoWrite-driven plan. | all |
| `file-read` | File read - read project files. | all |
| `file-write` | File write - write project files. | all |
| `file-edit` | File edit - edit project files. | all |
| `research-search` | Research search - Tavily-backed shallow research. | `new-generation` |
| `critique-theater` | Critique theater - 5-dimension panel critique; emits the `critique.score` signal that drives devloop convergence. | all |
| `code-import` | Code import - walk an existing repo into `<cwd>/code/index.json`. | `code-migration` |
| `design-extract` | Design extract - extract design tokens into `<cwd>/code/tokens.json`. | `code-migration`, `figma-migration` |
| `figma-extract` | Figma extract - pull Figma file tree and assets through REST. | `figma-migration` |
| `token-map` | Token map - crosswalk source token bags onto the active design system. | `code-migration`, `figma-migration` |
| `rewrite-plan` | Rewrite plan - ownership classifier plus per-leaf step list. | `code-migration`, `tune-collab` |
| `patch-edit` | Patch edit - unified-diff applier with shell-tier safety gate. | `code-migration`, `tune-collab` |
| `build-test` | Build / test - run typecheck and tests; emits build/test signals. | `code-migration` |
| `diff-review` | Diff review - render rewrite as reviewable diff artifacts. | `code-migration`, `tune-collab` |
| `handoff` | Handoff - update artifact provenance and handoff state. | `code-migration`, `tune-collab` |

## Planned atoms

There are no reserved planned atoms in the v1 catalog. Unknown atom ids are
reported by `readable plugin doctor` as errors.

## How the daemon resolves an atom

1. The plugin manifest's `readable.pipeline.stages[*].atoms[]` is parsed into a
   `PipelineStage[]` by `apps/daemon/src/plugins/pipeline.ts`.
2. At run time, `apps/daemon/src/plugins/pipeline-runner.ts` walks the stages.
   For each stage entry it:
   - emits a `pipeline_stage_started` SSE event,
   - asks the atom worker registry to execute each atom,
   - persists one row into `run_devloop_iterations` for audit,
   - emits a `pipeline_stage_completed` event with the resulting signals.
3. Atom prompt fragments live in `plugins/_official/atoms/<atom>/SKILL.md` and
   are loaded by `apps/daemon/src/plugins/atom-bodies.ts`.

## Atom signals + the `until` vocabulary

The closed v1 `until` vocabulary is:

- `critique.score` - emitted by `critique-theater`.
- `iterations` - built-in per-stage counter.
- `user.confirmed` - emitted when a `confirmation` GenUI surface resolves.
- `build.passing` / `tests.passing` - emitted by `build-test`.

## Adding a new atom

1. Author the atom out-of-tree as a plugin.
2. Once the SKILL.md / MCP tool / pipeline shape stabilises, append the
   matching row to `FIRST_PARTY_ATOMS` in `apps/daemon/src/plugins/atoms.ts`.
3. Add `plugins/_official/atoms/<atom>/SKILL.md`.
4. Update this document and the plugin spec tables in the same PR.
5. The atom is now reachable via:
   - `readable.pipeline.stages[*].atoms[]` references in any plugin,
   - `GET /api/atoms` discovery,
   - `readable plugin doctor` validation.
