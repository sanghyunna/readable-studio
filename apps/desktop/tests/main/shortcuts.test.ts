import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createShortcut, shortcutCapabilities } from '../../src/main/shortcuts.js';

const exe = 'D:\\한글 폴더\\Readable Studio.exe';
const desktop = 'C:\\Users\\홍길동\\OneDrive\\Desktop';
const start = 'C:\\Users\\홍길동\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';

function fixture(existing?: { target: string; cwd: string }) {
  const write = vi.fn((_file: string, _operation: 'create', _options: { target: string; cwd?: string }) => true);
  const read = vi.fn((_file: string) => existing ?? { target: exe, cwd: path.dirname(exe) });
  const exists = vi.fn((_file: string) => Boolean(existing));
  return { write, read, exists, shell: { writeShortcutLink: write, readShortcutLink: read }, fs: { existsSync: exists, lstatSync: vi.fn(() => ({ isFile: () => true, isSymbolicLink: () => false, size: 0 })), openSync: vi.fn(() => 1), closeSync: vi.fn(), unlinkSync: vi.fn() } };
}

describe('portable shortcut', () => {
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
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'write-failed' });
    expect(f.fs.unlinkSync).toHaveBeenCalledWith(path.join(desktop, 'Readable Studio.lnk'));
  });
  it('reports write errors without claiming success', () => {
    const f = fixture();
    f.write.mockImplementation(() => { throw Object.assign(new Error('read-only'), { code: 'EACCES' }); });
    expect(createShortcut('desktop', { packaged: true, exe, paths: { desktop, startMenu: start }, ...f })).toMatchObject({ status: 'failed', reason: 'EACCES' });
  });
});
