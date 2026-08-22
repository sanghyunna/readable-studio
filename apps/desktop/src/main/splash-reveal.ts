export type SplashRevealReadiness = {
  appMounted: boolean;
  deadlineReached: boolean;
  splashFinished: boolean;
};

export function shouldFinishSplashPolling(readiness: SplashRevealReadiness): boolean {
  return readiness.deadlineReached || (readiness.appMounted && readiness.splashFinished);
}

export function remainingSplashHoldMs(
  startedAt: number,
  now: number,
  minimumHoldMs: number,
): number {
  return Math.max(0, minimumHoldMs - (now - startedAt));
}
