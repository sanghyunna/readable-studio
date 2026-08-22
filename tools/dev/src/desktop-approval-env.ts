import { randomBytes } from "node:crypto";

import { APP_KEYS, SIDECAR_ENV, type AppKey } from "@readable-studio/sidecar-proto";

export function createDesktopApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

export function stripDesktopApprovalToken(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN) delete env[key];
  }
}

/** Remove inherited bearers, then add the coordinated token to daemon/desktop only. */
export function desktopApprovalChildEnv(
  app: AppKey,
  token: string | null,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  stripDesktopApprovalToken(childEnv);
  if (token && (app === APP_KEYS.DAEMON || app === APP_KEYS.DESKTOP)) {
    childEnv[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN] = token;
  }
  return childEnv;
}
