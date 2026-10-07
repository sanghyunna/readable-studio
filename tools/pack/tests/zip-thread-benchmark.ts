// Explicit synthetic benchmark; not part of the unit suite or portable build.
// Run from tools/pack: pnpm exec tsx tests/zip-thread-benchmark.ts <evidence.json>
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertPortableContentEquivalent } from "../src/content-equivalence.js";
import { winResources } from "../src/resources.js";

const execFileAsync = promisify(execFile);
const evidence = process.argv[2];
if (!evidence) throw new Error("provide an evidence JSON path");
const scratch = resolve("../../.tmp");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "zip-thread-bench-"));
const tree = join(root, "tree");
const results: unknown[] = [];
try {
  await mkdir(tree);
  // 16 MiB, fixed mixed text/entropy repeated within Deflate's window.
  let state = 314159;
  const block = Buffer.alloc(4096);
  for (let i = 0; i < block.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    block[i] = i % 5 === 0 ? state & 255 : 32 + state % 95;
  }
  const payload = Buffer.alloc(256 * 1024);
  for (let i = 0; i < payload.length; i += block.length) block.copy(payload, i);
  const files = Array.from({ length: 64 }, (_, i) => `payload-${String(i).padStart(3, "0")}.bin`);
  for (const file of files) await writeFile(join(tree, file), payload);
  const cases = [
    { threads: 1, reverse: false }, { threads: 0, reverse: false }, { threads: 20, reverse: false },
    { threads: 20, reverse: true }, { threads: 0, reverse: true }, { threads: 1, reverse: true },
  ];
  for (const [i, variant] of cases.entries()) {
    const output = join(root, `case-${i}.zip`);
    const fileList = join(root, `case-${i}.txt`);
    await writeFile(fileList, `${(variant.reverse ? [...files].reverse() : files).join("\n")}\n`);
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("tests/measure-zip-threads.ps1"),
      "-ZipExe", winResources.sevenZipExe, "-Tree", tree, "-FileList", fileList,
      "-Output", output, "-Threads", String(variant.threads),
    ], { windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    const measurement = JSON.parse(stdout) as Record<string, unknown>;
    await execFileAsync(winResources.sevenZipExe, ["t", output], { windowsHide: true, timeout: 60_000 });
    const extracted = join(root, `extract-${i}`);
    await execFileAsync(winResources.sevenZipExe, ["x", output, `-o${extracted}`, "-y"], { windowsHide: true, timeout: 60_000 });
    const comparedFiles = await assertPortableContentEquivalent(tree, extracted);
    const bytes = await readFile(output);
    results.push({ requestedThreads: variant.threads, reverse: variant.reverse, ...measurement, comparedFiles, zipBytes: bytes.length, zipSha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(dirname(resolve(evidence)), { recursive: true });
  await writeFile(evidence, `${JSON.stringify({ uncompressedBytes: payload.length * files.length, node: process.version, results }, null, 2)}\n`);
  console.log(`Recorded ${results.length} level-5 cases with exact extracted-content checks in ${evidence}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
