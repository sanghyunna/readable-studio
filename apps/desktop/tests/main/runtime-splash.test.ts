import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import * as scanProgress from '../../src/main/scan-progress.js';

class TestWindow extends EventEmitter {
  static readonly instances: TestWindow[] = [];
  static readonly events = new EventEmitter();
  readonly attributes = new Map<string, string>();
  readonly reads: string[] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    session: new EventEmitter(), setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(),
    executeJavaScript: async (script: string): Promise<unknown> => runInNewContext(script, {
      document: { documentElement: { getAttribute: (name: string) => {
        this.reads.push(name);
        return this.attributes.get(name) ?? null;
      } } },
      localStorage: { getItem: () => null },
      window: { __readableSplash: { setProgress: () => undefined } },
    }),
  });
  readonly loadFile = vi.fn().mockResolvedValue(undefined);
  readonly loadURL = vi.fn(async () => { TestWindow.events.emit('boundary', 'navigation'); });
  readonly show = vi.fn();
  readonly focus = vi.fn();
  constructor() { super(); TestWindow.instances.push(this); }
  isDestroyed(): boolean { return false; }
  isMinimized(): boolean { return false; }
  isVisible(): boolean { return this.show.mock.calls.length > 0; }
  close(): void { this.emit('closed'); }
}
vi.mock('electron', () => ({
  BrowserWindow: TestWindow, app: { quit: vi.fn() }, dialog: {},
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn(), removeAllListeners: vi.fn(), on: vi.fn() },
  nativeImage: {}, screen: new EventEmitter(), session: {}, shell: {},
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  TestWindow.instances.length = 0;
  TestWindow.events.removeAllListeners();
});

it('starts daemon discovery before navigation or app mount and waits only for acceptance', async () => {
  // Given a real HTTP daemon boundary that holds scan-start acceptance.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(0);
  let accept = () => {};
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/agents/scan') {
      accept = () => response.end(JSON.stringify({ scan: null }));
      TestWindow.events.emit('boundary', 'POST');
    } else response.end(JSON.stringify({ scan: null }));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected TCP listener');
  const boundary = once(TestWindow.events, 'boundary', { signal: AbortSignal.timeout(2000) });
  const { createDesktopRuntime } = await import('../../src/main/runtime.js');
  const runtime = await createDesktopRuntime({
    discoverUrl: async () => 'http://127.0.0.1:3000',
    discoverDaemonUrl: async () => `http://127.0.0.1:${address.port}`,
  });
  try {
    // When the daemon receives startup before the renderer has mounted.
    expect(await boundary).toEqual(['POST']);
    const main = TestWindow.instances[0];
    if (!main) throw new Error('main window not created');
    expect(main.attributes.has('data-readable-app-mounted')).toBe(false);
    expect(main.loadURL).not.toHaveBeenCalled();
    const navigation = once(TestWindow.events, 'boundary', { signal: AbortSignal.timeout(2000) });
    accept();
    await navigation;
    // Then scan completion is not awaited and repeated discovery does not restart it.
    expect(main.loadURL).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests.filter((request) => request === 'POST /api/agents/scan')).toHaveLength(1);
    expect(main.show).not.toHaveBeenCalled();
  } finally {
    accept();
    await runtime.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

it('reads completion from the splash window and reveals only after the mounted app paints', async () => {
  // Given the real runtime and separate main/splash renderer documents.
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(scanProgress, 'startDaemonScan').mockResolvedValue(null);
  const { createDesktopRuntime } = await import('../../src/main/runtime.js');
  const runtime = await createDesktopRuntime({
    discoverUrl: async () => 'http://127.0.0.1:3000', discoverDaemonUrl: async () => 'http://127.0.0.1:3001',
  });
  const [main, splash] = TestWindow.instances;
  if (!main || !splash) throw new Error('startup windows not created');
  main.attributes.set('data-readable-app-mounted', '1');
  splash.attributes.set('data-readable-splash-finished', '1');
  try {
    // When readiness arrives, but no renderer paint has occurred yet.
    await vi.advanceTimersByTimeAsync(80);
    expect(main.show).not.toHaveBeenCalled();
    main.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(160);
    // Then the actual window reveals before the ceiling using the correct document.
    expect(main.show).toHaveBeenCalledOnce();
    expect(splash.reads).toContain('data-readable-splash-finished');
    expect(main.reads).not.toContain('data-readable-splash-finished');
  } finally {
    await runtime.close();
  }
});
