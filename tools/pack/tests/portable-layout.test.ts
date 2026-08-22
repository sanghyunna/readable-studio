import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, RESOURCE_TREE_NAME, WEB_STANDALONE_RESOURCE_NAME } from "../src/win/constants.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("Windows portable layout", () => {
  it("uses the Readable Studio artifact and standalone resource names", () => {
    expect(PRODUCT_NAME).toBe("Readable Studio");
    expect(RESOURCE_TREE_NAME).toBe("readable-studio");
    expect(WEB_STANDALONE_RESOURCE_NAME).toBe("readable-studio-web-standalone");
  });

  it("keeps the root build entrypoint on the canonical artifact identity", () => {
    const source = readFileSync(join(REPOSITORY_ROOT, "build-portable.ps1"), "utf8");

    expect(source).toContain("Readable Studio-$NamespaceToken-portable.zip");
    expect(source).toContain("Readable Studio portable build");
    expect(source).not.toContain(["Open", "Design"].join(" "));
    expect(source).not.toMatch(/OpenDesignData|0\.1\.5/);
  });
});
