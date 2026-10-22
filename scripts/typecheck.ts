import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

export type WorkspacePackage = {
  name: string;
  dir: string;
  dependencies: string[];
  typecheck: boolean;
  built: boolean;
};

export type BuildEvent = {
  v: number;
  runId: string;
  event: string;
  node: string;
  ts: string;
  inputHash: string | null;
  outputRoot: string | null;
  receipt: string | null;
  outputManifestHash: string | null;
  error?: string;
  packages?: { name: string; dir: string; dependencies: string[]; inputHash: string }[];
};

type Receipt = {
  v: number;
  runId: string;
  node: string;
  inputHash: string;
  outputRoot: string;
  files: { path: string; size: number; sha256: string }[];
  manifestHash: string;
};

export type CheckResult = {
  name: string;
  exitCode: number;
  wallMs: number;
  error?: string;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function typecheckConcurrency(freeCommitBytes: number, estimateGb = 1.5, override?: number): number {
  if (!Number.isFinite(freeCommitBytes) || freeCommitBytes < 0) throw new Error("Invalid free commit");
  if (!Number.isFinite(estimateGb) || estimateGb <= 0) throw new Error("Invalid memory estimate");
  if (override !== undefined && (!Number.isInteger(override) || override < 1)) {
    throw new Error("Concurrency must be a positive integer");
  }
  return Math.min(20, override ?? Math.max(1, Math.floor((freeCommitBytes / 1024 ** 3 - 6) / estimateGb)));
}

export async function validateReceipt(
  event: BuildEvent,
  runId: string,
  io: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    stat: (path: string) => Promise<{ size: number; isFile: () => boolean }>;
  } = { readFile, stat },
): Promise<void> {
  if (event.v !== 1 || event.runId !== runId) throw new Error(`Invalid run for ${event.node}`);
  if (!event.receipt || !isAbsolute(event.receipt) || !event.outputRoot || !isAbsolute(event.outputRoot)
    || !event.inputHash || !event.outputManifestHash) {
    throw new Error(`Missing receipt metadata for ${event.node}`);
  }
  const receipt = JSON.parse(await io.readFile(event.receipt, "utf8")) as Receipt;
  if (receipt.v !== 1 || receipt.runId !== runId || receipt.node !== event.node
    || receipt.inputHash !== event.inputHash || receipt.outputRoot !== event.outputRoot
    || !Array.isArray(receipt.files) || receipt.files.length === 0
    || receipt.manifestHash !== event.outputManifestHash
    || sha256(JSON.stringify(receipt.files)) !== receipt.manifestHash) {
    throw new Error(`Invalid receipt for ${event.node}`);
  }
  let previous = "";
  for (const file of receipt.files) {
    if (typeof file.path !== "string" || !file.path || file.path.includes("\\")
      || isAbsolute(file.path) || file.path.split("/").some((part) => part === ".." || part === ".")
      || (previous !== "" && file.path <= previous) || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid manifest entry for ${event.node}`);
    }
    previous = file.path;
    const path = resolve(receipt.outputRoot, file.path);
    if (relative(receipt.outputRoot, path).startsWith("..")) throw new Error(`Invalid output path: ${file.path}`);
    const info = await io.stat(path);
    if (!info.isFile() || info.size !== file.size) throw new Error(`Missing or changed output: ${path}`);
  }
}

export function createTypecheckScheduler(options: {
  packages: WorkspacePackage[];
  runId: string;
  concurrency: number;
  rootDependencies: string[];
  execute: (name: string) => Promise<number>;
  validate?: (event: BuildEvent) => Promise<void>;
  now?: () => number;
  report?: (result: CheckResult) => void;
}) {
  const limit = typecheckConcurrency(0, 1.5, options.concurrency);
  const now = options.now ?? performance.now.bind(performance);
  const pending = new Map(options.packages.filter((pkg) => pkg.typecheck).map((pkg) => [pkg.name, pkg.dependencies]));
  pending.set("scripts", options.rootDependencies);
  const ready = new Map<string, string>();
  const invalid = new Map<string, string>();
  const results: CheckResult[] = [];
  const errors: string[] = [];
  let graph: Map<string, { dependencies: string[]; inputHash: string }> | undefined;
  let running = 0;
  let finished = false;
  let resolveDone!: (value: { results: CheckResult[]; errors: string[] }) => void;
  const done = new Promise<{ results: CheckResult[]; errors: string[] }>((resolve) => { resolveDone = resolve; });
  const record = (result: CheckResult) => {
    results.push(result);
    options.report?.(result);
  };
  const prerequisites = (dependencies: string[]): string[] => {
    const needed = new Set(dependencies);
    // Typechecks use .tmp/typecheck, not the producer's build information.
    const expand = (node: string) => {
      for (const dependency of graph?.get(node)?.dependencies ?? []) {
        if (!needed.has(dependency)) {
          needed.add(dependency);
          expand(dependency);
        }
      }
    };
    for (const dependency of needed) expand(dependency);
    return [...needed];
  };
  const dispatch = () => {
    if (finished) return;
    for (const [name, dependencies] of pending) {
      if (!graph) continue;
      const needed = prerequisites(dependencies);
      const failed = needed.find((dependency) => invalid.has(dependency) || !graph?.has(dependency));
      if (failed) {
        pending.delete(name);
        record({ name, exitCode: 1, wallMs: 0, error: invalid.get(failed) ?? `Missing producer: ${failed}` });
        continue;
      }
      if (running >= limit || needed.some((dependency) => !ready.has(dependency))) continue;
      pending.delete(name);
      running++;
      const start = now();
      void Promise.resolve().then(() => options.execute(name)).then(
        (exitCode) => record({ name, exitCode, wallMs: now() - start }),
        (error: unknown) => record({ name, exitCode: 1, wallMs: now() - start, error: message(error) }),
      ).finally(() => {
        running--;
        dispatch();
      });
    }
    if (pending.size === 0 && running === 0) {
      finished = true;
      resolveDone({ results, errors });
    }
  };
  const fail = (error: unknown) => {
    const text = message(error);
    errors.push(text);
    for (const name of pending.keys()) record({ name, exitCode: 1, wallMs: 0, error: text });
    pending.clear();
    graph ??= new Map();
    dispatch();
  };
  const accept = async (event: BuildEvent) => {
    if (finished) return;
    if (event.v !== 1 || event.runId !== options.runId) {
      fail(new Error(`Invalid build event run: ${event.runId}`));
      return;
    }
    if (event.event === "graph-ready") {
      if (graph || !event.packages) {
        fail(new Error("Invalid or duplicate build graph"));
        return;
      }
      graph = new Map(event.packages.map((pkg) => [pkg.name, pkg]));
    } else if (event.event === "node-ready") {
      try {
        const node = graph?.get(event.node);
        if (!node || node.inputHash !== event.inputHash) throw new Error(`Unexpected input hash: ${event.node}`);
        const signature = `${event.inputHash}:${event.outputManifestHash}`;
        if (ready.has(event.node) && ready.get(event.node) !== signature) {
          throw new Error(`Conflicting readiness events: ${event.node}`);
        }
        await (options.validate ?? ((value) => validateReceipt(value, options.runId)))(event);
        ready.set(event.node, signature);
      } catch (error) {
        errors.push(message(error));
        invalid.set(event.node, message(error));
        ready.delete(event.node);
      }
    } else if (event.event === "failed") {
      const text = event.error ?? `Build failed: ${event.node}`;
      errors.push(text);
      invalid.set(event.node, text);
      if (!graph?.has(event.node)) {
        fail(new Error(text));
        return;
      }
    } else if (event.event === "workspace-ready") {
      for (const pkg of graph?.keys() ?? []) {
        if (!ready.has(pkg)) invalid.set(pkg, `Missing node-ready: ${pkg}`);
      }
    }
    dispatch();
  };
  const failPending = (reason: (name: string) => string, missingReadinessOnly = false) => {
    if (finished) return;
    for (const [name, dependencies] of pending) {
      if (missingReadinessOnly && graph && prerequisites(dependencies)
        .every((dependency) => ready.has(dependency) && !invalid.has(dependency))) continue;
      const text = reason(name);
      errors.push(text);
      record({ name, exitCode: 1, wallMs: 0, error: text });
      pending.delete(name);
    }
    graph ??= new Map();
    dispatch();
  };
  return { accept, fail, failPending, done };
}

export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

/** Waits for the scheduler; a producer exit or the deadline can never leave checks pending forever. */
export async function settleTypecheck(options: {
  scheduler: Pick<ReturnType<typeof createTypecheckScheduler>, "done" | "failPending">;
  observer: { flush: () => Promise<void> };
  producer?: Promise<void> | undefined;
  deadlineMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Promise<{ results: CheckResult[]; errors: string[] }> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const timer = setTimer(() => {
    options.scheduler.failPending((name) =>
      `typecheck deadline of ${Math.round(deadlineMs / 1000)}s exceeded before ${name} could start`);
  }, deadlineMs);
  try {
    if (options.producer) {
      void options.producer.then(async () => {
        // The last events may have been appended without a watch notification.
        await options.observer.flush();
        options.scheduler.failPending((name) => `producer exited without node-ready ${name}`, true);
      }, () => undefined);
    }
    return await options.scheduler.done;
  } finally {
    clearTimer(timer);
  }
}

type Manifest = {
  name: string;
  scripts?: Record<string, string>;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export function workspacePackages(entries: { path: string; manifest: Manifest }[]): WorkspacePackage[] {
  const built = new Set(entries.filter(({ manifest }) =>
    /(?:\.\/)?(?:dist|lib|build)\//.test(JSON.stringify([manifest.types, manifest.exports])),
  ).map(({ manifest }) => manifest.name));
  return entries.map(({ path, manifest }) => ({
    name: manifest.name,
    dir: path,
    typecheck: Boolean(manifest.scripts?.typecheck),
    built: built.has(manifest.name),
    dependencies: Object.entries({
      ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies,
    }).filter(([name, version]) => version.startsWith("workspace:") && built.has(name)).map(([name]) => name),
  }));
}

export function typecheckCommands(script: string, keepIncremental: boolean): string[][] {
  return script.split("&&").map((part) => {
    const words = part.trim().split(/\s+/);
    if (words[0] !== "tsc" || keepIncremental) return words;
    const args = words.filter((word, index) => word !== "--incremental"
      && word !== "--tsBuildInfoFile" && words[index - 1] !== "--tsBuildInfoFile");
    return [...args, "--incremental", "false"];
  });
}

/** Runtime package dependencies do not necessarily supply any compiler inputs. */
export async function compilerDependencies(dir: string, script: string, dependencies: string[]): Promise<string[]> {
  const imports = new Set<string>();
  for (const words of typecheckCommands(script, true)) {
    if (words[0] !== "tsc") {
      // Preserve explicit prerequisite commands until their scripts are removed.
      for (const dependency of dependencies) if (words.includes(dependency)) imports.add(dependency);
      continue;
    }
    const project = words.indexOf("-p");
    const configPath = resolve(dir, project < 0 ? "tsconfig.json" : words[project + 1]!);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    if (parsed.errors.length) throw new Error(parsed.errors.map((error) =>
      ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
    await Promise.all(parsed.fileNames.map(async (file) => {
      for (const imported of ts.preProcessFile(await readFile(file, "utf8"), true, true).importedFiles) {
        for (const dependency of dependencies) {
          if (imported.fileName === dependency || imported.fileName.startsWith(`${dependency}/`)) imports.add(dependency);
        }
      }
    }));
  }
  return dependencies.filter((dependency) => imports.has(dependency));
}

export async function command(program: string, args: string[], cwd: string, capture = false): Promise<{ code: number; stdout: string }> {
  if (program === "pnpm") {
    let cli = process.env.npm_execpath;
    if (!cli || basename(cli) !== "pnpm.cjs") {
      cli = undefined;
      for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
        const shim = join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
        const candidate = join(directory, "node_modules/pnpm/bin/pnpm.cjs");
        if (await access(shim).then(() => true, () => false)
          && await access(candidate).then(() => true, () => false)) {
          cli = candidate;
          break;
        }
      }
    }
    if (!cli) throw new Error("Cannot resolve pnpm.cjs from npm_execpath or pnpm on PATH");
    program = process.execPath;
    args = [cli, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args,
      { cwd, windowsHide: true, shell: false, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

export async function observeBuildEvents(
  path: string,
  accept: (event: BuildEvent) => Promise<void>,
  fail: (error: unknown) => void,
): Promise<{ close: () => Promise<void>; flush: () => Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  let consumed = 0;
  let closed = false;
  let work = Promise.resolve();
  const drain = async () => {
    if (closed) return;
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (text.length < consumed) throw new Error("Build event log was truncated");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(consumed, end).split("\n")) {
      if (line.trim()) await accept(JSON.parse(line) as BuildEvent);
    }
    consumed = end;
  };
  const enqueue = () => { work = work.then(drain).catch(fail); };
  // Subscribe before the initial read, including when the producer has not created the file.
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename === null || resolve(dirname(path), filename.toString()) === resolve(path)) enqueue();
  });
  watcher.on("error", fail);
  enqueue();
  await work;
  return {
    close: async () => { watcher.close(); await work; closed = true; },
    flush: async () => { enqueue(); await work; },
  };
}

export async function prepareTypecheck(args: string[], root: string) {
  const { values } = parseArgs({ args, options: {
    events: { type: "string" }, "run-id": { type: "string" }, summary: { type: "string" },
    concurrency: { type: "string" }, "deadline-minutes": { type: "string" }, "memory-per-tsc-gb": { type: "string" },
    "keep-incremental": { type: "boolean" },
  } });
  if (Boolean(values.events) !== Boolean(values["run-id"])) throw new Error("--events and --run-id must be used together");
  if (values["keep-incremental"]) {
    console.log("Reusing incremental typecheck state (--keep-incremental).");
  } else {
    await rm(join(root, ".tmp", "typecheck"), { recursive: true, force: true });
  }
  return values;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const started = performance.now();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const values = await prepareTypecheck(args, root);
  const listing = await command("pnpm", ["-r", "list", "--depth", "-1", "--json"], root, true);
  if (listing.code !== 0) throw new Error("Cannot enumerate workspace packages");
  const entries = (JSON.parse(listing.stdout) as { path: string }[]).filter((entry) => resolve(entry.path) !== root);
  const manifests = await Promise.all(entries.map(async ({ path }) => ({
    path, manifest: JSON.parse(await readFile(join(path, "package.json"), "utf8")) as Manifest,
  })));
  const packages = workspacePackages(manifests);
  const scripts = new Map(manifests.map(({ manifest }) => [manifest.name, manifest.scripts?.typecheck ?? ""]));
  await Promise.all(packages.filter((pkg) => pkg.typecheck).map(async (pkg) => {
    pkg.dependencies = await compilerDependencies(pkg.dir, scripts.get(pkg.name)!, pkg.dependencies);
  }));
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Manifest;
  const rootDependencies = workspacePackages([...manifests, { path: root, manifest: rootManifest }])
    .find((pkg) => pkg.dir === root)!.dependencies;
  // Only built library entrypoints are needed by the root script compiler.
  const rootScript = "tsc -p scripts/tsconfig.json --noEmit";
  const scriptDependencies = await compilerDependencies(root, rootScript, rootDependencies);
  const override = values.concurrency ?? process.env.READABLE_TYPECHECK_CONCURRENCY;
  const estimate = Number(values["memory-per-tsc-gb"] ?? process.env.READABLE_TYPECHECK_MEMORY_GB ?? 1.5);
  let freeCommit = 0;
  if (override === undefined) {
    const memory = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory"], root, true);
    if (memory.code !== 0 || !memory.stdout.trim()) throw new Error("Cannot read Windows free commit");
    freeCommit = Number(memory.stdout.trim()) * 1024;
  }
  const concurrency = typecheckConcurrency(freeCommit, estimate, override === undefined ? undefined : Number(override));
  console.log(`Typecheck concurrency: ${concurrency} (6 GiB reserve, ${estimate} GiB/check)`);
  const temporary = values.events ? undefined : await mkdtemp(join(tmpdir(), "readable-typecheck-"));
  const events = resolve(values.events ?? join(temporary!, "build.jsonl"));
  const runId = values["run-id"] ?? randomUUID();
  const deadlineMinutes = Number(values["deadline-minutes"] ?? 30);
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) throw new Error("--deadline-minutes must be positive");
  const scheduler = createTypecheckScheduler({
    packages, runId, concurrency, rootDependencies: scriptDependencies,
    execute: async (name) => {
      console.log(`${name}: START +${((performance.now() - started) / 1000).toFixed(2)}s`);
      const pkg = packages.find((pkg) => pkg.name === name);
      for (const [program, ...args] of typecheckCommands(
        name === "scripts" ? rootScript : scripts.get(name)!, Boolean(values["keep-incremental"]),
      )) {
        const result = await command("pnpm", program === "tsc" ? ["exec", "tsc", ...args] : args, pkg?.dir ?? root);
        if (result.code !== 0) return result.code;
      }
      return 0;
    },
    report: (result) => console.log(`${result.name}: ${result.exitCode === 0 ? "PASS" : "FAIL"} ${(result.wallMs / 1000).toFixed(2)}s +${((performance.now() - started) / 1000).toFixed(2)}s${result.error ? ` ${result.error}` : ""}`),
  });
  const observer = await observeBuildEvents(events, scheduler.accept, scheduler.fail);
  let prepare: Promise<void> | undefined;
  if (temporary) {
    const needed = [...new Set([
      ...packages.filter((pkg) => pkg.typecheck).flatMap((pkg) => pkg.dependencies),
      ...scriptDependencies,
    ])].sort();
    prepare = command("pnpm", ["--filter", "@readable-studio/tools-pack", "exec", "tsx",
      "scripts/workspace-prepare.ts", "--packages", needed.join(","), "--events", events, "--run-id", runId], root)
      .then(({ code }) => {
        if (code !== 0) scheduler.fail(new Error(`workspace-prepare exited ${code}`));
      }, scheduler.fail);
  }
  try {
    const outcome = await settleTypecheck({
      scheduler, observer, producer: prepare, deadlineMs: deadlineMinutes * 60_000,
    });
    await prepare;
    await observer.close();
    const exitCode = outcome.errors.length > 0 || outcome.results.some((result) => result.exitCode !== 0) ? 1 : 0;
    if (values.summary) {
      await mkdir(dirname(resolve(values.summary)), { recursive: true });
      await writeFile(values.summary, `${JSON.stringify({ runId, concurrency, exitCode, ...outcome }, null, 2)}\n`);
    }
    return exitCode;
  } finally {
    await observer.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
