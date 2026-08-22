/**
 * Drives pi's `--mode rpc` JSON-RPC protocol over stdio and maps agent
 * events into the daemon's typed UI events (the same set that
 * claude-stream.js / copilot-stream.js / acp.js emit).
 *
 * Lifecycle:
 *   1. Daemon spawns `pi --mode rpc [--model ...]`
 *   2. This module optionally switches an owned session, then sends `prompt`
 *   3. pi streams events on stdout
 *   4. We translate them to: status, text_delta, thinking_delta,
 *      tool_use, tool_result, usage
 *   5. After agent_end/agent_settled, get_state captures the session and
 *      stdin closes; completion waits for child close
 *
 * Extension UI requests from pi are auto-resolved (the web UI has no
 * dialog surfaces), and fire-and-forget notifications are silently
 * consumed to keep the protocol clean.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { createJsonLineStream } from './acp.js';

type JsonRecord = Record<string, unknown>;

type SendAgentEvent = (channel: string, payload: JsonRecord) => void;

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_read_tokens?: number;
  cached_write_tokens?: number;
  total_tokens?: number;
};

type PiImagePayload = {
  type: 'image';
  data: string;
  mimeType: string;
};

type PiRpcParams = JsonRecord;

type PiRpcSessionOptions = {
  child: ChildProcess;
  prompt: string;
  cwd?: string;
  sessionDir?: string;
  model?: string | null;
  send: SendAgentEvent;
  imagePaths?: string[];
  uploadRoot?: string;
  resumeSession?: {
    path: string;
    root: string;
  };
};

export type PiRpcSession = {
  readonly ownsAbortLifecycle: true;
  hasFatalError(): boolean;
  abort(): void;
  getLastSessionPath(): string | null;
  /** Resolves only after the owned session is captured and the child has exited. */
  waitForQuiescence(): Promise<void>;
};

type PiRpcContext = {
  runStartedAt: number;
  sentFirstToken: { value: boolean };
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
}

function getRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

// Image forwarding budgets to prevent large synchronous base64 work.
const MAX_IMAGE_COUNT = 10;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// sendCommand is scoped inside attachPiRpcSession to avoid sharing
// the RPC id counter across concurrent sessions.

// Auto-approve any extension UI dialog (select/confirm/input/editor).
// The web UI has no surface for these; resolving them keeps pi unblocked.
// Fire-and-forget methods (setStatus, setWidget, notify, setTitle, set_editor_text)
// are silently consumed — no response is expected.
const FIRE_AND_FORGET_METHODS = new Set([
  'setStatus',
  'setWidget',
  'notify',
  'setTitle',
  'set_editor_text',
]);

function replyExtensionUi(writable: Writable, raw: JsonRecord): void {
  if (raw?.id == null) return;

  // Fire-and-forget: no response expected. Silently consume.
  if (typeof raw.method === 'string' && FIRE_AND_FORGET_METHODS.has(raw.method)) return;

  // Dialog methods: auto-resolve to keep pi unblocked.
  // confirm → true, select/input/editor → empty-ish default
  let result;
  if (raw.method === 'confirm') {
    result = { confirmed: true };
  } else {
    // select: pick first option if available, else cancel
    const params = getRecord(raw.params);
    const opts = params?.options ?? raw.options;
    if (Array.isArray(opts) && opts.length > 0) {
      const first = opts[0];
      result =
        typeof first === 'string'
          ? { value: first }
          : { value: getRecord(first)?.label ?? getRecord(first)?.value ?? '' };
    } else {
      result = { cancelled: true };
    }
  }
  writable.write(
    `${JSON.stringify({ type: 'extension_ui_response', id: raw.id, ...result })}\n`,
  );
}

/**
 * Map a single pi RPC event to zero or more daemon UI events.
 *
 * No I/O or child process interaction; mutates `ctx.sentFirstToken`
 * to track streaming state.
 * `send` callback and `ctx` are provided by the caller.
 *
 * @param {object} raw        - parsed JSON from pi's stdout
 * @param {function} send     - (channel, payload) emitter
 * @param {object} ctx        - session context
 * @param {number} ctx.runStartedAt - Date.now() at session start
 * @param {{ value: boolean }} ctx.sentFirstToken - mutable flag
 * @returns {string|null} 'agent_end' if the agent is done, null otherwise
 */
