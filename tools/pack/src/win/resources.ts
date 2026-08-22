import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache.js";
import type { ToolPackConfig } from "../config.js";
import { copyBundledResourceTrees, winResources } from "../resources.js";
import { RESOURCE_TREE_NAME } from "./constants.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 11;

function nativeIsolatorPaths(workspaceRoot: string): {
  binary: string;
  buildScript: string;
  source: string;
} {
  const root = join(workspaceRoot, "packages", "platform", "native", "win32");
  return {
    binary: join(workspaceRoot, "packages", "platform", "dist", "native", "win32", "agent-isolator.exe"),
    buildScript: join(root, "build.ps1"),
    source: join(root, "agent-isolator.cpp"),
  };
}

async function createResourceTreeCacheKey(config: ToolPackConfig): Promise<string> {
  const nativeIsolator = nativeIsolatorPaths(config.workspaceRoot);
  return hashJson({
    assetsCommunityPets: await hashPath(join(config.workspaceRoot, "assets", "community-pets")),
    assetsFrames: await hashPath(join(config.workspaceRoot, "assets", "frames")),
    craft: await hashPath(join(config.workspaceRoot, "craft")),
    designSystems: await hashPath(join(config.workspaceRoot, "design-systems")),
    designTemplates: await hashPath(join(config.workspaceRoot, "design-templates")),
    nodeExecutable: await hashPath(process.execPath),
    nativeIsolatorBinary: await hashPath(nativeIsolator.binary),
    nativeIsolatorBuildScript: await hashPath(nativeIsolator.buildScript),
    nativeIsolatorSource: await hashPath(nativeIsolator.source),
    node: "win.resource-tree",
    pluginOfficial: await hashPath(join(config.workspaceRoot, "plugins", "_official")),
    pluginPreviews: await hashPath(join(config.workspaceRoot, "data", "plugin-previews")),
    pluginRegistry: await hashPath(join(config.workspaceRoot, "plugins", "registry")),
    schemaVersion: RESOURCE_TREE_CACHE_SCHEMA_VERSION,
    skills: await hashPath(join(config.workspaceRoot, "skills")),
    sevenZipDll: await hashPath(winResources.sevenZipDll),
    sevenZipExe: await hashPath(winResources.sevenZipExe),
  });
}

export type ResourceTreeResult = {
  key: string;
  resourceRoot: string;
};

export async function prepareResourceTree(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  options: { materialize: boolean },
): Promise<ResourceTreeResult> {
  const key = await createResourceTreeCacheKey(config);
  const node = {
    id: "win.resource-tree",
    key,
    outputs: [RESOURCE_TREE_NAME],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ResourceTreeCacheMetadata> => {
      const resourceRoot = join(entryRoot, RESOURCE_TREE_NAME);
      await mkdir(resourceRoot, { recursive: true });
      await copyBundledResourceTrees({
        workspaceRoot: config.workspaceRoot,
        resourceRoot,
      });
      await mkdir(join(resourceRoot, "bin"), { recursive: true });
      await cp(process.execPath, join(resourceRoot, "bin", "node.exe"));
      await cp(
        nativeIsolatorPaths(config.workspaceRoot).binary,
        join(resourceRoot, "bin", "agent-isolator.exe"),
      );
      await cp(winResources.sevenZipExe, join(resourceRoot, "bin", "7z.exe"));
      await cp(winResources.sevenZipDll, join(resourceRoot, "bin", "7z.dll"));
      return { resourceName: RESOURCE_TREE_NAME };
    },
  };
  const manifest = await cache.acquire({
    materialize: options.materialize ? [{ from: RESOURCE_TREE_NAME, to: paths.resourceRoot }] : [],
    node,
  });
  return {
    key,
    resourceRoot: options.materialize ? paths.resourceRoot : join(manifest.entryPath, RESOURCE_TREE_NAME),
  };
}

export async function copyWinIcon(paths: WinPaths): Promise<void> {
  await mkdir(dirname(paths.winIconPath), { recursive: true });
  await cp(winResources.icon, paths.winIconPath);
}
