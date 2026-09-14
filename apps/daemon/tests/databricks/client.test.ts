import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runDatabricksProcess } from '../../src/databricks/client.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}

describe('native Databricks process boundary', () => {
  it('uses argument arrays, closed stdin, shell disabled, UTF-8 pipes and a deadline', async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const controller = new AbortController();
    const completion = runDatabricksProcess('C:\\Program Files\\Databricks\\databricks.exe', ['auth', 'token', '--profile', 'Team & profile'], {
      signal: controller.signal, timeoutMs: 5000,
    });
    expect(spawn).toHaveBeenLastCalledWith('C:\\Program Files\\Databricks\\databricks.exe', ['auth', 'token', '--profile', 'Team & profile'], {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: controller.signal, timeout: 5000,
    });
    const text = '{"access_token":"\u03bb"}';
    const bytes = Buffer.from(text, 'utf8');
    const split = bytes.indexOf(0xce) + 1;
    process.stdout.write(bytes.subarray(0, split));
    process.stdout.write(bytes.subarray(split));
    process.stderr.write(Buffer.from('diagnostic', 'utf8'));
    process.emit('close', 0);
    expect(await completion).toEqual({ stdout: text, stderr: 'diagnostic', exitCode: 0 });
  });

  it('sanitizes invocation failures rather than retaining executable paths in errors', async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const completion = runDatabricksProcess('private-executable.exe', [], { signal: new AbortController().signal, timeoutMs: 5000 });
    const failed = expect(completion).rejects.toMatchObject({ message: 'DATABRICKS_UPSTREAM_UNAVAILABLE', code: 'DATABRICKS_UPSTREAM_UNAVAILABLE' });
    process.emit('error', new Error('private-executable.exe failed with private-bearer'));
    await failed;
  });
});
