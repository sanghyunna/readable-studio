import type { AgentScanProgress } from '@readable-studio/contracts';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

type Probe = (def: RuntimeAgentDef) => Promise<DetectedAgent>;
export type StartupScanSession = {
  readonly promises: ReadonlyMap<string, Promise<DetectedAgent>>;
  readonly progress: AgentScanProgress;
};

let latestSession: StartupScanSession | null = null;
export function resetStartupScanProgress(): void { latestSession = null; }
export function getStartupScanProgress(): AgentScanProgress | null {
  return latestSession?.progress ?? null;
}

export function startStartupScan(
  defs: readonly RuntimeAgentDef[],
  probe: Probe,
  signal?: AbortSignal,
): StartupScanSession {
  let progress: AgentScanProgress = {
    phase: 'running', currentAgentId: null, currentAgentName: null,
    completed: 0, total: defs.length,
  };
  const jobs = defs.map((def) => {
    let resolve: (agent: DetectedAgent) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<DetectedAgent>((yes, no) => { resolve = yes; reject = no; });
    return { def, promise, resolve, reject };
  });
  const session: StartupScanSession = {
    promises: new Map(jobs.map(({ def, promise }) => [def.id, promise])),
    get progress() { return progress; },
  };
  latestSession = session;
  // Observe all job rejections even if an SSE consumer disconnects early.
  void Promise.allSettled(jobs.map(({ promise }) => promise));
  void (async () => {
    try {
      for (const job of jobs) {
        signal?.throwIfAborted();
        progress = { ...progress, currentAgentId: job.def.id, currentAgentName: job.def.name };
        let onAbort = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal?.reason);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        let agent: DetectedAgent;
        try {
          agent = await Promise.race([probe(job.def), aborted]);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        progress = { ...progress, completed: progress.completed + 1 };
        job.resolve(agent);
      }
      progress = { ...progress, phase: 'done', currentAgentId: null, currentAgentName: null };
    } catch (error) {
      // Session boundary: every queued consumer must settle on cancellation/error.
      progress = { ...progress, phase: signal?.aborted ? 'cancelled' : 'failed', currentAgentId: null, currentAgentName: null };
      for (const job of jobs) job.reject(error);
    }
  })();
  return session;
}
