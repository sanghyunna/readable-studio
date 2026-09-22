import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexRpcMessage = Record<string, unknown>;
export function codexRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
export class CodexRpcError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexRpcError'; }
}

/** Shared JSONL framing and request IDs for discovery and inference. The caller owns the child. */
export function attachCodexAppServerClient(
  child: ChildProcess,
  onMessage: (message: CodexRpcMessage) => void,
  onError: (error: Error) => void,
) {
  let nextId = 1;
  const { stdin, stdout } = child;
  if (!stdin || !stdout) throw new CodexRpcError('App-server requires piped stdin/stdout');
  const lines = createInterface({ input: stdout });
  lines.on('line', line => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch (error) {
      if (error instanceof SyntaxError) { onError(new CodexRpcError('Invalid app-server JSON')); return; }
      throw error;
    }
    onMessage(codexRecord(parsed));
  });
  stdin.on('error', onError);
  child.on('error', onError);
  child.once('close', () => lines.close());
  const notify = (method: string, params: unknown) => {
    stdin.write(`${JSON.stringify({ method, params })}\n`);
  };
  return {
    notify,
    request(method: string, params: unknown) {
      const id = nextId++;
      stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return id;
    },
    initialize(name: string) {
      const id = nextId++;
      stdin.write(`${JSON.stringify({ id, method: 'initialize', params: { clientInfo: { name, version: '1.0.0' } } })}\n`);
      return id;
    },
  };
}
