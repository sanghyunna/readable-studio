import { describe, expect, it } from "vitest";
import { parseSevenZipTiming } from "../src/win/zip.js";

describe("7-Zip CPU timing", () => {
  it("reports process CPU rather than treating one process as one compression core", () => {
    expect(parseSevenZipTiming("Process Time = 0.890 = 305%\r\nGlobal Time = 0.291 = 100%\r\n"))
      .toEqual({ cpuSeconds: 0.890, wallSeconds: 0.291, averageBusyCores: 0.890 / 0.291 });
  });
  it.each(["", "Process Time = 0.001", "Process Time = 0.001\nGlobal Time = 0.000"])("does not invent missing or zero-duration CPU coverage: %j", (output) => {
    expect(parseSevenZipTiming(output)).toBeNull();
  });
});
