import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHostedContentQuota,
  HOSTED_CONTENT_QUOTA_LIMITS,
} from '../src/hosted-content-quota.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `readable-hosted-quota-${name}-`));
  roots.push(root);
  return root;
}

describe('hosted content quota', () => {
  it('scans only exact regular files and pins the hosted workspace limits', async () => {
    const root = fixture('scan');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'a.txt'), '123');
    await writeFile(path.join(root, 'nested', 'b.txt'), '4567');

    expect(HOSTED_CONTENT_QUOTA_LIMITS).toEqual({
      bytesGlobal: 32 * 1024 * 1024 * 1024,
      bytesPerProject: 1024 * 1024 * 1024,
      filesPerProject: 10_000,
    });
    await expect(createHostedContentQuota().scanWorkspace(root)).resolves.toEqual({
      bytes: 7,
      files: 2,
    });
  });

  it('rejects symlink or junction trees instead of counting their targets', async () => {
    const root = fixture('links');
    const outside = fixture('outside');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'escape'), 'junction');

    await expect(createHostedContentQuota().scanWorkspace(root)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects project byte and file growth before the mutation callback runs', async () => {
    const root = fixture('project-limit');
    await writeFile(path.join(root, 'one.txt'), '12345678');
    await writeFile(path.join(root, 'two.txt'), '');
    const quota = createHostedContentQuota({
      bytesGlobal: 100,
      bytesPerProject: 10,
      filesPerProject: 2,
    });
    let mutations = 0;

    await expect(quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'write', path: 'three.txt', bytes: 1 },
      workspaceRoot: root,
    }, async () => { mutations += 1; })).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });
    await expect(quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'write', path: 'one.txt', bytes: 11 },
      workspaceRoot: root,
    }, async () => { mutations += 1; })).rejects.toMatchObject({
      code: 'HOSTED_QUOTA_EXCEEDED',
    });

    expect(mutations).toBe(0);
    await expect(readFile(path.join(root, 'one.txt'), 'utf8')).resolves.toBe('12345678');
  });

  it('serializes global reservations so concurrent growth cannot overcommit capacity', async () => {
    const a = fixture('global-a');
    const b = fixture('global-b');
    await writeFile(path.join(a, 'a.txt'), '12345678');
    await writeFile(path.join(b, 'b.txt'), '123456');
    const quota = createHostedContentQuota({
      bytesGlobal: 15,
      bytesPerProject: 10,
      filesPerProject: 10,
    });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let secondMutated = false;

    const first = quota.runMutation({
      allWorkspaceRoots: [a, b],
      operation: { kind: 'write', path: 'a.txt', bytes: 9 },
      workspaceRoot: a,
    }, async () => {
      firstEntered();
      await firstHeld;
      await writeFile(path.join(a, 'a.txt'), '123456789');
    });
    await firstStarted;
    const second = quota.runMutation({
      allWorkspaceRoots: [a, b],
      operation: { kind: 'write', path: 'new.txt', bytes: 1 },
      workspaceRoot: b,
    }, async () => {
      secondMutated = true;
      await writeFile(path.join(b, 'new.txt'), 'x');
    });
    await Promise.resolve();
    expect(secondMutated).toBe(false);

    releaseFirst();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'HOSTED_CAPACITY_EXHAUSTED' });
    expect(secondMutated).toBe(false);
  });

  it('ignores a non-target workspace retired while its mutation waits', async () => {
    const retired = fixture('retired');
    const target = fixture('retirement-target');
    const quota = createHostedContentQuota();
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = quota.runMutation({
      allWorkspaceRoots: [retired, target],
      operation: { kind: 'write', path: 'first.txt', bytes: 0 },
      workspaceRoot: target,
    }, async () => {
      firstEntered();
      await firstHeld;
    });
    await firstStarted;
    const second = quota.runMutation({
      allWorkspaceRoots: [retired, target],
      operation: { kind: 'write', path: 'second.txt', bytes: 1 },
      workspaceRoot: target,
    }, () => writeFile(path.join(target, 'second.txt'), 'x'));
    await rm(retired, { recursive: true });
    releaseFirst();

    await first;
    await expect(second).resolves.toBeUndefined();
    await expect(readFile(path.join(target, 'second.txt'), 'utf8')).resolves.toBe('x');
  });

  it('preflights rename, delete, and folder operations with canonical relative paths', async () => {
    const root = fixture('operations');
    await mkdir(path.join(root, 'folder'), { recursive: true });
    await writeFile(path.join(root, 'old.txt'), 'old');
    await writeFile(path.join(root, 'folder', 'nested.txt'), 'nested');
    const quota = createHostedContentQuota();

    await quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'rename', from: 'old.txt', to: 'new.txt' },
      workspaceRoot: root,
    }, () => rename(path.join(root, 'old.txt'), path.join(root, 'new.txt')));
    await quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'delete', path: 'new.txt' },
      workspaceRoot: root,
    }, () => rm(path.join(root, 'new.txt')));
    await quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'folder.delete', path: 'folder' },
      workspaceRoot: root,
    }, () => rm(path.join(root, 'folder'), { recursive: true }));
    await quota.runMutation({
      allWorkspaceRoots: [root],
      operation: { kind: 'folder.create', path: 'fresh' },
      workspaceRoot: root,
    }, () => mkdir(path.join(root, 'fresh')));

    await expect(quota.scanWorkspace(root)).resolves.toEqual({ bytes: 0, files: 0 });
    for (const unsafe of ['../outside', 'C:/outside', 'nested\\outside', 'nested/%2foutside']) {
      await expect(quota.runMutation({
        allWorkspaceRoots: [root],
        operation: { kind: 'delete', path: unsafe },
        workspaceRoot: root,
      }, async () => {})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});
