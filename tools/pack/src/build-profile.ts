import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const activePhases = new AsyncLocalStorage<readonly string[]>();
const PROFILE_PREFIX = "[tools-pack profile] ";

export function isBuildProfilingEnabled(): boolean {
  return process.env.READABLE_TOOLS_PACK_PROFILE === "1";
}

export function writeBuildProfile(phase: string, fields: Readonly<Record<string, unknown>>): void {
  if (!isBuildProfilingEnabled()) return;
  process.stderr.write(`${PROFILE_PREFIX}${JSON.stringify({ phase, timestampMs: Date.now(), pid: process.pid, ...fields })}\n`);
}

// No clock, I/O, async context, or promise wrapper on the default build path.
export function measureBuildStep<T>(
  phase: string,
  task: () => Promise<T>,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  if (!isBuildProfilingEnabled()) return task();
  const parents = activePhases.getStore() ?? [];
  // The compatibility hook has recursive filesystem operations. Record their
  // outer duration, not a log entry and clock read for every file visited.
  if (parents.includes(phase)) return task();
  const startedAt = performance.now();
  return activePhases.run([...parents, phase], async () => {
    let status = "failed";
    try {
      const result = await task();
      status = "done";
      return result;
    } finally {
      writeBuildProfile(phase, {
        ...fields,
        durationMs: performance.now() - startedAt,
        parent: parents.at(-1) ?? null,
        pid: process.pid,
        startedAt: performance.timeOrigin + startedAt,
        status,
      });
    }
  });
}

// Preserve lifecycle NDJSON verbatim, including child timestamps. Parsing logs
// must not turn an otherwise successful build into an instrumentation failure.
export function forwardPnpmProfile(output: string): void {
  if (!isBuildProfilingEnabled()) return;
  for (const line of output.split(/\r?\n/)) {
    if (/"name"\s*:\s*"pnpm:lifecycle"/.test(line)) writeBuildProfile("pnpm:lifecycle", { raw: line });
  }
}

// electron-builder is buffered by execFile; forward only profiling records.
export function forwardBuildProfile(output: string): void {
  if (!isBuildProfilingEnabled()) return;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(PROFILE_PREFIX)) process.stderr.write(`${line}\n`);
  }
}
