import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createShortcut, shortcutCapabilities, resolveShortcutPaths, resolveStartMenuPrograms } from '../../src/main/shortcuts.js';

const exe = 'D:\\한글 폴더\\Readable Studio.exe';
const desktop = 'C:\\Users\\홍길동\\OneDrive\\Desktop';
const start = 'C:\\Users\\홍길동\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

function fixture(existing?: { target: string; cwd: string }) {
  const write = vi.fn((_file: string, _operation: 'create', _options: { target: string; cwd?: string }) => true);
  const read = vi.fn((_file: string) => existing ?? { target: exe, cwd: path.dirname(exe) });
  const exists = vi.fn((_file: string) => Boolean(existing));
  return { write, read, exists, shell: { writeShortcutLink: write, readShortcutLink: read }, fs: { existsSync: exists, lstatSync: vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false, size: 0 })), openSync: vi.fn(() => 1), closeSync: vi.fn(), unlinkSync: vi.fn(), mkdirSync: vi.fn() } };
}

describe('portable shortcut', () => {
  it('uses the OS Programs folder even when Electron appData is redirected to a portable cache', () => {
    const getPath = vi.fn((name: string) => name === 'desktop' ? desktop : 'D:\\portable-cache');
    expect(resolveShortcutPaths(getPath, () => start)).toEqual({ desktop, startMenu: start });
    expect(getPath.mock.calls).toEqual([['desktop']]);
  });
  it('accepts CLIXML progress stderr from a successful hidden PowerShell known-folder query', () => {
    const run = vi.fn((_file: string, _args: string[], options: { encoding: 'utf8'; windowsHide: true; timeout: number }) => execFileSync(process.execPath, ['-e', `process.stderr.write('#< CLIXML\\n<Objs><Obj S="progress" /></Objs>'); process.stdout.write(${JSON.stringify(start + '\r\n')});`], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(resolveStartMenuPrograms(run)).toBe(start);
    expect(run).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']), expect.objectContaining({ windowsHide: true, encoding: 'utf8' }));
  });
  it('rejects a real nonzero PowerShell exit and an empty known-folder response', () => {
    const run = (_file: string, _args: string[], options: { encoding: 'utf8'; windowsHide: true; timeout: number }) => execFileSync(process.execPath, ['-e', "process.stderr.write('COM or known-folder failure'); process.exit(7)"], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(() => resolveStartMenuPrograms(run)).toThrow();
    expect(() => resolveStartMenuPrograms(() => '')).toThrow();
  });
  it('does not require PowerShell for a Desktop request', () => {
    const programs = vi.fn(() => { throw new Error('PowerShell unavailable'); });
    expect(resolveShortcutPaths(() => desktop, programs, 'desktop')).toEqual({ desktop, startMenu: '' });
    expect(programs).not.toHaveBeenCalled();
  });
  it('creates a missing Start-menu Programs directory before reserving the shortcut', () => {
    const f = fixture();
    expect(createShortcut('startMenu', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'created' });
    expect(f.fs.mkdirSync).toHaveBeenCalledWith(start, { recursive: true });
    expect(f.fs.mkdirSync.mock.invocationCallOrder[0]).toBeLessThan(f.fs.openSync.mock.invocationCallOrder[0]!);
  });
  it('reports and logs an unwritable Programs directory as a real failure', () => {
    const f = fixture();
    const error = Object.assign(new Error('read-only Programs'), { code: 'EACCES' });
    f.fs.mkdirSync.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(createShortcut('startMenu', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toEqual({ status: 'failed', location: 'startMenu', reason: 'failed' });
      expect(f.write).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('shortcut creation failed:', expect.objectContaining({ location: 'startMenu', file: path.join(start, 'Readable Studio.lnk'), error }));
    } finally { log.mockRestore(); }
  });
  it('does not offer a broken link from source mode', () => {
    const f = fixture();
    expect(shortcutCapabilities(false)).toMatchObject({ desktop: false, startMenu: false, taskbar: false, startPinned: false });
    expect(createShortcut('desktop', { packaged: false, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'unsupported' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('sets exe and cwd to the same portable data parent even with unicode and redirected desktop', () => {
    const f = fixture();
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'created' });
    expect(f.write).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'), 'create', expect.objectContaining({ target: exe, cwd: path.dirname(exe), icon: exe }));
    expect(path.join(f.write.mock.calls[0]![2]!.cwd!, 'ReadableStudioData')).toBe(path.join(path.dirname(exe), 'ReadableStudioData'));
  });
  it('targets the immutable top-level stub when Electron runs in app with the stub present', () => {
    const f = fixture();
    f.exists.mockImplementation((file) => file === exe);
    const payloadExe = path.join(path.dirname(exe), 'app', 'Readable Studio.exe');
    expect(createShortcut('desktop', { packaged: true, exe: payloadExe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'created' });
    expect(f.write).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'), 'create', expect.objectContaining({ target: exe, cwd: path.dirname(exe), icon: exe }));
  });
  it('targets the exe beside its data for a legacy folder named app without a stub', () => {
    const f = fixture();
    const payloadExe = path.join(path.dirname(exe), 'app', 'Readable Studio.exe');
    expect(createShortcut('desktop', { packaged: true, exe: payloadExe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'created' });
    expect(f.write).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'), 'create', expect.objectContaining({ target: payloadExe, cwd: path.dirname(payloadExe), icon: payloadExe }));
    expect(f.exists).toHaveBeenCalledWith(exe);
  });
  it('does not replace an unrelated shortcut and recognizes the same target and cwd', () => {
    const f = fixture({ target: exe, cwd: path.dirname(exe) });
    expect(createShortcut('startMenu', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'already-existed' });
    expect(f.write).not.toHaveBeenCalled();
    f.read.mockReturnValue({ target: 'C:\\Other.exe', cwd: desktop });
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'conflict' });
    expect(f.write).not.toHaveBeenCalled();
  });
  it('reserves the filename exclusively and never overwrites a concurrent unrelated link', () => {
    const f = fixture();
    f.fs.openSync.mockImplementation(() => { throw Object.assign(new Error('collision'), { code: 'EEXIST' }); });
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'conflict' });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.fs.openSync).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'), 'wx');
  });
  it('removes an empty reservation after a failed write', () => {
    const f = fixture();
    f.exists.mockReturnValueOnce(false).mockReturnValueOnce(true);
    f.write.mockReturnValue(false);
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'failed' });
    expect(f.fs.unlinkSync).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'));
  });
  it('reports write errors without claiming success', () => {
    const f = fixture();
    f.write.mockImplementation(() => { throw Object.assign(new Error('read-only'), { code: 'EACCES' }); });
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'failed' });
  });
});
