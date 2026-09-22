import type { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { crashReporter } from "electron";

export type CrashEvidenceEvent = {
  readonly event: "capture-started" | "renderer-gone" | "renderer-reload" | "recovery-blocked" | "renderer-unresponsive" | "renderer-responsive" | "manual-reload" | "child-process-gone";
  readonly reason?: string;
  readonly processType?: string;
  readonly exitCode?: number;
  readonly attempt?: number;
};
type CrashApp = EventEmitter & {
  setPath(name: "crashDumps", path: string): void;
  readonly commandLine: { removeSwitch(name: string): void };
};
const REASONS = new Set(["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"]);
const PROCESS_TYPES = new Set(["Utility", "GPU", "Zygote", "Sandbox helper", "Pepper Plugin", "Pepper Plugin Broker", "Unknown"]);

/** Always-on, content-free event evidence. Native memory dumps are opt-in, never uploaded. */
export function startCrashEvidence(app: CrashApp, namespaceRoot: string, nativeDumps = false) {
  const eventPath = join(namespaceRoot, "logs", "desktop", "crashes.jsonl");
  const record = (event: CrashEvidenceEvent): void => {
    // Explicit projection: never serialize Electron details, URLs, names, paths,
    // process IDs, document text, console messages, environment or user objects.
    const entry = {
      timestamp: new Date().toISOString(),
      event: event.event,
      ...(event.reason === undefined ? {} : { reason: REASONS.has(event.reason) ? event.reason : "unknown" }),
      ...(event.processType === undefined ? {} : { processType: PROCESS_TYPES.has(event.processType) ? event.processType : "unknown" }),
      ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    };
    try {
      mkdirSync(dirname(eventPath), { recursive: true });
      if (existsSync(eventPath) && statSync(eventPath).size >= 1024 * 1024) {
        renameSync(eventPath, `${eventPath}.previous`);
      }
      // Small synchronous records survive immediate shutdown after a crash.
      appendFileSync(eventPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error: unknown) {
      console.error("desktop crash evidence write failed", { errorType: error instanceof Error ? error.name : "unknown" });
    }
  };
  if (nativeDumps) {
    const dumpPath = join(namespaceRoot, "crashes");
    mkdirSync(dumpPath, { recursive: true });
    app.setPath("crashDumps", dumpPath);
    app.commandLine.removeSwitch("disable-breakpad");
    crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true, compress: true, extra: {}, globalExtra: {} });
    console.warn("desktop local native crash dumps enabled; memory fragments may contain sensitive data; uploads disabled");
  }
  const onChildGone = (_event: unknown, details: Electron.Details): void => {
    record({ event: "child-process-gone", processType: details.type, reason: details.reason, exitCode: details.exitCode });
  };
  app.on("child-process-gone", onChildGone);
  record({ event: "capture-started" });
  return { record, dispose: (): void => { app.removeListener("child-process-gone", onChildGone); } };
}
