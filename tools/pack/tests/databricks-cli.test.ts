import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pin = vi.hoisted(() => ({ version: "fixture", url: "https://example.invalid/cli.zip", archiveSha256: "", executableSha256: "" }));
vi.mock("../src/databricks-cli.json", () => ({ default: pin }));
import { assertDatabricksCliOutput, DATABRICKS_CLI_RELATIVE_PATH, stageDatabricksCli } from "../src/databricks-cli.js";
import { ELECTRON_BUILDER_ASAR, ELECTRON_BUILDER_FILE_PATTERNS } from "../src/win/constants.js";

let root: string;
let archive: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "databricks-pack-test-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "databricks.exe"), "native executable fixture");
  await writeFile(join(source, "LICENSE"), "license fixture");
  archive = join(root, "fixture.zip");
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Compress-Archive -Path ($env:READABLE_TEST_SOURCE + '/*') -DestinationPath $env:READABLE_TEST_ZIP"], {
    env: { ...process.env, READABLE_TEST_SOURCE: source, READABLE_TEST_ZIP: archive }, timeout: 30_000,
  });
  pin.archiveSha256 = hash(await readFile(archive));
  pin.executableSha256 = hash(await readFile(join(source, "databricks.exe")));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("bundled Databricks native artifact", () => {
  it("includes the executable and license outside asar", () => {
    expect(ELECTRON_BUILDER_ASAR).toBe(false);
    expect(ELECTRON_BUILDER_FILE_PATTERNS).toContain(DATABRICKS_CLI_RELATIVE_PATH);
    expect(ELECTRON_BUILDER_FILE_PATTERNS).toContain("vendor/databricks/LICENSE");
  });
  it("stages the verified archive and validates the relocated portable output", async () => {
    const assembled = join(root, "assembled");
    await stageDatabricksCli(assembled, archive);
    const shipped = join(root, "portable", "resources", "app");
    await cp(assembled, shipped, { recursive: true });
    await rm(assembled, { recursive: true });
    await expect(assertDatabricksCliOutput(shipped)).resolves.toBeUndefined();
    expect(await readFile(join(dirname(join(shipped, DATABRICKS_CLI_RELATIVE_PATH)), "LICENSE"), "utf8")).toBe("license fixture");
  });
  it("rejects a corrupt acquisition before extraction", async () => {
    const corrupt = join(root, "corrupt.zip");
    await writeFile(corrupt, "not the pinned archive");
    await expect(stageDatabricksCli(join(root, "bad-stage"), corrupt)).rejects.toMatchObject({ cause: { message: "release archive SHA256 mismatch" } });
  });
  it.each(["missing", "corrupt"])("fails the output assertion for a %s binary with acquisition details", async (failure) => {
    const app = join(root, failure);
    if (failure === "corrupt") {
      await mkdir(dirname(join(app, DATABRICKS_CLI_RELATIVE_PATH)), { recursive: true });
      await writeFile(join(app, DATABRICKS_CLI_RELATIVE_PATH), "corrupt");
    }
    await expect(assertDatabricksCliOutput(app)).rejects.toThrow(pin.url);
  });
});