export function mapPiRpcEvent(
  raw: JsonRecord,
  send: SendAgentEvent,
  ctx: PiRpcContext,
): 'agent_end' | null {
  if (raw.type === 'agent_start') {
    send('agent', { type: 'status', label: 'working' });
    return null;
  }

  if (raw.type === 'agent_end') {
    return 'agent_end';
  }

  if (raw.type === 'turn_start') {
    send('agent', { type: 'status', label: 'thinking' });
    return null;
  }

  if (raw.type === 'turn_end') {
    const message = getRecord(raw.message);
    const messageUsage = getRecord(message?.usage);
    if (messageUsage) {
      const u = messageUsage;
      const usage: TokenUsage = {};
      if (typeof u.input === 'number') usage.input_tokens = u.input;
      if (typeof u.output === 'number') usage.output_tokens = u.output;
      if (typeof u.cacheRead === 'number') usage.cached_read_tokens = u.cacheRead;
      if (typeof u.cacheWrite === 'number') usage.cached_write_tokens = u.cacheWrite;
      if (typeof u.totalTokens === 'number') usage.total_tokens = u.totalTokens;
      if (Object.keys(usage).length > 0) {
        const cost = getRecord(u.cost);
        send('agent', {
          type: 'usage',
          usage,
          costUsd: cost?.total ?? cost?.totalCost ?? null,
          durationMs: Date.now() - ctx.runStartedAt,
        });
      }
    }

    if (message?.stopReason === 'error') {
      const messageText =
        typeof message.errorMessage === 'string' && message.errorMessage.length > 0
          ? message.errorMessage
          : 'Pi agent error';
      send('agent', { type: 'error', message: messageText, raw });
    }
    return null;
  }

  const assistantMessageEvent = getRecord(raw.assistantMessageEvent);
  if (raw.type === 'message_update' && assistantMessageEvent) {
    const ev = assistantMessageEvent;

    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      if (!ctx.sentFirstToken.value) {
        ctx.sentFirstToken.value = true;
        send('agent', {
          type: 'status',
          label: 'streaming',
          ttftMs: Date.now() - ctx.runStartedAt,
        });
      }
      send('agent', { type: 'text_delta', delta: ev.delta });
      return null;
    }

    if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
      send('agent', { type: 'thinking_delta', delta: ev.delta });
      return null;
    }

    if (ev.type === 'thinking_start') {
      send('agent', { type: 'thinking_start' });
      return null;
    }

    if (ev.type === 'thinking_end') {
      send('agent', { type: 'thinking_end' });
      return null;
    }

    // pi's RPC protocol emits a message_update with error delta when
    // the model returns an error (e.g. aborted, context overflow).
    // Surface it so sendAgentEvent's error-handling path sets
    // agentStreamError and the run flips to `failed` on close.
    if (ev.type === 'error') {
      const message =
        typeof ev.reason === 'string' && ev.reason.length > 0
          ? ev.reason
          : typeof ev.delta === 'string' && ev.delta.length > 0
            ? ev.delta
            : 'Agent error';
      send('agent', { type: 'error', message, raw });
      return null;
    }

    return null;
  }

  if (raw.type === 'message_end') {
    // message_end carries usage (already emitted from turn_end) and
    // tool call blocks (already emitted from tool_execution_start).
    // Nothing to extract here.
    return null;
  }

  if (raw.type === 'tool_execution_start') {
    send('agent', {
      type: 'tool_use',
      id: raw.toolCallId ?? null,
      name: raw.toolName ?? null,
      input: raw.args ?? null,
    });
    return null;
  }

  if (raw.type === 'tool_execution_end') {
    const result = getRecord(raw.result);
    const content = result?.content;
    const text =
      Array.isArray(content)
        ? content
            .map((c: unknown) => {
              const item = getRecord(c);
              return item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(c);
            })
            .join('\n')
        : typeof content === 'string'
          ? content
          : '';
    send('agent', {
      type: 'tool_result',
      toolUseId: raw.toolCallId ?? null,
      content: text,
      isError: raw.isError === true,
    });
    return null;
  }

  // pi's RPC protocol can emit `extension_error` when an extension
  // throws during a tool call or event handler. Surface it so the
  // daemon's error-handling path (sendAgentEvent → agentStreamError)
  // can flip the run to `failed` and forward a visible SSE error.
  if (raw.type === 'extension_error') {
    const message =
      typeof raw.error === 'string' && raw.error.length > 0
        ? raw.error
        : 'Extension error';
    send('agent', { type: 'error', message, raw });
    return null;
  }

  if (raw.type === 'compaction_start') {
    send('agent', { type: 'status', label: 'compacting' });
    return null;
  }
  if (raw.type === 'auto_retry_start') {
    send('agent', { type: 'status', label: 'retrying' });
    return null;
  }

  if (raw.type === 'auto_retry_end' && raw.success === false) {
    // Auto-retry exhausted — the agent is about to give up. Surface
    // the final error so the daemon marks the run as failed rather
    // than silently succeeding with empty output.
    const message =
      typeof raw.finalError === 'string' && raw.finalError.length > 0
        ? raw.finalError
        : 'Auto-retry exhausted';
    send('agent', { type: 'error', message, raw });
    return null;
  }

  return null;
}

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_LINEAGE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_DIRECTORY_ENTRIES = 4096;
const MAX_SESSION_PARENT_DEPTH = 32;
const DEFAULT_SHUTDOWN_MS = 5000;
const FORCE_KILL_MS = 1000;

