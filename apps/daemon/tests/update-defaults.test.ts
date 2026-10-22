import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultUpdateServerResolver, resolveUpdateConfigDefaults } from '../src/update-source.js';
import type { DatabricksExecutable, DatabricksSubprocessRunner } from '../src/databricks/client.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function cli(app: unknown) {
  const calls: string[][] = [];
  const runner: DatabricksSubprocessRunner = async (_executable, args) => {
    calls.push([...args]);
    return { stdout: args[0] === '--version' ? 'Databricks CLI v0.250.0' : JSON.stringify(app), stderr: '', exitCode: 0 };
  };
  return { calls, runner, resolveCli: async () => ({ path: 'C:\\tools\\databricks.exe', source: 'path' as const }) };
}

it('uses the CLI-selected workspace and its app URL without reconstructing a host', async () => {
  const fake = cli({ name: 'readable-studio-updates', url: 'https://readable-studio-updates-123.aws.databricksapps.com/' });
  const resolveServer = createDefaultUpdateServerResolver(fake);
  expect(await resolveServer()).toBe('https://readable-studio-updates-123.aws.databricksapps.com');
  expect(fake.calls).toEqual([['--version'], ['apps', 'get', 'readable-studio-updates', '--output', 'json']]);
});

it('normalizes the scheme-less App.url shape returned by the workspace API', async () => {
  expect(await createDefaultUpdateServerResolver(cli({ url: 'readable-studio-updates-123.aws.databricksapps.com' }))())
    .toBe('https://readable-studio-updates-123.aws.databricksapps.com');
});

it.each([
  null, {}, { url: '' }, { url: 'http://updates.example.com' },
  { url: 'https://user:secret@updates.example.com' }, { url: 'https://updates.example.com/?token=secret' },
  { url: 'https://updates.example.com/#secret' }, { url: 'https://updates.example.com/other-app' },
  { url: 'https://updates.example.com\\other-app' }, { url: 'https://updates.\nexample.com' },
  { name: 'another-app', url: 'https://updates.example.com' },
])('does not use an invalid app URL: %j', async (value) => {
  expect(await createDefaultUpdateServerResolver(cli(value))()).toBeNull();
});

it('shares concurrent discovery and reuses the successful URL', async () => {
  const fake = cli({ url: 'https://updates.example.com' });
  const resolveServer = createDefaultUpdateServerResolver(fake);
  expect(await Promise.all([resolveServer(), resolveServer()])).toEqual(['https://updates.example.com', 'https://updates.example.com']);
  expect(await resolveServer()).toBe('https://updates.example.com');
  expect(fake.calls.filter((args) => args[0] === 'apps')).toHaveLength(1);
});

it('does not cancel an active discovery waiter when another caller disconnects', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const runner: DatabricksSubprocessRunner = async (_executable, args, options) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    signals.push(options.signal);
    await new Promise<void>((done) => setTimeout(done, 31_000));
    return { stdout: JSON.stringify({ url: 'https://updates.example.com' }), stderr: '', exitCode: 0 };
  };
  const resolveServer = createDefaultUpdateServerResolver({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) });
  const a = new AbortController(); const b = new AbortController();
  const first = resolveServer(a.signal); const second = resolveServer(b.signal);
  await vi.advanceTimersByTimeAsync(1);
  a.abort();
  expect(await first).toBeNull();
  expect(signals[0]?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(31_001);
  expect(await second).toBe('https://updates.example.com');
  expect(await resolveServer()).toBe('https://updates.example.com');
  expect(signals).toHaveLength(1);
});

it.each(['last-waiter', 'shutdown'] as const)('aborts discovery on %s and never caches the cancelled result', async (mode) => {
  const signals: AbortSignal[] = [];
  let entered!: () => void;
  const ready = new Promise<void>((done) => { entered = done; });
  const runner: DatabricksSubprocessRunner = async (_executable, args, options) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v1.10.0', stderr: '', exitCode: 0 };
    signals.push(options.signal);
    if (signals.length === 1) { entered(); return new Promise(() => {}); }
    return { stdout: JSON.stringify({ url: 'https://updates.example.com' }), stderr: '', exitCode: 0 };
  };
  const resolveServer = createDefaultUpdateServerResolver({ runner, resolveCli: async () => ({ path: 'C:\\fixture\\databricks.exe', source: 'path' }) });
  const a = new AbortController(); const b = new AbortController(); const shutdown = new AbortController();
  const first = resolveServer(AbortSignal.any([a.signal, shutdown.signal]));
  const second = resolveServer(AbortSignal.any([b.signal, shutdown.signal]));
  await ready;
  if (mode === 'shutdown') shutdown.abort();
  else {
    a.abort();
    expect(await first).toBeNull();
    expect(signals[0]?.aborted).toBe(false);
    b.abort();
  }
  expect(await Promise.all([first, second])).toEqual([null, null]);
  expect(signals[0]?.aborted).toBe(true);
  expect(await resolveServer()).toBe('https://updates.example.com');
  expect(signals).toHaveLength(2);
});

it('briefly caches missing setup and retries discovery after the cache expires', async () => {
  vi.useFakeTimers();
  const fake = cli({ url: 'https://updates.example.com' });
  const resolveCli = vi.fn<() => Promise<DatabricksExecutable | null>>(fake.resolveCli).mockResolvedValueOnce(null);
  const resolveServer = createDefaultUpdateServerResolver({ ...fake, resolveCli });
  expect(await resolveServer()).toBeNull();
  expect(await resolveServer()).toBeNull();
  expect(resolveCli).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await resolveServer()).toBe('https://updates.example.com');
});

it('refreshes a successful default when the CLI workspace changes after cache expiry', async () => {
  vi.useFakeTimers();
  const app = { url: 'https://first.example.com' };
  const fake = cli(app);
  const resolveServer = createDefaultUpdateServerResolver(fake);
  expect(await resolveServer()).toBe('https://first.example.com');
  app.url = 'https://second.example.com';
  expect(await resolveServer()).toBe('https://first.example.com');
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await resolveServer()).toBe('https://second.example.com');
});

it('keeps slow discovery alive until the requester cancels and never proceeds after cancellation', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>((done) => { release = done; });
  const fake = cli({ url: 'https://updates.example.com' });
  const resolveServer = createDefaultUpdateServerResolver({ ...fake, resolveCli: async () => { await blocked; return fake.resolveCli(); } });
  const controller = new AbortController();
  const result = resolveServer(controller.signal);
  await vi.advanceTimersByTimeAsync(31_001);
  controller.abort();
  expect(await result).toBeNull();
  release();
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.calls.filter((args) => args[0] === 'apps')).toEqual([]);
});

it('preserves an explicit URL and a configured opt-out without consulting the CLI', async () => {
  const resolveServer = vi.fn(async () => 'https://default.example.com');
  for (const enabled of [true, false]) {
    const config = { enabled, serverUrl: 'https://custom.example.com' };
    expect(await resolveUpdateConfigDefaults(config, resolveServer)).toEqual(config);
  }
  expect(resolveServer).not.toHaveBeenCalled();
});

it('uses the discovered server for an unconfigured installation and leaves failed discovery unconfigured', async () => {
  expect(await resolveUpdateConfigDefaults({ enabled: false, serverUrl: null }, async () => 'https://updates.example.com'))
    .toEqual({ enabled: true, serverUrl: 'https://updates.example.com' });
  expect(await resolveUpdateConfigDefaults({ enabled: false, serverUrl: null }, async () => null))
    .toEqual({ enabled: false, serverUrl: null });
});
