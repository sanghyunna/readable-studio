import type { AgentScanProgress } from '@readable-studio/contracts';

export type ScanProgress = Pick<AgentScanProgress, 'phase' | 'currentAgentName' | 'completed' | 'total'>;

export type SplashHost = {
  readonly startedAt: number;
  readonly isStopped: () => boolean;
  readonly readReadiness: () => Promise<{ readonly appMounted: boolean; readonly splashFinished: boolean }>;
  readonly readScan: () => Promise<ScanProgress | null>;
  readonly executeSplash: (script: string) => Promise<unknown>;
  readonly reveal: () => void;
};

export async function runStartupSplash(host: SplashHost): Promise<'ready' | 'unverified' | 'stopped'> {
  const normalDeadline = Date.now() + 15_000;
  const scanDeadline = Math.max(normalDeadline, host.startedAt + 60_000);
  let deadline = normalDeadline;
  let settled = false;
  let verified = false;
  let readingScan = false;
  let readingReadiness = false;
  let appMounted = false;
  let splashFinished = false;
  let nextScanAt = 0;
  let active = true;
  let label: string | null = null;
  let pushedLabel: string | null | undefined;
  let pushing = false;
  // Reads deliberately run beside the clock: a hung HTTP request or renderer
  // must not suspend the reveal ceiling. Late results cannot change the outcome.
  while (!host.isStopped()) {
    const now = Date.now();
    if (now >= deadline) break;
    if (!readingReadiness) {
      readingReadiness = true;
      void host.readReadiness().then((value) => {
        appMounted = value.appMounted;
        splashFinished = value.splashFinished;
      }, () => { appMounted = false; }).finally(() => { readingReadiness = false; });
    }
    if (!settled && !readingScan && now >= nextScanAt) {
      readingScan = true;
      nextScanAt = now + 320;
      void host.readScan().then((scan) => {
        if (!active) return;
        if (scan === null) {
          settled = true;
          verified = true;
          return;
        }
        switch (scan.phase) {
          case 'running':
            deadline = scanDeadline;
            label = `Checking ${scan.currentAgentName ?? 'agents'} (${scan.completed}/${scan.total})`;
            break;
          case 'done':
            settled = scan.completed === scan.total;
            verified = settled;
            label = settled ? 'Agent scan complete' : 'Agent checks incomplete';
            break;
          case 'cancelled':
          case 'failed':
            settled = true;
            label = 'Agent checks incomplete - opening Readable Studio';
            break;
          default: {
            const unreachable: never = scan.phase;
            throw new TypeError(`Unknown scan phase: ${unreachable}`);
          }
        }
      }, () => {
        label = 'Agent checks unavailable - opening Readable Studio';
      }).finally(() => { readingScan = false; });
    }
    if (!pushing && label !== pushedLabel) {
      pushing = true;
      const text = label;
      void host.executeSplash(`window.__readableSplash.setProgress(${JSON.stringify(text)})`).then(() => {
        pushedLabel = text;
      }, () => { /* Document may still be loading; retry on the next tick. */ }).finally(() => { pushing = false; });
    }
    if (appMounted && splashFinished && settled && now - host.startedAt >= 6800) {
      active = false;
      host.reveal();
      return verified ? 'ready' : 'unverified';
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(80, deadline - now)));
  }
  active = false;
  if (host.isStopped()) return 'stopped';
  // Do not await a potentially hung splash renderer on the fallback path.
  void host.executeSplash('window.__readableSplash.setProgress("Agent checks incomplete - opening Readable Studio")')
    .catch((error: unknown) => console.warn('splash progress unavailable', { error: error instanceof Error ? error.message : String(error) }));
  host.reveal();
  return 'unverified';
}
