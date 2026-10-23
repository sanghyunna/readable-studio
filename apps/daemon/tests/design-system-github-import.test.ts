import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  importGitHubDesignSystemProject,
  parseGitHubRepoUrl,
} from '../src/design-system-github-import.js';

describe('parseGitHubRepoUrl', () => {
  it('normalizes public GitHub repository URLs to clone URLs', () => {
    expect(parseGitHubRepoUrl('https://github.com/acme/design-system')).toEqual({
      owner: 'acme',
      repo: 'design-system',
      cloneUrl: 'https://github.com/acme/design-system.git',
    });
    expect(parseGitHubRepoUrl('https://github.com/acme/design-system.git')).toEqual({
      owner: 'acme',
      repo: 'design-system',
      cloneUrl: 'https://github.com/acme/design-system.git',
    });
  });

  it('rejects non-root or non-GitHub URLs', () => {
    expect(() => parseGitHubRepoUrl('https://example.com/acme/design-system')).toThrow(
      /github\.com/,
    );
    expect(() => parseGitHubRepoUrl('https://github.com/acme/design-system/tree/main')).toThrow(
      /repository root/,
    );
  });
});

describe('importGitHubDesignSystemProject', () => {
  let tempRoot: string;
  let fixtureRoot: string;
  let tmpRoot: string;
  let userDesignSystemsRoot: string;
  let commit: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'readable ds & github import-'));
    fixtureRoot = path.join(tempRoot, 'fixture-repo');
    tmpRoot = path.join(tempRoot, '.tmp');
    userDesignSystemsRoot = path.join(tempRoot, 'user-design-systems');
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'components'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'styles'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, 'package.json'),
      JSON.stringify({
        name: 'github-design-kit',
        description: 'A GitHub-hosted design kit.',
        dependencies: { react: '^18.0.0' },
      }),
    );
    fs.writeFileSync(path.join(fixtureRoot, 'README.md'), '# GitHub Design Kit\n\nRemote style source.\n');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'styles', 'tokens.css'), ':root { --primary: #22c55e; }');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'components', 'Card.tsx'), 'export function Card() {}');

    const gitConfig = path.join(tempRoot, 'gitconfig');
    const emptyTemplate = path.join(tempRoot, 'empty-template');
    fs.mkdirSync(emptyTemplate);
    fs.writeFileSync(gitConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
    // Use the real Windows Git executable while keeping clones local and config private.
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: fixtureRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '-b', 'main', `--template=${emptyTemplate}`]);
    git(['add', '.']);
    git(['-c', 'user.name=Readable Studio Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
    commit = git(['rev-parse', 'HEAD']);
    git(['branch', 'feature/tokens']);
    git(['config', '--file', gitConfig, `url.${pathToFileURL(fixtureRoot).href}.insteadOf`, 'https://github.com/acme/design-kit.git']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('clones a public GitHub URL and imports through the local project format', async () => {
    const result = await importGitHubDesignSystemProject(
      'https://github.com/acme/design-kit',
      tmpRoot,
      userDesignSystemsRoot,
      {
        now: new Date('2026-05-18T10:00:00.000Z'),
        importMode: 'normalized',
        craftApplies: ['color'],
      },
    );

    expect(result.id).toBe('github-design-kit');
    const cloneDir = path.join(tmpRoot, 'github-design-system-imports', 'acme-design-kit-20260518T100000000Z');
    expect(fs.readFileSync(path.join(cloneDir, '.git', 'shallow'), 'utf8').trim()).toBe(commit);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schemaVersion: 'readable.design-system-project/v1',
      id: 'github-design-kit',
      source: {
        type: 'github',
        url: 'https://github.com/acme/design-kit.git',
        branch: 'main',
        commit,
        importedAt: '2026-05-18T10:00:00.000Z',
      },
      files: {
        design: 'DESIGN.md',
        tokens: 'tokens.css',
        components: 'components.html',
      },
      usage: 'USAGE.md',
      componentsManifest: 'components.manifest.json',
      importMode: 'normalized',
      craft: {
        applies: ['color'],
      },
      sourceFiles: {
        scanned: 'source/scanned-files.json',
        evidence: 'source/evidence.md',
        tokens: 'source/tokens.source.json',
        report: 'source/token-contract.report.json',
        snippets: 'source/snippets/INDEX.json',
      },
    });
    expect(fs.readFileSync(path.join(result.dir, 'DESIGN.md'), 'utf8')).toContain(
      'A GitHub-hosted design kit.',
    );
    expect(fs.existsSync(path.join(result.dir, 'USAGE.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'components.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'token-contract.report.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'preview', 'app.html'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'source', 'snippets', 'card.tsx'))).toBe(true);
  });

  it('clones an explicitly requested branch with real Git', async () => {
    const result = await importGitHubDesignSystemProject(
      'https://github.com/acme/design-kit',
      tmpRoot,
      userDesignSystemsRoot,
      { branch: 'feature/tokens', importMode: 'normalized' },
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
    expect(manifest.source).toMatchObject({ branch: 'feature/tokens', commit });
  });

  it('reports clone errors and removes the failed checkout', async () => {
    await expect(importGitHubDesignSystemProject(
      'https://github.com/acme/design-kit',
      tmpRoot,
      userDesignSystemsRoot,
      { branch: 'missing-branch', now: new Date('2026-05-18T10:00:00.000Z') },
    )).rejects.toThrow(/could not import public GitHub repository:.*missing-branch/);

    expect(fs.existsSync(path.join(tmpRoot, 'github-design-system-imports', 'acme-design-kit-20260518T100000000Z'))).toBe(false);
    expect(fs.existsSync(userDesignSystemsRoot)).toBe(false);
  });
});
