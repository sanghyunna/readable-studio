import path from 'node:path';
import type { ShortcutCapabilities, ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';

type Link = { target: string; cwd?: string; icon?: string; iconIndex?: number; description?: string };
type Dependencies = {
  packaged: boolean;
  exe: string;
  paths: { desktop: string; startMenu: string };
  shell: { writeShortcutLink(file: string, operation: 'create', options: Link): boolean; readShortcutLink(file: string): Link };
  fs: { existsSync(file: string): boolean; lstatSync(file: string): { isFile(): boolean; isSymbolicLink(): boolean; size?: number }; openSync(file: string, flags: 'wx'): number; closeSync(fd: number): void; unlinkSync(file: string): void };
};

export function shortcutCapabilities(packaged: boolean): ShortcutCapabilities {
  return { desktop: packaged, startMenu: packaged, taskbar: false, startPinned: false,
    ...(packaged ? {} : { reason: 'unsupported' as const }) };
}

export function createShortcut(location: ShortcutLocation, deps: Dependencies): ShortcutCreateResult {
  if (!deps.packaged || process.platform !== 'win32') {
    return { status: 'failed', location, reason: 'unsupported' };
  }
  const file = path.join(deps.paths[location], 'Readable Studio.lnk');
  try {
    if (deps.fs.existsSync(file)) {
      const stat = deps.fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'failed', location, reason: 'conflict' };
      let link: Link;
      try { link = deps.shell.readShortcutLink(file); }
      catch { return { status: 'failed', location, reason: 'conflict' }; }
      const equal = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
      return equal(link.target, deps.exe) && typeof link.cwd === 'string' && equal(link.cwd, path.dirname(deps.exe))
        ? { status: 'already-existed', location }
        : { status: 'failed', location, reason: 'conflict' };
    }
    // Electron's `create` overwrites existing links. Reserve exclusively to close
    // the exists-check race before calling it; never replace an unrelated file.
    const fd = deps.fs.openSync(file, 'wx');
    deps.fs.closeSync(fd);
    let created = false;
    try {
      created = deps.shell.writeShortcutLink(file, 'create', {
        target: deps.exe, cwd: path.dirname(deps.exe), icon: deps.exe, iconIndex: 0, description: 'Readable Studio',
      });
    } finally {
      // Only remove our empty reservation; never remove a populated link.
      if (!created && deps.fs.existsSync(file) && deps.fs.lstatSync(file).size === 0) deps.fs.unlinkSync(file);
    }
    return created ? { status: 'created', location } : { status: 'failed', location, reason: 'write-failed' };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'write-failed';
    return { status: 'failed', location, reason: code === 'EEXIST' ? 'conflict' : code };
  }
}
