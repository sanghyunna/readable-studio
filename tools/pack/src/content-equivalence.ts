import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function portableContentManifest(root: string): Promise<Record<string, string>> {
  const { manifest } = await portableContentInventory(root);
  return Object.fromEntries(manifest.files.map((file) => [file.path, file.sha256]));
}

export type PortableContentFile = { path: string; size: number; sha256: string };
export type SealedPortableManifest = { v: 1; files: PortableContentFile[] };

export async function portableContentInventory(
  root: string,
  include: (path: string) => boolean = () => true,
): Promise<{ manifest: SealedPortableManifest; readOnlyFiles: string[] }> {
  const directory = resolve(root);
  // Use the repository's discovery boundary, including hidden/ignored payload files.
  const { stdout } = await execFileAsync("fd", [
    "--hidden", "--no-ignore", "--type", "f", "--type", "l", "--print0", ".", ".",
  ], { cwd: directory, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const paths = stdout.split("\0").filter(Boolean)
    .map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")).filter(include);
  const files: (PortableContentFile & { mode: number })[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(20, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]!;
      const absolute = join(directory, path);
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`portable content must be a regular extracted file: ${path}`);
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      files.push({ path, size: metadata.size, sha256: hash.digest("hex"), mode: metadata.mode });
    }
  }));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // Preserve the original manifest's object-key order, including numeric root names.
  const ordered = Object.values(Object.fromEntries(files.map((file) => [file.path, file])));
  return {
    manifest: { v: 1, files: ordered.map(({ path, size, sha256 }) => ({ path, size, sha256 })) },
    // libuv maps FILE_ATTRIBUTE_READONLY to the absence of write permission bits.
    readOnlyFiles: ordered.filter((file) => (file.mode & 0o222) === 0).map((file) => file.path),
  };
}

export async function compareSealedPortableContent(expected: SealedPortableManifest, actualRoot: string) {
  const actual = await portableContentInventory(actualRoot);
  const expectedHashes = Object.fromEntries(expected.files.map((file) => [file.path, file.sha256]));
  const actualHashes = Object.fromEntries(actual.manifest.files.map((file) => [file.path, file.sha256]));
  let error: string | null = null;
  try {
    assertPortableContentManifestsEqual(expectedHashes, actualHashes);
    const sizes = new Map(actual.manifest.files.map((file) => [file.path, file.size]));
    const changedSizes = expected.files.filter((file) => sizes.get(file.path) !== file.size).map((file) => file.path);
    if (changedSizes.length) throw new Error(`portable file sizes differ: ${JSON.stringify(changedSizes)}`);
    if (actual.readOnlyFiles.length) throw new Error(`read-only extracted files: ${JSON.stringify(actual.readOnlyFiles)}`);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  return { ...actual, equal: error == null, error };
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
