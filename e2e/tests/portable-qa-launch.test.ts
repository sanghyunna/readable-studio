import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, test, vi } from 'vitest';
import type { Page } from '@playwright/test';

const calls = vi.hoisted(() => ({
  smoke: vi.fn(),
  ui: vi.fn(),
  commands: vi.fn(),
  roots: [] as string[],
}));

vi.mock('../scripts/portable-qa-support.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/portable-qa-support.ts')>();
  return {
    ...actual,
    runCommand: calls.commands.mockImplementation(async (...args: Parameters<typeof actual.runCommand>) => {
      if (args[0] === 'powershell.exe') {
        return { command: args[0], args: args[1], exitCode: 0, stdout: '0', stderr: '' };
      }
      const rootIndex = args[1].indexOf('--actual-root');
      if (rootIndex >= 0) calls.roots.push(args[1][rootIndex + 1]!);
      return actual.runCommand(...args);
    }),
  };
});

vi.mock('../scripts/portable-qa-runtime.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/portable-qa-runtime.ts')>(),
  registrySnapshot: vi.fn(async () => ({})),
  smokePortableLauncher: calls.smoke,
  launchPortable: calls.ui,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let root: string;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  calls.smoke.mockReset();
  calls.ui.mockReset().mockRejectedValue(new Error('UI workflow must not run'));
  calls.commands.mockClear();
  calls.roots.length = 0;
  root = await mkdtemp(join(tmpdir(), 'readable-qa-launch-'));
  vi.stubEnv('READABLE_PORTABLE_QA_PRIVATE_DESKTOP', 'test-private-desktop');
  process.exitCode = 0;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of [...calls.roots, root]) await rm(path, { force: true, recursive: true });
});

test('cold start registers delayed welcome dismissal before later actions', async () => {
  const { finishColdStart } = await import('../scripts/portable-qa-workflows.ts');
  const events: string[] = [];
  let handleWelcome!: () => Promise<void>;
  const welcome = {
    isVisible: async () => false,
    waitFor: vi.fn(async ({ state }: { state: string }) => {
      events.push(state);
    }),
  };
  const absent = { isVisible: async () => false, filter() { return this; } };
  const dataImport = { isVisible: async () => false };
  const page = {
    evaluate: async () => 'unavailable',
    addLocatorHandler: async (locator: unknown, handler: () => Promise<void>) => {
      if (locator === dataImport) return;
      assert.equal(locator, welcome);
      handleWelcome = handler;
      events.push('registered');
    },
    getByRole: () => absent,
    getByTestId: (id: string) => id === 'data-import-modal' ? dataImport
      : id === 'welcome-modal' ? welcome : { waitFor: async () => { events.push('home'); } },
    keyboard: { press: async (key: string) => { events.push(key); } },
  } as unknown as Page;
  await finishColdStart(page);
  assert.deepEqual(events, ['registered', 'home']);
  await handleWelcome();
  assert.deepEqual(events, ['registered', 'home', 'Escape', 'detached']);
});

test('cold start does not require the optional welcome to appear', async () => {
  const { finishColdStart } = await import('../scripts/portable-qa-workflows.ts');
  const absent = { isVisible: async () => false, filter() { return this; } };
  const wait = vi.fn();
  const press = vi.fn();
  const page = {
    evaluate: async () => 'unavailable',
    addLocatorHandler: async () => {},
    getByRole: () => absent,
    getByTestId: (id: string) => id === 'welcome-modal' || id === 'data-import-modal'
      ? { isVisible: async () => false, waitFor: wait }
      : { waitFor: async () => {} },
    keyboard: { press },
  } as unknown as Page;
  await finishColdStart(page);
  assert.equal(wait.mock.calls.length, 0);
  assert.equal(press.mock.calls.length, 0);
});

test('cold start declines a data import offer through the localized user action', async () => {
  const { finishColdStart } = await import('../scripts/portable-qa-workflows.ts');
  const events: string[] = [];
  const absent = { isVisible: async () => false, filter() { return this; } };
  const dataImport = {
    isVisible: async () => true,
    getByRole: (_role: string, options: { name: RegExp }) => {
      assert.equal(options.name.test('새로 시작'), true);
      assert.equal(options.name.test('가져오지 않기'), true);
      return { click: async () => { events.push('decline'); } };
    },
    waitFor: async ({ state }: { state: string }) => { events.push(state); },
  };
  const page = {
    evaluate: async () => 'offered',
    addLocatorHandler: async () => {},
    getByRole: () => absent,
    getByTestId: (id: string) => id === 'data-import-modal' ? dataImport
      : id === 'welcome-modal' ? absent : { waitFor: async () => { events.push('home'); } },
    keyboard: { press: async () => { throw new Error('import is not dismissed with Escape'); } },
  } as unknown as Page;
  await finishColdStart(page);
  assert.deepEqual(events, ['visible', 'decline', 'detached', 'home']);
});

test.each(['tree-precheck', 'zip-gate'] as const)('launch accepts complete %s options', async (mode) => {
  const { parseOptions } = await import('../scripts/portable-qa-support.ts');
  const args = mode === 'tree-precheck'
    ? ['--tree', 'tree']
    : ['--zip', 'portable.zip', '--zip-receipt', 'receipt.txt', '--run-id', 'launch-test'];
  const options = parseOptions([
    '--case', 'launch', '--mode', mode, '--sealed-manifest', 'seal.txt', '--evidence', root, ...args,
  ]);
  assert.equal(options.case, 'launch');
  assert.equal(options.mode, mode);
  assert.equal(parseOptions(['--case', 'launch', '--zip', 'portable.zip', '--evidence', root]).mode, undefined);
});

