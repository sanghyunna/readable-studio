import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeDescriptor } from '@readable-studio/sidecar-proto';
import { requestJsonIpc } from '@readable-studio/sidecar';
import { waitForStatus } from '../src/sidecars.js';

vi.mock('@readable-studio/sidecar', async (importOriginal) => ({
  ...await importOriginal<typeof import('@readable-studio/sidecar')>(),
  requestJsonIpc: vi.fn(),
}));

const childFixture = () => Object.assign(new EventEmitter(), {
  pid: 42, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('slow packaged status IPC', () => {
  it('fails immediately when a child was already terminated by a signal before watching', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    child.signalCode = 'SIGTERM';
    vi.mocked(requestJsonIpc).mockRejectedValue(new Error('IPC endpoint missing'));
    const result = waitForStatus<{ url: string }>('test', status => Boolean(status.url), 900_000, { child, logPath: 'test.log' });
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    await expect(result).rejects.toThrow(/daemon exited before reporting status \(code=null, signal=SIGTERM\)/);
    expect(requestJsonIpc).not.toHaveBeenCalled();
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('accepts readiness after a thirty-five-second event-loop stall', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    vi.mocked(requestJsonIpc).mockImplementation(async (_path, _payload, options) => {
      expect(options?.timeoutMs).toBe(60_000);
      await new Promise(resolve => setTimeout(resolve, 35_000));
      return { descriptor: createRuntimeDescriptor('1.3.5'), pid: child.pid, url: 'http://127.0.0.1:12345' };
    });
    const result = waitForStatus<{ url: string }>('test', status => Boolean(status.url), 900_000, { child, logPath: 'test.log' });
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(result).resolves.toHaveProperty('url', 'http://127.0.0.1:12345');
  });

  it('aborts a pending IPC immediately when its child exits', async () => {
    const child = childFixture();
    let requestSignal: AbortSignal | undefined;
    vi.mocked(requestJsonIpc).mockImplementation((_path, _payload, options) => new Promise((_resolve, reject) => {
      requestSignal = options?.signal;
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }));
    const result = waitForStatus<{ url: string }>('test', status => Boolean(status.url), 900_000, { child, logPath: 'test.log' });
    const rejected = expect(result).rejects.toThrow(/daemon exited before reporting status/);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    expect(requestSignal?.aborted).toBe(true);
    await rejected;
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('aborts pending recovery status when the user closes the app', async () => {
    const child = childFixture();
    const closing = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.mocked(requestJsonIpc).mockImplementation((_path, _payload, options) => new Promise((_resolve, reject) => {
      requestSignal = options?.signal;
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
    }));
    const result = waitForStatus<{ url: string }>('test', status => Boolean(status.url), 900_000, { child, logPath: 'test.log', signal: closing.signal });
    const rejected = expect(result).rejects.toThrow('app closing');
    closing.abort(new Error('app closing'));
    expect(requestSignal?.aborted).toBe(true);
    await rejected;
    expect(child.listenerCount('exit')).toBe(0);
  });
});
