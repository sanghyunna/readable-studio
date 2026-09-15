import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { piAgentDef } from '../../src/runtimes/defs/pi.js';
import { resolveAgentLaunch } from '../../src/runtimes/launch.js';
import * as invocation from '../../src/runtimes/invocation.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

test('portable Pi resolves the staged CLI before global Pi and preserves an explicit override', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'readable-pi-resolution-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const resourceRoot = path.join(root, 'resources', 'readable-studio');
    const appRoot = path.join(root, 'resources', 'app');
    const globalBin = path.join(root, 'global');
    await mkdir(appRoot, { recursive: true });
    await mkdir(globalBin);
    const bundled = path.join(appRoot, 'pi.cmd');
    const global = path.join(globalBin, 'pi.cmd');
    await writeFile(bundled, '@exit /b 0\r\n');
    await writeFile(global, '@exit /b 0\r\n');
    vi.stubEnv('READABLE_RESOURCE_ROOT', resourceRoot);
    vi.stubEnv('READABLE_AGENT_HOME', root);
    vi.stubEnv('PATH', globalBin);
    vi.stubEnv('PATHEXT', '.CMD');
    expect(resolveAgentLaunch(piAgentDef).selectedPath).toBe(bundled);
    expect(resolveAgentLaunch(piAgentDef, { PI_BIN: global }).selectedPath).toBe(global);
    vi.stubEnv('PATH', '');
    expect(resolveAgentLaunch(piAgentDef).launchPath).toBe(bundled);
    await rm(bundled);
    expect(resolveAgentLaunch(piAgentDef).selectedPath).toBeNull();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi no-credentials guidance never becomes selectable model IDs', async () => {
  vi.spyOn(invocation, 'execAgentFile').mockResolvedValue({
    stdout: 'No models available. Use /login to log into a provider via OAuth or API key. See:\n  C:\\Program Files\\Readable Studio\\docs\\providers.md\n  C:\\Program Files\\Readable Studio\\docs\\models.md\n',
    stderr: '',
  });
  expect(await piAgentDef.fetchModels('pi', {})).toEqual([{ id: 'default', label: 'Default (CLI config)' }]);
});
