import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  command,
  compilerDependencies,
  createTypecheckScheduler,
  observeBuildEvents,
  prepareTypecheck,
  settleTypecheck,
  typecheckConcurrency,
  typecheckCommands,
  validateReceipt,
  workspacePackages,
  type BuildEvent,
  type WorkspacePackage,
} from "./typecheck.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const pkg = (name: string, dependencies: string[] = []): WorkspacePackage => ({
  name, dependencies, dir: resolve(name), typecheck: true, built: true,
});
function event(node: string, kind = "node-ready"): BuildEvent {
  return {
    v: 1, runId: "run", event: kind, node, ts: "2026-10-19T00:00:00.000Z",
    inputHash: `input-${node}`, outputRoot: resolve("output"),
    receipt: resolve("receipt.txt"), outputManifestHash: hash("manifest"),
  };
}
function graph(names: string[], dependencies: Record<string, string[]> = {}): BuildEvent {
  return {
    ...event("workspace", "graph-ready"),
    packages: names.map((name) => ({
      name, dir: resolve(name), dependencies: dependencies[name] ?? [], inputHash: `input-${name}`,
    })),
  };
}
function signal<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}
const valid = async () => {};

test("cold compiler commands disable incremental state without dropping test passes or prerequisites", () => {
  const script = "pnpm --filter desktop build && tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile state.tsbuildinfo && tsc -p tsconfig.tests.json --noEmit";
  assert.deepEqual(typecheckCommands(script, false), [
    ["pnpm", "--filter", "desktop", "build"],
    ["tsc", "-p", "tsconfig.json", "--noEmit", "--incremental", "false"],
    ["tsc", "-p", "tsconfig.tests.json", "--noEmit", "--incremental", "false"],
  ]);
  assert.deepEqual(typecheckCommands(script, true)[1],
    ["tsc", "-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", "state.tsbuildinfo"]);
});

test("compiler edges include real source and test imports, not runtime names or fixture strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "typecheck-imports-"));
  try {
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: ["source.ts"] }));
    await writeFile(join(root, "tsconfig.tests.json"), JSON.stringify({ files: ["test.ts"] }));
    await writeFile(join(root, "source.ts"), 'import type { Value } from "library/subpath"; const name = "runtime"; const fixture = \'import x from "fixture";\';');
    await writeFile(join(root, "test.ts"), 'export { other } from "tests";');
    assert.deepEqual(await compilerDependencies(root,
      "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit",
      ["library", "runtime", "fixture", "tests"]), ["library", "tests"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("own production build does not block a check with separate build information", async () => {
  const started: string[] = [];
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library")], runId: "run", concurrency: 2, rootDependencies: [], validate: valid,
    execute: async (name) => { started.push(name); return 0; },
  });
  await scheduler.accept(graph(["library"]));
  assert.deepEqual((await scheduler.done).errors, []);
  assert.deepEqual(started, ["library", "scripts"]);
});

test("real pnpm spawn enumerates workspace packages", { timeout: 30_000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await command("pnpm", ["-r", "list", "--depth", "-1", "--json"], root, true);
  assert.equal(result.code, 0);
  const packages = JSON.parse(result.stdout) as { name: string; path: string }[];
  for (const name of ["web", "daemon", "tools-pack"]) {
    assert.ok(packages.some((pkg) => pkg.name === `@readable-studio/${name}`));
  }
  assert.ok(packages.every((pkg) => typeof pkg.path === "string"));
});

test("real pnpm spawn executes the TypeScript compiler", { timeout: 30_000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await command("pnpm", ["exec", "tsc", "--version"], root, true);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^Version \d+\.\d+\.\d+/);
});

test("memory admission reserves 6 GiB, supports overrides, and caps at twenty", () => {
  assert.equal(typecheckConcurrency(32 * 1024 ** 3), 17);
  assert.equal(typecheckConcurrency(4 * 1024 ** 3), 1);
  assert.equal(typecheckConcurrency(100 * 1024 ** 3), 20);
  assert.equal(typecheckConcurrency(12 * 1024 ** 3, 2), 3);
  assert.equal(typecheckConcurrency(0, 1.5, 40), 20);
  assert.throws(() => typecheckConcurrency(0, 0));
  assert.throws(() => typecheckConcurrency(0, 1.5, 1.5));
});

