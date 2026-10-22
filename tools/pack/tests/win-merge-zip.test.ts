import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPortableContentEquivalent } from "../src/content-equivalence.js";
import { winResources } from "../src/resources.js";
import { mergeWinZipShards } from "../src/win/merge-zip.js";
import { buildWinPortableZip, resolvePortableZipShards } from "../src/win/zip.js";
import { resolveToolPackConfig } from "../src/config.js";
import { resolveWinPaths } from "../src/win/paths.js";
import { buildWinPortableZipCacheKeyInput } from "../src/win/builder.js";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, createHash: vi.fn(original.createHash) };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, stat: vi.fn(original.stat), writeFile: vi.fn(original.writeFile) };
});

afterEach(() => vi.unstubAllEnvs());

const execFileAsync = promisify(execFile);
describe.skipIf(process.platform !== "win32")("standard ZIP shard merge", () => {
  it("balances plain ZIP shard bytes without hashing or repeated source stats and preserves exact content", async () => {
    vi.stubEnv("READABLE_BUILD_EVENTS", undefined);
    const root = await mkdtemp(join(tmpdir(), "readable-portable-shards-"));
    const config = resolveToolPackConfig("win", { dir: root, namespace: "test", fastBuild: true });
    const paths = resolveWinPaths(config);
    const sizes = new Map<string, number>(Array.from({ length: 140 }, (_, i) =>
      [`file-${i}.txt`, i % 20 < 4 ? 10_000 : 1_000] as const));
    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      for (const [file, size] of sizes) await writeFile(join(paths.unpackedRoot, file), Buffer.alloc(size, 65));
      vi.clearAllMocks();
      const segments = await buildWinPortableZip(config, paths, {
        version: 1, source: "namespace", appBuilderOutputRoot: paths.appBuilderOutputRoot,
        unpackedRoot: paths.unpackedRoot, executablePath: paths.unpackedExePath,
        cacheEntryPath: null, configPath: paths.packagedConfigPath, webStandaloneHookAuditPath: null,
      });
      const processes = segments.filter(({ phase }) => phase.startsWith("portable-zip:7z:shard-"));
      expect(processes).toHaveLength(resolvePortableZipShards(true)!);
      for (const process of processes) expect(process.details?.args).toContain("-mx=5");
      expect(createHash).not.toHaveBeenCalled();
      expect(createReadStream).not.toHaveBeenCalled();
      for (const file of sizes.keys()) {
        expect(vi.mocked(stat).mock.calls.filter(([path]) => path === join(paths.unpackedRoot, file))).toHaveLength(1);
      }
      const shardFiles = vi.mocked(writeFile).mock.calls
        .filter(([path]) => String(path).includes(".zip-shards-") && String(path).endsWith(".txt"))
        .map(([, data]) => String(data).trim().split("\n"));
      expect(shardFiles).toHaveLength(processes.length);
      expect(shardFiles.flat().sort()).toEqual([...sizes.keys()].sort());
      const shardBytes = shardFiles.map((files) => files.reduce((sum, file) => sum + sizes.get(file)!, 0));
      const mean = shardBytes.reduce((sum, bytes) => sum + bytes, 0) / shardBytes.length;
      expect(Math.max(...shardBytes)).toBeLessThanOrEqual(mean * 1.15);
      const extracted = join(root, "extracted");
      await execFileAsync(winResources.sevenZipExe, ["x", paths.setupZipPath, `-o${extracted}`, "-y"], { windowsHide: true });
      expect(await assertPortableContentEquivalent(paths.unpackedRoot, extracted)).toBe(140);
      const input = { electronBuilderDirKey: "dir", packagedConfig: "{}", portableZipCompression: 5, portableZipThreads: 20, namespace: "rg", packagedAppKey: "app", packagedVersion: "1.3.0", signing: null };
      expect(buildWinPortableZipCacheKeyInput({ ...input, portableZipShards: 4 })).not.toEqual(buildWinPortableZipCacheKeyInput(input));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves exact archive bytes and every extracted file with level-5 7-Zip inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-zip-merge-"));
    const source = join(root, "source");
    const files = [".hidden", "Readable Studio.exe", "app/empty", "app/nested/a.txt", "app/nested/\uD55C\uAE00.txt"];
    const archive = async (name: string, selected: string[]) => {
      const list = join(root, `${name}.txt`);
      const output = join(root, `${name}.zip`);
      await writeFile(list, `${selected.join("\n")}\n`);
      await execFileAsync(winResources.sevenZipExe, ["a", "-tzip", "-mx=5", "-mmt=2", "-mtc=off", "-mta=off", "-mtm=off", "-scsUTF-8", output, `@${list}`], { cwd: source, windowsHide: true });
      return output;
    };
    try {
      for (const [i, file] of files.entries()) {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await writeFile(join(source, file), file === "app/empty" ? Buffer.alloc(0) : Buffer.alloc(512 + i, i));
      }
      const single = await archive("single", files);
      const shards = [await archive("one", files.filter((_, i) => i % 2 === 0)), await archive("two", files.filter((_, i) => i % 2 === 1))];
      const merged = join(root, "merged.zip");
      expect(await mergeWinZipShards(shards, merged)).toBe(true);
      expect(await readFile(merged)).toEqual(await readFile(single));
      await execFileAsync(winResources.sevenZipExe, ["t", merged], { windowsHide: true });
      const extracted = join(root, "extracted");
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${merged.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}'`], { windowsHide: true });
      expect(await assertPortableContentEquivalent(source, extracted)).toBe(files.length);
      await expect(mergeWinZipShards([shards[0]!, shards[0]!], join(root, "duplicate.zip"))).rejects.toThrow("duplicate ZIP shard entry");
      const zip64 = join(root, "zip64.zip");
      const bytes = await readFile(single);
      bytes.writeUInt16LE(0xffff, bytes.length - 12);
      await writeFile(zip64, bytes);
      expect(await mergeWinZipShards([zip64], join(root, "unsupported.zip"))).toBe(false);
      bytes.writeUInt16LE(files.length, bytes.length - 12);
      bytes.writeUInt32LE(0xffffffff, bytes.length - 6);
      await writeFile(zip64, bytes);
      expect(await mergeWinZipShards([zip64], join(root, "unsupported-offset.zip"))).toBe(false);
      await writeFile(join(root, "broken.zip"), "not a ZIP");
      await expect(mergeWinZipShards([join(root, "broken.zip")], join(root, "broken-output.zip"))).rejects.toThrow("invalid ZIP shard end record");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("clears cache protection attributes and leaves CRC corruption detectable by the ZIP engine", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-zip-attributes-"));
    try {
      await writeFile(join(root, "payload"), "payload bytes for CRC verification");
      const shard = join(root, "shard.zip");
      await execFileAsync(winResources.sevenZipExe, ["a", "-tzip", "-mx=0",
        "-mtc=off", "-mta=off", "-mtm=off", shard, "payload"], { cwd: root, windowsHide: true });
      const bytes = await readFile(shard);
      const footer = bytes.length - 22;
      const central = bytes.readUInt32LE(footer + 16);
      bytes.writeUInt32LE(0x81a40027, central + 38);
      await writeFile(shard, bytes);
      const merged = join(root, "merged.zip");
      expect(await mergeWinZipShards([shard], merged)).toBe(true);
      const output = await readFile(merged);
      expect(output.readUInt32LE(output.readUInt32LE(output.length - 6) + 38)).toBe(0x20);
      await execFileAsync(winResources.sevenZipExe, ["t", merged], { windowsHide: true });
      // Store has no deflate parser to fail first: this must be a CRC mismatch.
      const dataOffset = 30 + output.readUInt16LE(26) + output.readUInt16LE(28);
      output[dataOffset] = output[dataOffset]! ^ 1;
      await writeFile(merged, output);
      await expect(execFileAsync(winResources.sevenZipExe, ["t", merged], { windowsHide: true }))
        .rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("CRC Failed") });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
