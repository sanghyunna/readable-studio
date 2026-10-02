import { AsyncLocalStorage } from 'node:async_hooks';
import { ChildProcess, execFile } from 'node:child_process';
import { subscribe } from 'node:diagnostics_channel';

type ProbeLifetime = { readonly signal: AbortSignal; readonly children: Set<Promise<void>>; readonly cleanup: Set<Promise<void>> };
const lifetimes = new AsyncLocalStorage<ProbeLifetime>();

export function terminateProbeTree(child: ChildProcess, kill = child.kill.bind(child)): Promise<void> {
  // Cleanup commands must not become children of the probe they are cleaning up.
  return lifetimes.exit(async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DOMException('Probe process-tree cleanup timed out', 'TimeoutError')), 2250);
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, (error) => {
          clearTimeout(timer);
          if (!error || child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(error);
        });
      });
    } else {
      // Walk descendants before killing the parent, while ancestry is intact.
      const listing = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DOMException('Probe process-tree cleanup timed out', 'TimeoutError')), 2250);
        execFile('ps', ['-eo', 'pid=,ppid='], { timeout: 2000 }, (error, stdout) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const rows = listing.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const descendants = (pid: number): number[] => rows.filter(row => row[1] === pid).flatMap(row => [...descendants(row[0]!), row[0]!]);
      for (const pid of descendants(child.pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      kill('SIGKILL');
    }
  });
}

// Node publishes this built-in channel before spawn. Scoping at this boundary
// covers custom adapter transports (including ACP), not only execAgentFile.
subscribe('child_process', (message: unknown) => {
  const lifetime = lifetimes.getStore();
  if (!lifetime || typeof message !== 'object' || message === null || !('process' in message) || !(message.process instanceof ChildProcess)) return;
  const child = message.process;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    stopping = terminateProbeTree(child);
    lifetime.cleanup.add(stopping);
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
  const lifetime: ProbeLifetime = { signal, children: new Set(), cleanup: new Set() };
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
    // Cancellation does not depend on close or adapter cooperation. Cleanup
    // itself is bounded and joined before returning to the scan owner.
    return await Promise.race([completed, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    await Promise.all(lifetime.cleanup);
  }
}