test('concurrent tree and ZIP launch workflows pass unique namespaces to smoke and lifecycle receipts', async () => {
  const { runLaunch } = await import('../scripts/portable-qa-workflows.ts');
  const trap = { proxyUrl: 'http://127.0.0.1:1234', attempts: [], close: async () => {} };
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  calls.smoke.mockImplementation(async () => {
    if (calls.smoke.mock.calls.length === 2) release();
    await bothStarted;
  });
  const results = await Promise.all((['tree-precheck', 'zip-gate'] as const).map(async (mode) => {
    const evidenceRoot = join(root, mode);
    await mkdir(evidenceRoot);
    return runLaunch({
      mode, runId: 'same-coordinator', case: 'launch', offline: true, zipPath: '', evidenceRoot,
    }, root, trap);
  }));
  const namespaces = calls.smoke.mock.calls.map((call) => call[4] as string);
  assert.equal(new Set(namespaces).size, 2);
  for (const [index, result] of results.entries()) {
    const evidenceRoot = join(root, index === 0 ? 'tree-precheck' : 'zip-gate');
    const namespace = calls.smoke.mock.calls.find((call) => call[1] === evidenceRoot)![4] as string;
    assert.deepEqual(result.lifecycle.runtimePaths, [
      join(root, 'ReadableStudioData', 'namespaces', namespace),
    ]);
  }
});

async function runTreeLaunch(mismatch = false): Promise<void> {
  const tree = join(root, 'tree');
  const evidence = join(root, 'evidence');
  await mkdir(tree);
  await mkdir(evidence);
  const text = 'fixture launcher, never executed';
  await writeFile(join(tree, 'Readable Studio.exe'), text);
  const seal = join(root, 'seal.txt');
  await writeFile(seal, JSON.stringify({
    v: 1,
    files: [{
      path: 'Readable Studio.exe',
      size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(mismatch ? 'different bytes' : text).digest('hex'),
    }],
  }));
  process.argv = [process.execPath, 'portable-qa.ts', '--case', 'launch', '--mode', 'tree-precheck',
    '--tree', tree, '--sealed-manifest', seal, '--evidence', evidence, '--offline'];
  await import('../scripts/portable-qa.ts');
}

test('launch runs the real inventory gate and smoke, skips UI, and writes its cleanup receipt', async () => {
  calls.smoke.mockResolvedValue(undefined);
  await runTreeLaunch();
  assert.equal(process.exitCode, 0, String(stderr.mock.calls));
  assert.equal(calls.smoke.mock.calls.length, 1);
  assert.equal(calls.smoke.mock.calls[0]![3], true);
  assert.equal(calls.ui.mock.calls.length, 0);
  const summary = JSON.parse(await readFile(join(root, 'evidence', 'summary.json'), 'utf8'));
  const inventory = JSON.parse(await readFile(join(root, 'evidence', 'extracted-inventory.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(root, 'evidence', 'cleanup-receipt.json'), 'utf8'));
  assert.equal(summary.case, 'launch');
  assert.equal(summary.status, 'passed');
  assert.equal(inventory.equal, true);
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.remainingRoots, []);
  await assert.rejects(readFile(join(root, 'evidence', 'actions.json')), /ENOENT/);
});

test('launch fails an actual SHA inventory mismatch before starting the launcher', async () => {
  await runTreeLaunch(true);
  assert.equal(process.exitCode, 1);
  assert.equal(calls.smoke.mock.calls.length, 0);
  assert.equal(calls.ui.mock.calls.length, 0);
  const inventory = JSON.parse(await readFile(join(root, 'evidence', 'extracted-inventory.json'), 'utf8'));
  assert.equal(inventory.equal, false);
  await assert.rejects(readFile(join(root, 'evidence', 'summary.json')), /ENOENT/);
});

test.each(['daemon-status-ready', 'main window revealed'])('launch fails when readiness lacks the other marker: %s', async (marker) => {
  calls.smoke.mockImplementation(async (extractionRoot: string) => {
    const { waitForLauncherReady } = await import('../scripts/portable-qa-runtime.ts');
    const logPath = join(extractionRoot, 'latest.log');
    await writeFile(logPath, marker);
    vi.useFakeTimers();
    const ready = waitForLauncherReady(extractionRoot, logPath, () => {}, 180_000);
    // Attach the rejection handler before advancing the readiness deadline.
    const outcome = ready.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(180_000);
    vi.useRealTimers();
    throw await outcome;
  });
  await runTreeLaunch();
  assert.equal(process.exitCode, 1);
  assert.match(String(stderr.mock.calls), /launcher readiness timed out/);
  assert.equal(calls.ui.mock.calls.length, 0);
  await assert.rejects(readFile(join(root, 'evidence', 'summary.json')), /ENOENT/);
});

test('launch rejects external network attempts after the hidden launcher smoke', async () => {
  calls.smoke.mockImplementation(async (_root: string, _evidence: string, trap: { attempts: unknown[] }) => {
    trap.attempts.push({ bytes: 1, firstData: 'CONNECT external', remoteAddress: '127.0.0.1' });
  });
  await runTreeLaunch();
  assert.equal(process.exitCode, 1);
  assert.match(String(stderr.mock.calls), /external network access/);
  assert.equal(calls.ui.mock.calls.length, 0);
});
