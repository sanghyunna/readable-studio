import { describe, expect, it } from 'vitest';
import { amrLoginPollOutcome } from '../../src/components/amrLoginPolling';

describe('AMR login on a slow VDI', () => {
  it('waits through delayed status propagation and a long browser sign-in', () => {
    const status = { loggedIn: false, loginInFlight: false, profile: 'default', user: null, configPath: '' };
    expect(amrLoginPollOutcome(status, 0, 10_000)).toBe('pending');
    expect(amrLoginPollOutcome({ ...status, loginInFlight: true }, 0, 6 * 60_000)).toBe('pending');
    expect(amrLoginPollOutcome({ ...status, loggedIn: true }, 0, 6 * 60_000)).toBe('signed-in');
    expect(amrLoginPollOutcome(status, 0, 60_000)).toBe('stopped');
    expect(amrLoginPollOutcome({ ...status, loginInFlight: true }, 0, 15 * 60_000)).toBe('timed-out');
  });
});
