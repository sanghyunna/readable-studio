import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DEFS } from '../../src/runtimes/registry.js';

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

function fakeAgentLaunch(def: { readonly id: string }) {
  return {
    configuredOverridePath: null,
    pathResolvedPath: `/fake/bin/${def.id}`,
    selectedPath: `/fake/bin/${def.id}`,
    launchPath: `/fake/bin/${def.id}`,
    launchKind: 'selected' as const,
    childPathPrepend: ['/fake/bin'],
    diagnostic: null,
  };
}

function versionProbeCalls(agentId: string) {
  return execAgentFileMock.mock.calls.filter(
    ([command, args]) =>
      command === `/fake/bin/${agentId}` &&
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
    resolveAgentLaunchMock.mockImplementation(fakeAgentLaunch);
  });
  afterEach(async () => {
    const { _resetAgentDetectionCacheForTests } = await import('../../src/runtimes/detection.js');
    _resetAgentDetectionCacheForTests();
  });

  it('memoizes repeated detection for the same configured environment within the TTL', async () => {
    // Given a completed exhaustive scan in the same environment.
    execAgentFileMock.mockResolvedValue({ stdout: 'codex 1.2.3\n', stderr: '' });
    const { detectAgents } = await import('../../src/runtimes/detection.js');

    await detectAgents({}, { enabledAgentIds: ['codex'] });
    // When discovery repeats within the TTL.
    await detectAgents({}, { enabledAgentIds: ['codex'] });

    // Then no CLI in the inventory receives a second version probe.
    for (const def of AGENT_DEFS.filter((def) => !def.detect)) {
      expect(versionProbeCalls(def.id), def.id).toHaveLength(1);
    }
  });

  it('bypasses a settled cached detection when refresh is requested', async () => {
    // Given a settled scan with the old Codex version.
    let versionProbeCount = 0;
    execAgentFileMock.mockImplementation((command, args) => {
      if (command === '/fake/bin/codex' && Array.isArray(args) && args.join('\0') === '--version') {
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
    // When an explicit refresh runs.
    const refreshed: string[] = [];
    for await (const agent of detectAgentsStream({}, { enabledAgentIds: ['codex'], refresh: true })) {
      refreshed.push(agent.version ?? '');
    }

    // Then the refresh replaces the version with exactly one fresh Codex probe.
    expect(warmed).toEqual(['codex 1.2.3']);
    expect(refreshed).toEqual(['codex 1.2.4']);
    expect(versionProbeCount).toBe(2);
  });

  it('joins an in-flight cached detection when refresh is requested', async () => {
    // Given an exhaustive scan holding the Codex version probe.
    type VersionProbeResult = { readonly stdout: string; readonly stderr: string };
    let versionProbeCount = 0;
    let markStarted: () => void = () => { throw new Error('start signal not initialized'); };
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishFirstProbe: (result: VersionProbeResult) => void = (_result) => {
      throw new Error('first codex version probe did not start');
    };
    execAgentFileMock.mockImplementation((command, args) => {
      if (command === '/fake/bin/codex' && Array.isArray(args) && args.join('\0') === '--version') {
        versionProbeCount += 1;
        if (versionProbeCount === 1) {
          return new Promise<VersionProbeResult>((resolve) => {
            finishFirstProbe = resolve;
            markStarted();
          });
        }
        return Promise.resolve({ stdout: 'codex 1.2.4\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const { detectAgentsStream } = await import('../../src/runtimes/detection.js');

    const firstStream = detectAgentsStream({}, { enabledAgentIds: ['codex'] });
    const firstResultPromise = firstStream.next();
    // When refresh subscribes before that probe completes.
    const refreshStream = detectAgentsStream({}, { enabledAgentIds: ['codex'], refresh: true });
    const refreshResultPromise = refreshStream.next();
    await started;
    const probesStartedBeforeFirstFinished = versionProbeCount;
    finishFirstProbe({ stdout: 'codex 1.2.3\n', stderr: '' });

    const firstResult = await firstResultPromise;
    const refreshResult = await refreshResultPromise;

    // Then both subscribers receive the same result from one Codex probe.
    expect(firstResult.value?.version).toBe('codex 1.2.3');
    expect(refreshResult.value?.version).toBe('codex 1.2.3');
    expect(probesStartedBeforeFirstFinished).toBe(1);
    expect(versionProbeCount).toBe(1);
    await Promise.all([
      (async () => { for await (const _agent of firstStream) { /* drain scan */ } })(),
      (async () => { for await (const _agent of refreshStream) { /* drain scan */ } })(),
    ]);
  });

  it('joins daemon warmup when the initial renderer stream starts', async () => {
    // Given a warmup whose version probe has not settled.
    let finishVersion: (value: { stdout: string; stderr: string }) => void = () => {
      throw new Error('version probe not started');
    };
    const version = new Promise<{ stdout: string; stderr: string }>((resolve) => { finishVersion = resolve; });
    execAgentFileMock.mockImplementation((_command, args) =>
      Array.isArray(args) && args.join('\0') === '--version'
        ? version : Promise.resolve({ stdout: '', stderr: '' }));
    const { detectAgents, detectAgentsStream } = await import('../../src/runtimes/detection.js');
    const warmup = detectAgents({}, { enabledAgentIds: ['codex'] });
    // When the renderer subscribes before warmup completes.
    const stream = detectAgentsStream({}, { enabledAgentIds: ['codex'] });
    const next = stream.next();
    finishVersion({ stdout: 'codex 1.2.3', stderr: '' });
    // Then both receive the same classification from one probe.
    const [agents, event] = await Promise.all([warmup, next]);
    expect(event.value).toEqual(agents[0]);
    for (const def of AGENT_DEFS.filter((def) => !def.detect)) {
      expect(versionProbeCalls(def.id), def.id).toHaveLength(1);
    }
    await stream.return(undefined);
  });

  it('invalidates memoized detection when the configured environment fingerprint changes', async () => {
    // Given a completed scan for the original Codex environment.
    execAgentFileMock.mockResolvedValue({ stdout: 'codex 1.2.3\n', stderr: '' });
    const { detectAgents } = await import('../../src/runtimes/detection.js');

    await detectAgents({ codex: { CODEX_HOME: '/one' } }, { enabledAgentIds: ['codex'] });
    // When only Codex's configured environment changes.
    await detectAgents({ codex: { CODEX_HOME: '/two' } }, { enabledAgentIds: ['codex'] });

    // Then only Codex is reprobed; every other CLI retains its cached result.
    for (const def of AGENT_DEFS.filter((def) => !def.detect)) {
      expect(versionProbeCalls(def.id), def.id).toHaveLength(def.id === 'codex' ? 2 : 1);
    }
  });
});
