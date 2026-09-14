import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import pin from "./databricks-cli.json" with { type: "json" };

// Official https://github.com/databricks/cli/releases/tag/v1.10.0 Windows amd64
// archive: digest published by GitHub Releases; executable digest from that verified ZIP.
export const DATABRICKS_CLI_RELATIVE_PATH = "vendor/databricks/databricks.exe";
const execFileAsync = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const acquisition = `Acquire ${pin.url} (SHA256 ${pin.archiveSha256}) and rerun packaging; stageDatabricksCli(appRoot, archivePath) also accepts that verified ZIP offline.`;

export async function assertDatabricksCliOutput(appRoot: string): Promise<void> {
  try {
    if (sha256(await readFile(join(appRoot, DATABRICKS_CLI_RELATIVE_PATH))) !== pin.executableSha256) {
      throw new Error("executable SHA256 mismatch");
    }
  } catch (cause) {
    throw new Error(`Bundled Databricks CLI ${pin.version} missing or invalid under ${appRoot}. ${acquisition}`, { cause });
  }
}

/** Stage a native dependency, not an npm package. Never consult the build host's CLI. */
export async function stageDatabricksCli(appRoot: string, archivePath?: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "readable-databricks-"));
  try {
    const bytes = archivePath ? await readFile(archivePath) : await (async () => {
      const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`release download returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    })();
    if (sha256(bytes) !== pin.archiveSha256) throw new Error("release archive SHA256 mismatch");
    const zip = join(temporary, "release.zip");
    const extracted = join(temporary, "extracted");
    await writeFile(zip, bytes);
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:READABLE_CLI_ZIP -DestinationPath $env:READABLE_CLI_EXTRACT"], {
      env: { ...process.env, READABLE_CLI_ZIP: zip, READABLE_CLI_EXTRACT: extracted },
      windowsHide: true, timeout: 60_000,
    });
    const destination = join(appRoot, DATABRICKS_CLI_RELATIVE_PATH);
    // Check the extracted bytes before installing; retain the upstream license.
    if (sha256(await readFile(join(extracted, "databricks.exe"))) !== pin.executableSha256) throw new Error("executable SHA256 mismatch");
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(extracted, "databricks.exe"), destination);
    await cp(join(extracted, "LICENSE"), join(dirname(destination), "LICENSE"));
    await assertDatabricksCliOutput(appRoot);
  } catch (cause) {
    throw new Error(`Cannot stage Databricks CLI ${pin.version}. ${acquisition}`, { cause });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
