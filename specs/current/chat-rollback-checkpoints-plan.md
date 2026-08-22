# Chat rollback and filesystem checkpoint plan

Status: planning artifact only. No implementation is included in this file.

Last verified: 2026-06-14

## Goal

Add rollback from a selected previous chat point, with the option to also revert
code and project file changes produced after that point.

The feature is intended for corporate use, so it must be predictable, auditable,
local-first, and safe around dirty working trees, imported external projects,
parallel agents, and resumable upstream coding-agent sessions.

## Product requirements

1. A user can choose a previous assistant or user turn and roll back to that
   point.
2. Rollback can restore files, chat history, or both.
3. Rollback must not modify the user's Git history or require the project to be
   a Git repository.
4. Rollback must work for normal web chat, side chat, CLI/headless runs, and MCP
   or SDK callers that create daemon runs.
5. Rollback must create a safety checkpoint before it changes anything.
6. Rollback must refuse or clearly surface conflicts when current files diverged
   from the checkpoint lineage.
7. Rollback must invalidate future agent resume state so a resumed coding agent
   cannot re-import discarded chat context.
8. Rollback must have both UI and `readable` CLI surfaces, because repository policy
   requires every user-facing capability to be reachable through both surfaces.

## Non-goals for the first implementation

1. Do not replace Git, branches, commits, or long-term version control.
2. Do not create commits in the user's project repository.
3. Do not promise cross-machine checkpoint portability in v1.
4. Do not try to snapshot huge generated dependency/build directories.
5. Do not follow symlinked directories outside the project root.
6. Do not rewrite upstream provider session files such as Claude's own session
   database. Instead, invalidate Readable Studio's stored resume pointer.
7. Do not add cloud sync for checkpoints.

## External evidence

The design should follow the common industry pattern: checkpoint locally,
separate checkpoint history from user Git history, expose file-only/chat-only/
combined restore modes, and treat checkpoints as fast local undo rather than
permanent version control.

| Source | Verified claim | Design consequence |
| --- | --- | --- |
| VS Code chat checkpoints, https://code.visualstudio.com/docs/chat/chat-checkpoints | VS Code can restore workspace files to a previous chat checkpoint, removes later chat history on restore, shows file changes, supports redo, and explicitly says checkpoints complement Git rather than replace it. | Readable Studio should expose restore from the chat timeline, show affected files before restore, and create a safety checkpoint for redo-like recovery. |
| Claude Code checkpointing, https://code.claude.com/docs/en/checkpointing | Claude creates prompt-level checkpoints and exposes separate actions for restoring code and conversation, restoring conversation only, and restoring code only. It also documents limitations around bash/external changes and says checkpoints do not replace version control. | Readable Studio should ship explicit restore modes and conflict/limitation language instead of one implicit destructive action. |
| Claude Agent SDK file checkpointing, https://code.claude.com/docs/en/agent-sdk/file-checkpointing | SDK checkpointing can restore file changes made by file-edit tools, but file rewind does not automatically rewind conversation state. | Readable Studio needs a joint model tying durable chat rows to file snapshots. File metadata alone is insufficient. |
| Cline checkpoints, https://docs.cline.bot/core-workflows/checkpoints | Cline uses a shadow Git repository separate from the project Git history, keeps user Git clean, captures files not tracked by Git, and offers Restore Files, Restore Task Only, and Restore Files & Task. | Prefer a shadow/content-addressed checkpoint store outside the project over user Git commits. Expose the same three conceptual modes. |
| Aider Git integration, https://aider.chat/docs/git.html | Aider uses real Git integration, including auto-commits and `/undo`, and can commit dirty files before AI edits. | This is not the right default for Readable Studio corporate rollback because it mutates Git history and dirty-worktree state. It remains useful prior art for command-line undo semantics. |
| Gemini CLI checkpointing, https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html | Gemini checkpointing uses a shadow Git repository in the user's home directory plus JSON for conversation/tool-call state, and `/restore` restores files plus conversation. | A local shadow store is a validated pattern. Readable Studio can implement equivalent semantics without requiring Git as the storage engine. |
| Devin Desktop/Windsurf Cascade overview, https://docs.devin.ai/desktop/cascade/cascade | Cascade exposes prompt-level code reverts and named snapshots, while warning that reverts are irreversible. | Readable Studio should expose named/safety checkpoints and be explicit about destructive scope. Safety checkpoints reduce the irreversibility problem. |

## Local evidence

This section anchors the plan in current Readable Studio code. Line numbers are from
the 2026-06-14 inspection pass and should be re-verified before implementation
if nearby files changed.

### Run creation and agent execution

| Evidence | Why it matters |
| --- | --- |
| `apps/daemon/src/server.ts:474` imports `registerProjectRoutes` and `registerProjectFileRoutes`. | Project/conversation/file endpoints already have domain route owners. New rollback endpoints should not be added directly to `server.ts` unless unavoidable. |
| `apps/daemon/src/server.ts:13661` defines `POST /api/runs`. | This is the canonical daemon run-create path where pre-run checkpoint capture should hook. |
| `apps/daemon/src/server.ts:13849` creates the run via `design.runs.create(meta)`. | A checkpoint tied to run id should be created after this point because the run id exists. |
| `apps/daemon/src/server.ts:13851` calls `pinAssistantMessageOnRunCreate(db, run)`. | The assistant message row exists before the agent process starts, so checkpoint metadata can be associated with `assistantMessageId`. |
| `apps/daemon/src/server.ts:13920` starts the run with `design.runs.start(run, () => startChatRun(meta, run))`. | Pre-run checkpoint capture must happen before this call to avoid racing the child process. |
| `apps/daemon/src/server.ts:10738` starts `startChatRun`. | This is the actual chat execution body. |
| `apps/daemon/src/server.ts:11346` persists streamed run events to the assistant message before emitting SSE. | Chat/event persistence is daemon-owned and durable enough to recover after UI reload. |
| `apps/daemon/src/server.ts:12330` spawns the coding agent with `cwd: effectiveCwd`. | The child process can mutate files directly in the project cwd. Rollback cannot rely only on HTTP file APIs or tool-token routes. |
| `apps/daemon/src/runs.ts:26` creates an in-memory run service. | Rollback must not depend on in-memory run records after TTL. Durable anchors must be DB rows and checkpoint metadata. |

