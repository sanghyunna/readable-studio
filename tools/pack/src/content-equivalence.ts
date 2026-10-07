import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function portableContentManifest(root: string): Promise<Record<string, string>> {
  const directory = resolve(root);
  // Use the repository's discovery boundary, including hidden/ignored payload files.
  const { stdout } = await execFileAsync("fd", [
    "--hidden", "--no-ignore", "--type", "f", "--type", "l", "--print0", ".", ".",
  ], { cwd: directory, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const paths = stdout.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")).sort();
  const manifest: Record<string, string> = {};
  for (const path of paths) {
    const absolute = join(directory, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`portable content must be a regular extracted file: ${path}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    manifest[path] = hash.digest("hex");
  }
  return manifest;
}

export function assertPortableContentManifestsEqual(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): void {
  const missing = Object.keys(expected).filter((path) => !Object.hasOwn(actual, path));
  const extra = Object.keys(actual).filter((path) => !Object.hasOwn(expected, path));
  const changed = Object.keys(expected).filter((path) => Object.hasOwn(actual, path) && expected[path] !== actual[path]);
  if (missing.length || extra.length || changed.length) {
    throw new Error(`portable content differs: ${JSON.stringify({ missing, extra, changed })}`);
  }
}

export async function assertPortableContentEquivalent(expectedRoot: string, actualRoot: string): Promise<number> {
  const expected = await portableContentManifest(expectedRoot);
  const actual = await portableContentManifest(actualRoot);
  assertPortableContentManifestsEqual(expected, actual);
  return Object.keys(expected).length;
}
