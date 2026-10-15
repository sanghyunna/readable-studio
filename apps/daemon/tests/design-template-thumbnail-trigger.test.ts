import { expect, it, vi } from 'vitest';
import type { SidecarRuntimeContext } from '@readable-studio/sidecar';
import { SIDECAR_MESSAGES, type SidecarStamp } from '@readable-studio/sidecar-proto';

const mocks = vi.hoisted(() => ({
  retry: vi.fn().mockResolvedValue(undefined),
  create: vi.fn(),
}));
vi.mock('../src/design-template-thumbnails.js', () => ({ retryPendingTemplateThumbnails: mocks.retry }));
vi.mock('../src/daemon-startup.js', () => ({
  startDaemonRuntime: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:12345', stop: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../src/app-version.js', () => ({ readCurrentAppVersionInfo: vi.fn().mockResolvedValue({ version: '1.3.1' }) }));
vi.mock('@readable-studio/sidecar', async (original) => ({
  ...await original<typeof import('@readable-studio/sidecar')>(),
  createJsonIpcServer: mocks.create.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
}));
import { startDaemonSidecar } from '../src/sidecar/server.js';

it('requests a pending sweep when desktop auth registers', async () => {
  const signalsBefore = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  const handle = await startDaemonSidecar({
    namespace: 'thumbnail-trigger', ipc: 'unused',
  } as SidecarRuntimeContext<SidecarStamp>);
  try {
    const handler = mocks.create.mock.calls[0]![0].handler;
    expect(await handler({
      type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      input: { secret: Buffer.alloc(32, 1).toString('base64') },
    })).toEqual({ accepted: true });
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  } finally {
    await handle.stop();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalsBefore[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