type PiSessionHeader = {
  cwd: string;
  parentSession?: string;
};

type PiSessionFileMetadata = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function assertSessionFile(stat: fs.Stats, sessionPath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || path.extname(sessionPath).toLowerCase() !== '.jsonl') {
    throw new Error('session path must be a regular non-link JSONL file');
  }
}

function sessionFileMetadata(stat: fs.Stats): PiSessionFileMetadata {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameSessionFile(
  left: PiSessionFileMetadata,
  right: PiSessionFileMetadata,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function parseSessionHeader(raw: string): PiSessionHeader {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.type !== 'session' || typeof parsed.cwd !== 'string') {
    throw new Error('session header is invalid');
  }
  if (parsed.parentSession !== undefined && typeof parsed.parentSession !== 'string') {
    throw new Error('session parent path is invalid');
  }
  return {
    cwd: parsed.cwd,
    ...(typeof parsed.parentSession === 'string' ? { parentSession: parsed.parentSession } : {}),
  };
}

function readBoundedSessionHeader(sessionPath: string): {
  header: PiSessionHeader;
  metadata: PiSessionFileMetadata;
} {
  const stat = fs.lstatSync(sessionPath);
  assertSessionFile(stat, sessionPath);

  const fd = fs.openSync(sessionPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_SESSION_HEADER_BYTES + 1));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const headerEnd = newline >= 0 ? newline : bytesRead;
    if (headerEnd === 0 || headerEnd > MAX_SESSION_HEADER_BYTES) {
      throw new Error('session header is empty or exceeds the size limit');
    }
    return {
      header: parseSessionHeader(buffer.toString('utf8', 0, headerEnd).replace(/\r$/u, '')),
      metadata: sessionFileMetadata(stat),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readStableSessionFile(
  sessionPath: string,
  expected: PiSessionFileMetadata,
): PiSessionHeader {
  const before = fs.lstatSync(sessionPath);
  assertSessionFile(before, sessionPath);
  if (!sameSessionFile(sessionFileMetadata(before), expected)) {
    throw new Error('session file changed before full validation');
  }
  if (before.size === 0 || before.size > MAX_SESSION_FILE_BYTES) {
    throw new Error('session file is empty or exceeds the size limit');
  }

  const contents = fs.readFileSync(sessionPath);
  const after = fs.lstatSync(sessionPath);
  assertSessionFile(after, sessionPath);
  if (!sameSessionFile(sessionFileMetadata(before), sessionFileMetadata(after)) || contents.length !== before.size) {
    throw new Error('session file changed during validation');
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error('session file contains an empty JSONL record');
  }
  if (Buffer.byteLength(lines[0]!, 'utf8') > MAX_SESSION_HEADER_BYTES) {
    throw new Error('session header exceeds the size limit');
  }
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line.replace(/\r$/u, ''));
    if (!isRecord(parsed)) throw new Error('session file contains a non-object JSONL record');
  }
  return parseSessionHeader(lines[0]!.replace(/\r$/u, ''));
}

