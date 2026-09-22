import type { AgentScanProgress } from '@readable-studio/contracts';

export type ScanProgress = Pick<AgentScanProgress, 'phase' | 'currentAgentName' | 'completed' | 'total'>;

export type SplashHost = {
  readonly startedAt: number;
  readonly isStopped: () => boolean;
  /** appMounted is true only after both mount and Electron's first render. */
  readonly readReadiness: () => Promise<{ readonly appMounted: boolean; readonly splashFinished: boolean }>;
  readonly readScan: () => Promise<ScanProgress | null>;
  readonly executeSplash: (script: string) => Promise<unknown>;
  readonly reveal: () => void;
  readonly onTimeout: () => void;
};

export async function runStartupSplash(host: SplashHost): Promise<'ready' | 'unverified' | 'stopped'> {
  const deadline = Date.now() + 15_000;
  let settled = false;
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
          return;
        }
        switch (scan.phase) {
          case 'running':
            label = `Checking ${scan.currentAgentName ?? 'agents'} (${scan.completed}/${scan.total})`;
            break;
          case 'done':
            settled = scan.completed === scan.total;
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
    // The painted app and parked animation own reveal, never background discovery.
    if (appMounted && splashFinished) {
      active = false;
      host.reveal();
      return 'ready';
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(80, deadline - now)));
  }
  active = false;
  if (host.isStopped()) return 'stopped';
  // Do not await a potentially hung splash renderer on the fallback path.
  void host.executeSplash('window.__readableSplash.setProgress("Display startup is taking longer than expected")')
    .catch((error: unknown) => console.warn('splash progress unavailable', { error: error instanceof Error ? error.message : String(error) }));
  if (appMounted) host.reveal();
  else host.onTimeout();
  return 'unverified';
}
