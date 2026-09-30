import { describe, expect, it, vi } from 'vitest';
import { resolveHtmlExportSource } from '../src/html-export-source.js';
import { releasedFixture } from './width-release-fixture.js';

function input(html: string) {
  return {
    projectId: 'project-1', projectsRoot: 'unused', relPath: 'index.html', html, metadata: undefined,
    readProjectFile: vi.fn(async () => ({ buffer: Buffer.from('<p>Unrelated build</p>') })),
    resolveProjectFilePath: vi.fn(async () => ({ size: 24, mime: 'text/html' })),
  };
}

describe('width-release export source identity', () => {
  it('refuses Vite dist substitution for record-bearing source', async () => {
    const released = releasedFixture();
    await expect(resolveHtmlExportSource(input(`${released.source}<script type="module" src="/src/main.ts"></script>`)))
      .rejects.toMatchObject({ code: 'WIDTH_RELEASE_EXPORT_UNSUPPORTED' });
  });
  it('does not block ordinary Vite dist exports', async () => {
    expect(await resolveHtmlExportSource(input('<script type="module" src="/src/main.ts"></script>')))
      .toEqual({ html: '<p>Unrelated build</p>', relPath: 'dist/index.html' });
  });
  it('keeps saved static record-bearing source unchanged', async () => {
    const released = releasedFixture();
    const args = input(released.source);
    expect(await resolveHtmlExportSource(args)).toEqual({ html: released.source, relPath: 'index.html' });
    expect(args.readProjectFile).not.toHaveBeenCalled();
  });
});
