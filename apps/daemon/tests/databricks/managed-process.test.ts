import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runDatabricksProcess } from '../../src/databricks/client.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
afterEach(() => vi.restoreAllMocks());

it('launches the native bundled CLI without a shell or visible Windows console and streams its browser URL', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  const onOutput = vi.fn();
  const args = ['auth', 'login', '--host', 'https://workspace.example', '--profile', 'DEFAULT'];
  const result = runDatabricksProcess('D:\\app\\vendor\\databricks\\databricks.exe', args, { signal: controller.signal, timeoutMs: 300_000, onOutput });
  expect(spawn).toHaveBeenCalledWith('D:\\app\\vendor\\databricks\\databricks.exe', args, {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal, timeout: 300_000,
  });
  child.stderr.write('https://workspace.example/oauth/authorize?state=opaque\n');
  child.emit('close', 0);
  expect(await result).toMatchObject({ exitCode: 0 });
  expect(onOutput).toHaveBeenCalledWith('https://workspace.example/oauth/authorize?state=opaque\n');
});