type PiSessionFileSnapshot = Map<string, PiSessionFileMetadata>;

function snapshotPiSessionFiles(rootPath: string): PiSessionFileSnapshot {
  const canonicalRoot = fs.realpathSync(rootPath);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('session root is not a directory');
  const entries = fs.readdirSync(canonicalRoot, { withFileTypes: true });
  if (entries.length > MAX_SESSION_DIRECTORY_ENTRIES) {
    throw new Error('session directory exceeds the entry limit');
  }
  const snapshot: PiSessionFileSnapshot = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') continue;
    const filePath = path.join(canonicalRoot, entry.name);
    const stat = fs.lstatSync(filePath);
    assertSessionFile(stat, filePath);
    if (pathKey(fs.realpathSync(filePath)) !== pathKey(filePath)) {
      throw new Error('session path is not canonical');
    }
    snapshot.set(filePath, sessionFileMetadata(stat));
  }
  return snapshot;
}

/** Validate the complete lineage before allowing Pi to read or reuse a session file. */
function validatePiSessionPath(
  sessionPath: string,
  rootPath: string,
  cwd: string,
  fullFile = false,
): string {
  const canonicalRoot = fs.realpathSync(rootPath);
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error('session root is not a directory');
  }
  const canonicalCwd = fs.realpathSync(cwd);
  if (!fs.statSync(canonicalCwd).isDirectory()) {
    throw new Error('session cwd is not a directory');
  }

  let current = path.resolve(sessionPath);
  const seen = new Set<string>();
  let firstSessionPath: string | null = null;
  const lineage: Array<{
    path: string;
    header: PiSessionHeader;
    metadata: PiSessionFileMetadata;
  }> = [];
  let lineageBytes = 0;

  for (let depth = 0; depth < MAX_SESSION_PARENT_DEPTH; depth += 1) {
    const canonicalPath = fs.realpathSync(current);
    if (pathKey(canonicalPath) !== pathKey(current)) {
      throw new Error('session path is not canonical');
    }
    if (!isPathInside(canonicalPath, canonicalRoot)) {
      throw new Error('session path is outside its owner root');
    }
    const key = pathKey(canonicalPath);
    if (seen.has(key)) {
      throw new Error('session parent chain contains a cycle');
    }
    seen.add(key);
    firstSessionPath ??= canonicalPath;

    const { header, metadata } = readBoundedSessionHeader(canonicalPath);
    lineage.push({ path: canonicalPath, header, metadata });
    if (fullFile) {
      if (metadata.size > MAX_SESSION_FILE_BYTES) {
        throw new Error('session file exceeds the size limit');
      }
      lineageBytes += metadata.size;
      if (lineageBytes > MAX_SESSION_LINEAGE_BYTES) {
        throw new Error('session lineage exceeds the aggregate size limit');
      }
    }
    let headerCwd: string;
    try {
      headerCwd = fs.realpathSync(header.cwd);
    } catch {
      throw new Error('session cwd does not exist');
    }
    if (pathKey(headerCwd) !== pathKey(canonicalCwd)) {
      throw new Error('session cwd does not match the requested project');
    }
    if (!header.parentSession) {
      if (fullFile) {
        for (const entry of lineage) {
          const stableHeader = readStableSessionFile(entry.path, entry.metadata);
          if (
            stableHeader.cwd !== entry.header.cwd ||
            stableHeader.parentSession !== entry.header.parentSession
          ) {
            throw new Error('session header changed during lineage validation');
          }
        }
      }
      return firstSessionPath;
    }
    current = path.isAbsolute(header.parentSession)
      ? header.parentSession
      : path.resolve(path.dirname(canonicalPath), header.parentSession);
  }

  throw new Error('session parent chain exceeds the depth limit');
}