test("workspace metadata keeps built workspace imports but ignores source-only and external dependencies", () => {
  const packages = workspacePackages([
    { path: "/library", manifest: { name: "library", types: "./dist/index.d.ts", scripts: { typecheck: "tsc" } } },
    { path: "/source", manifest: { name: "source", exports: "./src/index.ts" } },
    { path: "/consumer", manifest: { name: "consumer", scripts: { typecheck: "tsc" },
      dependencies: { library: "workspace:*", source: "workspace:*", external: "^1" } } },
  ]);
  assert.deepEqual(packages[2]?.dependencies, ["library"]);
  assert.equal(packages[1]?.typecheck, false);
});

test("startup removes incremental state on every run unless --keep-incremental is passed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "typecheck-state-"));
  const state = join(root, ".tmp", "typecheck");
  const buildInfo = join(state, "library.typecheck.tsbuildinfo");
  const log = t.mock.method(console, "log", () => {});
  try {
    await mkdir(state, { recursive: true });
    await writeFile(buildInfo, "previous diagnostics");
    await writeFile(join(root, ".tmp", "other.txt"), "unrelated state");
    await prepareTypecheck([], root);
    await assert.rejects(stat(state), { code: "ENOENT" });
    assert.equal(await readFile(join(root, ".tmp", "other.txt"), "utf8"), "unrelated state");
    assert.equal(log.mock.callCount(), 0);

    await mkdir(state, { recursive: true });
    await writeFile(buildInfo, "new diagnostics");
    const values = await prepareTypecheck(["--keep-incremental"], root);
    assert.equal(values["keep-incremental"], true);
    assert.equal(await readFile(buildInfo, "utf8"), "new diagnostics");
    assert.equal(log.mock.callCount(), 1);

    await prepareTypecheck([], root);
    await assert.rejects(stat(state), { code: "ENOENT" });
    assert.equal(log.mock.callCount(), 1);
    await prepareTypecheck([], root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready jobs start immediately; dependency checks do not wait for other typechecks", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const starts = new Map(["scripts", "library", "consumer", "independent"].map((name) => [name, signal<void>()]));
  const releases = new Map([...starts.keys()].map((name) => [name, signal<number>()]));
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library", ["library"]), pkg("consumer", ["library"]), pkg("independent", ["independent"])],
    runId: "run", concurrency: 3, rootDependencies: [], validate: valid,
    execute: (name) => {
      started.push(name);
      starts.get(name)!.resolve();
      return releases.get(name)!.promise;
    },
  });
  await scheduler.accept(graph(["library", "consumer", "independent"], { consumer: ["library"] }));
  await starts.get("scripts")!.promise;
  assert.deepEqual(started, ["scripts"]);
  await scheduler.accept(event("consumer"));
  assert.deepEqual(started, ["scripts"]);
  await scheduler.accept(event("library"));
  await Promise.all([starts.get("library")!.promise, starts.get("consumer")!.promise]);
  assert.deepEqual(started, ["scripts", "library", "consumer"]);
  await scheduler.accept(event("library"));
  await scheduler.accept(event("independent"));
  assert.equal(started.includes("independent"), false);
  releases.get("scripts")!.resolve(0);
  await starts.get("independent")!.promise;
  for (const release of releases.values()) release.resolve(0);
  const result = await scheduler.done;
  assert.equal(result.results.length, 4);
  assert.equal(new Set(started).size, 4);
  assert.deepEqual(result.errors, []);
});

test("collects exit failures and thrown failures while continuing independent checks", { timeout: 5000 }, async () => {
  let clock = 0;
  const scheduler = createTypecheckScheduler({
    packages: [pkg("bad"), pkg("crash"), pkg("good")], runId: "run", concurrency: 2,
    rootDependencies: [], now: () => clock++, validate: valid,
    execute: async (name) => {
      if (name === "crash") throw new Error("spawn failed");
      return name === "bad" ? 2 : 0;
    },
  });
  await scheduler.accept(graph([]));
  const outcome = await scheduler.done;
  assert.equal(outcome.results.length, 4);
  assert.equal(outcome.results.filter((result) => result.exitCode !== 0).length, 2);
  assert.equal(outcome.results.find((result) => result.name === "crash")?.error, "spawn failed");
  assert.ok(outcome.results.every((result) => result.wallMs > 0));
});

test("producer failure blocks only dependent checks including transitive declaration imports", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const scheduler = createTypecheckScheduler({
    packages: [pkg("consumer", ["library"]), pkg("independent")], runId: "run", concurrency: 20,
    rootDependencies: [], validate: valid, execute: async (name) => { started.push(name); return 0; },
  });
  await scheduler.accept(graph(["library", "base"], { library: ["base"] }));
  await scheduler.accept({ ...event("base", "failed"), error: "base build failed" });
  const outcome = await scheduler.done;
  assert.deepEqual(started.sort(), ["independent", "scripts"]);
  assert.equal(outcome.results.find((result) => result.name === "consumer")?.exitCode, 1);
  assert.ok(outcome.errors.includes("base build failed"));
});

