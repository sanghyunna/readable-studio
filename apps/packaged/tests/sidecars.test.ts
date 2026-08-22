import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SIDECAR_ENV } from '@readable-studio/sidecar-proto';

import {
  buildPackagedDaemonSpawnEnv,
  resolvePackagedChildBaseEnv,
  resolvePackagedElectronNodeCommand,
  resolvePackagedPathEnv,
  waitForStatus,
} from '../src/sidecars.js';
import type { PackagedNamespacePaths } from '../src/paths.js';

describe('packaged child Vite+ environment forwarding', () => {
  it('never inherits the desktop approval bearer through packaged child forwarding', () => {
    const env = resolvePackagedChildBaseEnv({
      HOME: '/Users/tester',
      Od_DeSkToP_ApPrOvAl_ToKeN: 'must-not-leak',
    }, true, {}, false);

    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toContain(
      SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN,
    );
  });

  it('keeps VP_HOME in the packaged child base env without forwarding unrelated variables', () => {
    const env = resolvePackagedChildBaseEnv({
      HOME: '/Users/tester',
      LANG: 'en_US.UTF-8',
      RANDOM_INTERNAL_FLAG: 'drop-me',
      VP_HOME: '/Users/tester/.custom-vite-plus',
    });

    expect(env).toMatchObject({
      HOME: '/Users/tester',
      LANG: 'en_US.UTF-8',
      VP_HOME: '/Users/tester/.custom-vite-plus',
    });
    expect(env.RANDOM_INTERNAL_FLAG).toBeUndefined();
  });

  it('forwards standard Node proxy variables to packaged sidecars', () => {
    const env = resolvePackagedChildBaseEnv({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      HOME: '/Users/tester',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,127.0.0.1',
      RANDOM_INTERNAL_FLAG: 'drop-me',
      all_proxy: 'socks5://127.0.0.1:1081',
      http_proxy: 'http://127.0.0.1:7891',
      https_proxy: 'http://127.0.0.1:7891',
      no_proxy: 'localhost,127.0.0.1,::1',
    }, false, undefined, true, 'darwin');

    expect(env).toMatchObject({
      ALL_PROXY: 'socks5://127.0.0.1:1081',
      HOME: '/Users/tester',
      HTTP_PROXY: 'http://127.0.0.1:7891',
      HTTPS_PROXY: 'http://127.0.0.1:7891',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,127.0.0.1,[::1]',
      all_proxy: 'socks5://127.0.0.1:1081',
      http_proxy: 'http://127.0.0.1:7891',
      https_proxy: 'http://127.0.0.1:7891',
      no_proxy: 'localhost,127.0.0.1,[::1]',
    });
    expect(env.RANDOM_INTERNAL_FLAG).toBeUndefined();
  });

  it('merges system proxy env when the packaged app was GUI-launched without shell proxy vars', () => {
    const env = resolvePackagedChildBaseEnv(
      {
        HOME: '/Users/tester',
      },
      false,
      {
        HTTP_PROXY: 'http://system-proxy:8080',
        HTTPS_PROXY: 'http://system-proxy:8443',
        ALL_PROXY: 'socks5://system-proxy:1080',
        NO_PROXY: '.local,localhost',
        NODE_USE_ENV_PROXY: '1',
      },
    );

    expect(env).toMatchObject({
      HOME: '/Users/tester',
      HTTP_PROXY: 'http://system-proxy:8080',
      HTTPS_PROXY: 'http://system-proxy:8443',
      ALL_PROXY: 'socks5://system-proxy:1080',
      NO_PROXY: '.local,localhost,127.0.0.1,[::1]',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('lets forwarded lowercase proxy env override system uppercase proxy env', () => {
    const env = resolvePackagedChildBaseEnv(
      {
        HOME: '/Users/tester',
        https_proxy: 'http://user-lowercase:9443',
      },
      false,
      {
        HTTPS_PROXY: 'http://system-uppercase:8443',
        NODE_USE_ENV_PROXY: '1',
      },
      true,
      'darwin',
    );

    expect(env.HTTPS_PROXY).toBe('http://user-lowercase:9443');
    expect(env.https_proxy).toBe('http://user-lowercase:9443');
  });

  it('enables Node env proxy support for forwarded lowercase proxy env', () => {
    const env = resolvePackagedChildBaseEnv(
      {
        HOME: '/Users/tester',
        https_proxy: 'http://user-lowercase:9443',
      },
      false,
      {},
      true,
      'darwin',
    );

    expect(env.HTTPS_PROXY).toBe('http://user-lowercase:9443');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.https_proxy).toBe('http://user-lowercase:9443');
  });

  it('can skip injecting system proxy env into the packaged daemon base env', () => {
    const env = resolvePackagedChildBaseEnv(
      {
        HOME: '/Users/tester',
      },
      true,
      {
        HTTP_PROXY: 'http://system-proxy:8080',
        HTTPS_PROXY: 'http://system-proxy:8443',
        NODE_USE_ENV_PROXY: '1',
      },
      false,
    );

    expect(env).toMatchObject({
      HOME: '/Users/tester',
    });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
  });

  it('adds custom VP_HOME/bin to the packaged PATH builder', () => {
    const vpHome = mkdtempSync(join(tmpdir(), 'readable-packaged-vp-home-'));
    const originalVpHome = process.env.VP_HOME;
    try {
      process.env.VP_HOME = vpHome;
      const pathEntries = resolvePackagedPathEnv('/usr/bin').split(delimiter);

      expect(pathEntries).toContain('/usr/bin');
      expect(pathEntries).toContain(join(vpHome, 'bin'));
    } finally {
      if (originalVpHome == null) delete process.env.VP_HOME;
      else process.env.VP_HOME = originalVpHome;
      rmSync(vpHome, { recursive: true, force: true });
    }
  });
});

describe('resolvePackagedElectronNodeCommand', () => {
  it('uses the hidden Electron helper as the macOS Electron-as-Node command when available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'readable-packaged-electron-helper-'));
    try {
      const appPath = join(root, 'Readable Studio.app');
      const execPath = join(appPath, 'Contents', 'MacOS', 'Readable Studio').replace(/\\/g, '/');
      const helperPath = join(
        appPath,
        'Contents',
        'Frameworks',
        'Readable Studio Helper.app',
        'Contents',
        'MacOS',
        'Readable Studio Helper',
      );

      mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
      mkdirSync(dirname(helperPath), { recursive: true });
      writeFileSync(execPath, '#!/bin/sh\n', 'utf8');
      writeFileSync(helperPath, '#!/bin/sh\n', 'utf8');

      await expect(resolvePackagedElectronNodeCommand(execPath, 'darwin')).resolves.toBe(helperPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the main executable when the macOS helper is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'readable-packaged-no-electron-helper-'));
    try {
      const execPath = join(root, 'Readable Studio.app', 'Contents', 'MacOS', 'Readable Studio').replace(/\\/g, '/');
      mkdirSync(dirname(execPath), { recursive: true });
      writeFileSync(execPath, '#!/bin/sh\n', 'utf8');

      await expect(resolvePackagedElectronNodeCommand(execPath, 'darwin')).resolves.toBe(execPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the main executable on non-macOS platforms', async () => {
    const execPath = '/opt/Readable Studio/readable-studio';

    await expect(resolvePackagedElectronNodeCommand(execPath, 'linux')).resolves.toBe(execPath);
  });
});

/**
 * Build a child-process stand-in that satisfies the `watch.child`
 * shape `waitForStatus` consumes. We only use `once('exit')`,
 * `off('exit')`, and the synchronous `exitCode` / `signalCode`
 * fields, so an EventEmitter plus those two properties is enough.
 */
function fakeChild(): EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  fireExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    fireExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.fireExit = (code, signal) => {
    emitter.exitCode = code;
    emitter.signalCode = signal;
    emitter.emit('exit', code, signal);
  };
  return emitter;
}

describe('buildPackagedDaemonSpawnEnv', () => {
  // PR #974 round-5 (lefarcen P2): the daemon's import-folder gate must
  // be ON when an Electron desktop is being started alongside the daemon
  // and OFF in headless packaged mode (daemon+web only, no shell.openPath
  // surface, no client to register a secret). Pin both branches against
  // a real pure-helper invocation so a future refactor can't silently
  // regress either side.
  function fakePaths(): PackagedNamespacePaths {
    return {
      cacheRoot: '/tmp/readable-pkg/cache',
      dataRoot: '/tmp/readable-pkg/data',
      desktopIdentityPath: '/tmp/readable-pkg/runtime/desktop-root.json',
      desktopLogPath: '/tmp/readable-pkg/logs/desktop/latest.log',
      desktopLogsRoot: '/tmp/readable-pkg/logs/desktop',
      electronSessionDataRoot: '/tmp/readable-pkg/user-data/session',
      electronUserDataRoot: '/tmp/readable-pkg/user-data',
      headlessIdentityPath: '/tmp/readable-pkg/runtime/headless-root.json',
      installationRoot: '/tmp/readable-pkg/..',
      logsRoot: '/tmp/readable-pkg/logs',
      namespaceRoot: '/tmp/readable-pkg',
      resourceRoot: '/tmp/readable-pkg/resources',
      runtimeRoot: '/tmp/readable-pkg/runtime',
      webIdentityPath: '/tmp/readable-pkg/runtime/web-root.json',
    };
  }

  it('sets READABLE_REQUIRE_DESKTOP_AUTH=1 when requireDesktopAuth=true (Electron entry)', () => {
    const env = buildPackagedDaemonSpawnEnv(fakePaths(), {
      appVersion: '1.2.3',
      daemonCliEntry: null,
      daemonPort: 7456,
      requireDesktopAuth: true,
    });
    expect(env.READABLE_REQUIRE_DESKTOP_AUTH).toBe('1');
    expect(env.READABLE_DATA_DIR).toBe('/tmp/readable-pkg/data');
    expect(env.READABLE_RESOURCE_ROOT).toBe('/tmp/readable-pkg/resources');
    expect(env.READABLE_APP_VERSION).toBe('1.2.3');
    expect(env.READABLE_AGENT_DISCOVERY_OFFLINE).toBe('1');
    expect(env[SIDECAR_ENV.DAEMON_PORT]).toBe('7456');
  });

  it('passes the ephemeral approval bearer only through the explicit daemon env', () => {
    const env = buildPackagedDaemonSpawnEnv(fakePaths(), {
      appVersion: null,
      daemonCliEntry: null,
      daemonPort: 7456,
      desktopApprovalToken: 'packaged-approval-token',
      requireDesktopAuth: true,
    });

    expect(env[SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN]).toBe('packaged-approval-token');
  });

  it('omits READABLE_REQUIRE_DESKTOP_AUTH entirely when requireDesktopAuth=false (headless)', () => {
    const env = buildPackagedDaemonSpawnEnv(fakePaths(), {
      appVersion: null,
      daemonCliEntry: null,
      daemonPort: 7456,
      requireDesktopAuth: false,
    });
    // Round-5 (lefarcen P2): MUST NOT set the env var, even to "0" —
    // the daemon's gate trigger is `process.env.READABLE_REQUIRE_DESKTOP_AUTH === '1'`,
    // so a literal "0" would behave the same as omitted today, but a
    // future code change to truthy-check the variable would silently
    // re-arm the gate. Omitted is the intent.
    expect('READABLE_REQUIRE_DESKTOP_AUTH' in env).toBe(false);
    expect(env.READABLE_DATA_DIR).toBe('/tmp/readable-pkg/data');
    expect(env.READABLE_APP_VERSION).toBeUndefined();
  });

  it('forwards daemonCliEntry through READABLE_DAEMON_CLI_PATH when set', () => {
    const env = buildPackagedDaemonSpawnEnv(fakePaths(), {
      appVersion: null,
      daemonCliEntry: '/path/to/cli/dist/index.js',
      daemonPort: 7456,
      requireDesktopAuth: true,
    });
    expect(env.READABLE_DAEMON_CLI_PATH).toBe('/path/to/cli/dist/index.js');
  });

  it('forwards the packaged AMR profile to the daemon when configured', () => {
    const env = buildPackagedDaemonSpawnEnv(fakePaths(), {
      appVersion: null,
      amrProfile: 'test',
      daemonCliEntry: null,
      daemonPort: 7456,
      requireDesktopAuth: true,
    });
    expect(env.READABLE_AMR_PROFILE).toBe('test');
  });

});

describe('waitForStatus child-exit fast-fail', () => {
  it('rejects within milliseconds when the child exits before status is ready', async () => {
    const child = fakeChild();
    const ipcPath = '/tmp/readable-test-no-such-ipc-' + Date.now();
    const logPath = '/tmp/readable-test-daemon.log';

    const startedAt = Date.now();
    const promise = waitForStatus<{ url: string | null }>(
      ipcPath,
      (status) => status.url != null,
      30 * 60 * 1000,
      { child, logPath },
    );

    // Simulate the daemon throwing in its startup migrator and exiting
    // immediately. With the old code, the wait would have blocked for
    // the full 30-minute budget; with the fix it must reject fast.
    setTimeout(() => child.fireExit(1, null), 50);

    let captured: unknown;
    try {
      await promise;
    } catch (err) {
      captured = err;
    }
    const elapsed = Date.now() - startedAt;

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/daemon exited before reporting status/);
    expect((captured as Error).message).toContain('code=1');
    expect((captured as Error).message).toContain(logPath);

    // The whole point: don't sit through DAEMON_MIGRATION_STATUS_TIMEOUT_MS.
    // Allow generous slack for slow CI runners; the fix should bound this
    // to roughly the IPC poll cadence (150ms) plus a couple of timer ticks.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('detects a child that exited synchronously before waitForStatus was entered', async () => {
    const child = fakeChild();
    // Pretend the daemon process already exited before we got here. The
    // 'exit' event has already fired and would not re-fire for a late
    // listener, so waitForStatus must read the synchronous exitCode /
    // signalCode fields to see the bad state.
    child.exitCode = 2;
    child.signalCode = null;

    const startedAt = Date.now();
    let captured: unknown;
    try {
      await waitForStatus<{ url: string | null }>(
        '/tmp/readable-test-no-such-ipc-pre-' + Date.now(),
        (status) => status.url != null,
        30 * 60 * 1000,
        { child, logPath: '/tmp/readable-test-daemon.log' },
      );
    } catch (err) {
      captured = err;
    }
    const elapsed = Date.now() - startedAt;

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/daemon exited before reporting status/);
    expect((captured as Error).message).toContain('code=2');
    expect(elapsed).toBeLessThan(2_000);
  });
});
