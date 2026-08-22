import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPackagedStartupPhaseTimer,
  PACKAGED_STARTUP_PHASE_EVENT,
} from "../src/startup-timing.js";

describe("createPackagedStartupPhaseTimer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits structured packaged startup phase logs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const timer = createPackagedStartupPhaseTimer();

    timer.mark("config-read-complete");

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      PACKAGED_STARTUP_PHASE_EVENT,
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        phase: "config-read-complete",
        uptimeMs: expect.any(Number),
      }),
    );
  });

  it("buffers events until flush when requested", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const timer = createPackagedStartupPhaseTimer({ buffer: true });

    timer.mark("config-read-complete");
    timer.mark("packaged-paths-resolved");
    expect(info).not.toHaveBeenCalled();

    timer.flush();

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(
      1,
      PACKAGED_STARTUP_PHASE_EVENT,
      expect.objectContaining({ phase: "config-read-complete" }),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      PACKAGED_STARTUP_PHASE_EVENT,
      expect.objectContaining({ phase: "packaged-paths-resolved" }),
    );
  });
});
