import { describe, expect, it } from "vitest";

import { SIDECAR_ENV } from "@readable-studio/sidecar-proto";

import { resolvePackagedChildBaseEnv } from "../src/sidecars.js";

const caEnv = {
  NODE_EXTRA_CA_CERTS: String.raw`C:\Corporate CA\node.pem`,
  SSL_CERT_FILE: String.raw`C:\Corporate CA\ssl.pem`,
  SSL_CERT_DIR: String.raw`C:\Corporate CA\certs`,
  REQUESTS_CA_BUNDLE: String.raw`C:\Corporate CA\requests.pem`,
  CURL_CA_BUNDLE: String.raw`C:\Corporate CA\curl.pem`,
} as const;

const privilegedEnv = {
  [SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN]: "inherited-bearer-must-not-leak",
  [SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN.toLowerCase()]: "lowercase-bearer-must-not-leak",
  DATABRICKS_TOKEN: "databricks-token-must-not-leak",
  DATABRICKS_API_KEY: "databricks-key-must-not-leak",
  NODE_OPTIONS: "--require=untrusted-loader",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  UNRELATED_SECRET: "unrelated-secret-must-not-leak",
} as const;

describe("packaged certificate authority environment", () => {
  it.each(Object.entries(caEnv))("forwards %s when supplied to the packaged daemon", (key, value) => {
    // Given: an inherited corporate trust path, without system proxy discovery.
    const parentEnv = { [key]: value };
    // When: the packaged daemon's launch filter constructs its environment.
    const env = resolvePackagedChildBaseEnv(parentEnv, true, {}, false, "win32");
    // Then: the certificate path survives unchanged, including spaces.
    expect(env[key]).toBe(value);
  });

  it.each(Object.entries(caEnv))("forwards mixed-case %s when inherited on Windows", (key, value) => {
    // Given: Windows environment names are case-insensitive.
    const mixedKey = key[0] + key.slice(1).toLowerCase();
    // When: the packaged daemon receives a noncanonical spelling.
    const env = resolvePackagedChildBaseEnv({ [mixedKey]: value }, true, {}, false, "win32");
    // Then: the original key and path survive for CreateProcess's environment.
    expect(env[mixedKey]).toBe(value);
  });

  it("keeps privileged values stripped when CA configuration is present", () => {
    // Given: CA paths alongside explicitly denied credentials and startup controls.
    const parentEnv = { ...caEnv, ...privilegedEnv };
    // When: the packaged daemon's environment is filtered.
    const env = resolvePackagedChildBaseEnv(parentEnv, true, {}, false, "win32");
    // Then: only the previously denied names remain absent.
    for (const key of Object.keys(privilegedEnv)) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("preserves existing proxy configuration when inherited by the packaged daemon", () => {
    // Given: an explicit corporate proxy and bypass list.
    const parentEnv = {
      HTTP_PROXY: "http://proxy.corp.test:8080",
      HTTPS_PROXY: "http://secure-proxy.corp.test:8443",
      NO_PROXY: ".corp.test",
    };
    // When: the daemon launches without injecting system proxy settings.
    const env = resolvePackagedChildBaseEnv(parentEnv, true, {}, false, "win32");
    // Then: proxy endpoints and corporate bypasses survive; loopback stays direct.
    expect(env.HTTP_PROXY).toBe(parentEnv.HTTP_PROXY);
    expect(env.HTTPS_PROXY).toBe(parentEnv.HTTPS_PROXY);
    expect(env.NO_PROXY?.split(",")).toEqual(expect.arrayContaining([
      ".corp.test", "localhost", "127.0.0.1", "[::1]",
    ]));
  });
});
