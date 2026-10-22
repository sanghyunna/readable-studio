import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { createPackageManagerInvocation } from "@readable-studio/platform";

import { resolveToolPackConfig } from "../src/config.js";
import { withDirectoryLock } from "../src/lock.js";
import { processWebSourcemaps } from "../src/web-sourcemaps.js";
import { ensureWorkspacePackageBuilds } from "../src/workspace-build.js";

const execFileAsync = promisify(execFile);

export async function prepareWorkspace(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      packages: { type: "string" },
      events: { type: "string" },
      "run-id": { type: "string" },
      "cache-dir": { type: "string" },
      namespace: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const packages = values.packages?.split(",").map((name) => name.trim());
  if (!packages?.length || packages.some((name) => !name) || !values.events || !values["run-id"]) {
    throw new Error("required: --packages a,b --events <file> --run-id <id>");
  }
  process.env.READABLE_BUILD_EVENTS = resolve(values.events);
  process.env.READABLE_BUILD_RUN_ID = values["run-id"];
  const config = resolveToolPackConfig("win", {
    cacheDir: values["cache-dir"], namespace: values.namespace,
  });
  const run = async (name: string, command: string): Promise<void> => {
    const invocation = createPackageManagerInvocation(["--filter", name, "run", command], process.env);
    await execFileAsync(invocation.command, invocation.args, {
      cwd: config.workspaceRoot,
      env: { ...process.env, READABLE_WEB_OUTPUT_MODE: config.webOutputMode },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true,
    });
  };
  await withDirectoryLock(join(config.roots.cacheRoot, "locks"), "workspace-build", async () => {
    const nextEnv = join(config.workspaceRoot, "apps/web/next-env.d.ts");
    const previous = await readFile(nextEnv).catch(() => null);
    let builtWeb = false;
    try {
      await ensureWorkspacePackageBuilds(config, async (info) => {
        if (info.name === "@readable-studio/web") builtWeb = true;
        await run(info.name, "build");
        if (info.name === "@readable-studio/platform") await run(info.name, "build:native:win32");
        if (info.name === "@readable-studio/web") {
          await run(info.name, "build:sidecar");
          await processWebSourcemaps(config);
        }
      }, { packages });
    } finally {
      if (builtWeb) {
        if (previous == null) await rm(nextEnv, { force: true });
        else await writeFile(nextEnv, previous);
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  prepareWorkspace(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
