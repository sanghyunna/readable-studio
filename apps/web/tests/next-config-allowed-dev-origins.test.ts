import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `allowedDevOrigins` only matters to the Next dev server, but the config object is
// serialized into the production artifacts (`required-server-files.json`,
// standalone `server.js`). Folding the build machine's private LAN addresses into it
// leaked them into the release ZIP and made two builds of the same source differ.

const BUILD_MACHINE_LAN_IP = '10.91.66.252';

function stubLanInterface() {
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const networkInterfaces = () => ({
      Ethernet: [
        {
          address: BUILD_MACHINE_LAN_IP,
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: `${BUILD_MACHINE_LAN_IP}/24`,
        },
      ],
    });
    return { ...actual, default: { ...actual, networkInterfaces }, networkInterfaces };
  });
}

async function loadAllowedDevOrigins(): Promise<string[]> {
  const config = await import('../next.config');
  return (config.default.allowedDevOrigins ?? []) as string[];
}

describe('next.config allowedDevOrigins', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('READABLE_ALLOWED_DEV_ORIGINS', undefined);
    vi.stubEnv('READABLE_ALLOWED_ORIGINS', undefined);
    vi.stubEnv('READABLE_HOST', undefined);
    stubLanInterface();
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(['static export', 'server', 'standalone'] as const)(
    'omits the build machine LAN address in a production %s build',
    async (mode) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('READABLE_WEB_OUTPUT_MODE', mode === 'static export' ? undefined : mode);

      const origins = await loadAllowedDevOrigins();

      expect(origins).not.toContain(BUILD_MACHINE_LAN_IP);
      expect(origins).toEqual(['127.0.0.1']);
    },
  );

  it('still allows the machine LAN address for the dev server', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('READABLE_WEB_OUTPUT_MODE', undefined);

    const origins = await loadAllowedDevOrigins();

    expect(origins).toContain('127.0.0.1');
    expect(origins).toContain(BUILD_MACHINE_LAN_IP);
  });
});
