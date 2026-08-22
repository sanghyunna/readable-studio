import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ToolPackCache } from "../src/cache.js";
import type { ToolPackConfig } from "../src/config.js";
import { prepareResourceTree } from "../src/win/resources.js";
import type { WinPaths } from "../src/win/types.js";

function stubExecPath(execPath: string): () => void {
  const previous = process.execPath;
  Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
  return () => {
    Object.defineProperty(process, "execPath", { value: previous, configurable: true });
  };
}

async function createWorkspaceFixture(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "packages", "platform", "dist", "native", "win32"), { recursive: true });
  await mkdir(join(workspaceRoot, "packages", "platform", "native", "win32"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "packages", "platform", "dist", "native", "win32", "agent-isolator.exe"),
    "fake deterministic isolator\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "packages", "platform", "native", "win32", "build.ps1"), "# build\n", "utf8");
  await writeFile(join(workspaceRoot, "packages", "platform", "native", "win32", "agent-isolator.cpp"), "// source\n", "utf8");
  await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "design-systems", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "plugins", "_official", "sample"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "_official", "sample", "readable-studio.json"),
    "{\"id\":\"sample\"}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "community"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "registry", "community", "readable-studio-marketplace.json"),
    "{\"plugins\":[]}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
  await mkdir(join(workspaceRoot, "assets", "community-pets", "clippit"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "assets", "community-pets", "dario"), { recursive: true });
  await writeFile(join(workspaceRoot, "assets", "community-pets", "clippit", "pet.json"), "{\"name\":\"clippit\"}\n", "utf8");
  await writeFile(join(workspaceRoot, "assets", "community-pets", "clippit", "spritesheet.webp"), "clippit-sheet\n", "utf8");
  await writeFile(join(workspaceRoot, "assets", "community-pets", "dario", "pet.json"), "{\"name\":\"dario\"}\n", "utf8");
  await writeFile(join(workspaceRoot, "assets", "community-pets", "dario", "spritesheet.webp"), "dario-sheet\n", "utf8");
  await mkdir(join(workspaceRoot, "data", "plugin-previews"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "data", "plugin-previews", "manifest.json"),
    "{\"previews\":{}}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "official"), {
    recursive: true,
  });
}

describe("prepareResourceTree", () => {
  it("keeps pure portable zip resource packaging on the cache tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-resources-cache-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const templatePath = join(
      workspaceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(templatePath, "portable resource\n", "utf8");

      const result = await prepareResourceTree(config, paths, cache, { materialize: false });

      expect(result.resourceRoot).not.toBe(resourceRoot);
      await expect(
        readFile(join(result.resourceRoot, "design-templates", "orbit-general", "SKILL.md"), "utf8"),
      ).resolves.toBe("portable resource\n");
      await expect(
        readFile(join(result.resourceRoot, "community-pets", "clippit", "pet.json"), "utf8"),
      ).resolves.toBe("{\"name\":\"clippit\"}\n");
      await expect(
        readFile(join(result.resourceRoot, "community-pets", "dario", "pet.json"), "utf8"),
      ).resolves.toBe("{\"name\":\"dario\"}\n");
      await expect(access(join(result.resourceRoot, "bin", "node.exe"))).resolves.toBeUndefined();
      await expect(
        readFile(join(result.resourceRoot, "bin", "agent-isolator.exe"), "utf8"),
      ).resolves.toBe("fake deterministic isolator\n");
      expect(cache.report().entries.at(-1)?.materialized).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates the Windows resource tree cache when design templates change", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-resources-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const templatePath = join(
      workspaceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );
    const materializedTemplatePath = join(
      resourceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(templatePath, "version one\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version one\n",
      );

      await writeFile(templatePath, "version two\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version two\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates the Windows resource tree cache when the plugin-preview manifest changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-previews-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const manifestPath = join(
      workspaceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );
    const materializedManifestPath = join(
      resourceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(manifestPath, "{\"previews\":{\"a\":1}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":1}}\n",
      );

      await writeFile(manifestPath, "{\"previews\":{\"a\":2}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":2}}\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("materializes a bundled node.exe copied from process.execPath", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-node-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const sourceRoot = join(root, "source");
    const nodePath = join(sourceRoot, "node.exe");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    let restoreExecPath: () => void = () => undefined;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(nodePath, "fake node binary\n", "utf8");
      restoreExecPath = stubExecPath(nodePath);

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(join(resourceRoot, "bin", "node.exe"))).resolves.toEqual(
        await readFile(process.execPath),
      );
    } finally {
      restoreExecPath();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates the Windows resource tree cache when the bundled Node binary changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-node-cache-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const sourceRoot = join(root, "source");
    const nodePath = join(sourceRoot, "node.exe");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    let restoreExecPath: () => void = () => undefined;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(nodePath, "node binary one\n", "utf8");

      restoreExecPath = stubExecPath(nodePath);
      await prepareResourceTree(config, paths, cache, { materialize: true });
      await expect(readFile(join(resourceRoot, "bin", "node.exe"), "utf8")).resolves.toBe(
        "node binary one\n",
      );

      await writeFile(nodePath, "node binary two\n", "utf8");
      await prepareResourceTree(config, paths, cache, { materialize: true });
      await expect(readFile(join(resourceRoot, "bin", "node.exe"), "utf8")).resolves.toBe(
        "node binary two\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      restoreExecPath();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates the Windows resource tree cache when the isolator source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-studio-win-isolator-cache-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "readable-studio");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const source = join(workspaceRoot, "packages", "platform", "native", "win32", "agent-isolator.cpp");

    try {
      await createWorkspaceFixture(workspaceRoot);
      await prepareResourceTree(config, paths, cache, { materialize: true });
      await writeFile(source, "// changed source\n", "utf8");
      await prepareResourceTree(config, paths, cache, { materialize: true });
      expect(cache.report().entries.map((entry) => entry.status)).toEqual(["miss", "miss"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

});
