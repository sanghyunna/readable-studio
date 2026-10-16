import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databricksLoginProfile, databricksWorkspaceOrigin } from '../../src/databricks/client.js';

describe('login profile isolation', () => {
  it('preserves a different workspace in a real temporary databrickscfg', async () => {
    const root = await mkdtemp(join(tmpdir(), 'databricks-login-'));
    const path = join(root, '.databrickscfg');
    const original = '[DEFAULT]\nhost = https://old.example\ntoken = existing\n[readable-new.example]\nhost = https://third.example\n';
    try {
      await writeFile(path, original);
      expect(await databricksLoginProfile('https://new.example', 'DEFAULT', path)).toBe('readable-new.example-2');
      expect(await databricksLoginProfile('https://old.example', undefined, path)).toBe('DEFAULT');
      expect(await readFile(path, 'utf8')).toBe(original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['https://workspace.example:443', 'https://localhost:4443', 'https://user@workspace.example', 'https://workspace.example/path'])('rejects invalid workspace authority %s', host => {
    expect(() => databricksWorkspaceOrigin(host)).toThrow();
  });
  it('accepts private-link custom HTTPS workspace names', () => {
    expect(databricksWorkspaceOrigin('https://workspace.private.company')).toBe('https://workspace.private.company');
  });
});
