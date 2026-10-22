import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabricksServiceError, runDatabricksProcess, withDeadline } from '../../src/databricks/client.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.useRealTimers());

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

  it.each(['ENOENT', 'private-bearer-code'])('retains only allowlisted native codes from a spawn failure (%s)', async (code) => {
    const process = child();
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const completion = runDatabricksProcess('private-executable.exe', [], { signal: new AbortController().signal, timeoutMs: 5000 });
    const failure = completion.catch((error: unknown) => error);
    process.emit('error', Object.assign(new Error('private-executable.exe private-bearer'), { code }));
    const error = await failure;
    expect(error).toBeInstanceOf(DatabricksServiceError);
    expect(error).toMatchObject({ diagnostic: { category: 'spawn', stdoutBytes: 0, stderrBytes: 0 } });
    expect(JSON.stringify(error)).not.toMatch(/private-executable|private-bearer/);
    expect(error instanceof DatabricksServiceError ? error.diagnostic?.nativeCode : undefined).toBe(code === 'ENOENT' ? 'ENOENT' : undefined);
  });

  it('retains the output-limit cause and counts without retaining process output', async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const completion = runDatabricksProcess('private-executable.exe', [], { signal: new AbortController().signal, timeoutMs: 5000 });
    const failure = completion.catch((error: unknown) => error);
    process.stdout.write('private-bearer'.repeat(400_000));
    const error = await failure;
    expect(error).toMatchObject({ diagnostic: { category: 'output-limit', stdoutBytes: 5_600_000, stderrBytes: 0 } });
    expect(JSON.stringify(error)).not.toMatch(/private-executable|private-bearer/);
    expect(process.kill).toHaveBeenCalled();
  });

  it('retains only the abort category and safe native code from a cancelled child', async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValueOnce(process as unknown as ReturnType<typeof spawn>);
    const controller = new AbortController();
    const completion = runDatabricksProcess('private-executable.exe', [], { signal: controller.signal, timeoutMs: 5000 });
    const failure = completion.catch((error: unknown) => error);
    controller.abort('private-bearer');
    process.emit('error', Object.assign(new Error('private-bearer'), { code: 'ABORT_ERR' }));
    const error = await failure;
    expect(error).toMatchObject({ diagnostic: { category: 'aborted', nativeCode: 'ABORT_ERR' } });
    expect(JSON.stringify(error)).not.toMatch(/private-executable|private-bearer/);
  });

  it('distinguishes an outer abort from the CLI deadline without retaining an abort reason', async () => {
    const parent = new AbortController();
    const aborted = withDeadline(() => new Promise(() => {}), 5000, parent.signal);
    const failure = aborted.catch((error: unknown) => error);
    parent.abort('private-bearer abort reason');
    const error = await failure;
    expect(error).toMatchObject({ diagnostic: { category: 'aborted' } });
    expect(JSON.stringify(error)).not.toContain('private-bearer');
    vi.useFakeTimers();
    const timed = withDeadline(() => new Promise(() => {}), 5000).catch((fault: unknown) => fault);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await timed).toMatchObject({ diagnostic: { category: 'timeout' } });
  });
});
