import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseProductIdentity, PRODUCT_IDENTITY, ProductIdentityParseError } from "@readable-studio/product-identity";

import * as sidecarProto from "../src/index.js";
import {
  APP_KEYS,
  createRuntimeDescriptor,
  normalizeDaemonSidecarMessage,
  normalizeDesktopSidecarMessage,
  normalizeRuntimeDescriptor,
  normalizeNamespace,
  normalizeSidecarStamp,
  createSidecarContract,
  SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_DEFAULTS,
  PRODUCT_DESCRIPTOR_HASH,
  RUNTIME_DESCRIPTOR_PROTOCOL_VERSION,
  RUNTIME_DESCRIPTOR_VERSION,
  serializeProductDescriptorIdentity,
  serializeRuntimeDescriptor,
  SIDECAR_ENV,
  SIDECAR_SOURCES,
  SIDECAR_STAMP_FIELDS,
  type DaemonStatusSnapshot,
} from "../src/index.js";

const validStamp = {
  app: APP_KEYS.WEB,
  ipc: "/tmp/readable-studio/ipc/contract-check/web.sock",
  mode: "dev" as const,
  namespace: "contract-check",
  source: SIDECAR_SOURCES.TOOLS_DEV,
};

describe("sidecar contract", () => {
  it("derives canonical defaults from the Readable Studio identity", () => {
    const contract = createSidecarContract(PRODUCT_IDENTITY);

    expect(contract.defaults).toEqual({
      host: "127.0.0.1",
      ipcBase: "/tmp/readable-studio/ipc",
      namespace: "default",
      projectTmpDirName: ".tmp",
      windowsPipePrefix: "readable-studio",
    });
    expect(SIDECAR_CONTRACT.defaults).toEqual(contract.defaults);
    expect(SIDECAR_DEFAULTS).toBe(SIDECAR_CONTRACT.defaults);
  });

  it("rejects malformed identity before constructing a contract", () => {
    const buildContract = () => createSidecarContract(parseProductIdentity({
      ...PRODUCT_IDENTITY,
      productId: "Readable Studio",
    }));

    expect(buildContract).toThrowError(ProductIdentityParseError);
    expect(buildContract).toThrowError(expect.objectContaining({
      code: "malformed_value",
      field: "productId",
    }));
  });

  it("exports the descriptor-derived five-field Readable Studio identity", () => {
    expect(SIDECAR_STAMP_FIELDS).toEqual(["app", "mode", "namespace", "ipc", "source"]);
    expect(SIDECAR_CONTRACT.stampFlags).toEqual({
      app: "--readable-studio-stamp-app",
      ipc: "--readable-studio-stamp-ipc",
      mode: "--readable-studio-stamp-mode",
      namespace: "--readable-studio-stamp-namespace",
      source: "--readable-studio-stamp-source",
    });
    expect(SIDECAR_CONTRACT).not.toHaveProperty("updateActions");
    expect(SIDECAR_ENV).toEqual({
      BASE: "READABLE_SIDECAR_BASE",
      DAEMON_CLI_PATH: "READABLE_DAEMON_CLI_PATH",
      DAEMON_PORT: "READABLE_PORT",
      DESKTOP_APPROVAL_TOKEN: "READABLE_DESKTOP_APPROVAL_TOKEN",
      IPC_BASE: "READABLE_SIDECAR_IPC_BASE",
      IPC_PATH: "READABLE_SIDECAR_IPC_PATH",
      NAMESPACE: "READABLE_SIDECAR_NAMESPACE",
      SOURCE: "READABLE_SIDECAR_SOURCE",
      TOOLS_DEV_PARENT_PID: "READABLE_TOOLS_DEV_PARENT_PID",
      WEB_DIST_DIR: "READABLE_WEB_DIST_DIR",
      WEB_PORT: "READABLE_WEB_PORT",
      WEB_TSCONFIG_PATH: "READABLE_WEB_TSCONFIG_PATH",
    });
  });

  it("serializes the canonical runtime descriptor deterministically", () => {
    const descriptor = createRuntimeDescriptor("1.2.3");

    expect(descriptor).toEqual({
      appId: "studio.readable.desktop",
      appVersion: "1.2.3",
      descriptorHash: "9d1181594e3733ae67c685c6e1529baa1f095a19d93ec9739445a15643ab0c3a",
      productId: "readable-studio",
      protocolVersion: 1,
      runtimeVersion: 1,
    });
    expect(PRODUCT_DESCRIPTOR_HASH).toBe(descriptor.descriptorHash);
    expect(createHash("sha256").update(serializeProductDescriptorIdentity()).digest("hex")).toBe(
      descriptor.descriptorHash,
    );
    expect(RUNTIME_DESCRIPTOR_PROTOCOL_VERSION).toBe(1);
    expect(RUNTIME_DESCRIPTOR_VERSION).toBe(1);
    expect(serializeRuntimeDescriptor(descriptor)).toBe(`${JSON.stringify(descriptor, null, 2)}\n`);
  });

  it("rejects missing and foreign runtime product identities", () => {
    const descriptor = createRuntimeDescriptor("1.2.3");
    const { productId: _productId, ...missingProductId } = descriptor;

    expect(() => normalizeRuntimeDescriptor(missingProductId)).toThrowError(/missing productId/);
    expect(() => normalizeRuntimeDescriptor({ ...descriptor, productId: "foreign-product" })).toThrowError(
      /productId must be "readable-studio"/,
    );
    expect(() => normalizeRuntimeDescriptor({ ...descriptor, appId: "io.readable-studio.desktop" })).toThrowError(
      /appId must be "studio.readable.desktop"/,
    );
    expect(() => normalizeRuntimeDescriptor({ ...descriptor, descriptorHash: "0".repeat(64) })).toThrowError(
      /descriptorHash must be/,
    );
  });

  it("does not export legacy contract symbols", () => {
    expect(sidecarProto).not.toHaveProperty("READABLE_PRODUCT_NAME");
    expect(sidecarProto).not.toHaveProperty("READABLE_SIDECAR_CONTRACT");
  });

  it("exports the desktop approval launch token key outside the process stamp", () => {
    expect(SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN).toBe("READABLE_DESKTOP_APPROVAL_TOKEN");
    expect(SIDECAR_STAMP_FIELDS).not.toContain(SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN);
  });

  it("accepts the explicit namespace contract", () => {
    expect(normalizeNamespace("contract-check_1.alpha")).toBe("contract-check_1.alpha");
  });

  it("rejects path-like or whitespace namespaces", () => {
    expect(() => normalizeNamespace("../other")).toThrow();
    expect(() => normalizeNamespace(" contract-check")).toThrow();
    expect(() => normalizeNamespace("contract check")).toThrow();
  });

  it("accepts exactly app, mode, namespace, ipc, and source", () => {
    expect(normalizeSidecarStamp(validStamp)).toEqual(validStamp);
  });

  it("rejects legacy or extra stamp fields", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, runtimeToken: "legacy" })).toThrow();
    expect(() => normalizeSidecarStamp({ ...validStamp, role: "web-sidecar" })).toThrow();
  });

  it("rejects non-contract sidecar sources", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, source: "custom-script" })).toThrow();
  });

  it("validates daemon IPC messages", () => {
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.STATUS })).toEqual({ type: "status" });
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.SHUTDOWN })).toEqual({ type: "shutdown" });
    expect(() => normalizeDaemonSidecarMessage({ input: {}, type: SIDECAR_MESSAGES.EVAL })).toThrow();
  });

  it("accepts a base64 register-desktop-auth payload", () => {
    const message = {
      input: { secret: "AAECAwQFBgcICQoLDA0ODw==" },
      type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
    };
    expect(normalizeDaemonSidecarMessage(message)).toEqual(message);
  });

  it("accepts a mint-import-token payload with a baseDir", () => {
    const message = {
      input: { baseDir: "/Users/u/project" },
      type: SIDECAR_MESSAGES.MINT_IMPORT_TOKEN,
    };
    expect(normalizeDaemonSidecarMessage(message)).toEqual(message);
  });

  it("rejects malformed mint-import-token payloads", () => {
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { baseDir: "" },
        type: SIDECAR_MESSAGES.MINT_IMPORT_TOKEN,
      }),
    ).toThrow(/baseDir/i);
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { baseDir: "/Users/u/project", extra: true },
        type: SIDECAR_MESSAGES.MINT_IMPORT_TOKEN,
      }),
    ).toThrow(/extra/i);
  });

  it("rejects register-desktop-auth payloads that are not base64-shaped", () => {
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { secret: "not base64!" },
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow(/base64/i);
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { secret: "" },
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow();
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: {},
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow();
  });

  it("validates desktop IPC message inputs", () => {
    expect(normalizeDesktopSidecarMessage({ type: SIDECAR_MESSAGES.SHOW })).toEqual({ type: "show" });
    expect(normalizeDesktopSidecarMessage({ input: { expression: "location.href" }, type: SIDECAR_MESSAGES.EVAL })).toEqual({
      input: { expression: "location.href" },
      type: "eval",
    });
    expect(() => normalizeDesktopSidecarMessage({ input: { expression: 42 }, type: SIDECAR_MESSAGES.EVAL })).toThrow();
    expect(() => normalizeDesktopSidecarMessage({ input: { selector: "" }, type: SIDECAR_MESSAGES.CLICK })).toThrow();
  });

  it("requires DaemonStatusSnapshot to carry desktopAuthGateActive (PR #974 round 6)", () => {
    // The TS compiler enforces that `desktopAuthGateActive: boolean` is
    // present on every constructed snapshot — tools-dev's split-start
    // hardening relies on the daemon STATUS IPC carrying this field so
    // `start desktop` can detect an ungated already-running daemon and
    // restart it before launching desktop main. Removing the field, or
    // softening it to optional, must fail this build.
    const armed: DaemonStatusSnapshot = {
      descriptor: createRuntimeDescriptor("1.2.3"),
      state: "running",
      url: "http://127.0.0.1:7456",
      desktopAuthGateActive: true,
    };
    const dormant: DaemonStatusSnapshot = {
      descriptor: createRuntimeDescriptor("1.2.3"),
      state: "running",
      url: "http://127.0.0.1:7456",
      desktopAuthGateActive: false,
    };
    expect(armed.desktopAuthGateActive).toBe(true);
    expect(dormant.desktopAuthGateActive).toBe(false);
  });

  it("validates desktop PDF export IPC message inputs", () => {
    expect(
      normalizeDesktopSidecarMessage({
        input: {
          baseHref: "http://127.0.0.1:7456/api/projects/proj/raw/deck/",
          deck: true,
          defaultFilename: "Seed Deck.pdf",
          html: "<!doctype html><section class=\"slide\">One</section>",
          title: "Seed Deck",
        },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toEqual({
      input: {
        baseHref: "http://127.0.0.1:7456/api/projects/proj/raw/deck/",
        deck: true,
        defaultFilename: "Seed Deck.pdf",
        html: "<!doctype html><section class=\"slide\">One</section>",
        title: "Seed Deck",
      },
      type: "export-pdf",
    });
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { deck: true, defaultFilename: "x.pdf", html: "", title: "x" },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toThrow();
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { deck: "yes", defaultFilename: "x.pdf", html: "<p>x</p>", title: "x" },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toThrow();
  });

  it("rejects removed desktop update IPC messages", () => {
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { action: "check" },
        type: "update",
      }),
    ).toThrow(/unknown desktop sidecar message/);
  });
});
