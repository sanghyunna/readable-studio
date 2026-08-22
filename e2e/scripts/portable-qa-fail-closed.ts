import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { _electron as electron, type ElectronApplication } from '@playwright/test';

import { closePortable, launchEnvironment, type NetworkTrap } from './portable-qa-runtime.ts';
import {
  canonicalProductName,
  toRecord,
  writeEvidence,
  type Options,
} from './portable-qa-support.ts';

type FailClosedInput = {
  readonly evidenceName: string;
  readonly env: Record<string, string>;
  readonly executablePath: string;
};

type FailClosedResult = {
  readonly applicationReady: boolean;
  readonly launchError: string;
  readonly windowTitle: string | null;
  readonly windowUrl: string | null;
};

async function observeFailClosedLaunch(input: FailClosedInput): Promise<FailClosedResult> {
  let app: ElectronApplication | null = null;
  let launchError = '';
  let windowTitle: string | null = null;
  let windowUrl: string | null = null;
  try {
    app = await electron.launch({ executablePath: input.executablePath, env: input.env, timeout: 20_000 });
    const firstWindow = await app.firstWindow({ timeout: 5_000 }).catch(() => null);
    if (firstWindow != null) {
      windowTitle = await firstWindow.title();
      windowUrl = firstWindow.url();
    }
  } catch (error) {
    launchError = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    if (app != null) await closePortable(app);
  }
  const applicationReady = windowTitle === canonicalProductName && windowUrl?.startsWith('readable-studio://app/') === true;
  assert.equal(applicationReady, false, `${input.evidenceName} reached application readiness`);
  assert.ok(launchError.length > 0 || windowTitle != null, `${input.evidenceName} produced no visible or launch diagnostic`);
  return { applicationReady, launchError, windowTitle, windowUrl };
}

export async function runBadRoot(options: Options, extractionRoot: string, trap: NetworkTrap): Promise<Record<string, unknown>> {
  const executablePath = join(extractionRoot, `${canonicalProductName}.exe`);
  const configPath = join(extractionRoot, 'resources', 'readable-studio-config.json');
  const originalConfigText = await readFile(configPath, 'utf8');
  const originalConfig = toRecord(JSON.parse(originalConfigText), 'portable config');
  const blockedRoot = join(extractionRoot, 'ReadableStudioData');
  await writeFile(blockedRoot, 'occupied by Task30 bad-root acceptance\n', 'utf8');
  const occupiedRoot = await observeFailClosedLaunch({
    env: launchEnvironment('task30-bad-root', trap, options.offline),
    evidenceName: 'occupied exe-adjacent data root',
    executablePath,
  });
  await rm(blockedRoot, { force: true });

  await writeFile(configPath, '{ malformed portable config', 'utf8');
  const malformedConfig = await observeFailClosedLaunch({
    env: launchEnvironment('task30-malformed', trap, options.offline),
    evidenceName: 'malformed portable config',
    executablePath,
  });
  assert.match(malformedConfig.launchError, /packaged config at .* is not valid JSON/);
  assert.match(malformedConfig.launchError, /exitCode=1/);

  await writeFile(configPath, `${JSON.stringify({ ...originalConfig, namespaceBaseRoot: join(extractionRoot, '..', 'foreign-namespaces') })}\n`, 'utf8');
  const foreignNamespaceRoot = await observeFailClosedLaunch({
    env: launchEnvironment('task30-foreign-root', trap, options.offline),
    evidenceName: 'foreign namespace root',
    executablePath,
  });
  assert.match(foreignNamespaceRoot.launchError, /namespaceBaseRoot must resolve inside <exeDir>\/ReadableStudioData/);
  assert.match(foreignNamespaceRoot.launchError, /exitCode=1/);

  await writeFile(configPath, originalConfigText, 'utf8');
  const foreignDataRoot = join(extractionRoot, '..', 'foreign-data');
  const foreignDataOverride = await observeFailClosedLaunch({
    env: {
      ...launchEnvironment('task30-foreign-data', trap, options.offline),
      READABLE_DATA_DIR: foreignDataRoot,
    },
    evidenceName: 'foreign data root override',
    executablePath,
  });
  assert.equal(foreignDataOverride.applicationReady, false);
  assert.match(foreignDataOverride.launchError, /READABLE_DATA_DIR.*requires.*stay inside <exeDir>\/ReadableStudioData/);
  assert.match(foreignDataOverride.launchError, /exitCode=1/);

  assert.deepEqual(trap.attempts, [], 'fail-closed launches attempted feed/network traffic');
  const cases = { foreignDataOverride, foreignNamespaceRoot, malformedConfig, occupiedRoot };
  await writeEvidence(options.evidenceRoot, 'bad-root.json', { cases, executablePath, proxyAttempts: trap.attempts });
  return { cases, status: 'passed' };
}
