import { stat } from "node:fs/promises";
import path from "node:path";

export async function ensureWindowsNativeIsolator(options: {
  log: (message: string) => Promise<void> | void;
  platform?: NodeJS.Platform;
  runBuild: () => Promise<void>;
  workspaceRoot: string;
}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "win32") return false;

  const platformRoot = path.join(options.workspaceRoot, "packages/platform");
  const output = path.join(platformRoot, "dist/native/win32/agent-isolator.exe");
  const inputs = [
    path.join(platformRoot, "native/win32/build.ps1"),
    path.join(platformRoot, "native/win32/agent-isolator.cpp"),
  ];
  const [outputStat, ...inputStats] = await Promise.all([
    stat(output).catch(() => null),
    ...inputs.map((input) => stat(input).catch(() => null)),
  ]);
  const missingInput = inputStats.findIndex((input) => input == null);
  if (missingInput >= 0) throw new Error(`native isolator source is missing: ${inputs[missingInput]}`);

  const newestInput = Math.max(...inputStats.map((input) => input!.mtimeMs));
  if (outputStat != null && outputStat.mtimeMs >= newestInput) return false;

  await options.log(
    `[tools-dev] building @readable-studio/platform native isolator because ${
      outputStat == null ? "the helper is missing" : "native source is newer"
    }\n`,
  );
  await options.runBuild();
  const built = await stat(output).catch(() => null);
  if (built == null || built.mtimeMs < newestInput) {
    throw new Error(`native isolator build did not produce ${output}`);
  }
  return true;
}
