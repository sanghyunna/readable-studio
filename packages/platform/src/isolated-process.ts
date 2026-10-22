import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { Duplex, Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createCommandInvocation } from "./index.js";

export type IsolatedAgentCapabilities = {
  appContainer: true;
  filesystemAcl: true;
  internetClient: true;
  killOnJobClose: true;
  loopbackDenied: true;
};

export type IsolatedAgentSupport =
  | { capabilities: IsolatedAgentCapabilities; supported: true }
  | { reason: string; supported: false };

export type SpawnIsolatedAgentOptions = {
  args?: readonly string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  helperPath?: string;
  signal?: AbortSignal;
  readExecutePaths: readonly string[];
  writablePaths: readonly string[];
  broker?: {
    pipeName: string;
    handleRequest(request: string): Promise<string>;
  };
};

export type IsolatedAgentProbeOptions = {
  helperPath?: string;
  signal?: AbortSignal;
};

type HelperReady = {
  profileName: string;
  status: "ready";
};

const MAX_BROKER_FRAME_BYTES = 4 * 1024 * 1024;
// Cold VDI launches include serialized ACL work on network-backed storage.
const HELPER_READY_TIMEOUT_MS = 5 * 60_000;
const HELPER_CLEANUP_TIMEOUT_MS = 3 * 60_000;
const BROKER_PIPE_PATTERN = /^\\\\\.\\pipe\\LOCAL\\ReadableStudio\.[A-Za-z0-9.-]{1,160}$/u;

const helperCandidates = [
  new URL("../dist/native/win32/agent-isolator.exe", import.meta.url),
  new URL("./native/win32/agent-isolator.exe", import.meta.url),
];

function nativeHelperPath(explicitPath?: string): string | null {
  if (process.platform !== "win32") return null;
  if (explicitPath) return win32.isAbsolute(explicitPath) && existsSync(explicitPath) ? explicitPath : null;
  for (const candidate of helperCandidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function invalidString(value: string): boolean {
  return value.length === 0 || value.includes("\0");
}

function validateOptions(options: SpawnIsolatedAgentOptions): void {
  if (invalidString(options.command)) throw new Error("isolated agent command must be non-empty and contain no NUL");
  if (!win32.isAbsolute(options.cwd)) throw new Error("isolated agent cwd must be absolute");
  for (const [name, values] of [
    ["args", options.args ?? []],
    ["readExecutePaths", options.readExecutePaths],
    ["writablePaths", options.writablePaths],
  ] as const) {
    for (const value of values) {
      if (invalidString(value)) throw new Error(`isolated agent ${name} entries must be non-empty and contain no NUL`);
      if (name !== "args" && !win32.isAbsolute(value)) throw new Error(`isolated agent ${name} entries must be absolute`);
    }
  }
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0") || value?.includes("\0")) {
      throw new Error("isolated agent environment contains an invalid entry");
    }
  }
  if (options.broker && !BROKER_PIPE_PATTERN.test(options.broker.pipeName)) {
    throw new Error("isolated agent broker pipe name is invalid");
  }
}

function helperFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeIsolatedAgentSupport(
  options: IsolatedAgentProbeOptions = {},
): Promise<IsolatedAgentSupport> {
  options.signal?.throwIfAborted();
  if (process.platform !== "win32") {
    return { reason: `AppContainer isolation is unavailable on ${process.platform}`, supported: false };
  }
  const helper = nativeHelperPath(options.helperPath);
  if (!helper) return { reason: "Windows AppContainer helper is missing; run build:native:win32", supported: false };

  try {
    const stdout = await new Promise<string>((resolveProbe, rejectProbe) => {
      const child = spawn(helper, ["--probe"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      let errorOutput = "";
      let failure: unknown;
      let timeout = setTimeout(() => {
        failure = new Error("AppContainer capability probe timed out");
        child.kill();
      }, HELPER_READY_TIMEOUT_MS);
      const onAbort = () => {
        failure = options.signal?.reason;
        clearTimeout(timeout);
        // The native probe has no cancel channel; let its ACL cleanup finish first.
        timeout = setTimeout(() => child.kill(), HELPER_CLEANUP_TIMEOUT_MS);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        errorOutput += chunk;
      });
      child.once("error", (error) => {
        cleanup();
        rejectProbe(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (failure != null) rejectProbe(failure);
        else if (code === 0) resolveProbe(output);
        else rejectProbe(new Error(errorOutput.trim() || `AppContainer capability probe exited ${code}`));
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    const result = JSON.parse(stdout) as IsolatedAgentSupport;
    if (
      result.supported !== true
      || result.capabilities?.appContainer !== true
      || result.capabilities.filesystemAcl !== true
      || result.capabilities.internetClient !== true
      || result.capabilities.killOnJobClose !== true
      || result.capabilities.loopbackDenied !== true
    ) {
      throw new Error("AppContainer helper returned an invalid capability result");
    }
    options.signal?.throwIfAborted();
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    return { reason: helperFailure(error), supported: false };
  }
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  control: Readable,
  signal?: AbortSignal,
): Promise<HelperReady> {
  return await new Promise<HelperReady>((resolveReady, rejectReady) => {
    let buffer = "";
    const timeout = setTimeout(() => fail(new Error("Windows AppContainer helper did not become ready")), HELPER_READY_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timeout);
      control.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      rejectReady(error);
    };
    const onError = (error: Error): void => fail(error);
    const onAbort = (): void => fail(signal?.reason);
    const onExit = (code: number | null): void => fail(new Error(`Windows AppContainer helper exited before launch (${code})`));
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024) return fail(new Error("Windows AppContainer helper control response is too large"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as HelperReady | { error?: string; status?: string };
        if (message.status !== "ready") {
          throw new Error("error" in message && message.error ? message.error : "Windows AppContainer launch failed");
        }
        cleanup();
        resolveReady(message as HelperReady);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    control.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function closeFailedHelper(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdin.end();
  // EOF also releases a native broker waiting for its ready acknowledgement.
  (child.stdio[3] as Duplex | null)?.end();
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolveClose) => {
    // Leave room for the native 2-minute ACL mutex wait and cleanup I/O.
    const kill = setTimeout(() => child.kill(), HELPER_CLEANUP_TIMEOUT_MS);
    child.once("close", () => {
      clearTimeout(kill);
      resolveClose();
    });
  });
}

function attachBrokerControl(
  child: ChildProcessWithoutNullStreams,
  control: Duplex,
  handleRequest: (request: string) => Promise<string>,
): void {
  let buffer = Buffer.alloc(0);
  const requests: string[] = [];
  let draining = false;
  const writeResponse = (payload: string): void => {
    const body = Buffer.from(payload, "utf8");
    if (body.length > MAX_BROKER_FRAME_BYTES) throw new Error("isolated broker response is too large");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(body.length);
    control.write(Buffer.concat([header, body]));
  };
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (requests.length > 0 && !control.destroyed) {
        const request = requests.shift()!;
        try {
          writeResponse(await handleRequest(request));
        } catch (error) {
          writeResponse(JSON.stringify({
            code: 125,
            stderr: `${error instanceof Error ? error.message : String(error)}\n`,
            stdout: "",
          }));
        }
      }
    } finally {
      draining = false;
    }
  };
  const onData = (chunk: Buffer | string): void => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (size > MAX_BROKER_FRAME_BYTES) {
        child.kill();
        return;
      }
      if (buffer.length < size + 4) return;
      requests.push(buffer.subarray(4, size + 4).toString("utf8"));
      buffer = buffer.subarray(size + 4);
    }
    void drain();
  };
  control.on("data", onData);
  child.once("close", () => control.off("data", onData));
}

export function isolatedHelperPathIsProtected(
  helperPath: string,
  writablePaths: readonly string[],
): boolean {
  const canonicalHelperPath = canonicalWin32Path(helperPath);
  if (!canonicalHelperPath) return false;
  return !writablePaths.some((writablePath) => {
    const canonicalWritablePath = canonicalWin32Path(writablePath);
    if (!canonicalWritablePath) return true;
    const helperRelative = win32.relative(canonicalWritablePath, canonicalHelperPath);
    return helperRelative === ""
      || (!win32.isAbsolute(helperRelative)
        && helperRelative !== ".."
        && !helperRelative.startsWith(`..${win32.sep}`));
  });
}

function canonicalWin32Path(path: string): string | null {
  const normalizedSeparators = path.replaceAll("/", "\\");
  const extendedMatch = /^\\\\\?\\(.*)$/u.exec(normalizedSeparators);
  if (!extendedMatch && /^\\\\(?:[?.]|\?\?)\\/u.test(normalizedSeparators)) return null;
  const ordinaryPath = extendedMatch
    ? /^UNC\\/iu.test(extendedMatch[1]!)
      ? `\\\\${extendedMatch[1]!.slice(4)}`
      : extendedMatch[1]!
    : normalizedSeparators;
  if (
    !/^[A-Za-z]:\\/u.test(ordinaryPath)
    && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(ordinaryPath)
  ) return null;
  return win32.resolve(ordinaryPath);
}

export async function spawnIsolatedAgent(
  options: SpawnIsolatedAgentOptions,
): Promise<ChildProcessWithoutNullStreams> {
  options.signal?.throwIfAborted();
  validateOptions(options);
  if (options.helperPath && !win32.isAbsolute(options.helperPath)) {
    throw new Error("Windows AppContainer helper path must be absolute");
  }
  const helper = nativeHelperPath(options.helperPath);
  if (!helper) throw new Error("Windows AppContainer helper is missing; run build:native:win32");
  if (!isolatedHelperPathIsProtected(helper, options.writablePaths)) {
    throw new Error("Windows AppContainer helper must stay outside agent-writable paths");
  }
  const support = await probeIsolatedAgentSupport({ helperPath: helper, signal: options.signal });
  if (!support.supported) throw new Error(support.reason);
  options.signal?.throwIfAborted();

  const env = options.env ?? process.env;
  const invocation = createCommandInvocation({ args: [...(options.args ?? [])], command: options.command, env });
  const child = spawn(helper, ["--exec"], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const control = child.stdio[3] as Duplex | null;
  if (!control) {
    child.kill();
    throw new Error("Windows AppContainer helper control pipe was not created");
  }
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const cleanup = () => {
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onError = (error: Error) => { cleanup(); rejectSpawn(error); };
      const onSpawn = () => { cleanup(); resolveSpawn(); };
      const onAbort = () => { cleanup(); rejectSpawn(options.signal?.reason); };
      child.once("error", onError);
      child.once("spawn", onSpawn);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    options.signal?.throwIfAborted();
    child.stdin.write(
      `${JSON.stringify({
        args: invocation.args,
        command: invocation.command,
        cwd: options.cwd,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] != null)),
        readExecutePaths: options.readExecutePaths,
        ...(options.broker ? { brokerPipeName: options.broker.pipeName } : {}),
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
        writablePaths: options.writablePaths,
      })}\n`,
    );
    await waitForReady(child, control, options.signal);
    options.signal?.throwIfAborted();
    if (options.broker) {
      attachBrokerControl(child, control, options.broker.handleRequest);
      control.write(Buffer.from([0x06]));
    }
  } catch (error) {
    await closeFailedHelper(child);
    throw error;
  }
  return child;
}
