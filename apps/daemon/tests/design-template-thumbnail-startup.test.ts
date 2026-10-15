import type { Server } from 'node:http';
import { expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ ready: vi.fn().mockResolvedValue(false) }));
vi.mock('../src/desktop-render-client.js', () => ({
  waitForDesktopRenderer: probe.ready,
  renderHtmlThumbnail: vi.fn(),
}));
import { startServer } from '../src/server.js';
import { closeDatabase } from '../src/db.js';

it('checks desktop readiness once after daemon starts listening', async () => {
  let notified!: () => void;
  const checked = new Promise<void>((resolve) => { notified = resolve; });
  probe.ready.mockImplementation(async () => { notified(); return false; });
  let started: { server: Server; url: string; shutdown: () => Promise<void> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    await Promise.race([
      checked,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('startup readiness probe missing')), 5_000); }),
    ]);
    expect(started!.server.listening).toBe(true);
    expect(probe.ready).toHaveBeenCalledTimes(1);
  } finally {
    clearTimeout(timer);
    await started?.shutdown();
    if (started) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    closeDatabase();
  }
});
