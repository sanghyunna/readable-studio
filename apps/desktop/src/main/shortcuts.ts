import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ShortcutCapabilities, ShortcutCreateResult, ShortcutLocation } from '@readable-studio/contracts';

type Link = { target: string; cwd?: string; icon?: string; iconIndex?: number; description?: string };
type Dependencies = {
  packaged: boolean;
  exe: string;
  paths: { desktop: string; startMenu: string };
  shell: { writeShortcutLink(file: string, operation: 'create', options: Link): boolean; readShortcutLink(file: string): Link };
  fs: { existsSync(file: string): boolean; lstatSync(file: string): { isFile(): boolean; isSymbolicLink(): boolean; size?: number }; openSync(file: string, flags: 'wx'): number; closeSync(fd: number): void; unlinkSync(file: string): void; mkdirSync(dir: string, options: { recursive: true }): unknown };
};

type RunPowerShell = (file: string, args: string[], options: { encoding: 'utf8'; windowsHide: true; timeout: number }) => string;

export function resolveStartMenuPrograms(run: RunPowerShell = execFileSync): string {
  // Ask Windows for the known folder: Electron appData is redirected in portable
  // mode, and APPDATA can be overridden or omit a redirected Start Menu.
  const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('Programs')";
  const programs = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  }).trim();
  // execFileSync rejects non-zero exits, not progress/informational stderr.
  if (!path.isAbsolute(programs)) throw new Error('Windows Programs known folder is unavailable');
  return programs;
}

export function resolveShortcutPaths(getPath: (name: 'desktop') => string, resolvePrograms = resolveStartMenuPrograms, location: ShortcutLocation = 'startMenu'): Dependencies['paths'] {
  return { desktop: getPath('desktop'), startMenu: location === 'startMenu' ? resolvePrograms() : '' };
}

export function shortcutCapabilities(packaged: boolean): ShortcutCapabilities {
  return { desktop: packaged, startMenu: packaged, taskbar: false, startPinned: false,
    ...(packaged ? {} : { reason: 'unsupported' as const }) };
}

export function createShortcut(location: ShortcutLocation, deps: Dependencies): ShortcutCreateResult {
  if (!deps.packaged || process.platform !== 'win32') {
    return { status: 'failed', location, reason: 'unsupported' };
  }
  const exeDir = path.dirname(deps.exe);
  // Target the immutable launcher only in the self-updating layout: an `app`
  // payload folder WITH the stub beside it. A legacy flat extraction may itself
  // be named `app`, and pointing above it would create a dangling shortcut.
  // Mirrors isPortableAppLayout in apps/packaged (apps may not import each other).
  const parent = path.dirname(exeDir);
  const launcher = path.join(parent, path.basename(deps.exe));
  const top = path.basename(exeDir).toLowerCase() === 'app' && deps.fs.existsSync(launcher) ? parent : exeDir;
  const target = path.join(top, path.basename(deps.exe));
  const file = path.join(deps.paths[location], 'Readable Studio.lnk');
  const failed = (reason: 'conflict' | 'failed', error: unknown): ShortcutCreateResult => {
    console.error('shortcut creation failed:', { location, file, reason, error });
    return { status: 'failed', location, reason };
  };
  try {
    if (location === 'startMenu') deps.fs.mkdirSync(deps.paths.startMenu, { recursive: true });
    if (deps.fs.existsSync(file)) {
      const stat = deps.fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return failed('conflict', 'Existing path is not a regular shortcut');
      let link: Link;
      try { link = deps.shell.readShortcutLink(file); }
      catch (error) { return failed('conflict', error); }
      const equal = (a: string, b: string) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
      return equal(link.target, target) && typeof link.cwd === 'string' && equal(link.cwd, top)
        ? { status: 'already-existed', location }
        : failed('conflict', { existing: link, target, cwd: top });
    }
    // Electron's `create` overwrites existing links. Reserve exclusively to close
    // the exists-check race before calling it; never replace an unrelated file.
    const fd = deps.fs.openSync(file, 'wx');
    deps.fs.closeSync(fd);
    let created = false;
    try {
      created = deps.shell.writeShortcutLink(file, 'create', {
        target, cwd: top, icon: target, iconIndex: 0, description: 'Readable Studio',
      });
    } finally {
      // Only remove our empty reservation; never remove a populated link.
      if (!created && deps.fs.existsSync(file) && deps.fs.lstatSync(file).size === 0) deps.fs.unlinkSync(file);
    }
    return created ? { status: 'created', location } : failed('failed', 'Electron writeShortcutLink returned false');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'write-failed';
    return failed(code === 'EEXIST' ? 'conflict' : 'failed', error);
  }
}
