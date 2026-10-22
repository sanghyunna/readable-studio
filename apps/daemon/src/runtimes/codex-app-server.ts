import { execFile, type ChildProcess } from 'node:child_process';
import { missingDocumentArtifact, documentRecoveryPrompt } from '../document-completion.js';
import { attachCodexAppServerClient, codexRecord, CodexRpcError } from './codex-app-server-client.js';
import { codexNeedsDangerFullAccessSandbox } from './defs/codex.js';

/** Marks the one in-thread delivery failure the daemon reports as DOCUMENT_NOT_SAVED. */
export class CodexDocumentNotSavedError extends CodexRpcError {
  readonly code = 'DOCUMENT_NOT_SAVED';
  constructor() {
    super('Document generation completed without saving index.html in the project root.');
    this.name = 'CodexDocumentNotSavedError';
  }
}

type SessionOptions = {
  readonly child: ChildProcess;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string;
  readonly resumeSessionId?: string;
  readonly refreshAuth?: boolean;
  readonly expectedArtifactPath?: string;
  readonly onEvent: (event: Record<string, unknown>) => void;
};

/** A composed prompt or continuation in a persistent thread; never chooses a default model. */
export function attachCodexAppServerSession(options: SessionOptions) {
  const { child, onEvent } = options;
  const stdin = child.stdin;
  if (!stdin) throw new CodexRpcError('App-server requires piped stdin');
  let phase: 'initialize' | 'account' | 'thread' | 'turn' = 'initialize';
  let expectedId = 1;
  let finished = false;
  let fatal = false;
  let aborted = false;
  let threadId = '';
  let turnId = '';
  let artifactRecoveryAttempted = false;
  let turnText = '';
  const textByItem = new Map<string, string>();
  const reasoningByItem = new Map<string, { summary: Map<number, string>; content: Map<number, string>; completed: boolean }>();
  let lastReasoningPart = '';
  const reasoningItem = (id: string) => {
    let item = reasoningByItem.get(id);
    if (!item) { item = { summary: new Map(), content: new Map(), completed: false }; reasoningByItem.set(id, item); }
    return item;
  };
  const emitReasoning = (id: string, index: number, delta: string) => {
    if (!delta) return;
    const key = JSON.stringify([id, index]);
    onEvent({ type: 'thinking_delta', delta: (lastReasoningPart && lastReasoningPart !== key ? '\n\n' : '') + delta });
    lastReasoningPart = key;
  };
  let previousSummary: string | undefined;
  let activeSummary: { id: string; index: number; text: string; emitted: number } | undefined;
  const finishSummary = () => {
    if (!activeSummary) return;
    const { id, index, text, emitted } = activeSummary;
    if (text.trim() !== previousSummary) emitReasoning(id, index, text.slice(emitted));
    previousSummary = text.trim();
    activeSummary = undefined;
  };
  const emitSummary = (id: string, index: number, delta: string) => {
    if (!delta) return;
    if (activeSummary && (activeSummary.id !== id || activeSummary.index !== index)) finishSummary();
    activeSummary ??= { id, index, text: '', emitted: 0 };
    activeSummary.text += delta;
    // Hold only a possible duplicate prefix. Once it differs, stream normally.
    if (activeSummary.emitted || previousSummary === undefined || !previousSummary.startsWith(activeSummary.text.trim())) {
      emitReasoning(id, index, activeSummary.text.slice(activeSummary.emitted));
      activeSummary.emitted = activeSummary.text.length;
    }
  };
  const endThinkingBlock = () => {
    finishSummary();
    previousSummary = undefined;
    lastReasoningPart = '';
  };
  const flushRawReasoning = (id: string) => {
    const item = reasoningItem(id);
    if (item.summary.size === 0 && !item.completed) {
      finishSummary();
      previousSummary = undefined;
      for (const [index, text] of item.content) emitReasoning(id, index, text);
    }
    item.completed = true;
  };
  let lastTextItem = '';
  let lastText = '';
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateOwnedTree = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
        if (error && child.exitCode === null && child.signalCode === null) onEvent({ type: 'error', message: `Codex shutdown failed: ${error.message}` });
      });
    } else child.kill('SIGTERM');
  };
  const boundShutdown = () => { shutdownTimer ??= setTimeout(terminateOwnedTree, 5000); };
  const stop = () => { clearTimeout(timer); stdin.end(); boundShutdown(); };
  const fail = (error: Error) => {
    if (finished || aborted) return;
    fatal = true;
    finished = true;
    onEvent({ type: 'error', message: error.message, ...(error instanceof CodexDocumentNotSavedError ? { code: error.code } : {}) });
    stop();
  };
  const timer = setTimeout(() => fail(new CodexRpcError('App-server initialization timed out')), 30_000);
  const emitText = (id: string, delta: string) => {
    if (!delta) return;
    const boundary = lastTextItem && lastTextItem !== id && !lastText.endsWith('\n') && !delta.startsWith('\n') ? '\n' : '';
    endThinkingBlock();
    turnText += boundary + delta;
    onEvent({ type: 'text_delta', delta: boundary + delta });
    lastTextItem = id;
    lastText = delta;
  };
  const startThread = () => {
    phase = 'thread';
    const params = { model: options.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: codexNeedsDangerFullAccessSandbox() ? 'danger-full-access' : 'workspace-write' };
    expectedId = options.resumeSessionId
      ? client.request('thread/resume', { ...params, threadId: options.resumeSessionId })
      : client.request('thread/start', { ...params, ephemeral: false });
  };
  const client = attachCodexAppServerClient(child, message => {
    if (finished) return;
    const params = codexRecord(message.params);
    if (aborted) {
      if (message.method === 'turn/completed') { finished = true; stop(); }
      return;
    }
    if (message.id === expectedId && !message.method) {
      if (message.error) { fail(new CodexRpcError(String(codexRecord(message.error).message ?? 'App-server request rejected'))); return; }
      const result = codexRecord(message.result);
      switch (phase) {
        case 'initialize':
          client.notify('initialized', {});
          if (options.refreshAuth) {
            phase = 'account';
            expectedId = client.request('account/read', { refreshToken: true });
          } else startThread();
          return;
        case 'account':
          if (!result.account && result.requiresOpenaiAuth !== false) { fail(new CodexRpcError('Authentication required')); return; }
          startThread();
          return;
        case 'thread': {
          const thread = codexRecord(result.thread);
          if (typeof thread.id !== 'string' || !thread.id.trim()) { fail(new CodexRpcError('Missing app-server thread ID')); return; }
          threadId = thread.id;
          onEvent({ type: 'status', label: 'thread_started', threadId });
          phase = 'turn';
          expectedId = client.request('turn/start', { threadId, input: [{ type: 'text', text: options.prompt }] });
          return;
        }
        case 'turn':
          clearTimeout(timer);
          turnId = String(codexRecord(result.turn).id ?? '');
          return;
        default: { const unreachable: never = phase; throw new CodexRpcError(String(unreachable)); }
      }
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      // No unattended approval/input requests may hang a run.
      stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are unsupported' } })}\n`);
      fail(new CodexRpcError(`Unsupported app-server request: ${message.method}`));
      return;
    }
    switch (message.method) {
      case 'turn/started': onEvent({ type: 'status', label: 'running' }); break;
      case 'item/agentMessage/delta': {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string') break;
        textByItem.set(params.itemId, (textByItem.get(params.itemId) ?? '') + params.delta);
        emitText(params.itemId, params.delta);
        break;
      }
      case 'item/started':
      case 'item/completed': {
        const item = codexRecord(params.item);
        const id = String(item.id ?? '');
        if (item.type === 'agentMessage' && message.method === 'item/completed' && typeof item.text === 'string') {
          const prior = textByItem.get(id) ?? '';
          if (item.text.startsWith(prior)) emitText(id, item.text.slice(prior.length));
          textByItem.set(id, item.text);
        }
        if (item.type === 'reasoning' && message.method === 'item/completed') {
          const reasoning = reasoningItem(id);
          if (!reasoning.completed) {
            if (Array.isArray(item.summary)) item.summary.forEach((text, index) => {
              if (typeof text !== 'string') return;
              const prior = reasoning.summary.get(index) ?? '';
              if (text.startsWith(prior)) emitSummary(id, index, text.slice(prior.length));
              reasoning.summary.set(index, text);
            });
            if (Array.isArray(item.content)) item.content.forEach((text, index) => {
              if (typeof text === 'string') reasoning.content.set(index, text);
            });
            if (activeSummary?.id === id) finishSummary();
            flushRawReasoning(id);
          }
        }
        if (item.type === 'commandExecution') {
          endThinkingBlock();
          if (message.method === 'item/started') onEvent({ type: 'tool_use', id, name: 'Bash', input: { command: item.command } });
          else onEvent({ type: 'tool_result', toolUseId: id, content: item.aggregatedOutput ?? '', isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) });
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string') break;
        const item = reasoningItem(params.itemId);
        if (item.completed) break;
        const summary = message.method === 'item/reasoning/summaryTextDelta';
        const index = Number(summary ? params.summaryIndex ?? 0 : params.contentIndex ?? 0);
        const parts = summary ? item.summary : item.content;
        parts.set(index, (parts.get(index) ?? '') + params.delta);
        // Raw reasoning may precede a summary of the same item; prefer the summary.
        if (summary) emitSummary(params.itemId, index, params.delta);
        break;
      }
      case 'thread/tokenUsage/updated': {
        const usage = codexRecord(codexRecord(params.tokenUsage).last);
        onEvent({ type: 'usage', usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cached_read_tokens: usage.cachedInputTokens, thought_tokens: usage.reasoningOutputTokens } });
        break;
      }
      case 'error':
        if (params.willRetry !== true) fail(new CodexRpcError(String(codexRecord(params.error).message ?? 'Codex turn failed')));
        break;
      case 'turn/completed': {
        const turn = codexRecord(params.turn);
        if (turn.status !== 'completed') { fail(new CodexRpcError(String(codexRecord(turn.error).message ?? `Codex turn ${String(turn.status)}`))); return; }
        finishSummary();
        for (const id of reasoningByItem.keys()) flushRawReasoning(id);
        const artifact = options.expectedArtifactPath;
        if (artifact && missingDocumentArtifact(artifact, turnText)) {
          if (artifactRecoveryAttempted) {
            fail(new CodexDocumentNotSavedError());
            return;
          }
          // A completed model turn is not delivery. Keep the same thread so
          // failed writes and the original brief remain available for repair.
          artifactRecoveryAttempted = true;
          turnText = '';
          endThinkingBlock();
          expectedId = client.request('turn/start', { threadId, input: [{ type: 'text', text: documentRecoveryPrompt(artifact) }] });
          return;
        }
        finished = true;
        stop();
        break;
      }
    }
  }, fail);
  child.once('close', () => {
    clearTimeout(timer);
    clearTimeout(shutdownTimer);
    // Preserve the caller's isolation-fallback and exit diagnostics on early exit.
    if (!finished && !aborted) fatal = true;
  });
  if (!options.model || options.model === 'default') fail(new CodexRpcError('An explicit Codex model is required'));
  else expectedId = client.initialize('readable-studio');
  return {
    hasFatalError: () => fatal,
    completedSuccessfully: () => finished && !fatal && !aborted,
    getSessionId: () => threadId || undefined,
    ownsAbortLifecycle: true,
    abort() {
      if (aborted) return;
      aborted = true;
      clearTimeout(timer);
      if (threadId && turnId && !stdin.destroyed && !stdin.writableEnded) {
        client.request('turn/interrupt', { threadId, turnId });
        boundShutdown();
      } else stop();
    },
  };
}
