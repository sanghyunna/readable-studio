import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

import { listSystemFonts } from '../src/system-fonts.js';

function fontProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn(),
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.skipIf(process.platform !== 'win32')('Windows font enumeration on slow storage', () => {
  it('keeps a cold PowerShell enumeration alive beyond 15 seconds', async () => {
    vi.useFakeTimers();
    const child = fontProcess();
    spawn.mockReturnValue(child);
    const pending = listSystemFonts({ refresh: true });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', JSON.stringify({ hklm: { 'Arial (TrueType)': 'arial.ttf' } }));
    child.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ fonts: [{ family: 'Arial' }] });
  });

  it('retries after a failed enumeration instead of caching an empty font list', async () => {
    const failed = fontProcess();
    const succeeded = fontProcess();
    spawn.mockReturnValueOnce(failed).mockReturnValueOnce(succeeded);
    const first = listSystemFonts({ refresh: true });
    failed.emit('error', new Error('temporary registry failure'));
    await expect(first).resolves.toMatchObject({ fonts: [] });
    const retry = listSystemFonts();
    succeeded.stdout.emit('data', JSON.stringify({ hklm: { 'Arial (TrueType)': 'arial.ttf' } }));
    succeeded.emit('close', 0);
    await expect(retry).resolves.toMatchObject({ fonts: [{ family: 'Arial' }] });
  });
});
