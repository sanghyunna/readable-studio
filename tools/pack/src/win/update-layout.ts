import { execFile } from 'node:child_process';
import { access, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const UPDATE_HELPER_FILES = ['update-broker.ps1', 'update-helper.ps1', 'common.ps1'] as const;
export const LAUNCHER_COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

export async function assertUpdateLayout(top: string): Promise<void> {
  for (const file of ['Readable Studio.exe', 'app/Readable Studio.exe', ...UPDATE_HELPER_FILES.map((name) => `app/resources/update-helper/${name}`)]) {
    await access(join(top, file));
  }
}

export async function prepareUpdateLayout(workspaceRoot: string, top: string): Promise<void> {
  const sourceRoot = join(workspaceRoot, 'apps', 'packaged', 'launcher');
  const helperRoot = join(top, 'app', 'resources', 'update-helper');
  await mkdir(helperRoot, { recursive: true });
  for (const name of UPDATE_HELPER_FILES) await cp(join(sourceRoot, name), join(helperRoot, name));
  await promisify(execFile)(LAUNCHER_COMPILER, ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/win32icon:${join(workspaceRoot, 'tools', 'pack', 'resources', 'win', 'icon.ico')}`, `/out:${join(top, 'Readable Studio.exe')}`, join(sourceRoot, 'ReadableStudioLauncher.cs')], { windowsHide: true, cwd: workspaceRoot });
  await assertUpdateLayout(top);
}
