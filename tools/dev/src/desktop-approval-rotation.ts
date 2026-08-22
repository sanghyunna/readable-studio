import { APP_KEYS } from "@readable-studio/sidecar-proto";

export type ApprovalLifecycleApp = (typeof APP_KEYS)[keyof typeof APP_KEYS];

export type ApprovalLifecyclePlan = {
  rotationRequired: boolean;
  startTargets: ApprovalLifecycleApp[];
  stopTargets: ApprovalLifecycleApp[];
};

const START_ORDER: readonly ApprovalLifecycleApp[] = [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP];
const STOP_ORDER: readonly ApprovalLifecycleApp[] = [APP_KEYS.DESKTOP, APP_KEYS.WEB, APP_KEYS.DAEMON];

export function planDesktopApprovalLifecycle(options: {
  daemonRunning: boolean;
  desktopRunning: boolean;
  forceDaemonRestart?: boolean;
  startTargets: readonly ApprovalLifecycleApp[];
  stopTargets?: readonly ApprovalLifecycleApp[];
  webRunning: boolean;
}): ApprovalLifecyclePlan {
  const rotationRequired = (
    options.desktopRunning
    && options.startTargets.includes(APP_KEYS.DAEMON)
    && (options.forceDaemonRestart === true || !options.daemonRunning)
  ) || (
    !options.desktopRunning
    && options.daemonRunning
    && options.startTargets.includes(APP_KEYS.DESKTOP)
  );
  if (!rotationRequired) {
    return {
      rotationRequired,
      startTargets: [...options.startTargets],
      stopTargets: [...(options.stopTargets ?? [])],
    };
  }

  const start = new Set(options.startTargets);
  start.add(APP_KEYS.DAEMON);
  start.add(APP_KEYS.DESKTOP);
  if (options.webRunning) start.add(APP_KEYS.WEB);

  const stop = new Set(options.stopTargets);
  if (options.desktopRunning) stop.add(APP_KEYS.DESKTOP);
  if (options.webRunning) stop.add(APP_KEYS.WEB);
  stop.add(APP_KEYS.DAEMON);

  return {
    rotationRequired,
    startTargets: START_ORDER.filter((app) => start.has(app)),
    stopTargets: STOP_ORDER.filter((app) => stop.has(app)),
  };
}