### Web chat finalization

| Evidence | Why it matters |
| --- | --- |
| `apps/web/src/components/ProjectView.tsx:3027` defines the primary `handleSend` path. | This is where visible web chat starts user and assistant message lifecycle. |
| `apps/web/src/components/ProjectView.tsx:3124` captures `preTurnFileNames`. | Current `producedFiles` is name-diff metadata, not a content snapshot. It helps UI chips but cannot restore bytes. |
| `apps/web/src/components/ProjectView.tsx:3504` refreshes project files after the daemon stream finishes. | The web needs a post-run file list to compute generated outputs. |
| `apps/web/src/components/ProjectView.tsx:3511` calls `persistArtifact(...)` after run completion when generated HTML is detected. | A daemon-only run-end checkpoint can miss web-persisted artifacts. |
| `apps/web/src/components/ProjectView.tsx:3514` computes produced files after artifact persistence. | Final assistant-message metadata is not complete until this step. |
| `apps/web/src/components/ProjectView.tsx:3524` persists the finalized assistant message with `telemetryFinalized: true`. | The daemon message-finalization route is the most accurate hook for an `after_message` checkpoint. |
| `apps/web/src/components/workspace/useConversationChat.ts:74` drives side chat and also uses `streamViaDaemon`. | Rollback capture must be daemon-level so both primary chat and side chat benefit. |
| `apps/web/src/providers/daemon.ts:517` defines `streamViaDaemon`. | All web chat surfaces converge into the same daemon run API. |

### Durable chat state

| Evidence | Why it matters |
| --- | --- |
| `packages/contracts/src/api/chat.ts:361` defines `ChatMessage`. | Any checkpoint/rollback DTOs should live in contracts, not web-only or daemon-only types. |
| `packages/contracts/src/api/chat.ts:384` carries `producedFiles`. | Produced files exist as metadata only. |
| `packages/contracts/src/api/chat.ts:386` carries `preTurnFileNames`. | The current baseline is only names, not file content or hashes. |
| `packages/contracts/src/api/chat.ts:393` defines request-only `telemetryFinalized`. | The system already has a request-only finalization marker that can be used to trigger after-message checkpoint capture. |
| `apps/daemon/src/db.ts:76` creates `conversations`. | Chat rollback must preserve the conversation row and prune messages, not necessarily delete the conversation. |
| `apps/daemon/src/db.ts:89` creates `agent_sessions`. | Agent resume state is durable and must be invalidated on chat rollback. |
| `apps/daemon/src/db.ts:99` creates `messages`. | Message order and pruning should use persisted `position` in this table. |
| `apps/daemon/src/db.ts:124` creates `preview_comments`. | Comments can point to DOM/file state that no longer exists after rollback. |
| `apps/daemon/src/db.ts:1171` lists messages ordered by position. | Target and future messages can be computed deterministically. |
| `apps/daemon/src/db.ts:1196` upserts messages. | This is where checkpoint ids may be joined indirectly via a separate table. |
| `apps/daemon/src/db.ts:1350` deletes individual messages. | v1 can add a batch delete helper for messages after a target position. |

### Project roots and file safety

| Evidence | Why it matters |
| --- | --- |
| `apps/daemon/src/projects.ts:88` resolves project roots and supports external `metadata.baseDir`. | Rollback must use the same root resolution as existing project file operations. |
| `apps/daemon/src/projects.ts:99` ensures managed project dirs, while external roots are not created. | Snapshot code must not create arbitrary external root directories. |
| `apps/daemon/src/projects.ts:108` lists files through the project root. | Snapshot walking should intentionally mirror, then extend, existing visible-file behavior. |
| `apps/daemon/src/projects.ts:234` skips dot-prefixed entries in normal file listing. | Normal listing hides `.live-artifacts`; rollback must decide explicitly whether to include it. |
| `apps/daemon/src/projects.ts:748` writes project files with path sanitization and safe realpath resolution. | Restore should reuse or mirror this safety model, while allowing reserved daemon-owned paths where intended. |
| `apps/daemon/src/projects.ts:931` deletes project files through safe resolution. | Restore deletion should be path-scoped and never recursive at the project root. |
| `apps/daemon/src/projects.ts:33` reserves `.live-artifacts`. | User file APIs intentionally block `.live-artifacts`; checkpoint service needs an internal path policy. |
| `apps/daemon/src/project-ignored-dirs.ts:4` excludes `.git`, `node_modules`, `.readable-studio`, build outputs, caches, venvs, and other generated dirs. | Snapshot scope must exclude these by default for safety and performance. |

### Project route ownership

| Evidence | Why it matters |
| --- | --- |
| `apps/daemon/src/project-routes.ts:755` defines `registerProjectRoutes`. | Conversation-level rollback endpoints belong here. |
| `apps/daemon/src/project-routes.ts:1492` lists conversations. | Checkpoint lists should fit this project/conversation route family. |
| `apps/daemon/src/project-routes.ts:1606` lists messages. | UI rollback modal can load messages and checkpoints from the same project/conversation API family. |
| `apps/daemon/src/project-routes.ts:1614` updates a message. | `after_message` checkpoint capture should hook here when `telemetryFinalized` is true. |
| `apps/daemon/src/project-routes.ts:1629` currently reports finalized-message telemetry. | Checkpoint finalization should run near this boundary, but must not be coupled to telemetry. |
| `apps/daemon/src/project-routes.ts:1895` defines `registerProjectFileRoutes`. | File restore helpers may live in the checkpoint service, but should honor the same constraints as project file routes. |

### Existing fork behavior

