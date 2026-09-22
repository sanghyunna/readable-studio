import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess, execFile } from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';

type ProbeLifetime = { readonly signal: AbortSignal; readonly children: Set<Promise<void>> };
const lifetimes = new AsyncLocalStorage<ProbeLifetime>();

// Node publishes this built-in channel before spawn. Scoping at this boundary
// covers custom adapter transports (including ACP), not only execAgentFile.
subscribe('child_process', (message: unknown) => {
  const lifetime = lifetimes.getStore();
  if (!lifetime || typeof message !== 'object' || message === null || !('process' in message) || !(message.process instanceof ChildProcess)) return;
  const child = message.process;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    // Leave the async scope so taskkill is not itself owned by this probe.
    stopping = lifetimes.exit(async () => {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, (error) => {
            if (!error || child.exitCode !== null || child.signalCode !== null) resolve();
            else reject(error);
          });
        });
      } else {
        child.kill('SIGKILL');
      }
    });
    // The lifetime joins cleanup errors below, even when a consumer disconnects.
    void stopping.catch(() => undefined);
  };
  const closed = new Promise<void>((resolve) => child.once('close', resolve));
  child.once('spawn', () => {
    // The diagnostics channel fires at construction, including unstarted mocks
    // and failed spawns. Only a started process has a lifecycle to join.
    lifetime.children.add(completion);
    if (lifetime.signal.aborted) stop();
  });
  lifetime.signal.addEventListener('abort', stop, { once: true });
  const completion = closed.then(async () => {
    lifetime.signal.removeEventListener('abort', stop);
    await stopping;
  });
  // Retain settled completions until the scope joins them, including failures.
  void completion.catch(() => undefined);
});

export async function withProbeLifetime<T>(signal: AbortSignal, probe: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const lifetime: ProbeLifetime = { signal, children: new Set() };
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const completed = lifetimes.run(lifetime, async () => {
    try {
      const result = await probe();
      signal.throwIfAborted();
      return result;
    } finally {
      await Promise.all(lifetime.children);
    }
  });
  try {
    // Cancellation must not depend on close, the adapter, or taskkill's callback.
    // Child abort/spawn listeners still terminate owned processes independently.
    return await Promise.race([completed, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
