import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type BuildOutputFile = { path: string; size: number; sha256: string };
export type BuildReceipt = {
  v: 1;
  runId: string;
  node: string;
  inputHash: string | null;
  outputRoot: string;
  files: BuildOutputFile[];
  manifestHash: string;
};
export type BuildGraphPackage = { name: string; dir: string; dependencies: string[]; inputHash: string };
export type BuildEvent = {
  v: 1;
  runId: string;
  event: "graph-ready" | "node-ready" | "workspace-ready" | "final-tree-ready" | "zip-ready" | "failed";
  node: string;
  ts: string;
  inputHash: string | null;
  outputRoot: string | null;
  receipt: string | null;
  outputManifestHash: string | null;
  error?: string;
  packages?: BuildGraphPackage[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashOutputManifest(files: BuildOutputFile[]): string {
  return sha256(JSON.stringify(files));
}

async function outputFiles(root: string, paths: readonly string[]): Promise<BuildOutputFile[]> {
  const names = new Set<string>();
  for (const path of paths) {
    const absolute = resolve(root, path);
    if ((await stat(absolute)).isDirectory()) {
      for (const entry of await readdir(absolute, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) continue;
        const file = join(entry.parentPath, entry.name);
        if (entry.isFile() || (entry.isSymbolicLink() && (await stat(file)).isFile())) names.add(file);
      }
    } else {
      names.add(absolute);
    }
  }
  const files: BuildOutputFile[] = [];
  const pending = [...names];
  // Bound file handles and buffers even for a full packaged tree.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(20, pending.length) }, async () => {
    while (cursor < pending.length) {
      const file = pending[cursor++]!;
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
        size += Buffer.byteLength(chunk);
      }
      files.push({ path: relative(root, file).replaceAll("\\", "/"), size, sha256: hash.digest("hex") });
    }
  }));
  return files;
}

export function createBuildEventWriter(env: NodeJS.ProcessEnv = process.env) {
  const eventPath = env.READABLE_BUILD_EVENTS;
  if (eventPath == null) return undefined;
  if (!isAbsolute(eventPath)) throw new Error("READABLE_BUILD_EVENTS must be an absolute path");
  const runId = env.READABLE_BUILD_RUN_ID;
  if (!runId) throw new Error("READABLE_BUILD_RUN_ID is required with READABLE_BUILD_EVENTS");

  const append = async (fields: Omit<BuildEvent, "v" | "runId" | "ts">): Promise<void> => {
    await mkdir(dirname(eventPath), { recursive: true });
    // A single synchronous append cannot interleave with another node's append.
    appendFileSync(eventPath, `${JSON.stringify({ v: 1, runId, ts: new Date().toISOString(), ...fields })}\n`, "utf8");
  };
  return {
    async graphReady(packages: BuildGraphPackage[]): Promise<string> {
      const inputHash = sha256(JSON.stringify(packages));
      await append({
        event: "graph-ready", node: "workspace", packages, inputHash,
        outputRoot: null, receipt: null, outputManifestHash: null,
      });
      return inputHash;
    },
    async ready(options: {
      event: "node-ready" | "workspace-ready" | "final-tree-ready" | "zip-ready";
      node: string;
      inputHash: string | null;
      outputRoot: string;
      paths?: readonly string[];
      files?: BuildOutputFile[];
    }): Promise<BuildReceipt> {
      const outputRoot = resolve(options.outputRoot);
      const files = [...(options.files ?? await outputFiles(outputRoot, options.paths ?? ["."]))]
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      const manifestHash = hashOutputManifest(files);
      const receipt: BuildReceipt = {
        v: 1, runId, node: options.node, inputHash: options.inputHash, outputRoot, files, manifestHash,
      };
      const receiptPath = join(`${eventPath}.receipts`, sha256(runId), `${sha256(options.node)}.json`);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(`${receiptPath}.tmp`, `${JSON.stringify(receipt)}\n`, "utf8");
      await rename(`${receiptPath}.tmp`, receiptPath);
      await append({
        event: options.event, node: options.node, inputHash: options.inputHash,
        outputRoot, receipt: receiptPath, outputManifestHash: manifestHash,
      });
      return receipt;
    },
    async failed(node: string, inputHash: string | null, error: unknown): Promise<void> {
      await append({
        event: "failed", node, inputHash, outputRoot: null, receipt: null, outputManifestHash: null,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}