| Evidence | Why it matters |
| --- | --- |
| `apps/web/src/components/ProjectView.tsx:4719` defines `handleForkFromMessage`. | The UI already has a selected-message action pattern near assistant messages. |
| `apps/web/src/components/ProjectView.tsx:4731` creates a new conversation seeded up to the fork point. | Fork is chat-only. Rollback should not be implemented by extending fork because rollback modifies current project state. |
| `apps/web/src/components/AssistantMessage.tsx:940` defines assistant footer props. | The rollback affordance should live near Fork in the assistant footer. |

### Agent resume risk

| Evidence | Why it matters |
| --- | --- |
| `apps/daemon/src/agent-session-resume.ts:32` reads stored agent sessions before a run. | A rolled-back conversation could still resume an upstream future session unless cleared. |
| `apps/daemon/src/agent-session-resume.ts:54` persists or clears captured sessions after a run. | There is already a narrow helper boundary for session state. |
| `apps/daemon/src/runtimes/defs/claude.ts:76` passes `--resume` or `--session-id`. | Claude can continue its own hidden session beyond Readable Studio's visible message history. |
| `apps/daemon/src/runtimes/defs/claude.ts:93` declares `resumesSessionViaCli: true`. | Rollback must treat resume-capable agents as special stateful actors. |

### Live artifacts

| Evidence | Why it matters |
| --- | --- |
| `apps/daemon/src/live-artifacts/store.ts:16` stores live artifacts under `.live-artifacts`. | Live artifacts are file-backed project state and should be checkpointed unless explicitly excluded. |
| `packages/contracts/src/api/live-artifacts.ts:83` includes `createdByRunId`. | Live artifact provenance can be associated with runs, but storage still needs file-level restore. |

### Repository constraints

| Evidence | Why it matters |
| --- | --- |
| `AGENTS.md:91` requires every user-facing capability to be reachable through both web UI and `readable` CLI. | Rollback must ship UI and CLI together. |
| `AGENTS.md:94` requires both surfaces to call the same `/api/*` endpoints. | CLI must not manipulate SQLite or checkpoint files directly. |
| `AGENTS.md:96` requires contract types, daemon endpoint, UI surface, and `readable` subcommand for new capabilities. | The implementation must be a full vertical slice. |
| `apps/AGENTS.md:21` says existing daemon domain endpoints belong in matching route files, not `server.ts`, unless bootstrap-wide or without a clear owner. | Rollback endpoints should be in `project-routes.ts` or a project-checkpoint route module registered from there. |
| `packages/AGENTS.md:7` says `packages/contracts` must remain pure TypeScript and free of Node, Express, SQLite, and browser APIs. | Checkpoint contract DTOs must be pure data only. |

## Architecture decision summary

### Decision 1: daemon-owned checkpoints

Rollback must be owned by the daemon, not the web client.

Evidence:

- The daemon creates and starts runs at `apps/daemon/src/server.ts:13661` and
  `apps/daemon/src/server.ts:13920`.
- The daemon spawns the coding agent in the project cwd at
  `apps/daemon/src/server.ts:12330`.
- Durable chat state is SQLite in `apps/daemon/src/db.ts`.
- Side chat and primary chat both use daemon streaming.
- CLI/headless/MCP callers may not run the web UI at all.

Consequence:

- The web UI only requests rollback and renders diff/conflict state.
- The CLI calls the same HTTP endpoints.
- All file restore, checkpoint metadata, conflict checks, and chat pruning happen
  in the daemon.

### Decision 2: use a shadow checkpoint store, not user Git

Rollback must not create commits or alter user repository history.

Evidence:

- Cline and Gemini use shadow stores separate from project Git.
- Aider's real Git model commits AI changes and dirty files, which is the wrong
  default for corporate rollback.
- Existing Readable Studio projects may be managed `.readable-studio/projects/<id>` folders or
  imported external `metadata.baseDir` folders.

Consequence:

- Store checkpoints under daemon runtime data, not under project roots.
- Use content-addressed blobs and manifests, or a shadow Git implementation that
  remains outside the project and never touches `.git`.
- Do not require `git` to be installed for rollback.

Recommended v1 storage:

```text
<READABLE_DATA_DIR>/checkpoints/
  blobs/
    sha256/
      ab/
        abcdef...     # file content blob
  projects/
    <projectId>/
      <checkpointId>/
        manifest.json
        metadata.json
```

SQLite should index metadata and restore audit records. File bytes should live
in content-addressed blobs to avoid bloating SQLite and to deduplicate repeated
snapshots.

### Decision 3: checkpoint at chat-turn boundaries, with after-message finalization

Capture `before_run` before the agent starts, and capture `after_message` once
the assistant message is finalized.

Evidence:

- The daemon can capture a pre-run checkpoint after `design.runs.create` and
  before `design.runs.start`.
- The web may persist generated artifacts after daemon stream completion at
  `apps/web/src/components/ProjectView.tsx:3511`.
- The web persists final `producedFiles` and sends `telemetryFinalized: true` at
  `apps/web/src/components/ProjectView.tsx:3524`.
- The daemon receives that finalization in
  `apps/daemon/src/project-routes.ts:1614`.

Consequence:

- A daemon-run-end `after_run` checkpoint is only a fallback.
- The canonical "state after this visible assistant message" checkpoint should
  be captured or refreshed from the finalized message PUT.
- This prevents rollback snapshots from missing UI-persisted artifacts.

Checkpoint kinds:

```ts
type ProjectCheckpointKind =
  | 'before_run'
  | 'after_run_unfinalized'
  | 'after_message'
  | 'before_restore'
  | 'manual';
```

### Decision 4: expose three restore modes

Restore modes should be explicit:

```ts
type RollbackMode =
  | 'files_only'
  | 'chat_only'
  | 'files_and_chat';
```

Evidence:

- Claude and Cline expose file-only, conversation/task-only, and combined
  restore modes.
- Current Readable Studio Fork is chat-only and does not touch files.
- Corporate users need to recover separately from bad code, bad context, or both.

Consequence:

- The modal and CLI must force an explicit mode.
- The response must report exactly what changed in each domain.

### Decision 5: clear Readable Studio agent sessions after chat rollback

Any rollback mode that changes chat history must clear `agent_sessions` for the
conversation.

Evidence:

