import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { codex, resolveAgentLaunch } from './helpers/test-helpers.js';

it('resolves the nested Codex npm bin layout without granting the global npm tree', () => {
  // Given: a Windows npm shim, not a symlink to the package entry point.
  const root = mkdtempSync(join(tmpdir(), 'codex-npm-layout-'));
  try {
    const shim = join(root, 'codex.cmd');
    const native = join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(shim, '@echo off\r\nnode "%~dp0/node_modules/@openai/codex/bin/codex.js" %*\r\n');
    writeFileSync(native, 'native fixture');
    // When: the daemon resolves its configured installed agent.
    const launch = resolveAgentLaunch(codex, { CODEX_BIN: shim });
    // Then: only native runtime assets need recursive ACL grants, not unrelated npm packages.
    expect(launch.launchPath).toBe(native);
    expect(launch.launchKind).toBe('codex-native');
    expect(launch.readExecutePaths).toEqual([dirname(native)]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
