import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_KEYS, SIDECAR_ENV } from "@readable-studio/sidecar-proto";

import {
  createDesktopApprovalToken,
  desktopApprovalChildEnv,
  stripDesktopApprovalToken,
} from "../src/desktop-approval-env.js";

describe("tools-dev desktop approval env", () => {
  it("mints a fresh 32-byte bearer", () => {
    const first = createDesktopApprovalToken();
    const second = createDesktopApprovalToken();

    assert.equal(Buffer.from(first, "base64url").byteLength, 32);
    assert.equal(Buffer.from(second, "base64url").byteLength, 32);
    assert.notEqual(first, second);
  });

  it("distributes one bearer to daemon and desktop but never web", () => {
    const inherited = {
      ReAdAbLe_DeSkToP_ApPrOvAl_ToKeN: "stale-token",
      PATH: "safe",
    };
    const token = "coordinated-token";
    const daemon = desktopApprovalChildEnv(APP_KEYS.DAEMON, token, inherited);
    const desktop = desktopApprovalChildEnv(APP_KEYS.DESKTOP, token, inherited);
    const web = desktopApprovalChildEnv(APP_KEYS.WEB, token, inherited);

    assert.equal(daemon[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN], token);
    assert.equal(desktop[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN], token);
    assert.equal(web[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN], undefined);
    assert.equal(Object.keys(web).some((key) => key.toUpperCase() === SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN), false);
    assert.deepEqual(inherited, {
      ReAdAbLe_DeSkToP_ApPrOvAl_ToKeN: "stale-token",
      PATH: "safe",
    });
  });

  it("fails closed by stripping every bearer when no coordinated token exists", () => {
    for (const app of [APP_KEYS.DAEMON, APP_KEYS.DESKTOP, APP_KEYS.WEB]) {
      const env = desktopApprovalChildEnv(app, null, {
        READABLE_DESKTOP_APPROVAL_TOKEN: "inherited",
      });
      assert.equal(env[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN], undefined);
    }
  });

  it("removes inherited bearers from the tools-dev parent before build, status, or logs", () => {
    const env = { readable_desktop_approval_token: "inherited", PATH: "safe" };
    stripDesktopApprovalToken(env);
    assert.deepEqual(env, { PATH: "safe" });
  });
});
