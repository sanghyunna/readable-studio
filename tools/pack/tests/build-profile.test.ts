import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardBuildProfile, forwardPnpmProfile, measureBuildStep } from "../src/build-profile.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("build profiling", () => {
  it("returns the original promise without observing the clock when disabled", () => {
    // Given disabled profiling and an existing operation
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", undefined);
    const clock = vi.spyOn(performance, "now");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const operation = Promise.resolve(7);
    // When the operation passes through instrumentation
    const result = measureBuildStep("fixture", () => operation);
    // Then there is no timing/logging work or promise replacement
    expect(result).toBe(operation);
    expect(clock).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it("records elapsed time and preserves results when enabled", async () => {
    // Given a deterministic clock and enabled profiling
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(45);
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // When an operation completes
    const result = await measureBuildStep("fixture", async () => 7, { package: "fixture-package" });
    // Then the machine-consumed record carries its measured duration and result is unchanged
    expect(result).toBe(7);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]).replace("[tools-pack profile] ", ""))).toMatchObject({
      phase: "fixture", durationMs: 35, status: "done", package: "fixture-package",
    });
  });

  it("records a failure without swallowing or replacing its error", async () => {
    // Given an operation that fails
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const failure = new Error("fixture failure");
    // When profiling observes the failure
    const result = measureBuildStep("fixture", async () => { throw failure; });
    // Then failure identity and failed status survive
    await expect(result).rejects.toBe(failure);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]).replace("[tools-pack profile] ", ""))).toMatchObject({
      phase: "fixture", status: "failed",
    });
  });

  it("preserves child timestamps when forwarding pnpm lifecycle records", () => {
    // Given buffered lifecycle NDJSON mixed with ordinary child output
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const lifecycle = JSON.stringify({ name: "pnpm:lifecycle", time: 123, stage: "build", exitCode: 0 });
    // When buffered records are forwarded
    forwardPnpmProfile(`ordinary output\n${lifecycle}\n{truncated output\n`);
    // Then the original event clock is retained without parsing arbitrary child prose
    expect(output).toHaveBeenCalledOnce();
    const envelope = JSON.parse(String(output.mock.calls[0]?.[0]).replace("[tools-pack profile] ", ""));
    expect(JSON.parse(envelope.raw)).toEqual({ name: "pnpm:lifecycle", time: 123, stage: "build", exitCode: 0 });
  });

  it("forwards only structured profiling output from the hook process", () => {
    // Given buffered stderr containing a profiling record
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const record = '[tools-pack profile] {"phase":"fixture","durationMs":2}';
    // When child output is relayed
    forwardBuildProfile(`other output\n${record}\n`);
    // Then the profiling protocol alone reaches the parent log
    expect(output).toHaveBeenCalledExactlyOnceWith(`${record}\n`);
  });

  it("avoids per-file logging when a profiled operation recurses", async () => {
    // Given a recursively invoked hook operation
    vi.stubEnv("READABLE_TOOLS_PACK_PROFILE", "1");
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // When it invokes the same profiled stage recursively
    const result = await measureBuildStep("recursive", () => measureBuildStep("recursive", async () => 9));
    // Then only the outer inclusive duration is recorded
    expect(result).toBe(9);
    expect(output).toHaveBeenCalledOnce();
  });
});
