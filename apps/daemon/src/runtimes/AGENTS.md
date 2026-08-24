# apps/daemon/src/runtimes

One `RuntimeAgentDef` (`types.ts`) per coding-agent CLI: binary, argument builder, stream
format and parser, stdin/file prompt behavior, models, capabilities, MCP injection.
22 agents live in `defs/`; `defs/shared.ts` holds the common builders.

## Adding an agent

1. `defs/<agent>.ts` — copy the closest existing def, not the biggest one.
2. Register it where the def index imports from.
3. Record a mock trace and verify the parser round-trips: see `../../../../mocks/AGENTS.md`.
   Do not verify a parser change against a live provider.
4. Tests go in `apps/daemon/tests/`, never under `src/`.

## promptInputFormat — read before touching stdin

- `'text'` (21 of 22 agents): write the composed prompt, close stdin immediately.
- `'stream-json'` (**Claude only**, `defs/claude.ts`, paired with
  `--input-format stream-json`): write one JSONL user message and keep stdin **open** so
  further user messages can be streamed mid-turn.

For stream-json, `applyClaudeStreamJsonRunBookkeeping` in `../server.ts` closes stdin
(and records `turnCompletedCleanly`) on a `turn_end`/`usage` event only when
`stop_reason !== 'tool_use'`. A `tool_use` stop means the model paused inside a tool;
closing there truncates the follow-up response. `../claude-stream.ts` must keep emitting
`turn_end` **after** iterating the assistant message's content blocks, so the final
`stop_reason` and every tool_use of the turn are visible when that decision is made.

## Stream adapters

`../claude-stream.ts`, `../copilot-stream.ts`, `../qoder-stream.ts`,
`../json-event-stream.ts` normalise frames into status / text / thinking / tool-use /
tool-result / usage / error events. Parser changes belong beside the matching runtime
helpers and their tests.

## Detection

`detection*.ts` and `executables.ts` resolve binaries through the shared toolchain helper
in `@readable-studio/platform`, which the packaged sidecar PATH builder also consumes. Do
not add a second search list.
