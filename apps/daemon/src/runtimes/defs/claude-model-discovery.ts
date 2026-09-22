import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createAgentCommandInvocation } from '../invocation.js';
import { DEFAULT_MODEL_OPTION } from '../models.js';
import type { RuntimeEnv, RuntimeModelOption } from '../types.js';

const REQUEST_ID = 'models-capability-check';
const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config'];

type DiscoveryOptions = { readonly signal?: AbortSignal; readonly timeoutMs?: number };

class ClaudeDiscoveryError extends Error {
  constructor(readonly reason: 'timeout' | 'exit' | 'protocol', detail: string) {
    super(detail);
    this.name = 'ClaudeDiscoveryError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function controlResponse(line: string): Record<string, unknown> | null {
  let message: unknown;
  try { message = JSON.parse(line); } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!record(message) || message.type !== 'control_response' || !record(message.response)) return null;
  return message.response.request_id === REQUEST_ID ? message.response : null;
}

/** CLI selector ids, not resolved inference ids or proof of account entitlement. */
export function parseClaudeModelCatalog(stdout: string): RuntimeModelOption[] | null {
  for (const line of stdout.split(/\r?\n/)) {
    const response = controlResponse(line);
    if (!response || response.subtype !== 'success' || !record(response.response)) continue;
    if (!Array.isArray(response.response.models)) return null;
    const models = [DEFAULT_MODEL_OPTION];
    const seen = new Set([DEFAULT_MODEL_OPTION.id]);
    for (const entry of response.response.models) {
      if (!record(entry) || typeof entry.value !== 'string' || !entry.value.trim() || seen.has(entry.value)) continue;
      seen.add(entry.value);
      models.push({ id: entry.value, label: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : entry.value });
    }
    return models.length > 1 ? models : null;
  }
  return null;
}

/** Read-only initialize request; no user message or interactive session is sent. */
export async function discoverClaudeCatalog(bin: string, env: RuntimeEnv, options: DiscoveryOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const invocation = createAgentCommandInvocation(bin, PROBE_ARGS, env);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';
    const finish = (result: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      lines.close();
      child.stdin.end();
      // SIGKILL is deliberate: a read-only probe must not survive its deadline.
      child.kill('SIGKILL');
      if (typeof result === 'string') resolve(result); else reject(result);
    };
    const abort = () => finish(options.signal?.reason instanceof Error
      ? options.signal.reason : new DOMException('Model discovery aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new ClaudeDiscoveryError('timeout', 'Model discovery timed out')), options.timeoutMs ?? 10_000);
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', () => finish(new ClaudeDiscoveryError('exit', `Claude exited before discovery: ${stderr}`)));
    lines.on('line', (line) => {
      const response = controlResponse(line);
      if (!response) return;
      if (response.subtype !== 'success') {
        finish(new ClaudeDiscoveryError('protocol', typeof response.error === 'string' ? response.error : 'Claude initialize rejected'));
        return;
      }
      finish(line);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    child.stdin.end(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
  });
}
