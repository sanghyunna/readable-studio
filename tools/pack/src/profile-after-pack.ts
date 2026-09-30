import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { compileFunction } from "node:vm";

import { measureBuildStep } from "./build-profile.js";
import { winResources } from "./resources.js";

// Build-only instrumentation of the existing trusted CommonJS hook. Its file
// stays byte-identical because it participates in the release cache key. These
// bindings are wrapped in an isolated module, not patched on disk or globally.
const PROFILED_HOOK_OPERATIONS = [
  "installStandaloneResource", "copyRequired", "linkPnpmPublicHoist",
  "pruneCopiedSharp", "dedupeCopiedStandaloneNext", "pruneSourceBuildResidue",
  "pruneBrokenSymlinks", "auditCopiedStandaloneNextDedupe", "auditCopiedStandalone",
  "pruneRootNext", "pruneRootSharp", "pruneRootWebPackage", "auditRootWebPackage",
  "auditRootNextPruned", "auditNoBrokenSymlinks", "collectClosureStats", "sizePathBytes",
] as const;

class ProfileHookExportError extends TypeError {
  constructor(readonly hookPath: string) {
    super(`after-pack profiling requires a callable hook export: ${hookPath}`);
  }
}

export async function profileWebStandaloneAfterPack(context: unknown): Promise<void> {
  const hookPath = winResources.webStandaloneAfterPackHook;
  const source = await readFile(hookPath, "utf8");
  const replacements = PROFILED_HOOK_OPERATIONS.map((name) =>
    `${name} = profiled(${JSON.stringify(name)}, ${name});`,
  ).join("\n");
  const initialize = compileFunction(`${source}\n${replacements}\n`, [
    "require", "module", "exports", "__filename", "__dirname", "profiled",
  ], { filename: hookPath });
  const loaded: { exports: unknown } = { exports: {} };
  const profiled = (name: string, task: (...args: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) => measureBuildStep(`after-pack:${name}`, () => task(...args),
      name === "copyRequired" ? { source: args[0], destination: args[1] } : {});
  initialize(createRequire(hookPath), loaded, loaded.exports, hookPath, dirname(hookPath), profiled);
  if (typeof loaded.exports !== "function") throw new ProfileHookExportError(hookPath);
  await loaded.exports(context);
}

// electron-builder's hook loader consumes the default export from this generated
// CommonJS bundle. The ordinary build still loads the original compatibility hook.
export default profileWebStandaloneAfterPack;
