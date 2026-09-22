import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStartupSplash, type SplashHost } from '../../src/main/startup-splash.js';

function fixture() {
  const setProgress = vi.fn();
  const reveal = vi.fn();
  const onTimeout = vi.fn();
  const host: SplashHost = {
    startedAt: 0,
    isStopped: () => false,
    readReadiness: async () => ({ appMounted: true, splashFinished: true }),
    readScan: async () => ({ phase: 'running', currentAgentName: 'Codex', completed: 0, total: 2 }),
    executeSplash: async (script) => runInNewContext(script, { window: { __readableSplash: { setProgress } } }),
    reveal,
    onTimeout,
  };
  return { host, setProgress, reveal, onTimeout };
}

afterEach(() => vi.useRealTimers());

describe('startup splash', () => {
  it.each(['running', 'hung', 'stored'] as const)('reveals before the deadline when the UI and animation are ready and scanning is %s', async (scan) => {
    // Given a parked animation and a scan independent of UI readiness.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    const readScan = scan === 'hung' ? () => new Promise<never>(() => {})
      : scan === 'stored' ? async () => null : host.readScan;
    // When the first readiness observation arrives.
    const done = runStartupSplash({ ...host, readScan });
    await vi.advanceTimersByTimeAsync(80);
    // Then neither scan completion nor a visual floor holds the window.
    expect(reveal).toHaveBeenCalledOnce();
    expect(await done).toBe('ready');
  });

  it('continues pushing progress while the UI is still mounting', async () => {
    // Given an unmounted UI and changing scan progress.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, setProgress, reveal } = fixture();
    let appMounted = false;
    let splashFinished = false;
    let completed = 0;
    const scanMountStates: boolean[] = [];
    const readScan = vi.fn(async () => {
      scanMountStates.push(appMounted);
      return { phase: 'running', currentAgentName: 'Codex', completed, total: 23 } as const;
    });
    const done = runStartupSplash({ ...host,
      readReadiness: async () => ({ appMounted, splashFinished }),
      readScan,
    });
    // When scan progress changes before UI readiness.
    await vi.advanceTimersByTimeAsync(320);
    const previousCalls = setProgress.mock.calls.length;
    completed = 1;
    await vi.advanceTimersByTimeAsync(400);
    // Then the document receives updated progress without a premature reveal.
    expect(setProgress.mock.calls.length).toBeGreaterThan(previousCalls);
    expect(readScan).toHaveBeenCalled();
    expect(scanMountStates.every((mounted) => mounted === false)).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
    appMounted = true;
    await vi.advanceTimersByTimeAsync(160);
    expect(reveal).not.toHaveBeenCalled();
    splashFinished = true;
    await vi.advanceTimersByTimeAsync(160);
    expect(await done).toBe('ready');
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('holds a mounted app until the animation finishes', async () => {
    // Given a painted app whose animation is still playing.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    let splashFinished = false;
    const done = runStartupSplash({ ...host,
      readReadiness: async () => ({ appMounted: true, splashFinished }),
    });
    await vi.advanceTimersByTimeAsync(6400);
    expect(reveal).not.toHaveBeenCalled();
    // When the animation parks on its final frame.
    splashFinished = true;
    await vi.advanceTimersByTimeAsync(160);
    // Then reveal does not burn the remaining deadline.
    expect(reveal).toHaveBeenCalledOnce();
    expect(await done).toBe('ready');
  });

  it('reveals exactly at the deadline when the animation never finishes', async () => {
    // Given a mounted app and a permanently stalled animation.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    const done = runStartupSplash({ ...host,
      readReadiness: async () => ({ appMounted: true, splashFinished: false }),
    });
    await vi.advanceTimersByTimeAsync(14999);
    expect(reveal).not.toHaveBeenCalled();
    // When the deadline arrives.
    await vi.advanceTimersByTimeAsync(1);
    // Then animation and scan cannot extend the ceiling.
    expect(reveal).toHaveBeenCalledOnce();
    expect(await done).toBe('unverified');
  });

  it('offers native recovery at the ceiling without revealing an unpainted renderer', async () => {
    // Given a hung renderer and active scanning.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal, onTimeout } = fixture();
    // When the readiness ceiling expires.
    const done = runStartupSplash({ ...host, readReadiness: () => new Promise<never>(() => {}) });
    await vi.advanceTimersByTimeAsync(15000);
    // Then an honest recovery state replaces indefinite waiting, never a blank window.
    expect(reveal).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(await done).toBe('unverified');
  });

  it('shows delayed scan progress when the scan session starts after polling begins', async () => {
    // Given a scan session that reports null before any agents run.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, setProgress, reveal } = fixture();
    let appMounted = false;
    let splashFinished = false;
    let call = 0;
    const done = runStartupSplash({ ...host,
      readReadiness: async () => ({ appMounted, splashFinished }),
      readScan: async () => {
        call += 1;
        if (call === 1) return null;
        if (call === 2) return { phase: 'running', currentAgentName: 'Agent1', completed: 0, total: 2 };
        if (call === 3) return { phase: 'running', currentAgentName: 'Agent2', completed: 1, total: 2 };
        return { phase: 'done', currentAgentName: null, completed: 2, total: 2 };
      },
    });
    // When the scan session transitions from null to running progress.
    await vi.advanceTimersByTimeAsync(400);
    expect(setProgress).toHaveBeenCalledWith('Checking Agent1 (0/2)');
    await vi.advanceTimersByTimeAsync(400);
    expect(setProgress).toHaveBeenCalledWith('Checking Agent2 (1/2)');
    // Then terminal completion still respects the readiness gate.
    await vi.advanceTimersByTimeAsync(400);
    expect(setProgress).toHaveBeenCalledWith('Agent scan complete');
    appMounted = true;
    splashFinished = true;
    await vi.advanceTimersByTimeAsync(160);
    expect(reveal).toHaveBeenCalledOnce();
    expect(await done).toBe('ready');
  });

  it('does not reveal when the host stops during scanning', async () => {
    // Given a pending startup.
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    let stopped = false;
    const done = runStartupSplash({ ...host, isStopped: () => stopped });
    // When the host stops before readiness is observed.
    stopped = true;
    await vi.advanceTimersByTimeAsync(80);
    // Then there is no reveal.
    expect(await done).toBe('stopped');
    expect(reveal).not.toHaveBeenCalled();
  });
});