- `agent_sessions` stores upstream session ids by conversation and agent.
- Claude resumes upstream sessions via `--resume`.
- A rolled-back Readable Studio conversation can otherwise be paired with a future
  Claude session containing discarded tool calls and messages.

Consequence:

- Add a DB helper like `clearAgentSessionsForConversation(db, conversationId)`.
- Invoke it for `chat_only` and `files_and_chat`.
- For `files_only`, do not clear sessions by default, but consider returning a
  warning if the restored files diverge sharply from the current chat state.

### Decision 6: always create a safety checkpoint before restore

Every file restore should first capture current state as `before_restore`.

Evidence:

- VS Code exposes redo after restoring checkpoints.
- Cascade warns that reverts are irreversible.
- Corporate users need an audit trail and a recovery path from mistaken restore.

Consequence:

- `createSafetyCheckpoint` should default to true.
- API may reject `createSafetyCheckpoint: false` outside tests or internal
  maintenance flows.
- The response should include the safety checkpoint id.

## Contract plan

Add `packages/contracts/src/api/checkpoints.ts` or an equivalent project API
module. Keep it pure TypeScript.

Recommended types:

```ts
export type ProjectCheckpointKind =
  | 'before_run'
  | 'after_run_unfinalized'
  | 'after_message'
  | 'before_restore'
  | 'manual';

export type RollbackMode =
  | 'files_only'
  | 'chat_only'
  | 'files_and_chat';

export type RollbackConflictPolicy =
  | 'fail'
  | 'overwrite'
  | 'keep_current';

export interface ProjectCheckpointSummary {
  id: string;
  projectId: string;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  kind: ProjectCheckpointKind;
  createdAt: number;
  rootPathHash: string;
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
  restoreModes: RollbackMode[];
}

export interface ProjectCheckpointFileDelta {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'unchanged';
  fromHash?: string | null;
  toHash?: string | null;
  fromSize?: number | null;
  toSize?: number | null;
}

export interface ProjectCheckpointConflict {
  path: string;
  reason:
    | 'current_changed_since_checkpoint'
    | 'current_deleted_since_checkpoint'
    | 'target_path_blocked'
    | 'unsupported_file_type'
    | 'path_escapes_project';
  currentHash?: string | null;
  expectedHash?: string | null;
  targetHash?: string | null;
}

export interface ProjectCheckpointDiffResponse {
  checkpoint: ProjectCheckpointSummary;
  baseCheckpoint?: ProjectCheckpointSummary | null;
  files: ProjectCheckpointFileDelta[];
  conflicts: ProjectCheckpointConflict[];
}

export interface RollbackRequest {
  targetMessageId: string;
  targetCheckpointId?: string;
  mode: RollbackMode;
  conflictPolicy?: RollbackConflictPolicy;
  createSafetyCheckpoint?: boolean;
}

export interface RollbackResponse {
  projectId: string;
  conversationId: string;
  mode: RollbackMode;
  targetMessageId: string;
  restoredCheckpointId?: string | null;
  safetyCheckpointId?: string | null;
  deletedMessageIds: string[];
  clearedAgentSessions: boolean;
  fileChanges: {
    added: number;
    modified: number;
    deleted: number;
    unchanged: number;
  };
  conflicts: ProjectCheckpointConflict[];
}
```

Add exports from the relevant contracts barrel.

## Daemon storage plan

### SQLite tables

Add checkpoint metadata tables in `apps/daemon/src/db.ts`.

Suggested schema:

```sql
CREATE TABLE IF NOT EXISTS project_checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  root_path_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_checkpoints_project_time
  ON project_checkpoints(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_checkpoints_message_kind
  ON project_checkpoints(project_id, conversation_id, message_id, kind);

CREATE TABLE IF NOT EXISTS project_checkpoint_restores (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  conversation_id TEXT,
  target_message_id TEXT,
  target_checkpoint_id TEXT,
  safety_checkpoint_id TEXT,
  mode TEXT NOT NULL,
  conflict_policy TEXT NOT NULL,
  file_changes_json TEXT NOT NULL,
  deleted_message_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

Rationale:

- Checkpoint manifests can become large; store them as files, not DB rows.
- SQLite keeps listing, filtering, and audit cheap.
- `message_id` is nullable to support manual or pre-message fallback
  checkpoints.

### Manifest format

Suggested `manifest.json`:

```json
{
  "schemaVersion": 1,
  "checkpointId": "uuid",
  "projectId": "project-id",
  "conversationId": "conversation-id",
  "messageId": "assistant-message-id",
  "runId": "run-id",
  "kind": "after_message",
  "createdAt": 1781440000000,
  "rootPathHash": "sha256:...",
  "files": [
    {
      "path": "src/App.tsx",
      "kind": "file",
      "size": 1234,
      "mtimeMs": 1781440000000,
      "mode": 438,
      "hash": "sha256:...",
      "blob": "sha256/ab/abcdef..."
    }
  ],
  "excluded": [
    { "path": "node_modules", "reason": "ignored_dir" }
  ]
}
```

Do not store absolute project paths in manifests. Store a salted/root hash for
diagnostics without leaking local folder names into portable artifacts.

### Content hashing

Use Node `crypto.createHash('sha256')` for v1 unless there is already a strong
project preference for a faster hash. The daemon already targets Node 24, so
streaming SHA-256 is available without a new dependency.

If future performance requires BLAKE3, add it as a deliberate dependency with
benchmarks and lockfile/Nix hash handling.

## Snapshot scope plan

### Include

1. Visible project files returned by normal project file listing.
2. User-created hidden files only if explicitly allowed by policy.
3. `.live-artifacts` internal state because it is user-visible product state
   even though normal file APIs reserve it.
4. Artifact sidecars needed to render generated outputs.

### Exclude

Use the ignored directory set from `project-ignored-dirs.ts`:

- `.git`
- `node_modules`
- `vendor`
- `.readable-studio`
- `debug`
- `dist`
- `build`
- `.build`
- `deriveddata*`
- `target`
- `.next`
- `.nuxt`
- `.turbo`
- `.cache`
- `.output`
- `out`
- `coverage`
- `.gradle`
- `.swiftpm`
- `.tmp`
- virtualenv and Python cache dirs

Also exclude daemon-owned transient launch scaffolding:

- `.readable-studio-skills`
- daemon-created managed-project `.mcp.json`
- checkpoint temp files

Nuance for `.mcp.json`:

- In managed projects, the daemon writes `.mcp.json` for Claude external MCP
  injection, so it should be treated as transient.
- In external imported projects, a user-owned `.mcp.json` may be legitimate. Do
  not blanket-delete it without a policy check.

### Symlink policy

For v1:

- Record symlink entries as unsupported or metadata-only.
- Do not follow symlinked directories.
- Do not restore symlink targets outside the project root.
- If a checkpoint contains unsupported symlink entries, show them in the diff
  and exclude them from file restore.

## Capture flow

### Before run

Hook in `/api/runs` after:

1. request validation,
2. project lookup and sandbox availability checks,
3. `design.runs.create(meta)`,
4. `pinAssistantMessageOnRunCreate(db, run)`,

and before:

1. `reconcileAssistantMessageOnRunEnd(...)`,
2. plugin success hooks that observe run end,
3. `design.runs.start(run, () => startChatRun(meta, run))`.

Pseudo-flow:

```ts
const run = design.runs.create(meta);
pinAssistantMessageOnRunCreate(db, run);

