import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { opencodeAgentDef, parseOpenCodeModels } from '../../src/runtimes/defs/opencode.js';
import { aiderAgentDef } from '../../src/runtimes/defs/aider.js';
import { fetchModels } from '../../src/runtimes/detection-model-fetch.js';

const liveIds = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/mimo-v2.5-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/north-mini-code-free',
];

test('OpenCode preserves the observed unauthenticated CLI catalogue and deduplicates rows', () => {
  expect(parseOpenCodeModels([...liveIds, liveIds[0]].join('\r\n'))?.map((m) => m.id))
    .toEqual(['default', ...liveIds]);
  expect(parseOpenCodeModels('custom/vendor/model:free')?.map((m) => m.id))
    .toEqual(['default', 'custom/vendor/model:free']);
});

test.each([
  '',
  'Authentication required. Please log in.\nhttps://example.invalid/docs/login\nDocumentation path with spaces/login.md',
  'Not logged in\ndocs/login.md',
  'https://example.invalid/docs/login',
  'Available models:\nPlease configure a provider first.',
])('OpenCode rejects non-catalogue stdout %#', (stdout) => {
  expect(parseOpenCodeModels(stdout)).toBeNull();
});

test('OpenCode discovery uses stdout only and returns no models on guidance or command failure', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'group-a-model-test-'));
  try {
    const runner = path.join(dir, 'fixture.ts');
    const bin = path.join(dir, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
    writeFileSync(bin, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${runner}' "$@"\n`);
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    for (const scenario of [
      { stdout: liveIds.join('\n'), stderr: 'Provider registry notice', code: 0, live: true },
      { stdout: 'Authentication required. Please log in.\nhttps://example.invalid/docs/login', stderr: '', code: 0, live: false },
      { stdout: '', stderr: liveIds.join('\n'), code: 0, live: false },
      { stdout: liveIds.join('\n'), stderr: 'Not logged in', code: 1, live: false },
    ]) {
      writeFileSync(runner, `process.stdout.write(${JSON.stringify(scenario.stdout)});process.stderr.write(${JSON.stringify(scenario.stderr)});process.exitCode=${scenario.code};`);
      const result = await fetchModels(opencodeAgentDef, bin, {
        SystemRoot: process.env.SystemRoot,
        PATH: path.dirname(process.execPath),
        HOME: dir,
        USERPROFILE: dir,
      });
      expect(result.source).toBe(scenario.live ? 'live' : 'fallback');
      expect(result.models.map((m) => m.id)).toEqual(scenario.live
        ? liveIds
        : []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Aider does not offer the retired Gemini 2.0 endpoint', () => {
  const ids = aiderAgentDef.fallbackModels.map((m) => m.id);
  expect(ids).not.toContain('gemini/gemini-2.0-flash');
  expect(ids).toContain('gemini/gemini-2.5-flash');
  expect(aiderAgentDef.buildArgs('', [], [], { model: 'gemini/gemini-2.5-flash' }))
    .toContain('gemini/gemini-2.5-flash');
});