test("rejects another run instead of admitting stale readiness", { timeout: 5000 }, async () => {
  const scheduler = createTypecheckScheduler({
    packages: [pkg("consumer", ["library"])], runId: "run", concurrency: 20,
    rootDependencies: [], execute: async () => 0, validate: valid,
  });
  await scheduler.accept({ ...graph(["library"]), runId: "stale" });
  const outcome = await scheduler.done;
  assert.equal(outcome.results.filter((result) => result.exitCode !== 0).length, 2);
  assert.equal(outcome.errors.length, 1);
});

test("conflicting node hashes invalidate readiness before blocked consumers start", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const scheduler = createTypecheckScheduler({
    packages: [pkg("consumer", ["library", "later"])], runId: "run", concurrency: 20,
    rootDependencies: [], execute: async (name) => { started.push(name); return 0; }, validate: valid,
  });
  await scheduler.accept(graph(["library", "later"]));
  await scheduler.accept(event("library"));
  await scheduler.accept({ ...event("library"), outputManifestHash: hash("other") });
  const outcome = await scheduler.done;
  assert.deepEqual(started, ["scripts"]);
  assert.match(outcome.errors[0]!, /Conflicting/);
  assert.equal(outcome.results.find((result) => result.name === "consumer")?.exitCode, 1);
});

test("missing producer and incomplete workspace readiness fail rather than hang", { timeout: 5000 }, async () => {
  const scheduler = createTypecheckScheduler({
    packages: [pkg("missing", ["absent"]), pkg("incomplete", ["library"])],
    runId: "run", concurrency: 20, rootDependencies: [], execute: async () => 0, validate: valid,
  });
  await scheduler.accept(graph(["library"]));
  await scheduler.accept(event("workspace", "workspace-ready"));
  const outcome = await scheduler.done;
  assert.equal(outcome.results.filter((result) => result.exitCode !== 0).length, 2);
});

function receiptFixture() {
  const files = [{ path: "index.d.ts", size: 5, sha256: hash("types") }];
  const manifestHash = hash(JSON.stringify(files));
  const ready = { ...event("library"), outputManifestHash: manifestHash };
  const receipt = {
    v: 1, runId: "run", node: "library", inputHash: ready.inputHash,
    outputRoot: ready.outputRoot, files, manifestHash,
  };
  const io = {
    readFile: async () => JSON.stringify(receipt),
    stat: async () => ({ size: 5, isFile: () => true }),
  };
  return { ready, receipt, io };
}

test("validates receipt identity, manifest digest, and output file sizes", async () => {
  const { ready, receipt, io } = receiptFixture();
  await validateReceipt(ready, "run", io);
  receipt.inputHash = "stale";
  await assert.rejects(validateReceipt(ready, "run", io), /Invalid receipt/);
});

test("missing receipts, files, wrong sizes, and changed manifest digests are invalid", async () => {
  const { ready, receipt, io } = receiptFixture();
  await assert.rejects(validateReceipt(ready, "run", {
    ...io, readFile: async () => { throw new Error("ENOENT receipt"); },
  }), /ENOENT/);
  await assert.rejects(validateReceipt(ready, "run", {
    ...io, stat: async () => { throw new Error("ENOENT file"); },
  }), /ENOENT/);
  await assert.rejects(validateReceipt(ready, "run", {
    ...io, stat: async () => ({ size: 99, isFile: () => true }),
  }), /Missing or changed/);
  receipt.files[0]!.size = 99;
  await assert.rejects(validateReceipt(ready, "run", io), /Invalid receipt/);
});

test("receipt paths cannot escape the output root even with a matching manifest digest", async () => {
  const { ready, receipt, io } = receiptFixture();
  receipt.files[0]!.path = "../outside";
  receipt.manifestHash = hash(JSON.stringify(receipt.files));
  ready.outputManifestHash = receipt.manifestHash;
  await assert.rejects(validateReceipt(ready, "run", io), /Invalid manifest entry/);
});

