import { afterEach, expect, test, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { opencodeAgentDef } from '../../src/runtimes/defs/opencode.js';
import * as invocation from '../../src/runtimes/invocation.js';
import * as launch from '../../src/runtimes/launch.js';

afterEach(() => vi.restoreAllMocks());
const credentials = '\u001b[90m┌\u001b[39m  Credentials ~/.local/share/opencode/auth.json\n●  OpenAI oauth\n●  Kimi For Coding api\n●  OpenCode Go api\n└  3 credentials';

function outputs(auth: string, models = 'openai/gpt-5.6\nopencode-go/kimi-k3') {
  return vi.spyOn(invocation, 'execAgentFile').mockImplementation((_bin, args) => Object.assign(Promise.resolve({
    stdout: args[0] === '--version' ? '1.17.8' : args[0] === 'auth' ? '' : models,
    stderr: args[0] === 'auth' ? auth : '',
  }), { child: new ChildProcess() }));
}

test('OpenCode reports live models when the captured credential listing succeeds', async () => {
  // Given
  const calls = outputs(credentials);
  // When
  const agent = await safeProbe(opencodeAgentDef, { OPENCODE_BIN: process.execPath });
  // Then
  expect(agent).toMatchObject({ available: true, modelsSource: 'live', authStatus: 'ok' });
  expect(agent.models.map((model) => model.id)).toEqual(['openai/gpt-5.6', 'opencode-go/kimi-k3']);
  expect(calls.mock.calls.some((call) => call[1].join(' ') === 'auth list')).toBe(true);
});

test.each(['unexpected output', '└  0 credentials'])('OpenCode stays unavailable when auth output is %s', async (auth) => {
  // Given
  outputs(auth);
  // When
  const agent = await safeProbe(opencodeAgentDef, { OPENCODE_BIN: process.execPath });
  // Then
  expect(agent).toMatchObject({ available: false, models: [] });
  expect(agent.diagnostics?.[0]?.reason).toBe(auth.includes('0 credentials') ? 'auth-missing' : 'auth-unknown');
});

test('OpenCode rejects malformed listing instead of claiming no configured models', async () => {
  // Given
  outputs(credentials, '{"unexpected": true}');
  // When
  const agent = await safeProbe(opencodeAgentDef, { OPENCODE_BIN: process.execPath });
  // Then
  expect(agent).toMatchObject({ available: false, models: [] });
  expect(opencodeAgentDef.listModels.parse.bind(null, '{"unexpected": true}')).toThrow();
});

test('OpenCode does not invoke discovery when the executable is absent', async () => {
  // Given
  const calls = outputs(credentials);
  const resolution = launch.resolveAgentLaunch(opencodeAgentDef, { OPENCODE_BIN: process.execPath });
  vi.spyOn(launch, 'resolveAgentLaunch').mockReturnValue({ ...resolution, selectedPath: null, launchPath: null });
  // When
  const agent = await safeProbe(opencodeAgentDef);
  // Then
  expect(agent).toMatchObject({ available: false, models: [], diagnostics: [{ reason: 'not-on-path' }] });
  expect(calls).not.toHaveBeenCalled();
});
