import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createHostedDaemonProxyHeaders,
  createStandaloneBackendEnv,
  createStandaloneParentMonitorImport,
  createStandaloneServerArgs,
  isHostedNextDevUpgrade,
  normalizeDaemonProxyOriginHeader,
  resolveDaemonProxyTarget,
  resolveHostedPublicOrigin,
  resolveHostedSidecarRoute,
  resolveStandaloneBackendOrigin,
  resolveStandaloneServerEntry,
  resolveWebAppVersion,
} from '../sidecar/server';

describe('hosted public sidecar boundary', () => {
  it('routes only the api prefix to the daemon and terminates raw content routes', () => {
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/api/projects?limit=10')).toEqual({
      kind: 'daemon',
      target: new URL('http://127.0.0.1:7456/api/projects?limit=10'),
    });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/artifacts/file')).toEqual({ kind: 'deny' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/frames/example')).toEqual({ kind: 'deny' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/apiary')).toEqual({ kind: 'next' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/settings')).toEqual({ kind: 'next' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/api%2Fhealth')).toEqual({ kind: 'deny' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/%61pi/health')).toEqual({ kind: 'deny' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/artifacts%2Ffile')).toEqual({ kind: 'deny' });
    expect(resolveHostedSidecarRoute('http://127.0.0.1:7456', '/api/%2e%2e/settings')).toEqual({ kind: 'deny' });
  });

  it('allows only the Next development HMR upgrade', () => {
    expect(isHostedNextDevUpgrade('/_next/webpack-hmr?id=dev')).toBe(true);
    expect(isHostedNextDevUpgrade('/_next/webpack-hmr-evil')).toBe(false);
    expect(isHostedNextDevUpgrade('/api/runs/1/stream')).toBe(false);
  });

  it('requires an exact HTTP public origin', () => {
    expect(resolveHostedPublicOrigin('https://design.example:8443').href).toBe('https://design.example:8443/');
    expect(() => resolveHostedPublicOrigin(undefined)).toThrow('READABLE_HOSTED_PUBLIC_ORIGIN');
    expect(() => resolveHostedPublicOrigin('https://design.example/path')).toThrow('READABLE_HOSTED_PUBLIC_ORIGIN');
    expect(() => resolveHostedPublicOrigin('file:///tmp/design')).toThrow('READABLE_HOSTED_PUBLIC_ORIGIN');
  });

  it('forwards one bearer credential carrier and a strict request-header allowlist', () => {
    expect(
      createHostedDaemonProxyHeaders({
        headers: {
          authorization: 'Bearer adapter-token',
          cookie: '__Host-readable-hosted=adapter-cookie; unrelated=drop-me',
          forwarded: 'for=attacker',
          host: 'design.example:8443',
          origin: 'https://exact-browser-origin.example',
          'remote-user': 'attacker',
          'x-auth-user': 'attacker',
          'x-auth-request-user': 'attacker',
          'cf-access-jwt-assertion': 'attacker',
          'x-databricks-user': 'attacker',
          'x-forwarded-for': 'attacker',
          'x-forwarded-host': 'attacker',
          'x-readable-studio-hosted-user': 'attacker',
          'x-request-id': 'ordinary-header',
        },
        publicOrigin: new URL('https://design.example:8443'),
        remoteAddress: '10.0.0.8',
        targetHost: '127.0.0.1:7456',
      }),
    ).toEqual({
      authorization: 'Bearer adapter-token',
      host: '127.0.0.1:7456',
      origin: 'https://exact-browser-origin.example',
      'x-forwarded-for': '10.0.0.8',
      'x-forwarded-host': 'design.example:8443',
      'x-forwarded-port': '8443',
      'x-forwarded-proto': 'https',
    });
  });

  it('forwards only the hosted browser cookie when no bearer credential is present', () => {
    expect(
      createHostedDaemonProxyHeaders({
        headers: {
          cookie: 'theme=dark; __Host-readable-hosted=adapter-cookie; odpvb_abcdefghijklmnopqrstuv=preview-proof; session=drop-me',
          origin: 'https://design.example',
        },
        publicOrigin: new URL('https://design.example'),
        remoteAddress: undefined,
        targetHost: '127.0.0.1:7456',
      }),
    ).toEqual({
      cookie: '__Host-readable-hosted=adapter-cookie; odpvb_abcdefghijklmnopqrstuv=preview-proof',
      host: '127.0.0.1:7456',
      origin: 'https://design.example',
      'x-forwarded-host': 'design.example',
      'x-forwarded-port': '443',
      'x-forwarded-proto': 'https',
    });
  });

  it('drops malformed or ambiguous preview proof cookies', () => {
    expect(createHostedDaemonProxyHeaders({
      headers: {
        cookie: '__Host-readable-hosted=session; odpvb_short=drop; odpvb_abcdefghijklmnopqrstuv=one; odpvb_ABCDEFGHIJKLMNOPQRSTUV=two',
      },
      publicOrigin: new URL('https://design.example'),
      remoteAddress: undefined,
      targetHost: '127.0.0.1:7456',
    }).cookie).toBe('__Host-readable-hosted=session');
  });
});

