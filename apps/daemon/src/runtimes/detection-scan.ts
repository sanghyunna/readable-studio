import { availableParallelism } from 'node:os';
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
  // A probe can spawn version/help/auth/model commands. Use at most half the
  // available CPUs, capped at four agents, to leave headroom for UI and VDI AV.
  const concurrency = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
  const active = new Set<RuntimeAgentDef>();
  let next = 0;
  const fail = (error: unknown) => {
    if (progress.phase !== 'running') return;
    progress = { ...progress, phase: signal?.aborted ? 'cancelled' : 'failed', currentAgentId: null, currentAgentName: null };
    for (const job of jobs) job.reject(error);
  };
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { fail(signal?.reason); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  // A pre-aborted or empty session may have no worker to observe the rejection.
  void Promise.allSettled([aborted]);
  if (signal?.aborted) onAbort();
  const worker = async () => {
    try {
      while (progress.phase === 'running') {
        const job = jobs[next++];
        if (!job) return;
        active.add(job.def);
        const current = active.values().next().value;
        progress = { ...progress, currentAgentId: current?.id ?? null, currentAgentName: current?.name ?? null };
        const agent = await Promise.race([probe(job.def), aborted]);
        if (progress.phase !== 'running') return;
        active.delete(job.def);
        const oldest = active.values().next().value;
        const completed = progress.completed + 1;
        progress = { ...progress, completed, phase: completed === jobs.length ? 'done' : 'running',
          currentAgentId: oldest?.id ?? null, currentAgentName: oldest?.name ?? null };
        job.resolve(agent);
      }
    } catch (error) {
      // Session boundary: active and queued consumers all settle on failure.
      fail(error);
    }
  };
  if (jobs.length === 0 && progress.phase === 'running') progress = { ...progress, phase: 'done' };
  void Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
    .finally(() => signal?.removeEventListener('abort', onAbort));
  return session;
}
