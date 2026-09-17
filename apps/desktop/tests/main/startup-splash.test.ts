import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStartupSplash, type ScanProgress, type SplashHost } from '../../src/main/startup-splash.js';

function fixture() {
  const labels: Array<string | null> = [];
  const setProgress = vi.fn((text: string | null) => { labels.push(text); });
  const reveal = vi.fn();
  const host: SplashHost = {
    startedAt: 0,
    isStopped: () => false,
    readReadiness: async () => ({ appMounted: true, splashFinished: true }),
    readScan: async () => ({ phase: 'running', currentAgentName: 'Codex', completed: 0, total: 2 }),
    executeSplash: async (script) => runInNewContext(script, { window: { __readableSplash: { setProgress } } }),
    reveal,
  };
  return { host, labels, reveal };
}

afterEach(() => vi.useRealTimers());

describe('startup splash', () => {
  it('pushes each current agent into the real document hook without revealing early', async () => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, labels, reveal } = fixture();
    let scan: ScanProgress = { phase: 'running', currentAgentName: 'Codex', completed: 0, total: 2 };
    const done = runStartupSplash({ ...host, readScan: async () => scan });
    // When
    await vi.advanceTimersByTimeAsync(6800);
    expect(reveal).not.toHaveBeenCalled();
    scan = { ...scan, currentAgentName: 'Kimi', completed: 1 };
    await vi.advanceTimersByTimeAsync(400);
    scan = { ...scan, phase: 'done', completed: 2 };
    await vi.advanceTimersByTimeAsync(400);
    // Then
    await done;
    expect(labels.some((text) => text?.includes('Codex'))).toBe(true);
    expect(labels.some((text) => text?.includes('Kimi'))).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('retains the normal reveal floor when stored completion skips the scan', async () => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    const readScan = vi.fn(async () => null);
    // When
    const done = runStartupSplash({ ...host, readScan });
    await vi.advanceTimersByTimeAsync(6800);
    // Then
    await done;
    expect(reveal).toHaveBeenCalledOnce();
    expect(readScan).toHaveBeenCalledOnce();
  });

  it.each(['request', 'renderer'])('opens at the normal ceiling when the %s never responds', async (stalled) => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    const never = new Promise<never>(() => {});
    const readScan = stalled === 'request' ? () => never : async () => null;
    const readReadiness = stalled === 'renderer' ? () => never : host.readReadiness;
    // When
    const done = runStartupSplash({ ...host, readScan, readReadiness });
    await vi.advanceTimersByTimeAsync(15000);
    // Then
    expect(await done).toBe('unverified');
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('opens without claiming completion when an active scan exceeds its budget', async () => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    // When
    const done = runStartupSplash(host);
    await vi.advanceTimersByTimeAsync(60000);
    // Then
    expect(await done).toBe('unverified');
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('keeps a completed scan behind the splash until the app mounts', async () => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    let appMounted = false;
    // When
    const done = runStartupSplash({ ...host,
      readScan: async () => ({ phase: 'done', currentAgentName: null, completed: 2, total: 2 }),
      readReadiness: async () => ({ appMounted, splashFinished: true }),
    });
    await vi.advanceTimersByTimeAsync(7000);
    expect(reveal).not.toHaveBeenCalled();
    appMounted = true;
    await vi.advanceTimersByTimeAsync(160);
    // Then
    expect(await done).toBe('ready');
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('does not reveal when the host stops during scanning', async () => {
    // Given
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { host, reveal } = fixture();
    let stopped = false;
    const done = runStartupSplash({ ...host, isStopped: () => stopped });
    // When
    stopped = true;
    await vi.advanceTimersByTimeAsync(80);
    // Then
    expect(await done).toBe('stopped');
    expect(reveal).not.toHaveBeenCalled();
  });
});
