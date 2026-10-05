import { app, shell } from 'electron';
import fs from 'node:fs';
import type { ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';
import { createShortcut, resolveShortcutPaths } from './shortcuts.js';

export function startShortcutLoop(options: { token: string; discoverDaemonUrl(): Promise<string | null> }): { abort(): void; done: Promise<void> } {
  const controller = new AbortController();
  const done = (async () => {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const base = await options.discoverDaemonUrl();
        if (!base) throw new Error('daemon is unavailable');
        const headers = { Authorization: `Bearer ${options.token}` };
        const response = await fetch(`${base}/api/shortcuts/desktop/next`, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`shortcut queue HTTP ${response.status}`);
        const body = await response.json() as { job: { id: string; location: ShortcutLocation } | null };
        failures = 0;
        if (!body.job || controller.signal.aborted) continue;
        const packaged = app.isPackaged && process.platform === 'win32';
        let result: ShortcutCreateResult;
        try {
          result = createShortcut(body.job.location, {
            packaged, exe: app.getPath('exe'),
            paths: packaged ? resolveShortcutPaths((name) => app.getPath(name), undefined, body.job.location) : { desktop: '', startMenu: '' },
            shell, fs,
          });
        } catch (error) {
          console.error('shortcut folder resolution failed:', { location: body.job.location, error });
          result = { status: 'failed', location: body.job.location, reason: 'failed' };
        }
        const ack = await fetch(`${base}/api/shortcuts/desktop/${encodeURIComponent(body.job.id)}/result`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(result), signal: controller.signal,
        });
        if (!ack.ok) console.error('shortcut result delivery failed:', ack.status);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (failures === 0) console.error('shortcut loop:', {
            message: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause != null ? String(error.cause) : undefined,
          });
          await delay(Math.min(1000 * 2 ** failures++, 30_000), controller.signal);
        }
      }
    }
  })();
  return { abort: () => controller.abort(), done };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(finish, ms);
    function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }
    signal.addEventListener('abort', finish, { once: true });
  });
}
