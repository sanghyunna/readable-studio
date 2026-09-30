import { afterEach, expect, test, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { cursorAgentDef } from '../../src/runtimes/defs/cursor-agent.js';
import * as invocation from '../../src/runtimes/invocation.js';
import * as launch from '../../src/runtimes/launch.js';

afterEach(() => vi.restoreAllMocks());

function outputs(models: string) {
  return vi.spyOn(invocation, 'execAgentFile').mockImplementation((_bin, args) => Object.assign(Promise.resolve({
    stdout: args[0] === '--version' ? '2026.06.12-19-59-36-f6aba9a' : args[0] === 'status'
      ? '✓ Login successful!\nLogged in (unable to fetch user details)' : models,
    stderr: '',
  }), { child: new ChildProcess() }));
}

test('Cursor stays unavailable when the captured account listing is empty', async () => {
  // Given
  const calls = outputs('No models available for this account.');
  // When
  const agent = await safeProbe(cursorAgentDef, { CURSOR_AGENT_BIN: process.execPath });
  // Then
  expect(agent).toMatchObject({ available: false, modelsSource: 'fallback', models: [], authStatus: 'ok' });
  expect(calls.mock.calls.some((call) => call[1][0] === 'models')).toBe(true);
});

test('Cursor reports discovery failure when listing output is malformed', async () => {
  // Given
  outputs('{"unexpected": true}');
  // When
  const agent = await safeProbe(cursorAgentDef, { CURSOR_AGENT_BIN: process.execPath });
  // Then: malformed output is not an empty account. Verified sign-in permits
  // only the CLI-owned default while the discovery failure stays actionable.
  expect(agent).toMatchObject({ available: true, authStatus: 'ok', modelsSource: 'fallback' });
  expect(agent.models).toEqual([{ id: 'default', label: 'Default (CLI config)' }]);
  expect(agent.diagnostics).toEqual([expect.objectContaining({
    reason: 'discovery-failed', severity: 'warning',
    fixActions: expect.arrayContaining([{ kind: 'rescan' }]),
  })]);
  expect(cursorAgentDef.listModels.parse.bind(null, '{"unexpected": true}')).toThrow();
});

test('Cursor does not invoke discovery when the executable is absent', async () => {
  // Given
  const calls = outputs('auto');
  const resolution = launch.resolveAgentLaunch(cursorAgentDef, { CURSOR_AGENT_BIN: process.execPath });
  vi.spyOn(launch, 'resolveAgentLaunch').mockReturnValue({ ...resolution, selectedPath: null, launchPath: null });
  // When
  const agent = await safeProbe(cursorAgentDef);
  // Then
  expect(agent).toMatchObject({ available: false, models: [], diagnostics: [{ reason: 'not-on-path' }] });
  expect(calls).not.toHaveBeenCalled();
});