if (run.projectId && run.conversationId && run.assistantMessageId) {
  await checkpoints.captureBeforeRun({
    projectId: run.projectId,
    conversationId: run.conversationId,
    messageId: run.assistantMessageId,
    runId: run.id,
  });
}

design.runs.start(run, () => startChatRun(meta, run));
```

If checkpoint capture fails:

- For v1 corporate safety, prefer failing run creation with a clear error unless
  the project is too large and checkpointing is configured as best effort.
- If best effort is allowed, the run response must surface
  `checkpointStatus: 'failed'` so the UI can warn that rollback is unavailable.

Recommendation:

- Default to fail-closed for managed Readable Studio projects.
- For external imported repositories over a size threshold, fail with actionable
  guidance or require an explicit "run without checkpoint" override.

### After run fallback

Hook after terminal run completion to create `after_run_unfinalized` if no
`after_message` exists.

Reason:

- CLI/headless/MCP callers may not send a web finalization PUT.
- Some failed/canceled runs still need a checkpoint for recovery or audit.

This checkpoint should be marked fallback/unfinalized so the UI can prefer
`after_message` when available.

### After message finalization

Hook in `PUT /api/projects/:id/conversations/:cid/messages/:mid`:

1. validate project/conversation ownership,
2. `upsertMessage`,
3. if request body has `telemetryFinalized === true`,
4. if saved message is assistant role,
5. if saved run state is terminal or content is otherwise finalized,
6. capture or refresh `after_message` checkpoint for this message.

Pseudo-flow:

```ts
const saved = upsertMessage(db, req.params.cid, { ...m, id: req.params.mid });

if (m.telemetryFinalized === true && saved.role === 'assistant') {
  await checkpoints.captureAfterMessage({
    projectId: req.params.id,
    conversationId: req.params.cid,
    messageId: saved.id,
    runId: saved.runId ?? null,
  });
}