describe('resolveDaemonProxyTarget', () => {
  it('proxies allowlisted relative paths to the daemon origin', () => {
    const target = resolveDaemonProxyTarget('http://127.0.0.1:7456', '/api/projects?limit=10');

    expect(target?.href).toBe('http://127.0.0.1:7456/api/projects?limit=10');
  });

  it('does not let absolute request URLs replace the daemon origin', () => {
    const target = resolveDaemonProxyTarget(
      'http://127.0.0.1:7456',
      'http://169.254.169.254/api/latest/meta-data?token=1',
    );

    expect(target?.href).toBe('http://127.0.0.1:7456/api/latest/meta-data?token=1');
  });

  it('rejects non-daemon paths', () => {
    expect(resolveDaemonProxyTarget('http://127.0.0.1:7456', '/settings')).toBeNull();
  });
});

describe('packaged standalone metadata', () => {
  it('uses the baked app version without resolving a web package root', () => {
    expect(resolveWebAppVersion(null, { NODE_ENV: 'production', READABLE_APP_VERSION: '0.2.2' })).toBe('0.2.2');
  });
});

describe('resolveStandaloneServerEntry', () => {
  it('resolves the traced monorepo standalone server entry', async () => {
    const previousDistDir = process.env.READABLE_WEB_DIST_DIR;
    delete process.env.READABLE_WEB_DIST_DIR;
    const webRoot = await mkdtemp(join(tmpdir(), 'readable-studio-web-standalone-'));
    const nestedRoot = join(webRoot, '.next', 'standalone', 'apps', 'web');
    const fallbackRoot = join(webRoot, '.next', 'standalone');

    try {
      await mkdir(nestedRoot, { recursive: true });
      await mkdir(fallbackRoot, { recursive: true });
      await writeFile(join(nestedRoot, 'server.js'), '', 'utf8');
      await writeFile(join(fallbackRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(webRoot)).toBe(join(nestedRoot, 'server.js'));
    } finally {
      if (previousDistDir == null) {
        delete process.env.READABLE_WEB_DIST_DIR;
      } else {
        process.env.READABLE_WEB_DIST_DIR = previousDistDir;
      }
      await rm(webRoot, { force: true, recursive: true });
    }
  });

  it('prefers a copied standalone resource root before package fallback entries', async () => {
    const previousDistDir = process.env.READABLE_WEB_DIST_DIR;
    delete process.env.READABLE_WEB_DIST_DIR;
    const webRoot = await mkdtemp(join(tmpdir(), 'readable-studio-web-package-'));
    const copiedRoot = await mkdtemp(join(tmpdir(), 'readable-studio-web-copied-'));
    const copiedWebRoot = join(copiedRoot, 'apps', 'web');
    const packageFallbackRoot = join(webRoot, '.next', 'standalone', 'apps', 'web');

    try {
      await mkdir(copiedWebRoot, { recursive: true });
      await mkdir(packageFallbackRoot, { recursive: true });
      await writeFile(join(copiedWebRoot, 'server.js'), '', 'utf8');
      await writeFile(join(packageFallbackRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(webRoot, copiedRoot)).toBe(join(copiedWebRoot, 'server.js'));
    } finally {
      if (previousDistDir == null) {
        delete process.env.READABLE_WEB_DIST_DIR;
      } else {
        process.env.READABLE_WEB_DIST_DIR = previousDistDir;
      }
      await rm(webRoot, { force: true, recursive: true });
      await rm(copiedRoot, { force: true, recursive: true });
    }
  });

  it('can resolve a copied standalone resource without a web package root', async () => {
    const copiedRoot = await mkdtemp(join(tmpdir(), 'readable-studio-web-copied-only-'));
    const copiedWebRoot = join(copiedRoot, 'apps', 'web');

    try {
      await mkdir(copiedWebRoot, { recursive: true });
      await writeFile(join(copiedWebRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(null, copiedRoot)).toBe(join(copiedWebRoot, 'server.js'));
    } finally {
      await rm(copiedRoot, { force: true, recursive: true });
    }
  });
});

describe('createStandaloneServerArgs', () => {
  it('preloads a parent monitor before running the standalone server entry', () => {
    const args = createStandaloneServerArgs('/tmp/readable-studio/server.js');

    expect(args).toHaveLength(3);
    expect(args[0]).toBe('--import');
    expect(args[1]).toBe(createStandaloneParentMonitorImport());
    expect(args[2]).toBe('/tmp/readable-studio/server.js');
  });

  it('uses a data import that exits when the recorded parent disappears', () => {
    const importSpecifier = createStandaloneParentMonitorImport('READABLE_TEST_PARENT_PID');
    const source = decodeURIComponent(importSpecifier.replace(/^data:text\/javascript,/, ''));

    expect(importSpecifier).toMatch(/^data:text\/javascript,/);
    expect(source).toContain('process.env["READABLE_TEST_PARENT_PID"]');
    expect(source).toContain('process.ppid === parentPid');
    expect(source).toContain('process.kill(parentPid, 0)');
    expect(source).toContain('process.exit(0)');
  });
});

describe('standalone backend binding', () => {
  it('keeps the hidden standalone backend on loopback even when the public sidecar host is wider', () => {
    const env = createStandaloneBackendEnv({
      baseEnv: { ...process.env, READABLE_HOST: '0.0.0.0' },
      parentPid: 1234,
      port: 5876,
    });

    expect(resolveStandaloneBackendOrigin(5876)).toBe('http://127.0.0.1:5876');
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.PORT).toBe('5876');
    expect(env.NODE_ENV).toBe('production');
    expect(env.READABLE_STANDALONE_PARENT_PID).toBe('1234');
  });
});

describe('normalizeDaemonProxyOriginHeader', () => {
  it('normalizes the current web origin to the daemon origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://127.0.0.1:3000',
        webPort: 3000,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('accepts localhost as an equivalent loopback web origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://localhost:3000',
        webPort: 3000,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('normalizes matching private LAN browser origins to the daemon origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://192.168.3.23:8085',
        requestHost: '192.168.3.23:8085',
        webPort: 8085,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('does not normalize mismatched private LAN origins', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://192.168.3.23:8085',
        requestHost: '192.168.3.24:8085',
        webPort: 8085,
      }),
    ).toBe('http://192.168.3.23:8085');
  });

  it('normalizes matching wildcard configured dev origins to the daemon origin', () => {
    const previous = process.env.READABLE_ALLOWED_DEV_ORIGINS;
    process.env.READABLE_ALLOWED_DEV_ORIGINS = '*.local-origin.dev';
    try {
      expect(
        normalizeDaemonProxyOriginHeader({
          daemonOrigin: 'http://127.0.0.1:7456',
          origin: 'http://app.local-origin.dev:8085',
          requestHost: 'app.local-origin.dev:8085',
          webPort: 8085,
        }),
      ).toBe('http://127.0.0.1:7456');
    } finally {
      if (previous == null) delete process.env.READABLE_ALLOWED_DEV_ORIGINS;
      else process.env.READABLE_ALLOWED_DEV_ORIGINS = previous;
    }
  });

  it('does not rewrite unrelated browser origins', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'https://example.com',
        webPort: 3000,
      }),
    ).toBe('https://example.com');
  });

  it('preserves absent and null origins for daemon policy to handle', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: undefined,
        webPort: 3000,
      }),
    ).toBeUndefined();
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'null',
        webPort: 3000,
      }),
    ).toBe('null');
  });
});
