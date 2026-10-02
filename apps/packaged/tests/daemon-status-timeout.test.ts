import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDaemonStatusTimeoutMs } from '../src/sidecars.js';

afterEach(() => vi.unstubAllEnvs());
describe('daemon status budget on cold launches and warm shortcut relaunches', () => {
  it('allows 180 seconds for extraction scans or loaded relaunches', () => {
    expect(resolveDaemonStatusTimeoutMs({})).toBe(180_000);
  });
  it('honors a positive integer override independently of the web budget', () => {
    expect(resolveDaemonStatusTimeoutMs({ READABLE_DAEMON_STATUS_TIMEOUT_MS: '240000', READABLE_WEB_STATUS_TIMEOUT_MS: '1' })).toBe(240_000);
  });
  it.each(['', '0', '-1', 'abc', '1.5', 'Infinity'])('rejects invalid override %j', (value) => {
    expect(resolveDaemonStatusTimeoutMs({ READABLE_DAEMON_STATUS_TIMEOUT_MS: value })).toBe(180_000);
  });
  it('reads the launcher environment by default', () => {
    vi.stubEnv('READABLE_DAEMON_STATUS_TIMEOUT_MS', '200000');
    expect(resolveDaemonStatusTimeoutMs()).toBe(200_000);
  });
});