ctx.telemetry?.reportFinalizedMessage(saved, m);
```

Keep checkpoint capture independent from telemetry. The existing flag can be
reused as a finalization signal, but rollback must not depend on telemetry being
enabled.

## Restore flow

### Preconditions

Before restore:

1. Project exists.
2. Conversation exists and belongs to project.
3. Target message exists and belongs to conversation.
4. Target checkpoint exists and belongs to project/conversation/message, unless
   `chat_only`.
5. No active run is mutating the same project/conversation, or the caller passes
   an explicit cancel-and-restore option.
6. No active live-artifact refresh is mutating checkpointed live artifact state.
7. If external `baseDir`, root must still exist and pass sandbox/import checks.

### Conflict model

Compute three manifests:

1. `target`: files at selected checkpoint.
2. `current`: files at restore time.
3. `baseline`: the checkpoint that represents the state immediately before
   changes being undone, when available.

Conflict examples:

- A file changed in current state but is not part of the checkpoint lineage.
- A file was deleted manually after the selected checkpoint.
- A path is now blocked by a directory/file type mismatch.
- A restore would write a reserved or escaping path.
- A symlink or special file cannot be restored safely.

Default conflict policy:

```ts
conflictPolicy: 'fail'
```

Other policies:

- `overwrite`: restore target bytes even if current changed.
- `keep_current`: skip conflicted paths and restore non-conflicted paths.

The UI should default to fail and make overwrite a deliberate confirmation.

### Files restore

For `files_only` and `files_and_chat`:

1. Acquire project checkpoint/restore lock.
2. Create `before_restore` safety checkpoint.
3. Recompute current manifest.
4. Detect conflicts.
5. If conflicts and policy is `fail`, return `409`.
6. For every target file:
   - verify normalized path,
   - verify destination stays inside project root,
   - create parent directories,
   - write temp file in the destination directory,
   - rename temp file into place.
7. For every file present in current but absent from target and within snapshot
   scope:
   - delete only that file,
   - never recursive-delete project root,
   - remove empty directories after file deletes.
8. Refresh project watchers/events.

Windows notes:

- Avoid shelling out for file moves/deletes.
- Use Node fs APIs with already-resolved absolute paths.
- Do not compose path deletion commands across PowerShell/cmd.
- Long paths and case-insensitive collisions need dedicated tests.

### Chat restore

For `chat_only` and `files_and_chat`:

1. Load ordered messages by conversation.
2. Find target message position.
3. Delete messages with `position > target.position`.
4. Preserve the target message itself.
5. Update conversation `updated_at`.
6. Clear all `agent_sessions` rows for that conversation.
7. Handle preview comments:
   - v1 preferred: mark comments created after target message time as stale or
     delete them if they belong to removed messages.
   - if no direct message association exists, use `created_at > target.createdAt`
     as a conservative cutoff and include count in response.

Do not delete the conversation row unless the user explicitly deletes the
conversation.

### Combined restore ordering

For `files_and_chat`, use this order:

1. Lock project/conversation.
2. Create safety checkpoint.
3. Validate target checkpoint and target message.
4. Detect conflicts.
5. Restore files.
6. Prune chat.
7. Clear agent sessions.
8. Refresh project state.
9. Return summary.

Reason:

- If file restore fails, chat should remain intact.
- If chat prune fails after files restore, safety checkpoint still allows
  recovery and the restore audit row captures partial failure.

## Locking and concurrency

Use a daemon in-memory project lock for v1:

```ts
withProjectCheckpointLock(projectId, async () => {
  // capture or restore
});
```

Rationale:

- The daemon is currently a single local process.
- It prevents two Readable Studio runs/restores from racing within the same process.

Future hardening:

- Add file locks under `READABLE_DATA_DIR/checkpoints/locks` if multiple daemon
  processes can operate on the same data dir.

Active run behavior:

- The restore endpoint should reject with `409 ACTIVE_RUN` if any non-terminal
  run for the project/conversation is active.
- The UI can offer "Cancel run and rollback" later, but v1 should require the
  run to be stopped first.

Parallel external agents:

- Readable Studio can only coordinate Readable Studio-owned runs. If another editor or
  shell modifies files concurrently, conflict detection should catch hash
  mismatches and fail by default.

## API surface

Add project checkpoint routes under the project domain.

```http
GET /api/projects/:id/checkpoints?conversationId=:cid
GET /api/projects/:id/checkpoints/:checkpointId
GET /api/projects/:id/checkpoints/:checkpointId/diff?base=current
POST /api/projects/:id/conversations/:cid/rollback
```

`GET /checkpoints` response:

```ts
{
  checkpoints: ProjectCheckpointSummary[];
}
```

`GET /diff` response:

```ts
ProjectCheckpointDiffResponse
```

`POST /rollback` request:

```json
{
  "targetMessageId": "assistant-message-id",
  "targetCheckpointId": "checkpoint-id",
  "mode": "files_and_chat",
  "conflictPolicy": "fail",
  "createSafetyCheckpoint": true
}
```

`POST /rollback` success response:

```ts
RollbackResponse
```

`POST /rollback` conflict response:

```json
{
  "error": {
    "code": "ROLLBACK_CONFLICT",
    "message": "Rollback has file conflicts.",
    "conflicts": []
  }
}
```

## CLI surface

Extend `apps/daemon/src/cli.ts` because `AGENTS.md` requires CLI parity.

Recommended commands:

```text
readable chat checkpoints --project <projectId> --conversation <conversationId> [--json]
readable chat checkpoint diff --project <projectId> --checkpoint <checkpointId> [--json]
readable chat rollback --project <projectId> --conversation <conversationId> --message <messageId>
                 [--checkpoint <checkpointId>]
                 [--mode files-only|chat-only|files-and-chat]
                 [--conflict-policy fail|overwrite|keep-current]
                 [--json]
