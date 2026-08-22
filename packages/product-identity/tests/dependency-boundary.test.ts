import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseProductIdentity, serializeProductIdentity } from "../src/index.js";

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
};

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");

describe("product identity dependency boundary", () => {
  it("has no runtime dependencies or runtime-specific API imports", async () => {
    const manifest: PackageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const source = await readFile(resolve(packageRoot, "src/index.ts"), "utf8");

    expect(manifest.name).toBe("@readable-studio/product-identity");
    expect(manifest.dependencies).toBeUndefined();
    expect(source).not.toMatch(/from\s+["'](?:node:|@readable-studio\/|@readable-studio\/|react|next|electron)/);
    expect(source).not.toMatch(/\b(?:process|window|document|Buffer)\b/);
  });

  it("ships the canonical serializable JSON artifact", async () => {
    const artifact = await readFile(resolve(packageRoot, "product-identity.json"), "utf8");

    expect(serializeProductIdentity(parseProductIdentity(JSON.parse(artifact)))).toBe(artifact);
  });

  it("allows only sidecar-proto to depend on product identity", async () => {
    const sidecarProtoRoot = resolve(workspaceRoot, "packages/sidecar-proto");
    const manifest: PackageManifest = JSON.parse(
      await readFile(resolve(sidecarProtoRoot, "package.json"), "utf8"),
    );
    const source = await readFile(resolve(sidecarProtoRoot, "src/index.ts"), "utf8");

    expect(manifest.dependencies).toEqual({
      "@readable-studio/product-identity": "workspace:*",
    });
    expect(source).toContain('from "@readable-studio/product-identity"');
    expect(source).not.toMatch(/READABLE_PRODUCT_NAME|OpenDesignSidecarContract|READABLE_SIDECAR_CONTRACT/);
  });

  it("keeps generic sidecar and platform packages product-neutral", async () => {
    const platformFiles = [
      "src/index.ts",
      "src/isolated-process.ts",
      "native/win32/agent-isolator.cpp",
      "native/win32/build.ps1",
    ];
    const [sidecarSource, ...platformSources] = await Promise.all([
      readFile(resolve(workspaceRoot, "packages/sidecar/src/index.ts"), "utf8"),
      ...platformFiles.map((file) => readFile(resolve(workspaceRoot, "packages/platform", file), "utf8")),
    ]);

    for (const source of [sidecarSource, ...platformSources]) {
      expect(source).not.toMatch(/Readable Studio|readable-studio|READABLE_|@readable-studio|__readableStudio__/);
      expect(source).not.toContain("@readable-studio/product-identity");
    }
    expect(sidecarSource).toContain("SidecarContractDescriptor");
    expect(platformSources[0]).toContain("ProcessStampContract");
  });
});
