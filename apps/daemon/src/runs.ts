// @ts-nocheck
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRunToolBundleForRun,
  summarizeRunToolBundle,
} from './run-tool-bundle.js';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

export interface ChatRunServiceOptions {
  createSseResponse: (...args: any[]) => any;
  createSseErrorPayload: (...args: any[]) => any;
  maxEvents?: number;
  ttlMs?: number;
  shutdownGraceMs?: number;
  runsLogDir?: string | null;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractErrorDetails(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
  return {
    error: readString(nested.message) ?? readString(payload.message),
    errorCode: readString(nested.code) ?? readString(payload.code),
  };
}

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
  shutdownGraceMs = 3_000,
  // Absolute directory under which per-run event JSONL logs are written
  // (one file per run at <runsLogDir>/<runId>/events.jsonl). When null,
  // event persistence is disabled and statusBody.eventsLogPath = null —
  // legacy behavior. The path is surfaced through MCP get_run so an
  // external coding agent can `tail` the file in its own shell during
  // a long Readable Studio generation, instead of polling blindly and giving up.
  runsLogDir = null,
}: ChatRunServiceOptions) {
  const runs = new Map();
  const retiringRunIds = new Set<string>();
  const resolvedRunsLogDir = runsLogDir ? path.resolve(runsLogDir) : null;

  const samePath = (left: string, right: string): boolean => (
    process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  );

  const removeRunLogDirectory = (run): void => {
    if (!resolvedRunsLogDir || !run.eventsLogPath) return;
    const runLogDir = path.dirname(path.resolve(run.eventsLogPath));
    if (path.relative(resolvedRunsLogDir, runLogDir) !== run.id) return;
    try {
      const entry = fs.lstatSync(runLogDir, { throwIfNoEntry: false });
      if (!entry?.isDirectory() || entry.isSymbolicLink()) return;
      const realRoot = fs.realpathSync.native(resolvedRunsLogDir);
      const realRunLogDir = fs.realpathSync.native(runLogDir);
      if (!samePath(path.dirname(realRunLogDir), realRoot)) return;
      fs.rmSync(runLogDir, { recursive: true, force: true });
    } catch {
      // Log retirement is best-effort; a transient filesystem failure must
      // not keep a terminal run in the in-memory registry indefinitely.
    }
  };

  const createRun = (id, meta = {}) => {
    const now = Date.now();
    if (runs.has(id) || retiringRunIds.has(id)) throw new Error(`Run already exists: ${id}`);
    const run = {
      id,
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      projectMetadata:
        meta.projectMetadata && typeof meta.projectMetadata === 'object' && !Array.isArray(meta.projectMetadata)
          ? meta.projectMetadata
          : null,
      // Plan §3.A1 / spec §11.5. The applied plugin snapshot id pins
      // every prompt fragment and tool gate to a frozen view so replay
      // is byte-equal across plugin upgrades. Runs are in-memory in
      // v1 — the id lives on the run object plus on the
      // `applied_plugin_snapshots` row (FK back via run_id).
      appliedPluginSnapshotId:
        typeof meta.appliedPluginSnapshotId === 'string' && meta.appliedPluginSnapshotId
          ? meta.appliedPluginSnapshotId
          : null,
      pluginId:
        typeof meta.pluginId === 'string' && meta.pluginId ? meta.pluginId : null,
      toolBundle: normalizeRunToolBundleForRun(meta.toolBundle),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: null,
      signal: null,
      error: null,
      errorCode: null,
      cancelRequested: false,
      eventsLogPath: resolvedRunsLogDir ? path.join(resolvedRunsLogDir, id, 'events.jsonl') : null,
      eventsLogStream: null,
      eventsLogClosePromise: null,
      pendingDelta: null,
      cleanupTimer: null,
      abortFallbackTimer: null,
    };
    runs.set(run.id, run);
    return run;
  };

  const create = (meta = {}) => createRun(randomUUID(), meta);

  const createWithId = (id, meta = {}) => {
    if (
      typeof id !== 'string'
      || !/^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$)[a-z0-9][a-z0-9_-]{0,127}$/u.test(id)
    ) {
      throw new Error('Run id is invalid');
    }
    return createRun(id, meta);
  };

  const get = (id) => runs.get(id) ?? null;

  // Lazily open the per-run event log on first emit. The directory may
  // not exist yet; mkdir is recursive so it's safe to call repeatedly.
  // Disk failures are best-effort — if we can't write, the run still
  // proceeds (SSE clients keep getting events from memory).
  const ensureLogStream = (run) => {
    if (!run.eventsLogPath) return null;
    if (run.eventsLogStream) return run.eventsLogStream;
    try {
      fs.mkdirSync(path.dirname(run.eventsLogPath), { recursive: true });
      const stream = fs.createWriteStream(run.eventsLogPath, { flags: 'a' });
      run.eventsLogStream = stream;
      // Don't crash the daemon on a stream-level error; just stop
      // trying to use this stream so subsequent emits silently skip.
      stream.on('error', () => {
        try { stream.destroy(); } catch { /* ignore */ }
        if (run.eventsLogStream === stream) run.eventsLogStream = null;
      });
      return stream;
    } catch {
      return null;
    }
  };

  const closeLogStream = (run): Promise<void> | null => {
    if (run.eventsLogClosePromise) return run.eventsLogClosePromise;
    const stream = run.eventsLogStream;
    run.eventsLogStream = null;
    if (!stream) return null;
    if (!run.eventsLogPath || typeof stream.once !== 'function') {
      try { stream.end(); } catch { /* ignore */ }
      return null;
    }

    run.eventsLogClosePromise = new Promise<void>((resolve) => {
      let settled = false;
      const onClosed = () => {
        if (settled) return;
        settled = true;
        run.eventsLogClosePromise = null;
        resolve();
      };
      stream.once('close', onClosed);
      try { stream.end(); } catch { onClosed(); }
    });
    return run.eventsLogClosePromise;
  };

  const retireRun = (run): void => {
    runs.delete(run.id);
    if (!run.eventsLogPath) {
      closeLogStream(run);
      return;
    }
    retiringRunIds.add(run.id);
    const finishRetirement = () => {
      removeRunLogDirectory(run);
      retiringRunIds.delete(run.id);
    };
    const closing = closeLogStream(run);
    if (closing) void closing.then(finishRetirement, finishRetirement);
    else finishRetirement();
  };

  const scheduleCleanup = (run) => {
    run.cleanupTimer = setTimeout(() => {
      run.cleanupTimer = null;
      if (TERMINAL_RUN_STATUSES.has(run.status)) retireRun(run);
    }, ttlMs);
    run.cleanupTimer.unref?.();
  };

  const writeRecord = (run, event, data) => {
    const id = run.nextEventId++;
    const record = { id, event, data, timestamp: Date.now() };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    const stream = ensureLogStream(run);
    if (stream) {
      try {
        stream.write(JSON.stringify(record) + '\n');
      } catch {
        // Stream-level write errors are caught by the on('error') above;
        // swallowing here keeps the SSE fan-out below from being skipped.
      }
    }
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const flushPendingDelta = (run) => {
    const pending = run.pendingDelta;
    if (!pending) return null;
    if (pending.timer) clearTimeout(pending.timer);
    run.pendingDelta = null;
    return writeRecord(run, pending.event, { ...pending.data, delta: pending.delta });
  };

  const deltaBatchKey = (data) => {
    const { delta: _delta, ...rest } = data;
    return JSON.stringify(rest);
  };

  const emit = (run, event, data) => {
    if (event === 'error') {
      const details = extractErrorDetails(data);
      if (details.error) run.error = details.error;
      if (details.errorCode) run.errorCode = details.errorCode;
    }
    const isDelta = event === 'agent'
      && (data?.type === 'text_delta' || data?.type === 'thinking_delta')
      && typeof data.delta === 'string';
    if (isDelta) {
      const batchKey = deltaBatchKey(data);
      const pending = run.pendingDelta;
      if (pending && pending.batchKey === batchKey) {
        pending.delta += data.delta;
        return pending;
      }
      flushPendingDelta(run);
      run.pendingDelta = {
        event,
        data: { ...data, delta: '' },
        delta: data.delta,
        batchKey,
        timer: setTimeout(() => flushPendingDelta(run), 32),
      };
      run.pendingDelta.timer.unref?.();
      return run.pendingDelta;
    }
    flushPendingDelta(run);
    return writeRecord(run, event, data);
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    appliedPluginSnapshotId: run.appliedPluginSnapshotId ?? null,
    pluginId: run.pluginId ?? null,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    resumable: run.resumable ?? false,
    eventsLogPath: run.eventsLogPath ?? null,
    toolBundle: summarizeRunToolBundle(run.toolBundle),
  });

  const finish = (run, status, code: number | null = null, signal: string | null = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    if (run.abortFallbackTimer) clearTimeout(run.abortFallbackTimer);
    run.abortFallbackTimer = null;
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    emit(run, 'end', { code, signal, status, resumable: run.resumable ?? false });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    // Close the event log stream now that no more events will be emitted.
    // The file remains available for tail/grep until terminal-run TTL expiry.
    closeLogStream(run);
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    run.analyticsTelemetry = {
      ...(run.analyticsTelemetry ?? {}),
      startRequestedAt: Date.now(),
    };
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventId = Number(req.get('Last-Event-ID') || req.query.after || 0);
    let sent = 0;
    for (const record of run.events) {
      if (!Number.isFinite(lastEventId) || record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
        sent++;
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      // Guarantee a reattaching client sees a terminal signal even if its
      // cursor is at or past the final event id — otherwise the SSE
      // stream ends silently and the client falls back to status-only fetch.
      if (sent === 0 && run.events.length > 0) {
        const last = run.events[run.events.length - 1];
        sse.send(last.event, last.data, last.id);
      }
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const reconcileExitedChild = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    const child = run.child;
    if (!child || (child.exitCode === null && child.signalCode === null)) return;
    const nextStatus = run.cancelRequested
      ? 'canceled'
      : child.exitCode === 0
        ? 'succeeded'
        : 'failed';
    finish(run, nextStatus, child.exitCode, child.signalCode ?? null);
  };

  const list = ({ projectId, conversationId, status } = {}) => Array.from(runs.values()).filter((run) => {
    reconcileExitedChild(run);
    if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
    if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
    if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
    if (typeof status === 'string' && status) return run.status === status;
    return true;
  });

  const waitForChildExit = (child, timeoutMs) => {
    if (!child) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('close', onClose);
        child.off?.('exit', onClose);
        resolve(exited);
      };
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      child.once?.('close', onClose);
      child.once?.('exit', onClose);
    });
  };

  const killChild = (run, signal) => {
    if (!run.child || run.child.exitCode !== null || run.child.signalCode !== null) return false;
    try {
      return run.child.kill(signal);
    } catch {
      return false;
    }
  };

  const cancel = (run) => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      // Prefer RPC-level abort for agents that support it. Pi owns its full
      // settle/state/SIGTERM/SIGKILL lifecycle; ACP still needs this caller's
      // process-signal fallback.
      if (run.acpSession?.abort) {
        run.acpSession.abort();
        if (
          run.acpSession.ownsAbortLifecycle !== true
          && !TERMINAL_RUN_STATUSES.has(run.status)
        ) {
          const graceMs = Number(process.env.PI_ABORT_GRACE_MS) || 3000;
          if (run.abortFallbackTimer) clearTimeout(run.abortFallbackTimer);
          run.abortFallbackTimer = setTimeout(() => {
            run.abortFallbackTimer = null;
            if (run.child && !run.child.killed) run.child.kill('SIGTERM');
          }, graceMs);
          run.abortFallbackTimer.unref?.();
        }
      } else if (run.child && !run.child.killed) {
        run.child.kill('SIGTERM');
      } else {
        finish(run, 'canceled', null, 'SIGTERM');
      }
    }
  };

  const cancelAndWait = async (run, { timeoutMs = 5_000 } = {}) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) killChild(run, 'SIGTERM');
    else cancel(run);
    return waitForChildExit(run.child, Math.max(0, timeoutMs));
  };

  const shutdownActive = async ({ graceMs = shutdownGraceMs } = {}) => {
    const activeRuns = Array.from(runs.values()).filter((run) => !TERMINAL_RUN_STATUSES.has(run.status));
    await Promise.all(activeRuns.map(async (run) => {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      if (run.acpSession?.abort) {
        try {
          run.acpSession.abort();
        } catch {
          // Process signals below are the shutdown fallback.
        }
      }
      killChild(run, 'SIGTERM');
      finish(run, 'canceled', null, 'SIGTERM');
      if (run.child && !(await waitForChildExit(run.child, graceMs))) {
        killChild(run, 'SIGKILL');
        await waitForChildExit(run.child, 500);
      }
    }));
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  const disposeRun = (run) => {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = null;
    if (run.abortFallbackTimer) clearTimeout(run.abortFallbackTimer);
    run.abortFallbackTimer = null;
    if (run.pendingDelta?.timer) clearTimeout(run.pendingDelta.timer);
    run.pendingDelta = null;
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.status = 'canceled';
      run.cancelRequested = true;
      run.updatedAt = Date.now();
    }
    for (const sse of run.clients) {
      try { sse.end(); } catch { /* best-effort detach */ }
    }
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    retireRun(run);
  };

  const dispose = () => {
    for (const run of runs.values()) disposeRun(run);
  };

  // Drop a run from the in-memory registry without emitting any terminal
  // event. Used by callers that prepared a run optimistically (created the
  // record before some external precondition was checked) and need to undo
  // the create without surfacing the run via `/api/runs`. Only valid before
  // the run reaches a terminal status — terminal runs use scheduleCleanup
  // and would already have notified any subscribers.
  const drop = (run) => {
    if (!run) return;
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    // Resolve any pending waiters with a synthetic "canceled" status so
    // they unblock instead of hanging forever — the run is being dropped
    // because nothing will ever start.
    disposeRun(run);
  };

  return {
    create,
    createWithId,
    start,
    get,
    list,
    stream,
    cancel,
    cancelAndWait,
    shutdownActive,
    wait,
    emit,
    finish,
    fail,
    drop,
    dispose,
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
  };
}