```

CLI behavior:

- Default mode should be `files-and-chat` only if explicitly accepted by product.
  Safer default is to require `--mode`.
- For non-json mode, print target checkpoint, safety checkpoint, counts, and
  next recovery command.
- For `--json`, emit the raw API response.
- Do not access checkpoint files or SQLite directly from CLI.

## Web UI plan

### Entry point

Add a rollback action near the existing Fork action in the assistant message
footer.

Constraints:

- Reuse existing app primitives and icon patterns.
- Add i18n keys to all locale files if UI labels are introduced.
- Keep the action hidden or disabled while the message/run is still streaming.
- Only show rollback for messages with an available checkpoint, or show it with
  a disabled tooltip explaining that no checkpoint exists.

### Modal

The rollback modal should show:

1. Target message timestamp and model/agent label.
2. Restore mode segmented control:
   - Files only
   - Chat only
   - Files and chat
3. File diff summary:
   - added count,
   - modified count,
   - deleted count,
   - conflicts count.
4. Expandable file list for affected files.
5. Safety checkpoint notice.
6. Conflict policy selector only when conflicts exist.
7. Confirm button with destructive wording for combined/chat modes.

Do not present this as a marketing or explanatory panel. It is an operational
control for a work-focused app.

### After success

After rollback succeeds:

1. Refresh messages for the active conversation.
2. Refresh project files.
3. Refresh tabs/open files and close missing files gracefully.
4. Refresh preview comments.
5. Clear active artifact preview if its file disappeared.
6. Show a concise toast with safety checkpoint id or "Restore point created".

### Empty/missing states

- If target message has no checkpoint, offer chat-only rollback if possible.
- If checkpoint files are missing/corrupt, show an error and do not prune chat.
- If conflicts exist, show conflict list and default to cancel.

## Service/module plan

Add a daemon module such as:

```text
apps/daemon/src/project-checkpoints.ts
```

Responsibilities:

- Resolve project root through existing helpers.
- Walk snapshot scope.
- Hash files and write blobs.
- Write manifests atomically.
- Insert/list checkpoint metadata.
- Compute diffs.
- Detect conflicts.
- Restore files.
- Create safety checkpoints.
- Prune chat through DB helpers passed in from routes.
- Emit project refresh events if existing event bus is available.

Do not put the entire implementation into `server.ts`.

Add or extend DB helpers:

```ts
insertProjectCheckpoint(...)
listProjectCheckpoints(...)
getProjectCheckpoint(...)
insertProjectCheckpointRestore(...)
deleteMessagesAfterPosition(...)
clearAgentSessionsForConversation(...)
markPreviewCommentsStaleAfter(...)
```

## Performance plan

Potential costs:

- Full-tree snapshots can be expensive on large imported repositories.
- Hashing many files on every turn can increase latency before agent start.
- Content-addressed storage can grow if users generate many binaries.

Mitigations:

1. Use ignored dirs aggressively.
2. Stream file hashing and blob writing.
3. Deduplicate blobs by hash.
4. Put size limits in app config:
   - max file size per checkpoint,
   - max total checkpoint bytes per project,
   - max checkpoint count or age.
5. If a project exceeds limits, fail run creation with a clear reason or require
   a deliberate "run without checkpoint" override.
6. Consider incremental manifests later, but v1 should optimize correctness
   before clever deltas.

Recommended default retention:

- Keep all checkpoints for active conversations up to a project byte cap.
- Keep safety checkpoints for at least 7 days.
- Garbage collect orphaned blobs after metadata deletion.

Garbage collection must be conservative:

- Never delete blobs referenced by any manifest.
- Use mark-and-sweep from SQLite checkpoint rows to manifest blob refs.
- Write GC tests before enabling automatic deletion.

## Security and corporate controls

The checkpoint system touches potentially proprietary source code, so the
security posture must be explicit.

Requirements:

1. Store checkpoints locally under `READABLE_DATA_DIR`.
2. Do not upload checkpoint contents.
3. Do not include absolute local paths in manifests.
4. Do not snapshot ignored secret-heavy directories like `.git`, `.readable-studio`, and
   `.tmp`.
5. Do not follow symlinks outside root.
6. Provide a setting to disable checkpoints for sensitive projects if corporate
   policy requires it.
7. Provide a cleanup command or UI action to delete checkpoints for a project.

Audit:

- `project_checkpoint_restores` should record every restore action.
- The UI should display the last restore time and safety checkpoint id when
  relevant.
- CLI JSON output should be machine-readable for compliance logs.

## Failure behavior

Checkpoint capture failure before run:

- Default: fail run creation and tell the user rollback safety could not be
  established.
- Optional later: allow explicit run-without-checkpoint override.

After-message checkpoint failure:

- Do not corrupt message persistence.
- Return success for message save only if product accepts best effort; otherwise
  return an error that the UI can surface.
- Preferred v1: message save succeeds, checkpoint warning is logged and surfaced
  through a checkpoint-status endpoint, because blocking final message
  persistence can lose chat data.

Restore failure before file writes:

- Return error, no state changed.

Restore failure during file writes:

- Return partial failure with safety checkpoint id.
- Do not prune chat if file restore did not complete.
- Leave restore audit row with failure metadata.

Restore failure during chat prune after successful file restore:

- Return partial failure with safety checkpoint id.
- User can restore safety checkpoint or retry chat prune.

Manifest corruption:

- Treat as unavailable checkpoint.
- Do not restore.
- Surface repair/delete option later.

## Testing plan

### Daemon unit tests

Add tests under `apps/daemon/tests/`.

Core checkpoint tests:

1. Captures a manifest with file hashes and blobs.
2. Deduplicates repeated file content blobs.
3. Excludes ignored dirs.
4. Includes `.live-artifacts`.
5. Does not follow symlinked dirs.
6. Rejects path traversal and root escape paths.
7. Restores modified files.
8. Restores deleted files.
9. Deletes files added after target checkpoint.
10. Creates a `before_restore` safety checkpoint before writing.
11. Returns conflicts when current files changed after checkpoint.
12. `keep_current` skips conflicted paths and restores non-conflicted paths.
13. `overwrite` restores despite conflicts.
14. Windows case-insensitive path collision behavior is deterministic.

DB tests:

1. Inserts and lists project checkpoints by project/conversation.
2. Associates checkpoints with message ids and run ids.
3. Deletes checkpoint metadata on project delete if using cascade.
4. Deletes messages after a target position.
5. Clears all agent sessions for a conversation.
6. Records restore audit rows.

Route tests:

1. `GET /api/projects/:id/checkpoints` requires a valid project.
2. `GET /diff` returns added/modified/deleted counts.
3. `POST /rollback` rejects missing target message.
4. `POST /rollback` rejects checkpoint from another project.
5. `POST /rollback` rejects active run.
6. `POST /rollback` restores files and chat together.
7. `POST /rollback` in `chat_only` mode does not touch files.
8. `POST /rollback` in `files_only` mode does not delete messages.
9. Finalized message PUT creates or refreshes `after_message`.
10. Run-end fallback creates `after_run_unfinalized` for headless runs.

### Web tests

Add focused tests under `apps/web/tests/`.

1. Assistant footer renders rollback action for checkpointed assistant messages.
2. Rollback action is disabled while streaming.
3. Modal loads diff and displays counts.
4. Confirm sends the selected restore mode and conflict policy.
5. Conflict response renders conflicted file list.
6. Success refreshes messages and project files.
7. Chat-only restore prunes later messages in UI state.
8. Missing checkpoint offers chat-only path or shows unavailable state.

### CLI tests

Add CLI tests under `apps/daemon/tests/` if the current CLI test pattern lives
there.

1. `readable chat checkpoints --json` prints API JSON.
2. `readable chat checkpoint diff --json` prints API JSON.
3. `readable chat rollback --mode files-and-chat --json` calls rollback endpoint.
4. Non-json output includes restored checkpoint and safety checkpoint.
5. HTTP conflict maps to a non-zero exit and structured JSON when `--json`.

### Integration/e2e tests

Add e2e only if unit/route tests cannot observe the behavior.

High-value scenario:

1. Create project.
2. Send prompt that creates file A.
3. Send prompt that modifies A and creates B.
4. Roll back to first assistant message with files and chat.
5. Verify A content is restored, B is gone, later messages are gone, and a
   safety checkpoint exists.

## Validation commands

After implementation:

```bash
pnpm --filter @readable-studio/contracts typecheck
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/web test
pnpm guard
pnpm typecheck
```

If package manifests or lockfile change:

```bash
pnpm install
```

If agent stream/parser behavior changes unexpectedly:

```bash
export PATH="$PWD/mocks/bin:$PATH" READABLE_MOCKS_TRACE=<trace> READABLE_MOCKS_NO_DELAY=1
```

Then replay relevant mock CLI traces per `mocks/README.md`.

## Implementation order

### Phase 0: red specs and fixtures

1. Add daemon tests for file snapshot and restore behavior.
2. Add route tests for rollback mode behavior.
3. Add a test proving finalized-message capture includes files created by web
   artifact persistence.
4. Add agent-session clearing test.

Exit criteria:

- Tests fail for missing checkpoint/rollback behavior.
- No production code changed yet except test fixtures.

### Phase 1: contracts

1. Add checkpoint DTOs.
2. Export DTOs from contracts.
3. Add type-only tests if the package uses them.

Exit criteria:

- `pnpm --filter @readable-studio/contracts typecheck` passes.

### Phase 2: daemon checkpoint service

1. Add manifest/blob writer.
2. Add manifest reader and validator.
3. Add snapshot walker with include/exclude policy.
4. Add diff and conflict detector.
5. Add restore engine.
6. Add project lock.

Exit criteria:

- Daemon unit tests for service behavior pass.

### Phase 3: DB metadata and route APIs

1. Add SQLite tables and helpers.
2. Add list/diff/rollback routes.
3. Add message pruning helper.
4. Add agent session clearing helper.
5. Add restore audit rows.

Exit criteria:

- Route tests pass.

### Phase 4: capture hooks

1. Add `before_run` capture in `/api/runs`.
2. Add `after_run_unfinalized` fallback.
3. Add `after_message` capture in finalized message PUT.
4. Make capture failures visible.

Exit criteria:

- Headless run creates checkpoints.
- Web finalized message creates final checkpoint after artifact persistence.

### Phase 5: CLI parity

1. Add `readable chat checkpoints`.
2. Add `readable chat checkpoint diff`.
3. Add `readable chat rollback`.
4. Add JSON and human output.

Exit criteria:

- CLI tests pass and all commands call daemon endpoints.

### Phase 6: web UI

1. Add provider/state helpers for checkpoints and rollback.
2. Add rollback action to assistant footer.
3. Add rollback modal.
4. Add refresh behavior after success.
5. Add all required i18n keys in every locale.

Exit criteria:

- Web tests pass.
- Manual UI check confirms no overlapping controls and clear destructive action
  wording.

### Phase 7: retention and cleanup

1. Add project checkpoint cleanup helper.
2. Add conservative blob GC.
3. Add settings/config if retention is configurable.
4. Add CLI/UI cleanup only if product wants it in v1.

Exit criteria:

- GC cannot delete referenced blobs.
- Checkpoint store does not grow unbounded in normal use.

## Acceptance criteria

1. A selected previous assistant message can be restored in files-only mode.
2. A selected previous assistant message can be restored in chat-only mode.
3. A selected previous assistant message can be restored in files-and-chat mode.
4. Every file restore creates a safety checkpoint first.
5. Restore does not touch `.git`.
6. Restore includes `.live-artifacts` state.
7. Restore clears `agent_sessions` when chat is pruned.
8. Restore refuses active runs by default.
9. Restore returns conflicts instead of silently overwriting external changes.
10. UI and CLI use the same daemon endpoints.
11. Contracts remain pure TypeScript.
12. No route implementation is added to `server.ts` except the unavoidable run
    capture hook.
13. Tests cover capture, restore, conflict, chat pruning, session clearing, CLI,
    and UI entry points.

## Open questions

1. Should checkpointing be mandatory for every run, or can users explicitly run
   without checkpointing when a project is too large?
   - Recommendation: mandatory by default, explicit override only after a clear
     warning.
2. Should `files_and_chat` be the default restore mode?
   - Recommendation: require explicit selection in the first UI version.
3. Should preview comments after the target be deleted or marked stale?
   - Recommendation: mark stale if a status exists or can be added cheaply;
     otherwise delete after target timestamp and report count.
4. Should manual named checkpoints ship in v1?
   - Recommendation: include storage support for `manual`, but ship UI only if
     it does not delay selected-message rollback.
5. Should file restore preserve executable bits and mtimes?
   - Recommendation: preserve executable bits where supported; do not rely on
     mtime for correctness.
6. Should checkpoint manifests include binary files?
   - Recommendation: yes up to a size cap, because generated assets can be
     binary. Show skipped oversized files before restore.

## Reviewer checklist

Use this checklist when reviewing the implementation PR.

1. Does every restore path create a safety checkpoint before writes?
2. Are all file writes path-normalized and constrained to the project root?
3. Does restore avoid `.git`, dependency dirs, build dirs, and daemon runtime
   dirs?
4. Does restore include `.live-artifacts` or explicitly document why not?
5. Does chat rollback clear `agent_sessions`?
6. Does the UI refuse rollback during active streaming/runs?
7. Does the CLI call daemon endpoints rather than local files/SQLite?
8. Are contract types in `packages/contracts` pure TypeScript?
9. Are all new UI strings present in every locale?
10. Do tests cover conflict handling and external changes?
11. Are checkpoint blobs garbage-collected only when unreferenced?
12. Does rollback work for imported external projects without creating roots or
    writing outside the selected baseDir?

## Verification performed for this plan

1. Confirmed no deeper `AGENTS.md` governs `specs/current`.
2. Confirmed project run creation, assistant message pinning, event persistence,
   and child process spawn locations in `apps/daemon/src/server.ts`.
3. Confirmed primary web chat finalizes produced files after optional artifact
   persistence in `apps/web/src/components/ProjectView.tsx`.
4. Confirmed message finalization reaches daemon project routes through
   `PUT /api/projects/:id/conversations/:cid/messages/:mid`.
5. Confirmed durable chat/message/session tables exist in `apps/daemon/src/db.ts`.
6. Confirmed resumable upstream session behavior for Claude in
   `apps/daemon/src/agent-session-resume.ts` and
   `apps/daemon/src/runtimes/defs/claude.ts`.
7. Confirmed project root and ignored-directory helpers in
   `apps/daemon/src/projects.ts` and `apps/daemon/src/project-ignored-dirs.ts`.
8. Confirmed live artifacts are stored under `.live-artifacts`.
9. Re-checked external checkpoint documentation for VS Code, Claude Code, Cline,
   Aider, Gemini CLI, and Devin Desktop/Cascade on 2026-06-14.
