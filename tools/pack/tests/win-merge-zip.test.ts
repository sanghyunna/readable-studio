import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertPortableContentEquivalent } from "../src/content-equivalence.js";
import { winResources } from "../src/resources.js";
import { mergeWinZipShards } from "../src/win/merge-zip.js";
import { buildWinPortableZip, resolvePortableZipShards } from "../src/win/zip.js";
import { resolveToolPackConfig } from "../src/config.js";
import { resolveWinPaths } from "../src/win/paths.js";
import { buildWinPortableZipCacheKeyInput } from "../src/win/builder.js";

const execFileAsync = promisify(execFile);
describe.skipIf(process.platform !== "win32")("standard ZIP shard merge", () => {
  it("routes the real portable ZIP stage through bounded shards with exact content", async () => {
    const root = await mkdtemp(join(tmpdir(), "readable-portable-shards-"));
    const config = resolveToolPackConfig("win", { dir: root, namespace: "test", fastBuild: true });
    const paths = resolveWinPaths(config);
    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      for (let i = 0; i < 140; i++) await writeFile(join(paths.unpackedRoot, `file-${i}.txt`), `bytes ${i}`);
      const segments = await buildWinPortableZip(config, paths, {
        version: 1, source: "namespace", appBuilderOutputRoot: paths.appBuilderOutputRoot,
        unpackedRoot: paths.unpackedRoot, executablePath: paths.unpackedExePath,
        cacheEntryPath: null, configPath: paths.packagedConfigPath, webStandaloneHookAuditPath: null,
      });
      const processes = segments.filter(({ phase }) => phase.startsWith("portable-zip:7z:shard-"));
      expect(processes).toHaveLength(resolvePortableZipShards(true)!);
      for (const process of processes) expect(process.details?.args).toContain("-mx=5");
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
      await writeFile(join(root, "broken.zip"), "not a ZIP");
      await expect(mergeWinZipShards([join(root, "broken.zip")], join(root, "broken-output.zip"))).rejects.toThrow("invalid ZIP shard end record");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
