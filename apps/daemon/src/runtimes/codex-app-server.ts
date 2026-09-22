import { execFile, type ChildProcess } from 'node:child_process';
import { attachCodexAppServerClient, codexRecord, CodexRpcError } from './codex-app-server-client.js';
import { codexNeedsDangerFullAccessSandbox } from './defs/codex.js';

type SessionOptions = {
  readonly child: ChildProcess;
  readonly prompt: string;
  readonly cwd: string;
  readonly model: string;
  readonly onEvent: (event: Record<string, unknown>) => void;
};

/** One composed (bounded-history) prompt per thread; never chooses a default model. */
export function attachCodexAppServerSession(options: SessionOptions) {
  const { child, onEvent } = options;
  const stdin = child.stdin;
  if (!stdin) throw new CodexRpcError('App-server requires piped stdin');
  let phase: 'initialize' | 'thread' | 'turn' = 'initialize';
  let expectedId = 1;
  let finished = false;
  let fatal = false;
  let aborted = false;
  let threadId = '';
  let turnId = '';
  const textByItem = new Map<string, string>();
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
    onEvent({ type: 'error', message: error.message });
    stop();
  };
  const timer = setTimeout(() => fail(new CodexRpcError('App-server initialization timed out')), 30_000);
  const emitText = (id: string, delta: string) => {
    if (!delta) return;
    const boundary = lastTextItem && lastTextItem !== id && !lastText.endsWith('\n') && !delta.startsWith('\n') ? '\n' : '';
    onEvent({ type: 'text_delta', delta: boundary + delta });
    lastTextItem = id;
    lastText = delta;
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
          phase = 'thread';
          expectedId = client.request('thread/start', { model: options.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: codexNeedsDangerFullAccessSandbox() ? 'danger-full-access' : 'workspace-write', ephemeral: true });
          return;
        case 'thread': {
          const thread = codexRecord(result.thread);
          if (typeof thread.id !== 'string') { fail(new CodexRpcError('Missing app-server thread ID')); return; }
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
        if (item.type === 'commandExecution') {
          if (message.method === 'item/started') onEvent({ type: 'tool_use', id, name: 'Bash', input: { command: item.command } });
          else onEvent({ type: 'tool_result', toolUseId: id, content: item.aggregatedOutput ?? '', isError: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) });
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (typeof params.delta === 'string') onEvent({ type: 'thinking_delta', delta: params.delta });
        break;
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
