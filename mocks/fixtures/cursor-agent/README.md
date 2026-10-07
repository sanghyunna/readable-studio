# Cursor stream regression fixture

`thinking-tool-segments.jsonl` is reconstructed, not a live provider capture.
The installed Cursor CLI reports `Not logged in`; no provider was invoked.

Provenance: Cursor CLI `2026.09.26-dd393fe`, `6853.index.js`, headless emitter
at byte offsets 569889-573800. The actual `Ie` flush expression and
`sendUpdate` cases for `textDelta`, `toolCallStarted`, `thinkingDelta`, and
`thinkingCompleted` were executed verbatim with captured stdout and local
session/model/tool identifiers. Timestamps were normalized to 1. Init, user,
tool-completed, and result envelopes follow the same installed emitter schema.
The installed June CLI `2026.06.12-19-59-36-f6aba9a`, `7633.index.js`,
contains the same protocol at offsets 529443-534900.

The fixture uses two text segments (A, B), each followed by a tool boundary,
and two thinking blocks. The second consolidated segment produced ABB in the
old parser; both thinking deltas became raw events. The regression tests also
replay this fixture through a real stdout child and split JSONL transport at
one-byte and 17-byte boundaries.

## Native schema

- `system/init`: session, model, workspace/auth metadata.
- `user`: user message content blocks; not assistant output.
- `assistant` with `timestamp_ms`, without `model_call_id`: individual text
  deltas under `--stream-partial-output`. Identical or prefix-sharing deltas
  are legitimate text, not necessarily cumulative snapshots.
- `assistant` with `model_call_id`: consolidated text since the previous flush,
  emitted immediately before `tool_call/started`; can also have a timestamp.
- Before `retry` and `interaction_query/request`, the same consolidated flush
  has a timestamp but no model-call ID. The following boundary disambiguates
  it from a genuine delta.
- Untimestamped `assistant`: consolidated text in non-partial stream mode;
  the parser also reconciles partial-plus-final sequences from older adapters.
- `thinking/delta`: `text` is incremental reasoning; `thinking/completed` ends
  that block. Neither resets the text segment.
- `tool_call/started` and `tool_call/completed`: `call_id`, `model_call_id`,
  structured `tool_call`, session, timestamp. Existing tool rendering is not
  changed by this fix.
- `result/success`: `result` contains run-wide text, plus optional camelCase
  usage token fields and durations. It is not another text delta. In both
  installed versions, partial mode ends with result directly; non-partial
  mode first flushes an untimestamped assistant.

Historical local Cursor transcripts confirm multi-segment assistant/tool-use
turns but do not preserve native stdout frames. A copy of the source dev DB
contained no Cursor messages. The fixture therefore makes no claim to reproduce
an individual owner's recorded run, only the installed emitter's exact framing.
