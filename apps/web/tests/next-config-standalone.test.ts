import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The packaged standalone server boots Next.js's traced standalone output. On a
// cold first launch the entire module tree being eagerly required at boot (the
// Next.js 16 default `experimental.preloadEntriesOnStart: true`) blocks the
// event loop while Windows Defender cold-scans the freshly extracted files,
// which pushes the readiness probe past its timeout and hangs the splash. The
// server output runtime must therefore opt OUT of eager entry preloading.

describe('next.config standalone runtime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('disables eager entry preloading for the standalone server output', async () => {
    vi.stubEnv('READABLE_WEB_OUTPUT_MODE', 'standalone');
    vi.stubEnv('NODE_ENV', 'production');

    const config = await import('../next.config');
    const experimental = config.default.experimental as
      | { preloadEntriesOnStart?: boolean }
      | undefined;

    expect(experimental?.preloadEntriesOnStart).toBe(false);
  });

  it('leaves preloadEntriesOnStart unset for the static export build', async () => {
    vi.stubEnv('READABLE_WEB_OUTPUT_MODE', undefined);
    vi.stubEnv('NODE_ENV', 'production');

    const config = await import('../next.config');
    const experimental = config.default.experimental as
      | { preloadEntriesOnStart?: boolean }
      | undefined;

    expect(experimental?.preloadEntriesOnStart).toBeUndefined();
  });
});