function resolveExitFallbackSession(
  rootPath: string,
  cwd: string,
  before: PiSessionFileSnapshot | null,
  expectedPath: string | null,
  expectedMetadata: PiSessionFileMetadata | null,
): string {
  if (expectedPath) {
    if (!expectedMetadata) throw new Error('resumed session metadata was not captured');
    const current = fs.lstatSync(expectedPath);
    assertSessionFile(current, expectedPath);
    if (sameSessionFile(sessionFileMetadata(current), expectedMetadata)) {
      throw new Error('resumed session was unchanged when the child exited');
    }
    return validatePiSessionPath(expectedPath, rootPath, cwd, true);
  }
  if (!before) throw new Error('session directory was unavailable before the prompt');
  const after = snapshotPiSessionFiles(rootPath);
  const changed = [...after].filter(([filePath, metadata]) => {
    const previous = before.get(filePath);
    return !previous || !sameSessionFile(previous, metadata);
  });
  if (changed.length !== 1) {
    throw new Error('unexpected exit did not leave exactly one changed session file');
  }
  return validatePiSessionPath(changed[0]![0], rootPath, cwd, true);
}

/**
 * Attach a pi RPC session to a spawned child process.
 *
 * Resumed turns validate their complete owned session lineage and use Pi's
 * semantic `switch_session` RPC before sending the latest prompt.
 *
 * The returned `abort()` method sends an RPC `abort` command so pi can
 * clean up gracefully (flush logs, finalize session files, etc.). The
 * adapter keeps parsing settle/state events and owns bounded SIGTERM/SIGKILL
 * escalation.
 *
 * After the session completes, `getLastSessionPath()` returns the path
 * to the .jsonl session file pi wrote to disk, or null if none was found.
 *
 * @param {object} opts
 * @param {import('node:child_process').ChildProcess} opts.child  - spawned pi process
 * @param {string} opts.prompt   - composed user message
 * @param {string} [opts.cwd]    - working directory (used to resolve .pi/sessions/)
 * @param {string} [opts.sessionDir] - daemon-owned session directory override
 * @param {string|null} [opts.model] - model id (null = default)
 * @param {string[]} [opts.imagePaths] - absolute paths to image files for multimodal input
 * @param {string} [opts.uploadRoot] - root directory that image paths must remain inside after symlink resolution
 * @param {function} opts.send   - SSE send function
 * @param {{path: string, root: string}} [opts.resumeSession] - owner-bound session to resume
 * @returns {PiRpcSession}
 */
