import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCrashEvidence } from "../../src/main/crash-evidence.js";

const electron = vi.hoisted(() => ({ start: vi.fn(), setPath: vi.fn(), removeSwitch: vi.fn() }));
vi.mock("electron", () => ({ crashReporter: { start: electron.start } }));
const roots: string[] = [];
function setup(nativeDumps = false) {
  const root = mkdtempSync(join(tmpdir(), "desktop-crash-evidence-"));
  roots.push(root);
  const namespaceRoot = join(root, "namespaces", "test");
  const app = Object.assign(new EventEmitter(), { setPath: electron.setPath, commandLine: { removeSwitch: electron.removeSwitch } });
  const evidence = startCrashEvidence(app, namespaceRoot, nativeDumps);
  return { app, evidence, namespaceRoot };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("local crash evidence", () => {
  it("captures process failures under the namespace root without payloads or identifiers", () => {
    // Given
    const { app, evidence, namespaceRoot } = setup();
    // When
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 5, name: "private document", serviceName: "credential", pid: 123, url: "https://user:secret@example.com", prompt: "private prompt" });
    // Then
    const records = readFileSync(join(namespaceRoot, "logs", "desktop", "crashes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toEqual({ timestamp: expect.any(String), event: "child-process-gone", processType: "GPU", reason: "crashed", exitCode: 5 });
    expect(electron.start).not.toHaveBeenCalled();
    evidence.dispose();
  });

  it("enables local native capture at the namespace path only when opted in", () => {
    // Given / When
    const { evidence, namespaceRoot } = setup(true);
    // Then
    expect(electron.setPath).toHaveBeenCalledWith("crashDumps", join(namespaceRoot, "crashes"));
    expect(electron.removeSwitch).toHaveBeenCalledWith("disable-breakpad");
    expect(electron.start).toHaveBeenCalledWith({ uploadToServer: false, ignoreSystemCrashHandler: true, compress: true, extra: {}, globalExtra: {} });
    evidence.dispose();
  });

  it("discards unrecognized strings instead of writing content into metadata", () => {
    // Given
    const { evidence, namespaceRoot } = setup();
    // When
    evidence.record({ event: "child-process-gone", processType: "private document", reason: "private prompt", exitCode: 2 });
    // Then
    const records = readFileSync(join(namespaceRoot, "logs", "desktop", "crashes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toEqual({ timestamp: expect.any(String), event: "child-process-gone", processType: "unknown", reason: "unknown", exitCode: 2 });
    evidence.dispose();
  });
});
