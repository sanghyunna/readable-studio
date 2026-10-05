import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemonRuntime } from '../src/daemon-startup.js';
import '../src/server.js';

it.each(['uncaughtException', 'unhandledRejection'] as const)(
  'writes %s details to the daemon stderr log before fatal exit',
  async (event) => {
    const previous = {
      uncaughtException: new Set(process.listeners('uncaughtException')),
      unhandledRejection: new Set(process.listeners('unhandledRejection')),
    };
    const runtime = await startDaemonRuntime({ port: 0 });
    const handler = event === 'uncaughtException'
      ? process.listeners('uncaughtException').find((listener) => !previous.uncaughtException.has(listener))
      : process.listeners('unhandledRejection').find((listener) => !previous.unhandledRejection.has(listener));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-fatal-log-'));
    const logPath = path.join(directory, 'latest.log');
    const fd = fs.openSync(logPath, 'a');
    const writeSync = fs.writeSync.bind(fs);
    // Packaged sidecars inherit a regular log-file descriptor as stderr.
    // Redirect only that descriptor while preserving the real filesystem write.
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(((target: number, ...args: unknown[]) =>
      Reflect.apply(writeSync, fs, [target === 2 ? fd : target, ...args])) as typeof fs.writeSync);
    let resolveExit!: (result: { code: number | string | null | undefined; log: string }) => void;
    const exited = new Promise<{ code: number | string | null | undefined; log: string }>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      resolveExit({ code, log: fs.readFileSync(logPath, 'utf8') });
      return undefined as never;
    });
    const previousExitCode = process.exitCode;
    try {
      expect(handler).toBeTypeOf('function');
      const error = new Error('fatal-databricks-probe-sentinel');
      Reflect.apply(handler!, process, [error, 'uncaughtException']);
      const result = await exited;
      expect(result.code).toBe(1);
      expect(result.log).toContain('fatal-databricks-probe-sentinel');
      expect(result.log).toContain('Error');
      expect(result.log).toContain(error.stack!);
      expect(result.log).toContain(event === 'uncaughtException' ? 'daemon_uncaught_exception' : 'daemon_unhandled_rejection');
    } finally {
      exit.mockRestore();
      write.mockRestore();
      process.exitCode = previousExitCode;
      // A server installs both fatal listeners; remove only this server's additions.
      for (const listener of process.listeners('uncaughtException')) {
        if (!previous.uncaughtException.has(listener)) process.removeListener('uncaughtException', listener);
      }
      for (const listener of process.listeners('unhandledRejection')) {
        if (!previous.unhandledRejection.has(listener)) process.removeListener('unhandledRejection', listener);
      }
      await runtime.stop();
      fs.closeSync(fd);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
