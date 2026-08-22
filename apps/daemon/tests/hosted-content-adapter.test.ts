import { describe, expect, it } from 'vitest';
import {
  createHostedContentAdapter,
  HostedContentAdapterError,
  type HostedContentAuthority,
  type HostedContentMutationOperation,
  type HostedContentReadOperation,
} from '../src/hosted-content-adapter.js';

const AUTHORITY: HostedContentAuthority = Object.freeze({
  userKey: 'issuer:subject-a',
  generation: 7,
});

describe('hosted content adapter', () => {
  it('dispatches reads outside the mutation lane and mutations through it', async () => {
    const reads: HostedContentReadOperation[] = [];
    const mutations: HostedContentMutationOperation[] = [];
    const adapter = createHostedContentAdapter({
      async read(_authority, operation) {
        reads.push(operation);
        if (operation.kind === 'file.read') {
          return {
            buffer: Buffer.from('hello'),
            name: 'src/index.txt',
            path: 'src/index.txt',
            type: 'file',
            size: 5,
            mtime: 10,
            kind: 'text',
            mime: 'text/plain',
          };
        }
        if (operation.kind === 'files.list') return [];
        if (operation.kind === 'files.search') return [];
        return [];
      },
      async mutateInLane(_authority, operation) {
        mutations.push(operation);
        return { ok: true };
      },
    });

    await adapter.dispatch(AUTHORITY, {
      kind: 'file.read',
      projectId: 'project-1',
      path: 'src/index.txt',
    });
    await adapter.dispatch(AUTHORITY, {
      kind: 'file.delete',
      projectId: 'project-1',
      path: 'src/index.txt',
    });

    expect(reads).toEqual([{
      kind: 'file.read',
      projectId: 'project-1',
      path: 'src/index.txt',
    }]);
    expect(mutations).toEqual([{
      kind: 'file.delete',
      projectId: 'project-1',
      path: 'src/index.txt',
    }]);
  });

  it('decodes UTF-8 and canonical base64 file writes before entering the lane', async () => {
    const mutations: HostedContentMutationOperation[] = [];
    const adapter = createHostedContentAdapter({
      async read() { return []; },
      async mutateInLane(_authority, operation) {
        mutations.push(operation);
        return {
          file: {
            name: operation.kind === 'file.write' ? operation.body.name : 'unknown.txt',
            path: operation.kind === 'file.write' ? operation.body.name : 'unknown.txt',
            size: operation.kind === 'file.write' ? operation.body.content.length : 0,
            mtime: 1,
            kind: 'text',
            mime: 'text/plain',
          },
        };
      },
    });

    await adapter.dispatch(AUTHORITY, {
      kind: 'file.write',
      projectId: 'project-1',
      body: { name: 'notes/hello.txt', content: '안녕' },
    });
    await adapter.dispatch(AUTHORITY, {
      kind: 'file.write',
      projectId: 'project-1',
      body: {
        name: 'assets/pixel.bin',
        content: Buffer.from([0, 1, 2, 255]).toString('base64'),
        encoding: 'base64',
        overwrite: false,
        expectedContentSha256: 'A'.repeat(64),
      },
    });

    expect(mutations).toEqual([
      {
        kind: 'file.write',
        projectId: 'project-1',
        body: {
          name: 'notes/hello.txt',
          content: Buffer.from('안녕'),
          encoding: 'utf8',
          overwrite: true,
        },
      },
      {
        kind: 'file.write',
        projectId: 'project-1',
        body: {
          name: 'assets/pixel.bin',
          content: Buffer.from([0, 1, 2, 255]),
          encoding: 'base64',
          overwrite: false,
          expectedContentSha256: 'a'.repeat(64),
        },
      },
    ]);
  });

  it('validates and sanitizes list, search, folder, rename, and create responses', async () => {
    const adapter = createHostedContentAdapter({
      async read(_authority, operation) {
        if (operation.kind === 'files.list') return [{
          name: 'src/index.html', path: 'src/index.html', type: 'file', size: 12,
          mtime: 2, kind: 'html', mime: 'text/html', artifactKind: 'html',
          filePath: 'C:\\private\\project\\src\\index.html', root: '/private/project',
          artifactManifest: { metadata: { sourcePath: '/private/source' } },
        }];
        if (operation.kind === 'files.search') {
          return [{ file: 'src/index.html', line: 3, snippet: '<h1>Hello</h1>', sourcePath: '/private' }];
        }
        if (operation.kind === 'folders.list') {
          return [{ name: 'src', path: 'src', type: 'dir', size: 0, mtime: 3, absDir: '/private' }];
        }
        throw new Error('unexpected read');
      },
      async mutateInLane(_authority, operation) {
        if (operation.kind === 'file.rename') return {
          file: {
            name: operation.body.to, path: operation.body.to, size: 12, mtime: 4,
            kind: 'html', mime: 'text/html', source: '/private',
          },
          oldName: operation.body.from,
          newName: operation.body.to,
          absolutePath: '/private/new.html',
        };
        if (operation.kind === 'folder.create') return {
          folder: { name: operation.body.path, path: operation.body.path, type: 'dir', size: 0, mtime: 5 },
        };
        return { ok: true };
      },
    });

    expect(await adapter.dispatch(AUTHORITY, {
      kind: 'files.list', projectId: 'project-1', since: 0,
    })).toEqual({ files: [{
      name: 'src/index.html', path: 'src/index.html', type: 'file', size: 12,
      mtime: 2, kind: 'html', mime: 'text/html', artifactKind: 'html',
    }] });
    expect(await adapter.dispatch(AUTHORITY, {
      kind: 'files.search', projectId: 'project-1', q: 'Hello', pattern: '*.html', max: 10,
    })).toEqual({ query: 'Hello', matches: [{ file: 'src/index.html', line: 3, snippet: '<h1>Hello</h1>' }] });
    expect(await adapter.dispatch(AUTHORITY, {
      kind: 'folders.list', projectId: 'project-1',
    })).toEqual({ folders: [{ name: 'src', path: 'src', type: 'dir', size: 0, mtime: 3 }] });
    expect(await adapter.dispatch(AUTHORITY, {
      kind: 'file.rename', projectId: 'project-1', body: { from: 'old.html', to: 'new.html' },
    })).toEqual({
      file: { name: 'new.html', path: 'new.html', type: 'file', size: 12, mtime: 4, kind: 'html', mime: 'text/html' },
      oldName: 'old.html',
      newName: 'new.html',
    });
    expect(await adapter.dispatch(AUTHORITY, {
      kind: 'folder.create', projectId: 'project-1', body: { path: 'assets/images' },
    })).toEqual({ folder: { name: 'assets/images', path: 'assets/images', type: 'dir', size: 0, mtime: 5 } });
  });

  it.each([
    '../secret.txt',
    'src/../secret.txt',
    './src/index.html',
    '/absolute.txt',
    'C:/private.txt',
    'src\\index.html',
    'src//index.html',
    'src/%2fsecret.txt',
    'src/%5Csecret.txt',
    'src/%2e%2e/secret.txt',
    'src/%252fsecret.txt',
  ])('rejects non-canonical and encoded path %s before dispatch', async (path) => {
    let dispatched = false;
    const adapter = createHostedContentAdapter({
      async read() { dispatched = true; return []; },
      async mutateInLane() { dispatched = true; return { ok: true }; },
    });
    await expect(adapter.dispatch(AUTHORITY, {
      kind: 'file.delete', projectId: 'project-1', path,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dispatched).toBe(false);
  });

  it('rejects non-exact DTOs, malformed encodings, and decoded content above 3 MiB', async () => {
    const adapter = createHostedContentAdapter({
      async read() { return []; },
      async mutateInLane() { return { ok: true }; },
    });
    const invalid = [
      { kind: 'files.list', projectId: 'project-1', query: {} },
      { kind: 'files.search', projectId: 'project-1', q: '', max: 200 },
      { kind: 'folders.list', projectId: 'project-1', root: '/private' },
      { kind: 'folder.create', projectId: 'project-1', body: { path: 'src', owner: 'b' } },
      { kind: 'file.rename', projectId: 'project-1', body: { from: 'a', to: 'b', overwrite: true } },
      { kind: 'file.write', projectId: 'project-1', body: { name: 'x', content: '====', encoding: 'base64' } },
    ];
    for (const request of invalid) {
      await expect(adapter.dispatch(AUTHORITY, request)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(adapter.dispatch(AUTHORITY, {
      kind: 'file.write', projectId: 'project-1',
      body: {
        name: 'x',
        content: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64'),
        encoding: 'base64',
      },
    })).rejects.toMatchObject({ code: 'HOSTED_QUOTA_EXCEEDED' });
  });

  it('accepts a file write exactly at the 3 MiB decoded boundary', async () => {
    let written = -1;
    const adapter = createHostedContentAdapter({
      async read() { return []; },
      async mutateInLane(_authority, operation) {
        if (operation.kind !== 'file.write') throw new Error('unexpected mutation');
        written = operation.body.content.length;
        return {
          file: {
            name: operation.body.name, path: operation.body.name, size: written,
            mtime: 1, kind: 'binary', mime: 'application/octet-stream',
          },
        };
      },
    });
    const content = Buffer.alloc(3 * 1024 * 1024).toString('base64');
    await adapter.dispatch(AUTHORITY, {
      kind: 'file.write', projectId: 'project-1',
      body: { name: 'max.bin', content, encoding: 'base64' },
    });
    expect(written).toBe(3 * 1024 * 1024);
  });

  it('turns unsafe semantic responses into a typed internal error', async () => {
    const adapter = createHostedContentAdapter({
      async read() {
        return [{
          name: 'safe.txt', path: 'C:/private/safe.txt', size: 1, mtime: 1,
          kind: 'text', mime: 'text/plain',
        }];
      },
      async mutateInLane() { return { ok: true }; },
    });
    await expect(adapter.dispatch(AUTHORITY, {
      kind: 'files.list', projectId: 'project-1',
    })).rejects.toEqual(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
    expect(new HostedContentAdapterError('BAD_REQUEST', 'bad')).toMatchObject({
      name: 'HostedContentAdapterError', code: 'BAD_REQUEST',
    });
  });
});
