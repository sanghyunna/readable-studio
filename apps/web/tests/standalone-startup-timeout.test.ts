import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveStandaloneStartupTimeoutMs } from '../sidecar/server';

const ENV_NAME = 'READABLE_STANDALONE_STARTUP_TIMEOUT_MS';

describe('resolveStandaloneStartupTimeoutMs', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_NAME];
    delete process.env[ENV_NAME];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = saved;
    }
  });

  it('defaults to 120000ms cold-first-launch headroom when env is unset', () => {
    delete process.env[ENV_NAME];
    expect(resolveStandaloneStartupTimeoutMs()).toBe(120_000);
  });

  it('honors a positive READABLE_STANDALONE_STARTUP_TIMEOUT_MS override', () => {
    process.env[ENV_NAME] = '60000';
    expect(resolveStandaloneStartupTimeoutMs()).toBe(60_000);
  });

  it('throws on a non-positive override value', () => {
    process.env[ENV_NAME] = '0';
    expect(() => resolveStandaloneStartupTimeoutMs()).toThrow();
  });

  it('throws on a non-numeric override value', () => {
    process.env[ENV_NAME] = 'abc';
    expect(() => resolveStandaloneStartupTimeoutMs()).toThrow();
  });
});
