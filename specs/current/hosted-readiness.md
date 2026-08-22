# Hosted readiness contract (Issue #63)

Status: final evidence candidate `2c184451` passed exact required checks in
[workflow run 31204885460](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31204885460)
for [PR #67](https://github.com/sanghyunna/readable-studio-sandboxed/pull/67). PR11
is frozen at `8491375b`; its exact Windows, Linux, and Nix checks passed in
[workflow run 31197265316](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31197265316).
No Databricks capacity claim is in scope.

This document is the executable review contract for the local hosted composition in
issue #63. It does not describe Databricks Apps, Databricks identity, Unity Catalog,
Gateway production connectivity, or production capacity.

## Composition boundary

- Local and desktop continue through `startServer()`.
- Production hosted starts through a separate `startHostedServer()` and must not
  import `server.ts` or initialize the local database, uploads, artifacts, paths,
  event registries, app config, plugins, templates, MCP, OAuth, terminals, updater,
  media, or native operating-system capabilities.
- Hosted dispatch is terminal. A rejected method, path, request shape, identity, or
  sub-app response cannot call a local handler or the SPA fallback.
- Test identities exist only in an injected test-server composition. Production
  startup without a production identity adapter returns unavailable and activates
  no hosted data route.

## Identity and storage namespace

The production identity adapter validates its credential and returns one canonical
opaque `userKey` (1-1,024 UTF-8 bytes) from its trusted issuer/subject namespace.
The daemon treats those exact adapter-output bytes as authority and never parses or
reconstructs issuer/subject itself. Display name, email, unverified assertion
headers, cookies interpreted by application code, request body, query, path, and
client-provided owner fields are never authority.

The daemon alone derives the storage namespace:

```text
storageKey = "od1_" + lowercaseHex(sha256(utf8(userKey)))
```

The runtime registry maintains both `userKey -> storageKey` and
`storageKey -> userKey` bindings for the process lifetime. Either direction changing
is a fatal collision. Every live and snapshot root has a server-written identity
marker containing the exact canonical `userKey`, `storageKey`, and derivation
version `1`; it must match before state is opened. The hash supplies a path-safe
name, while the reverse binding and marker make a collision fail closed.

## Hosted web topology

- Hosted uses a distinct Next standalone build, never the default production static
  export.
- The build serializes `<html data-readable-composition="hosted">`; the marker therefore
  exists before the layout theme script and React hydration. It is composition
  metadata, not authentication.
- One public web sidecar origin serves the browser. It proxies only the exact `/api`
  prefix to loopback `startHostedServer`; `/artifacts` and `/frames` terminate with
  `404` at that sidecar, and all other paths go to the hidden Next listener. Hosted
  catalogue/prompt adapters remove local `/frames` references before exposure.
- The sidecar forwards a strict allowlist of non-authority request headers and at
  most one supported credential carrier. A valid CLI `Authorization: Bearer` value
  takes precedence; otherwise only the browser's Secure/HttpOnly/SameSite
  `__Host-readable-hosted` cookie is forwarded. The single path-scoped, cryptographic
  `odpvb_*` preview proof may accompany it; every other cookie is removed. All
  assertion-like and undeclared headers are dropped. The selected carrier is
  cryptographically verified before it can yield a `userKey`. The sidecar then sets
  `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Forwarded-Port` from the configured
  public-origin URL and `X-Forwarded-For` from the direct socket peer. It preserves
  the browser's `Origin` value, while the hosted dispatcher compares its canonical
  URL origin exactly with the configured public origin. Identity comes only from the
  adapter's verified credential, never from a forwarded header. The local loopback
  Origin rewrite is forbidden.
- Before hydration, hosted theme/config code applies fixed defaults without reading
  `readable-studio:config`. Hosted config persistence is an allowlist of non-secret UI
  preferences. Provider drafts remain component memory only.
- Hosted boot does not start local app-config sync, local agent discovery, AMR/Vela
  polling, MCP/OAuth, plugin/template administration, notification service workers,
  or critique-theater config access.

## Activation matrix

Every route not listed below is permanently denied. A route becomes reachable only
at the named boundary and only through its hosted adapter. `/health`, `/ready`, and
`/version` are not aliases; only `/api/*` probes exist.

| Boundary | Methods and paths |
| --- | --- |
| C2 / PR03 | `GET /api/health`, `GET /api/ready`, `GET /api/version` |
| PR04 | `GET /api/hosted/session`; `GET /api/hosted/provider`; `PUT /api/hosted/provider`; `POST /api/hosted/provider/test`; `DELETE /api/hosted/provider` |
| PR07 metadata | `GET,POST /api/projects`; `GET,PATCH,DELETE /api/projects/:id`; `GET /api/projects/:id/events`; `GET,POST /api/projects/:id/conversations`; `PATCH,DELETE /api/projects/:id/conversations/:cid`; `GET /api/projects/:id/conversations/:cid/messages`; `PUT /api/projects/:id/conversations/:cid/messages/:mid`; `GET,POST /api/projects/:id/conversations/:cid/comments`; `GET,PUT /api/projects/:id/tabs`; `GET /api/projects/:id/checkpoints`; `GET /api/projects/:id/checkpoints/:checkpointId`; `GET /api/projects/:id/checkpoints/:checkpointId/diff` |
| PR07 execution | `GET,POST /api/runs`; `GET /api/runs/:id`; `GET /api/runs/:id/events`; `POST /api/runs/:id/cancel`; `POST /api/runs/:id/feedback`; `GET /api/runs/:id/agui`; `GET /api/runs/:id/genui`; `GET /api/projects/:projectId/genui`; `GET /api/runs/:runId/genui/:surfaceId`; `POST /api/runs/:runId/genui/:surfaceId/respond`; `POST /api/projects/:projectId/genui/:surfaceId/revoke`; `POST /api/chat` |
| PR07 fixed catalogues/tools | `GET /api/agents/catalog`; `GET /api/skills`; `GET /api/skills/:id`; `GET /api/skills/:id/files`; `GET /api/design-systems`; `GET /api/design-systems/:id`; `POST /api/tools/design-systems/read` |
| PR08 content | `GET /api/projects/:id/files`; `GET /api/projects/:id/files/*`; `POST /api/projects/:id/files`; `POST /api/projects/:id/files/rename`; `DELETE /api/projects/:id/files/*`; `GET /api/projects/:id/search`; `GET,POST,DELETE /api/projects/:id/folders`; `POST /api/projects/:id/upload`; `POST /api/projects/:id/files/preview`; `POST /api/projects/:id/preview-url`; `GET /api/projects/:id/preview/*`; `GET /api/projects/:id/archive`; `GET /api/projects/:id/export/manifest`; `POST /api/artifacts/save`; `POST /api/artifacts/lint`; `GET /api/artifacts/:artifactId/download` |

Archive intake/batch, raw project/artifact routes, comment update/delete, plugin/
design-system/inline standalone export, working directories, project locations,
plugin/template snapshots, local skills/design systems, finalize, deployment,
handoff, media, research, social share, and every local administration route remain
denied.

Hosted UI removes comment resolve/edit/delete actions because their local
`PATCH/DELETE` routes remain denied; comment creation and read stay available.

## Request-shape authority

Browser and CLI session-authority unsafe methods require the hosted Origin and a nonce from
`GET /api/hosted/session`. The nonce is session-bound, memory-only, constant-time
checked, rotated after authentication changes, and never accepted from query/path.
The broker-only `POST /api/tools/design-systems/read` accepts neither browser cookies
nor that nonce: it requires the server-minted user/run/project/endpoint-bound broker
grant and rejects browser or unauthenticated invocation before request parsing.
`requestId` is generated by the hosted dispatcher for diagnostics and is never read
from a client header, query, path, or body.

`GET /api/hosted/session` returns the configured public origin, a 10-minute nonce,
its expiry, and no identity data. Browser requests bind that nonce to the verified
`__Host-readable-hosted` session; the CLI supplies its verified bearer credential from
`--identity-token-file <path|->` or `READABLE_HOSTED_IDENTITY_TOKEN_FILE` (never plaintext
argv or persistent config). The shared web/CLI request helper sends unsafe requests
with the exact returned origin in `Origin` and the nonce in
`X-Readable-Studio-CSRF`. On one `401` or `419`, it refreshes the hosted session and
retries once with the identical normalized body and `clientRequestId`. CLI base URL
and returned public origin must have equal canonical origins; redirects to another
origin are rejected.

The PR04 provider contract is closed and versionless because its only accepted
catalogue is shipped with the pinned Pi runtime. Provider IDs are `anthropic` and
`vercel-ai-gateway`. Anthropic uses model `claude-sonnet-4-5-20250929`, base URL
`https://api.anthropic.com`, and child variable `ANTHROPIC_API_KEY`. Vercel AI
Gateway uses model `anthropic/claude-sonnet-4.5`, base URL
`https://ai-gateway.vercel.sh`, and child variable `AI_GATEWAY_API_KEY`. The client
cannot submit a model, base URL, protocol, header, or environment name.

`HostedSessionResponse` is `{publicOrigin,csrfToken,csrfExpiresAt,providers}` where
`csrfExpiresAt` is epoch milliseconds and each provider descriptor is `{id,model}`.
Provider GET returns `{provider,configured}`. PUT accepts exactly `{provider,key}`
and returns `{result:'set',provider,configured:true}`. Test accepts exactly
`{provider}` and returns `{result:'passed',provider,model}`. DELETE accepts no body
and returns `{result:'cleared',provider:null,configured:false}`. The nonce header is
exactly `X-Readable-Studio-CSRF`. Provider key files and stdin remove exactly one final
LF or CRLF; all other bytes, including spaces, are preserved. Empty, NUL-containing,
line-broken, or greater-than-16-KiB secrets are rejected and no response contains a
secret or reversible derivative.

Common rejected fields at any authority-bearing location include `owner`, `userId`,
`userKey`, `storageKey`, `tenant`, `namespace`, filesystem/base/root/location paths,
provider base URL/headers/environment/executable, plugin/template identifiers or
snapshots, client tool bundles, local agent/config fields, and absolute paths.
Opaque user-authored document/GenUI content may contain ordinary words such as
`owner`; only schema-declared authority locations are rejected.

- Project create accepts hosted project kind/title and repository-owned catalogue
  selections only. External locations and snapshots are rejected.
- Run/chat accepts owned project/conversation/message identifiers, prompt content,
  the mandatory retry key, and closed server-owned model/provider selections. Tools,
  roots, system prompts, environments, and provider endpoints are server-owned.
- Catalogue routes expose repository-owned immutable entries only.
- Content routes accept root-relative names only and return opaque identifiers, never
  `resolvedDir`, `eventsLogPath`, absolute artifact paths, or raw file-system URLs.

## Route dependency and request-shape audit

This table is exhaustive by activation-matrix family. Every path parameter is a
bounded safe ID resolved inside the authenticated runtime; every unlisted query/body
field is rejected before adapter code. `S` is a generation-bound strong lease, `W`
is a weak stream lease, and `L` is the one per-user FIFO mutation lane.

| Route family | Hosted adapter and server-owned dependencies | Accepted request shape and authority | Lease/lane and acknowledgement | Response exposure |
| --- | --- | --- | --- | --- |
| `/api/health`, `/api/ready`, `/api/version` | `hostedProbeAdapter`; build/readiness state only | no params, query, or body; no user identity | none; read-only | fixed status/version, no paths |
| hosted session/provider | `hostedProviderAdapter`; identity, registry, closed provider catalogue, credential slot | session GET has no input; provider GET has no input; PUT accepts `{provider,key}`; test accepts `{provider}`; DELETE has no body; Origin + nonce; `requestId` ignored/rejected as input | reads `S`; mutations `S+L`; set/clear/rotation responds while the lease is held and only after any old-key child settles; secret is never snapshotted | provider/status/error enum only, never key/endpoint/env |
| project/conversation/message/comment/tab mutation | `hostedMetadataAdapter`; owned DB/project/checkpoint services | path IDs plus the closed V1 DTOs below; no external location/plugin/template/root fields; Origin + nonce | `S+L`; before PR09 local completion, from PR09 complete snapshot before response | owned DTOs with opaque IDs, no resolved paths |
| project/conversation/message/comment/tab/checkpoint read | `hostedMetadataAdapter`; same owned services | owned path IDs; checkpoint list alone accepts `conversationId`; checkpoint diff alone accepts `base=current`; no other query/body | `S`; read-only | owned rows only; event paths stripped |
| project event SSE | `hostedProjectEventAdapter`; owned event journal | project ID plus bounded owned `Last-Event-ID`; identity at connect; no query/body | establish with `S`, retain `W`; no lane | owner-filtered events/heartbeat only; typed resync on expired generation/cursor |
| run/chat create | `hostedRunAdapter`; worker, owned DB/checkpoint/session map, fixed agent/model catalogue | the versioned run-intent fields listed below plus `clientRequestId`; system prompt, tools, roots, plugin snapshots, provider endpoint/env and owner fields rejected; Origin + nonce | `S+L` through child settle/exit; PR09 accepted snapshot before `202`, chat headers, created event, or first SSE byte | stable owned run/conversation/message IDs only |
| run/status/AGUI/GenUI read | `hostedRunAdapter`; owned run registry/journal/DB | owned path IDs; run list alone accepts owned `projectId`, owned `conversationId`, and `status=queued\|running\|succeeded\|failed\|canceled`; no other query/body | `S`; read-only | owner-filtered status/surface DTOs, no grants or paths |
| run event/chat SSE | `hostedRunEventAdapter`; owned bounded journal | owned run ID and bounded owned `Last-Event-ID`, or validated run-intent for chat; identity and Origin/nonce for chat POST | establish with `S+L` for chat then retain `W`; plain event GET retains `W` | owner-filtered events/heartbeat; generation cursor or typed resync |
| cancel/feedback/GenUI mutation | `hostedRunMutationAdapter`; generation-bound child control, owned DB/journal | cancel/revoke have no body; feedback uses `ChatRunFeedbackRequest`; surface response uses `HostedGenUiRespondV1`; Origin + nonce | `S+L`; cancel waits for reconciliation; PR09 snapshot before success | fixed result/status DTOs, no child handles/grants |
| fixed catalogues | `hostedCatalogueAdapter`; immutable repository-owned snapshots with local-only entries and `/frames` references removed | path catalogue ID only; no query/body; identity | no runtime lease; read-only | curated immutable DTOs, no filesystem source paths |
| design-system broker read | `hostedDesignSystemToolAdapter`; immutable catalogue and server-minted broker grant | `HostedDesignSystemReadV1`; valid user/run/project/endpoint grant; no Origin/nonce, cookies, owner, root, or client grant fields | generation-bound internal `S`; no lane because immutable | bounded content DTO, no source path or grant |
| Pi project-file broker | turn-scoped `hostedPiBroker`; owned root identity and directory snapshot | child-env socket/token carrier only; `project:file:list/read/write`, canonical relative path at most 1,024 bytes, UTF-8 read/write at most 4 MiB, wire message at most 32 MiB; no client carrier or owner/root input | grant is bound to user/run/project/endpoints/operations/generation and held turn `L`; write is serialized and remains unacknowledged to the user until the PR09 terminal snapshot | bounded entries/content or typed broker error; never token/root |
| file/folder/upload/artifact mutation | `hostedContentAdapter`; owned root, quota ledger, artifact index | project ID plus canonical wildcard path; `HostedProjectFileWriteV1`, rename `{from,to}`, folder `{path}`, `HostedProjectUploadV1`, or `HostedArtifactSaveV1`; Origin + nonce | body reservation then `S+L`; PR09 snapshot before success | opaque file/artifact IDs and relative names only; artifact save returns `/api/artifacts/:artifactId/download` |
| file/search/preview/archive/download/lint | `hostedContentAdapter`; owned root, preview-scope registry, artifact index | files accepts integer `since` in `0..2^53-1`; search accepts `q` 1..4,096 bytes, optional `pattern` <=512 bytes, `max` 1..1,000 (default 200); file-preview POST `{path}` <=1,024 bytes; preview-url POST `{file}` <=1,024 bytes; archive alone accepts optional root-relative `root` <=1,024 bytes; lint POST `{html}` within JSON limit; other reads have no query/body; encoded separator/traversal rejected | ordinary reads `S`; preview mint atomically updates the bounded generation map under `S` without `L`; POSTs require Origin + nonce; archive/download retain `S` until their bounded stream closes | opaque preview/download URLs under `/api`; attachment headers, `nosniff`, no absolute/raw URL |

The PR08 web/CLI providers use the canonical raw wildcard path for nested deletion
and the file-preview POST DTO for nested preview; neither calls the local `/raw/*`
route nor encodes path separators into `:name`. Preview-scope mint is POST so a
cross-origin safe-method request cannot consume its quota.

The following request DTOs are closed: unknown keys are rejected and all referenced
IDs/relative paths are re-resolved as owned before use.

- `HostedProjectCreateV1`: required `title` (1..256 UTF-8 bytes); optional `kind`
  from the hosted enum and optional repository `catalogueId`; project ID is generated.
  `HostedProjectPatchV1` permits only optional `title` with the same bound.
- `HostedConversationCreateV1`: optional `title` (<=256 bytes), `sessionMode`
  (`design|chat`, default `design`), owned `seedFromConversationId`, and owned
  `forkAfterMessageId`; no client `seedMessages`. Patch permits only `title`.
- `HostedMessageUpsertV1`: required `role` (`user|assistant`) and `content` (<=1 MiB);
  optional safe `agentId`, up to 2,000 `PersistedAgentEvent` entries, owned `runId`,
  `runStatus`, boolean `resumable`, owned `lastRunEventId`, non-negative integer
  `startedAt`/`endedAt`, `sessionMode`, up to 12 owned attachment IDs, 100 owned
  comment IDs, 1,000 owned produced-file IDs, and boolean `telemetryFinalized`.
  Message ID comes only from the path; names, plugin snapshots, raw paths, feedback,
  and timestamps other than those listed are server-owned.
- Comment create is `PreviewCommentUpsertRequest`: `note` <=64 KiB, at most 12 owned
  attachments, target/member arrays <=100, each selector/label/text/html hint <=4 KiB,
  finite position numbers, and a canonical owned `filePath` <=1,024 bytes.
- `HostedTabsPutV1`: `tabs` is at most 100 relative names <=1,024 bytes, `active` is
  null or a member of `tabs`, and `browserTabs` is at most 100
  `ProjectBrowserWorkspaceTab` values with safe ID, labels/titles <=256 bytes, and
  URL/icon URL <=4,096 bytes; defaults are `[]`, `null`, and `[]`.
- Cancel and GenUI revoke accept no body. `ChatRunFeedbackRequest` requires owned
  project/conversation/assistant-message IDs, rating, at most eight allowlisted reason
  codes, boolean `hasCustomReason`, and `customReason` <=2 KiB.
  `HostedGenUiRespondV1` permits only JSON `value` <=64 KiB; `respondedBy` is always
  server-derived `user`. Hosted GenUI prefill and its plugin snapshot body stay denied.
- `HostedDesignSystemReadV1`: required manifest-declared `path` (1..1,024 bytes) and
  optional repository `designSystemId`; both must be within the grant's fixed catalogue.
- `HostedProjectFileWriteV1`: required relative `name` <=1,024 bytes and `content`
  whose decoded size is <=3 MiB; optional `encoding` (`utf8|base64`, default `utf8`),
  boolean `overwrite` (default `true`), and 64-hex `expectedContentSha256`.
  `HostedProjectUploadV1` is multipart with optional relative `dir` <=1,024 bytes and
  exactly 1..12 `files` parts; no other fields. `HostedArtifactSaveV1` permits optional
  `identifier`/`title` <=256 bytes and required `html` <=3 MiB; the server generates
  the opaque artifact ID. Lint accepts only the same bounded `html` field.

The broker token and socket path exist only in the minimal turn-child environment,
never argv, HTTP, logs, persistence, or client state. A grant expires after 31
minutes and is revoked earlier on settle/child close, cancel, crash, timeout,
generation replacement, eviction, or shutdown; closing the broker removes the Unix
socket/named-pipe listener. A copied token fails unless every immutable binding and
live generation still match.

## Stable retry identity

`clientRequestId` is the hosted run retry key. It is mandatory, 1-128 ASCII
`[A-Za-z0-9_-]` characters, generated once by web/CLI before the first attempt, and
retained across transport errors until an authoritative response is received.

PR09 stores a narrow receipt keyed by `(userKey, clientRequestId)`. Its digest is the
lowercase hexadecimal SHA-256 of the RFC 8785 canonical JSON bytes of a
`hosted-run-intent-v1` object. Unknown fields are rejected first; accepted fields are
then ownership-validated and normalized. The fixed object contains `version` =
`hosted-run-intent-v1`, `routeKind` = `runs` or `chat`, canonical `projectId`,
`conversationId`, `assistantMessageId`, `agentId`, exact `message`, `currentPrompt`
(default: `message`), `sessionMode` (default: `design`), ordered `skillIds` (default:
`[]`), `designSystemId` (default: `null`), ordered opaque `attachmentIds` and
`commentAttachmentIds` (default: `[]`), closed `model` and `reasoning` (default:
`null`), `locale` (default: `en`), and owned `contextSelectionIds` (default: `[]`).
Strings are not case-folded or Unicode-normalized; ID canonicalization only replaces
an already validated owned reference with its stored opaque ID.
`clientRequestId`, display metadata, analytics hints, and server-derived user/root/
grant/provider authority are excluded. A contract field change requires a new digest
version. The same digest returns the existing run/result; a different digest returns
typed `409 RETRY_KEY_REUSED`. `requestId`, `assistantMessageId`, and an in-process
model retry are not acceptance retry keys. Web/CLI retains and resends the entire
normalized request, including `assistantMessageId`, unchanged until an authoritative
response; it does not generate a second message ID on response-loss retry.

## Mutation lane and acknowledgement boundaries

Every hosted mutation of SQLite, files, run/session state, credentials, or snapshots
uses the one per-user FIFO lane. Cancel/crash/timeout/shutdown may signal a
generation-bound active child outside the queue but cannot acknowledge success until
reconciliation re-enters the held lease/lane.

Before PR09, PR07/PR08 are review checkpoints only and explicitly not crash durable.
At PR09 and later, the following response boundaries occur only after a complete
authoritative snapshot:

| Mutation | Authoritative acknowledgement |
| --- | --- |
| project/conversation/message/comment/tab/file/folder/upload/artifact/GenUI/feedback | Before success status or JSON is written |
| checkpoint/snapshot publication | Database backup and referenced files validate, manifest/checksums are written, completion marker is written last, and only then the latest pointer and response advance |
| run creation | Before `/api/runs` returns `202`, `/api/chat` flushes headers, or any run-created event/first SSE byte is emitted |
| run terminal | Session file + DB session reference + message/run status + event journal, then terminal snapshot, then terminal SSE/end |
| cancel | Child settle/exit + session/run reconciliation + canceled/interrupted snapshot, then success; timeout returns typed failure |
| eviction/shutdown | Dirty runtime final snapshot before close; failure poisons the generation and cannot acknowledge work |

Credential set/clear/rotation is the explicit ephemeral exception to snapshot-before-
acknowledgement: it responds while the owning lane/lease is held and only after any
old-key child settles. Its response promises only current-process memory state;
restart clears it, and no secret or reversible derivative enters a snapshot.

No checkpoint, directory delete, artifact write, or finalization error may be swallowed
and followed by success in hosted mode.

Run-created, status-transition, terminal, and resync journal events are durable
milestones and are snapshotted before serialization. Token/tool progress events are
explicitly transient, do not acknowledge a mutation, and use a cursor containing the
persisted runtime generation plus an in-generation sequence. The accepted-run
snapshot reserves that generation, so restart cannot reuse an emitted cursor. After
restart, any cursor whose transient suffix was not captured receives typed resync to
the restored durable milestone; it is never silently treated as complete replay.

## Fixed limits

Limits are server-owned and may only become smaller without revising this contract.

| Resource | Per user | Process/global |
| --- | ---: | ---: |
| process-lifetime identity bindings | 1 | 65,536 |
| resident runtimes / open DBs | 1 | 64 |
| conversation/session references | 1,000 and 1 MiB | 64,000 and 64 MiB |
| active Pi children | 1 | 32 |
| live Pi broker grants | 1, 31-minute TTL | 32 |
| queued mutations | 16 | 512 |
| strong request/internal leases | 64 | 2,048 |
| filesystem watchers | 32 | 1,024 |
| SSE connections | 4 | 256 |
| replay journal | 2,000 events and 8 MiB | 256 MiB |
| slow-client buffered SSE | 1 MiB | 64 MiB |
| minted preview scopes | 32, 10-minute TTL | 2,048 |
| in-flight request-body reservations | 2 requests and 200 MiB | 64 requests and 2 GiB |
| archive/download streams | 1 and 1 GiB | 32 and 16 GiB in flight |
| JSON request | 4 MiB | n/a |
| provider secret | 16 KiB | memory only |
| provider response | 2 MiB | 64 MiB in flight |
| upload | 12 files, 20 MiB each, 100 MiB/request | n/a |
| project workspace | 1 GiB and 10,000 files | 32 GiB |
| generated output/artifact | 100 MiB/item | n/a |
| immutable snapshot version | 1.5 GiB and 20,000 files | n/a |
| retained snapshots | 4 GiB, newest two valid minimum | 64 GiB |

Body capacity is reserved before reading or buffering and released on abort/close.
JSON body read is limited to 30 seconds and upload streaming to 120 seconds. Run
admission wait is 30 seconds; one run is limited to 30 minutes. Provider connect is
5 seconds and the complete provider test/turn call is 60 seconds. Snapshot
publication is 120 seconds, cancel settle is 10 seconds, and graceful hosted
shutdown/final flush is 60 seconds. SSE heartbeat is 25 seconds; a connection that
remains backpressured for 5 seconds is closed with typed resync semantics.
Runtime root creation and DB open/migration each have a 30-second deadline; restore
has 120 seconds. Archive/download streams have a 30-second idle and 10-minute total
deadline. Snapshot publication gets at most three attempts inside its 120-second
budget with 1-second then 4-second backoff; dirty idle flush begins after 30 seconds.

Per-user queue/lease/watcher/scope/body overflow returns typed
`429 HOSTED_OVERLOADED`; byte/item/workspace limits return typed
`413 HOSTED_QUOTA_EXCEEDED`. Global resource exhaustion returns typed
`503 HOSTED_CAPACITY_EXHAUSTED`, and provider/snapshot/cancel/shutdown deadline
failures use their domain-specific typed timeout without acknowledging success.
Hosted capture fails on an oversized state; it never silently omits files. Archive
intake remains disabled.

## Required-check policy

The umbrella cannot merge unless the exact candidate SHA has successful, uniquely
named GitHub Actions checks:

- `Hosted / Windows x64`
- `Hosted / Linux x64`
- `Hosted / Nix dependency hash and flake check`

The hosted workflow runs for every pull request so required jobs are never skipped by
path filtering. The Windows/Linux jobs run the exact logical-boundary suite selected
by the committed validation manifest. C2, PR04, PR06, PR08, PR10, and the final SHA
record their platform evidence. Before PR03 begins, repository settings must require
all three checks above, require two approving reviews, dismiss stale approvals, and
require conversation resolution. If repository settings cannot enforce this, a
maintainer must record an explicit manual gate naming the exact green SHA and all
three successful check URLs; the umbrella must not merge automatically. The
protection/ruleset URL or exact-SHA manual record belongs in the ledger before Wave 0
is marked frozen.

Wave 0 enforcement was verified at the
[`main` branch protection endpoint](https://api.github.com/repos/sanghyunna/readable-studio-sandboxed/branches/main/protection):
strict required checks name exactly the three jobs above, two approvals are required,
stale approvals are dismissed, conversation resolution and admin enforcement are
enabled, and force pushes and deletion are disabled.

## Logical-boundary validation ledger

Each row is filled only after checking out and validating that exact commit.

| Boundary | Commit | Windows | Linux | Focused/prior suites | Review/enforcement |
| --- | --- | --- | --- | --- | --- |
| C2 | `23eadb71` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31034456875/job/92402933808) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31034456875/job/92402934003) | 111 focused daemon tests; 6 tools-pack workspace-build tests; daemon/tools-pack typechecks; staged Pi build/check; `pnpm guard`; `pnpm typecheck`; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31034456875/job/92402934008) | Spec `CLEAN`; standards `CLEAN`; protection verified |
| PR03 | `031a2273` | n/a | n/a | 127 focused daemon tests; 6 tools-pack workspace-build tests; `pnpm guard`; `pnpm typecheck` | Spec `CLEAN`; standards `CLEAN` |
| PR04 | `b9d847f8` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31060919679/job/92488515096) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31060919679/job/92488515086) | 49 focused daemon tests; 49 focused web tests; Windows/Linux staged Pi build/check; `pnpm guard`; `pnpm typecheck`; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31060919679/job/92488515055) | Spec `CLEAN`; standards `CLEAN`; hosted entry screenshot captured at `docs/screenshots/09-hosted-entry.png` |
| PR05 | `0b2c9077` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063828315/job/92497244814) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063828315/job/92497244803) | Prior PR04 suite; Windows/Linux staged Pi build/check; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063828315/job/92497244773) | covered by final full-range Spec/Standards review |
| PR06 | `c4f5e98b` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063917935/job/92497511370) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063917935/job/92497511372) | PR06 snapshot manifest including PR05 storage and failpoints; Windows/Linux staged Pi build/check; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31063917935/job/92497511355) | covered by final full-range Spec/Standards review |
| PR07 | `5b181a7c` | n/a | n/a | Exact-boundary hosted traffic suite passed on Linux; the historical staged-artifact job later failed and Windows was cancelled, so no platform pass is claimed; PR07 was re-run by the green PR09 and PR10 composed gates | covered by final full-range Spec/Standards review |
| PR08 | `5079cc1a` | not recorded at this exact SHA | not recorded at this exact SHA | Protected content boundary; its junction/symlink and content suites were re-run by the green PR09 and PR10 composed gates | covered by final full-range Spec/Standards review |
| PR09 | `1bc831d7` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31096551257/job/92599845416) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31096551257/job/92599845461) | Complete prior hosted suite plus PR06/PR07/PR08/PR09 boundary suites and staged artifact smoke; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31096551257/job/92599845381) | covered by final full-range Spec/Standards review |
| PR10 | `dc3d7ba0` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31185767658/job/92889771600) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31185767658/job/92889771535) | Complete composed hosted gate; 3 local acceptance/recovery specs; tools-pack manifest test; web sidecar tests; e2e/tools-pack typechecks; `pnpm guard`; `pnpm typecheck`; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31185767658/job/92889771489). Local acceptance does not prove Databricks Apps ingress/identity, Unity Catalog persistence, production Gateway connectivity, or Databricks capacity | Spec `CLEAN`; standards `CLEAN`; exact-SHA required checks green |
| PR11 | `8491375b` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31197265316/job/92928466226) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31197265316/job/92928466155) | Complete composed hosted gate plus the reusable two-repetition 1/2/4/8-user local capacity workload and machine-readable report; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31197265316/job/92928466216). The report explicitly leaves Databricks ingress, identity, persistence, Gateway, autoscaling, quotas, and admission capacity unproven | Preliminary full-range review found measurement and repository-ownership issues; corrective commits `37adc311` through `17bb6ca4` address them |
| final evidence | `2c184451` | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31204885460/job/92953372240) | [pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31204885460/job/92953372387) | Capacity 1/1 passed in 1,257.91s; acceptance/recovery 2/2; daemon/e2e/web and root typechecks; web sidecar 20/20; tools-pack 1/1; `pnpm guard` 45/45; [Nix pass](https://github.com/sanghyunna/readable-studio-sandboxed/actions/runs/31204885460/job/92953372192). Hosted/export daemon integration passed 145/148; the same three PR07 20-second timeouts reproduce before the review refactors at `7be9ccc1`, so no new failure is attributed to this range. Final capacity measurement correction passed e2e typecheck and diff-check | Spec `CLEAN`; Standards code/structure `CLEAN`; hosted entry screenshot captured |
