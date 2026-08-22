import { beforeEach, describe, expect, it, vi } from 'vitest';

const execAgentFileMock = vi.fn();
const resolveAgentLaunchMock = vi.fn();

vi.mock('../../src/runtimes/invocation.js', () => ({
  execAgentFile: (...args: unknown[]) =>
    (execAgentFileMock as unknown as (...args: unknown[]) => unknown)(...args),
}));

vi.mock('../../src/runtimes/launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtimes/launch.js')>();
  return {
    ...actual,
    resolveAgentLaunch: (
      ...args: Parameters<typeof actual.resolveAgentLaunch>
    ) =>
      (
        resolveAgentLaunchMock as unknown as (
          ...a: Parameters<typeof actual.resolveAgentLaunch>
        ) => ReturnType<typeof actual.resolveAgentLaunch>
      )(...args),
  };
});

function fakeCodexLaunch() {
  return {
    configuredOverridePath: null,
    pathResolvedPath: '/fake/bin/codex',
    selectedPath: '/fake/bin/codex',
    launchPath: '/fake/bin/codex',
    launchKind: 'selected' as const,
    childPathPrepend: ['/fake/bin'],
    diagnostic: null,
  };
}

function codexVersionProbeCalls() {
  return execAgentFileMock.mock.calls.filter(
    ([command, args]) =>
      command === '/fake/bin/codex' &&
      Array.isArray(args) &&
      args.join('\0') === '--version',
  );
}

describe('agent detection cache', () => {
  beforeEach(async () => {
    execAgentFileMock.mockReset();
    resolveAgentLaunchMock.mockReset();
    const { _resetAgentDetectionCacheForTests } = await import('../../src/runtimes/detection.js');
    _resetAgentDetectionCacheForTests();
    resolveAgentLaunchMock.mockImplementation(fakeCodexLaunch);
  });

  it('memoizes repeated detection for the same configured environment within the TTL', async () => {
    execAgentFileMock.mockResolvedValue({ stdout: 'codex 1.2.3\n', stderr: '' });
    const { detectAgents } = await import('../../src/runtimes/detection.js');

    await detectAgents({}, { enabledAgentIds: ['codex'] });
    await detectAgents({}, { enabledAgentIds: ['codex'] });

    expect(codexVersionProbeCalls()).toHaveLength(1);
  });

  it('bypasses a settled cached detection when refresh is requested', async () => {
    let versionProbeCount = 0;
    execAgentFileMock.mockImplementation((_command, args) => {
      if (Array.isArray(args) && args.join('\0') === '--version') {
        versionProbeCount += 1;
        return Promise.resolve({
          stdout: versionProbeCount === 1 ? 'codex 1.2.3\n' : 'codex 1.2.4\n',
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const { detectAgentsStream } = await import('../../src/runtimes/detection.js');

    const warmed: string[] = [];
    for await (const agent of detectAgentsStream({}, { enabledAgentIds: ['codex'] })) {
      warmed.push(agent.version ?? '');
    }
    const refreshed: string[] = [];
    for await (const agent of detectAgentsStream({}, { enabledAgentIds: ['codex'], refresh: true })) {
      refreshed.push(agent.version ?? '');
    }

    expect(warmed).toEqual(['codex 1.2.3']);
    expect(refreshed).toEqual(['codex 1.2.4']);
    expect(versionProbeCount).toBe(2);
  });

  it('bypasses an in-flight cached detection when refresh is requested', async () => {
    type VersionProbeResult = { readonly stdout: string; readonly stderr: string };
    let versionProbeCount = 0;
    let finishFirstProbe: (result: VersionProbeResult) => void = (_result) => {
      throw new Error('first codex version probe did not start');
    };
    execAgentFileMock.mockImplementation((_command, args) => {
      if (Array.isArray(args) && args.join('\0') === '--version') {
        versionProbeCount += 1;
        if (versionProbeCount === 1) {
          return new Promise<VersionProbeResult>((resolve) => {
            finishFirstProbe = resolve;
          });
        }
        return Promise.resolve({ stdout: 'codex 1.2.4\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const { detectAgentsStream } = await import('../../src/runtimes/detection.js');

    const firstStream = detectAgentsStream({}, { enabledAgentIds: ['codex'] });
    const firstResultPromise = firstStream.next();
    const refreshStream = detectAgentsStream({}, { enabledAgentIds: ['codex'], refresh: true });
    const refreshResultPromise = refreshStream.next();
    await Promise.resolve();
    const probesStartedBeforeFirstFinished = versionProbeCount;
    finishFirstProbe({ stdout: 'codex 1.2.3\n', stderr: '' });

    const firstResult = await firstResultPromise;
    const refreshResult = await refreshResultPromise;

    expect(firstResult.value?.version).toBe('codex 1.2.3');
    expect(refreshResult.value?.version).toBe('codex 1.2.4');
    expect(probesStartedBeforeFirstFinished).toBe(2);
    expect(versionProbeCount).toBe(2);
  });

  it('invalidates memoized detection when the configured environment fingerprint changes', async () => {
    execAgentFileMock.mockResolvedValue({ stdout: 'codex 1.2.3\n', stderr: '' });
    const { detectAgents } = await import('../../src/runtimes/detection.js');

    await detectAgents({ codex: { CODEX_HOME: '/one' } }, { enabledAgentIds: ['codex'] });
    await detectAgents({ codex: { CODEX_HOME: '/two' } }, { enabledAgentIds: ['codex'] });

    expect(codexVersionProbeCalls()).toHaveLength(2);
  });
});
