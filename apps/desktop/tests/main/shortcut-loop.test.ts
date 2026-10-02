import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ packaged: true, getPath: vi.fn(), run: vi.fn(), write: vi.fn(), read: vi.fn() }));
vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged; }, getPath: mocks.getPath },
  shell: { writeShortcutLink: mocks.write, readShortcutLink: mocks.read },
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.run }));
import { startShortcutLoop } from '../../src/main/shortcut-loop.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.packaged = true;
});

async function deliverJob(location: 'desktop' | 'startMenu') {
  let result: unknown;
  let loop: ReturnType<typeof startShortcutLoop>;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      result = JSON.parse(String(init.body));
      loop.abort();
      return { ok: true };
    }
    return { ok: true, json: async () => ({ job: { id: 'shortcut-job', location } }) };
  });
  vi.stubGlobal('fetch', fetch);
  loop = startShortcutLoop({ token: 'test-token', discoverDaemonUrl: async () => 'http://localhost:1' });
  await loop.done;
  expect(fetch).toHaveBeenCalledTimes(2);
  return result;
}

describe('shortcut queue folder boundary', () => {
  it('acknowledges unsupported source requests without invoking PowerShell', async () => {
    mocks.packaged = false;
    mocks.getPath.mockReturnValue('D:\\source\\electron.exe');
    expect(await deliverJob('startMenu')).toEqual({ status: 'failed', location: 'startMenu', reason: 'unsupported' });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('creates in injected real Programs, not redirected portable appData, and acknowledges success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-shortcut-loop-'));
    roots.push(root);
    const desktop = path.join(root, '한글 Desktop');
    const cache = path.join(root, 'portable cache');
    const programs = path.join(root, 'real 한글 Start Menu', 'Programs');
    fs.mkdirSync(desktop); fs.mkdirSync(cache);
    const exe = path.join(root, 'Readable Studio.exe');
    mocks.getPath.mockImplementation((name: string) => name === 'desktop' ? desktop : name === 'exe' ? exe : cache);
    mocks.run.mockReturnValue(programs + '\r\n');
    mocks.write.mockImplementation((file: string) => { fs.writeFileSync(file, 'owned test shortcut'); return true; });
    expect(await deliverJob('startMenu')).toEqual({ status: 'created', location: 'startMenu' });
    expect(fs.existsSync(path.join(programs, 'Readable Studio.lnk'))).toBe(true);
    expect(fs.existsSync(path.join(cache, 'Microsoft'))).toBe(false);
    expect(mocks.getPath).not.toHaveBeenCalledWith('appData');
    expect(mocks.write).toHaveBeenCalledWith(path.join(programs, 'Readable Studio.lnk'), 'create', expect.objectContaining({ target: exe, cwd: root }));
  });
  it('logs folder resolution detail and acknowledges a failed job rather than abandoning it', async () => {
    mocks.getPath.mockReturnValue('D:\\portable cache');
    const error = Object.assign(new Error('PowerShell denied'), { status: 7, stderr: 'access denied' });
    mocks.run.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverJob('startMenu')).toEqual({ status: 'failed', location: 'startMenu', reason: 'failed' });
    expect(log).toHaveBeenCalledWith('shortcut folder resolution failed:', expect.objectContaining({ location: 'startMenu', error }));
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
