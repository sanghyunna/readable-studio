import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabricksClient, type DatabricksSubprocessRunner } from '../../src/databricks/client.js';
import { DatabricksLogins } from '../../src/databricks/login.js';

const host = 'https://private-workspace.example';
const token = 'dapi_PRIVATE_TOKEN';
const profileId = `dbc_${'a'.repeat(32)}`;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
  let authenticated = false;
  let exit: (code: number) => void = () => {};
  const kill = vi.fn();
  const runner = vi.fn<DatabricksSubprocessRunner>(async (_exe, args, options) => {
    if (args[0] === '--version') return { stdout: 'Databricks CLI v0.282.0', stderr: '', exitCode: 0 };
    if (args[1] === 'login') return new Promise((resolve) => {
      exit = (exitCode) => resolve({ stdout: `success ${token} ${host}`, stderr: `${token} ${host}`, exitCode });
      options.signal.addEventListener('abort', () => { kill(); exit(1); }, { once: true });
    });
    if (args[1] === 'token') return authenticated
      ? { stdout: JSON.stringify({ access_token: token, expiry: new Date(Date.now() + 3600_000).toISOString() }), stderr: '', exitCode: 0 }
      : { stdout: '', stderr: `${token} ${host}`, exitCode: 1 };
    throw new Error('Unexpected command');
  });
  const client = new DatabricksClient({ resolveExecutable: async () => 'databricks.exe', runner });
  const connected = vi.fn(async () => profileId);
  const clock = { now: () => Date.now(), setTimeout, clearTimeout };
  const options = { clock, deadlineMs: 5000, pollMs: 1000 };
  const logins = new DatabricksLogins(client, connected, options);
  return { logins, client, connected, runner, kill, options, authenticate: () => { authenticated = true; }, exit: (code: number) => exit(code) };
}

describe('Databricks browser SSO jobs', () => {
  it('polls CLI auth JSON until it flips, never trusting successful login stdout', async () => {
    const f = fixture();
    const snapshot = f.logins.start({ host });
    expect(snapshot.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.logins.get(snapshot.loginId).state).toBe('waiting-for-browser');
    f.exit(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.logins.get(snapshot.loginId).state).toBe('waiting-for-browser');
    f.authenticate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.logins.get(snapshot.loginId)).toMatchObject({ state: 'authenticated', profileId, issues: [] });
    expect(f.connected).toHaveBeenCalledWith(host, `readable-${snapshot.loginId}`, expect.any(AbortSignal));
    expect(f.runner.mock.calls.some(([, args]) => JSON.stringify(args) === JSON.stringify(['auth', 'login', '--host', host, '--profile', `readable-${snapshot.loginId}`]))).toBe(true);
    expect(f.runner.mock.calls.filter(([, args]) => args[1] === 'token')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancellation aborts the child and remains terminal despite late completion', async () => {
    const f = fixture(); const snapshot = f.logins.start({ host });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.logins.cancel(snapshot.loginId).state).toBe('cancelled');
    expect(f.kill).toHaveBeenCalledOnce();
    f.authenticate();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.logins.get(snapshot.loginId).state).toBe('cancelled');
    expect(f.connected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deadline expiry reports timed-out and terminates the child', async () => {
    const f = fixture(); const snapshot = f.logins.start({ host });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.logins.get(snapshot.loginId).state).toBe('waiting-for-browser');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.logins.get(snapshot.loginId)).toMatchObject({ state: 'timed-out', completedAt: '2026-09-13T00:00:05.000Z' });
    expect(f.kill).toHaveBeenCalledOnce();
    expect(f.connected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const invalid of ['http://workspace.example', 'https://user:password@workspace.example', 'https://workspace.example/path', 'https://workspace.example?token=secret', 'https://workspace.example#secret', 'https://workspace.example\\path', 'https://workspace.example\n', 'not-a-url']) {
    it(`rejects invalid origin before any spawn: ${JSON.stringify(invalid)}`, () => {
      const f = fixture();
      expect(() => f.logins.start({ host: invalid })).toThrow('DATABRICKS_AUTH_REQUIRED');
      expect(f.runner).not.toHaveBeenCalled();
    });
  }

  it('sanitizes command failures and emits no credential, host or command logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const f = fixture(); const snapshot = f.logins.start({ host });
    await vi.advanceTimersByTimeAsync(0);
    f.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    const result = f.logins.get(snapshot.loginId);
    expect(result.state).toBe('failed');
    for (const secret of [token, host, 'auth login']) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(secret);
    }
    // The child already exited; cleanup must clear polling rather than kill a dead process.
    expect(f.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel before executable discovery prevents launching browser auth', async () => {
    const f = fixture(); const snapshot = f.logins.start({ host });
    f.logins.cancel(snapshot.loginId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runner.mock.calls.some(([, args]) => args[1] === 'login')).toBe(false);
  });

});