test("event observer subscribes before file creation and preserves split JSON lines", { timeout: 5000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "readable-typecheck-test-"));
  const path = join(temporary, "events.jsonl");
  const received = signal<BuildEvent>();
  const errors: unknown[] = [];
  const observer = await observeBuildEvents(path, async (value) => { received.resolve(value); }, (error) => {
    errors.push(error);
  });
  try {
    const line = JSON.stringify(event("library"));
    await appendFile(path, line.slice(0, 20));
    await appendFile(path, `${line.slice(20)}\n`);
    assert.deepEqual(await received.promise, event("library"));
    assert.deepEqual(errors, []);
  } finally {
    await observer.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("final drain consumes an event appended without a watch notification", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library", ["library"])], runId: "run", concurrency: 4, rootDependencies: [], validate: valid,
    execute: async (name) => { started.push(name); return 0; },
  });
  await scheduler.accept(graph(["library"]));
  let flushed = 0;
  const producer = signal<void>();
  const outcome = settleTypecheck({
    scheduler, producer: producer.promise, setTimer: () => 0, clearTimer: () => {},
    observer: { flush: async () => { flushed++; await scheduler.accept(event("library")); } },
  });
  producer.resolve();
  const result = await outcome;
  assert.equal(flushed, 1);
  assert.ok(started.includes("library"));
  assert.deepEqual(result.errors, []);
  assert.ok(result.results.every((entry) => entry.exitCode === 0));
});

test("producer exit keeps ready checks queued behind a single executing check", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const firstStarted = signal<void>();
  const release = signal<number>();
  const producer = signal<void>();
  const producerSettled = signal<void>();
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library", ["library"]), pkg("consumer", ["library"])], runId: "run", concurrency: 1,
    rootDependencies: [], validate: valid,
    execute: async (name) => {
      started.push(name);
      if (name === "scripts") {
        firstStarted.resolve();
        return release.promise;
      }
      return 0;
    },
  });
  const outcome = settleTypecheck({
    scheduler: {
      ...scheduler,
      failPending: (...args) => {
        scheduler.failPending(...args);
        producerSettled.resolve();
      },
    },
    producer: producer.promise, observer: { flush: async () => {} },
    setTimer: () => 0, clearTimer: () => {},
  });
  await scheduler.accept(graph(["library", "consumer"], { consumer: ["library"] }));
  await firstStarted.promise;
  await scheduler.accept(event("library"));
  await scheduler.accept(event("consumer"));
  producer.resolve();
  await producerSettled.promise;
  assert.deepEqual(started, ["scripts"]);
  release.resolve(0);
  const result = await outcome;
  assert.deepEqual(started, ["scripts", "library", "consumer"]);
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((entry) => entry.exitCode === 0));
  assert.deepEqual(result.errors, []);
});

test("real observer flush reads events that no watch callback delivered", { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "typecheck-flush-"));
  try {
    const seen: string[] = [];
    const path = join(dir, "build.jsonl");
    const observer = await observeBuildEvents(path, async (value) => { seen.push(value.event); }, (error) => { throw error; });
    await appendFile(path, JSON.stringify(event("x", "workspace-ready")) + "\n");
    await observer.flush();
    assert.deepEqual(seen, ["workspace-ready"]);
    await observer.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("producer exit without node-ready fails pending packages instead of hanging", { timeout: 5000 }, async () => {
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library", ["library"]), pkg("consumer", ["library"])], runId: "run", concurrency: 4,
    rootDependencies: [], validate: valid, execute: async () => 0,
  });
  await scheduler.accept(graph(["library"]));
  const result = await settleTypecheck({
    scheduler, producer: Promise.resolve(), setTimer: () => 0, clearTimer: () => {},
    observer: { flush: async () => {} },
  });
  const failed = result.results.filter((entry) => entry.exitCode !== 0).map((entry) => entry.name).sort();
  assert.deepEqual(failed, ["consumer", "library"]);
  assert.ok(result.errors.includes("producer exited without node-ready library"));
  assert.equal(result.results.find((entry) => entry.name === "consumer")?.error, "producer exited without node-ready consumer");
});

test("deadline fails pending checks with a clear message", { timeout: 5000 }, async () => {
  const scheduler = createTypecheckScheduler({
    packages: [pkg("library", ["library"])], runId: "run", concurrency: 4,
    rootDependencies: [], validate: valid, execute: async () => 0,
  });
  await scheduler.accept(graph(["library"]));
  let fire!: () => void;
  let cleared = 0;
  const outcome = settleTypecheck({
    scheduler, deadlineMs: 90_000, observer: { flush: async () => {} },
    setTimer: (callback) => { fire = callback; return 1; }, clearTimer: () => { cleared++; },
  });
  fire();
  const result = await outcome;
  assert.equal(cleared, 1);
  assert.match(result.errors[0] ?? "", /deadline of 90s exceeded before library/);
  assert.equal(result.results.find((entry) => entry.name === "library")?.exitCode, 1);
});
