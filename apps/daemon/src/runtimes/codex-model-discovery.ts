import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createCommandInvocation } from '@readable-studio/platform';
import type { RuntimeEnv } from './types.js';

/** Fresh, account-bound catalogue. No disk cache or static snapshot is trusted. */
export async function discoverCodexCatalog(bin: string, env: RuntimeEnv): Promise<string> {
  const invocation = createCommandInvocation({ command: bin, args: ['app-server', '--listen', 'stdio://'], env });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    let nextId = 1;
    let expectedId = 1;
    let phase: 'initialize' | 'account' | 'models' = 'initialize';
    let outcome: string | Error | undefined;
    let stderr = '';
    const models: unknown[] = [];
    const cursors = new Set<string>();
    const lines = createInterface({ input: child.stdout });
    const finish = (result: string | Error) => {
      if (outcome !== undefined) return;
      outcome = result;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
    };
    const request = (method: string, params: unknown) => {
      expectedId = nextId++;
      child.stdin.write(`${JSON.stringify({ id: expectedId, method, params })}\n`);
    };
    const timer = setTimeout(() => finish(new Error('Model discovery timed out')), 10_000);
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', () => {
      clearTimeout(timer);
      lines.close();
      if (typeof outcome === 'string') resolve(outcome);
      else reject(outcome ?? new Error(`App-server exited before discovery: ${stderr}`));
    });
    lines.on('line', (line) => {
      if (outcome !== undefined) return;
      let message: { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== expectedId) return;
      if (message.error) { finish(new Error(message.error.message ?? 'App-server request rejected')); return; }
      const result = message.result;
      if (!result) { finish(new Error('Invalid app-server response')); return; }
      if (phase === 'initialize') {
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        phase = 'account';
        request('account/read', { refreshToken: false });
      } else if (phase === 'account') {
        if (!result.account) { finish(new Error('Authentication required')); return; }
        phase = 'models';
        request('model/list', { includeHidden: false });
      } else {
        if (!Array.isArray(result.data)) { finish(new Error('Invalid model catalogue')); return; }
        models.push(...result.data);
        const cursor = result.nextCursor;
        if (typeof cursor === 'string' && cursor) {
          if (cursors.has(cursor)) { finish(new Error('Repeated model catalogue cursor')); return; }
          cursors.add(cursor);
          request('model/list', { includeHidden: false, cursor });
        } else {
          finish(JSON.stringify({ data: models }));
        }
      }
    });
    request('initialize', { clientInfo: { name: 'readable-studio-detect', version: '1.0.0' } });
  });
}