export function attachPiRpcSession({
  child,
  prompt,
  cwd,
  sessionDir,
  model,
  send,
  imagePaths,
  uploadRoot,
  resumeSession,
}: PiRpcSessionOptions): PiRpcSession {
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (stdin === null) {
    throw new Error('pi RPC child process is missing stdin');
  }
  if (stdout === null) {
    throw new Error('pi RPC child process is missing stdout');
  }

  const runStartedAt = Date.now();
  let terminal = false;
  let fatal = false;
  let aborted = false;
  let agentEnded = false;
  let agentSettled = false;
  const sentFirstToken = { value: false };
  let capturedSessionPath: string | null = null;
  let expectedResumePath: string | null = null;
  let expectedResumeMetadata: PiSessionFileMetadata | null = null;
  const sessionRoot =
    resumeSession?.root ?? sessionDir ?? (cwd ? path.join(cwd, '.pi', 'sessions') : null);
  let sessionFilesBeforePrompt: PiSessionFileSnapshot | null = null;
  if (sessionRoot && !resumeSession) {
    try {
      sessionFilesBeforePrompt = snapshotPiSessionFiles(sessionRoot);
    } catch {
      // Normal settle/get_state remains authoritative. A missing snapshot only
      // disables the exceptional child-exit recovery path.
    }
  }

  let nextRpcId = 1;
  let stdinOpen = true;
  let childClosed = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveQuiescence!: () => void;
  let rejectQuiescence!: (error: Error) => void;
  const quiescence = new Promise<void>((resolve, reject) => {
    resolveQuiescence = resolve;
    rejectQuiescence = reject;
  });
  // Existing local callers do not await the hosted snapshot barrier.
  void quiescence.catch(() => undefined);

  function sendCommand(writable: Writable, type: string, params: PiRpcParams = {}): number | null {
    if (!stdinOpen) return null;
    const id = nextRpcId++;
    writable.write(`${JSON.stringify({ id, type, ...params })}\n`);
    return id;
  }

  // A resumed turn must not send the latest-only prompt until Pi confirms the
  // semantic session switch.
  let resumeRpcId: number | null = null;
  let promptRpcId: number | null = null;
  let stateRpcId: number | null = null;

  const scheduleForceKill = (): void => {
    if (forceKillTimer || childClosed) return;
    forceKillTimer = setTimeout(() => {
      if (!childClosed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may have exited between the close check and signal.
        }
      }
    }, FORCE_KILL_MS);
    forceKillTimer.unref?.();
  };

  const terminateChild = (): void => {
    if (childClosed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Force escalation below remains the final bounded attempt.
    }
    scheduleForceKill();
  };

  const scheduleKillFallback = (): void => {
    if (shutdownTimer || childClosed) return;
    const configured = Number(process.env.PI_GRACEFUL_SHUTDOWN_MS);
    const shutdownMs = Number.isFinite(configured)
      ? Math.max(100, Math.min(30_000, configured))
      : DEFAULT_SHUTDOWN_MS;
    shutdownTimer = setTimeout(() => {
      terminateChild();
    }, shutdownMs);
    shutdownTimer.unref?.();
  };

  const fail = (message: string, code?: string): void => {
    if (terminal) return;
    terminal = true;
    fatal = true;
    send('error', { message, ...(code ? { code } : {}) });
    terminateChild();
  };

  const closeStdin = (): void => {
    if (!stdinOpen) return;
    stdinOpen = false;
    try {
      stdin.end();
    } catch (err: unknown) {
      fail(`stdin close: ${errorMessage(err)}`, 'PI_SESSION_CLOSE_FAILED');
      return;
    }
    scheduleKillFallback();
  };

  // Emit initial status with model name immediately — before pi even
  // responds — so the UI header shows the model name at session start.
  send('agent', {
    type: 'status',
    label: 'initializing',
    model: typeof model === 'string' && model ? model : null,
  });

  // ---- Outbound RPC lifecycle ----
  stdin.on('error', (err: unknown) => {
    if (errorCode(err) !== 'EPIPE') {
      fail(`stdin: ${errorMessage(err)}`);
    }
  });
  stdin.on('close', () => {
    stdinOpen = false;
  });

  // Build the images array for pi's prompt command. pi's RPC protocol
  // accepts `images` as an array of {type, data, mimeType} objects where
  // `data` is base64-encoded file contents. The daemon's safeImages guard
  // already validated that each path exists under UPLOAD_DIR.
  //
  // Security: realpath resolves symlinks so we re-check that the resolved
  // path is still a regular file (no /proc/self/mem or symlink escape).
  // We also enforce a count and total-byte budget to prevent large
  // synchronous base64 reads from blocking the event loop.
  const images: PiImagePayload[] = [];
  if (Array.isArray(imagePaths) && imagePaths.length > 0) {
    let totalBytes = 0;
    for (const imgPath of imagePaths) {
      if (images.length >= MAX_IMAGE_COUNT) break;
      if (typeof imgPath !== 'string' || !imgPath.length) continue;
      try {
        // Resolve symlinks and verify it's a regular file.
        const realPath = fs.realpathSync(imgPath);
        const stat = fs.statSync(realPath);
        if (!stat.isFile()) continue;

        // Re-verify the resolved path stays inside the upload root.
        // Without this, a path that passed server.ts's safeImages prefix
        // check (under UPLOAD_DIR) could be a symlink pointing to a file
        // outside UPLOAD_DIR, and we'd read/base64-forward it to pi.
        if (uploadRoot) {
          const resolvedRoot = fs.realpathSync(uploadRoot);
          if (realPath !== resolvedRoot && !realPath.startsWith(resolvedRoot + path.sep)) continue;
        }

        const ext = path.extname(realPath).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) continue;

        // Enforce total byte budget.
        if (totalBytes + stat.size > MAX_TOTAL_IMAGE_BYTES) continue;

        const buf = fs.readFileSync(realPath);
        const mimeType =
          ext === '.png' ? 'image/png' :
          ext === '.gif' ? 'image/gif' :
          ext === '.webp' ? 'image/webp' :
          'image/jpeg'; // .jpg, .jpeg, and unknown
        images.push({
          type: 'image',
          data: buf.toString('base64'),
          mimeType,
        });
        totalBytes += stat.size;
      } catch (_err: unknown) {
        // Skip unreadable images rather than failing the entire run.
      }
    }
  }

  const sendPromptCommand = (): void => {
    promptRpcId = sendCommand(stdin, 'prompt', {
      message: prompt,
      ...(images.length > 0 ? { images } : {}),
    });
  };

  // ---- Inbound: parse stdout events ----
  const parser = createJsonLineStream((raw: unknown) => {
    if (!isRecord(raw)) return;
    // agent_end and abort are not terminal: settle/get_state responses still
    // have to be parsed. Only fatal failure or child close stops parsing.
    if (terminal) return;

    // Extension UI requests: auto-resolve to keep pi unblocked.
    if (raw.type === 'extension_ui_request') {
      if (!aborted) replyExtensionUi(stdin, raw);
      return;
    }

    // RPC responses (prompt accepted, set_model ack, etc.) — not
    // agent events. Log the prompt acceptance, ignore the rest.
    if (raw.type === 'response') {
      if (raw.id === resumeRpcId) {
        const data = getRecord(raw.data);
        if (raw.command !== 'switch_session' || raw.success !== true || data?.cancelled === true) {
          fail(
            `resume session rejected: ${String(raw.error ?? 'unknown')}`,
            'PI_RESUME_SESSION_FAILED',
          );
          return;
        }
        if (!aborted) sendPromptCommand();
        return;
      }
      if (raw.id === promptRpcId && raw.success === false) {
        fail(`prompt rejected: ${String(raw.error ?? 'unknown')}`);
        return;
      }
      if (raw.id === stateRpcId) {
        const data = getRecord(raw.data);
        if (
          raw.command !== 'get_state' ||
          raw.success !== true ||
          typeof data?.sessionFile !== 'string' ||
          !sessionRoot ||
          !cwd
        ) {
          fail('Pi get_state did not return an owned session file', 'PI_SESSION_STATE_FAILED');
          return;
        }
        try {
          const validated = validatePiSessionPath(data.sessionFile, sessionRoot, cwd, true);
          if (expectedResumePath && pathKey(validated) !== pathKey(expectedResumePath)) {
            throw new Error('Pi switched to an unexpected session file');
          }
          capturedSessionPath = validated;
        } catch (err: unknown) {
          fail(`invalid Pi session state: ${errorMessage(err)}`, 'PI_SESSION_STATE_FAILED');
          return;
        }
        closeStdin();
      }
      return;
    }

    if (raw.type === 'agent_settled') {
      if (!agentEnded) {
        fail('Pi emitted agent_settled before agent_end', 'PI_SESSION_STATE_FAILED');
        return;
      }
      if (!agentSettled) {
        agentSettled = true;
        stateRpcId = sendCommand(stdin, 'get_state');
        if (stateRpcId === null) {
          fail('Pi stdin closed before session state capture', 'PI_SESSION_STATE_FAILED');
        }
      }
      return;
    }

    // Agent events: delegate to the pure mapper.
    const result = mapPiRpcEvent(
      raw,
      (channel, payload) => {
        if (!aborted && !terminal) send(channel, payload);
      },
      { runStartedAt, sentFirstToken },
    );

    if (result === 'agent_end') {
      agentEnded = true;
    }
  });

  stdout.on('data', (chunk: Buffer | string) => {
    try {
      parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    } catch (err) {
      fail(`parser: ${errorMessage(err)}`);
    }
  });
  stdout.on('close', () => {
    try {
      parser.flush();
    } catch (err: unknown) {
      fail(`parser: ${errorMessage(err)}`);
    }
  });
  child.on('error', (err: unknown) => fail(errorMessage(err)));
  child.on('close', () => {
    childClosed = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (!terminal && !capturedSessionPath && sessionRoot && cwd) {
      try {
        capturedSessionPath = resolveExitFallbackSession(
          sessionRoot,
          cwd,
          sessionFilesBeforePrompt,
          expectedResumePath,
          expectedResumeMetadata,
        );
      } catch (err: unknown) {
        if (!aborted) {
          fatal = true;
          send('error', {
            message: `Pi exited before settled session state was safely captured: ${errorMessage(err)}`,
            code: 'PI_SESSION_STATE_FAILED',
          });
        }
      }
    } else if (!terminal && !capturedSessionPath && !aborted) {
      fatal = true;
      send('error', {
        message: 'Pi exited before settled session state was captured',
        code: 'PI_SESSION_STATE_FAILED',
      });
    }
    terminal = true;
    if (!fatal && capturedSessionPath) {
      resolveQuiescence();
    } else {
      rejectQuiescence(new Error('Pi child closed without a safely captured session'));
    }
  });

  if (resumeSession) {
    if (!cwd) {
      fail('resume session requires a cwd', 'PI_RESUME_SESSION_INVALID');
    } else {
      try {
        expectedResumePath = validatePiSessionPath(resumeSession.path, resumeSession.root, cwd, true);
        expectedResumeMetadata = sessionFileMetadata(fs.lstatSync(expectedResumePath));
        resumeRpcId = sendCommand(stdin, 'switch_session', { sessionPath: expectedResumePath });
      } catch (err: unknown) {
        fail(`invalid resume session: ${errorMessage(err)}`, 'PI_RESUME_SESSION_INVALID');
      }
    }
  } else {
    sendPromptCommand();
  }

  return {
    ownsAbortLifecycle: true,
    hasFatalError() {
      return fatal;
    },
    getLastSessionPath() {
      return capturedSessionPath;
    },
    waitForQuiescence() {
      return quiescence;
    },
    abort() {
      if (terminal || aborted || childClosed) return;
      aborted = true;
      sendCommand(stdin, 'abort');
      scheduleKillFallback();
    },
  };
}

/**
 * Parse `pi --list-models` tabular output into the model-picker format
 * used by the daemon's /api/agents endpoint.
 *
 * Input lines look like:
 *   provider         model                  context  max-out  thinking  images
 *   anthropic        claude-sonnet-4-5      200K      64K      yes        yes
 *
 * We collapse to `provider/model` ids and prepend the synthetic default.
 */
type PiModelOption = { id: string; label: string };

export function parsePiModels(stdout: unknown): PiModelOption[] | null {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) return null;

  const DEFAULT_MODEL_OPTION = { id: 'default', label: 'Default (CLI config)' };

  // First line is the header; skip it.
  const entries = [DEFAULT_MODEL_OPTION];
  const seen = new Set(['default']);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const provider = parts[0];
    const modelId = parts[1];
    if (provider === undefined || modelId === undefined) continue;
    // Skip duplicates (some providers list the same model under multiple names).
    const fullId = `${provider}/${modelId}`;
    if (seen.has(fullId)) continue;
    seen.add(fullId);
    entries.push({ id: fullId, label: fullId });
  }

  return entries.length > 1 ? entries : null;
}
