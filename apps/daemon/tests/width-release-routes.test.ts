import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editWidthRelease } from '@readable-studio/html-edit';
import { startServer } from '../src/server.js';
import { releasedFixture } from './width-release-fixture.js';

const hash = (source: string) => createHash('sha256').update(source).digest('hex');

describe('project file width releases', () => {
  let server: Server;
  let base: string;
  const project = 'width-release-routes';
  let sequence = 0;
  const post = (body: unknown) => fetch(`${base}/api/projects/${project}/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const read = (name: string) => fetch(`${base}/api/projects/${project}/files/${name}`).then((response) => response.text());
  async function save(content: string) {
    const name = `pages/release-${sequence++}.html`;
    expect((await post({ name, content })).status).toBe(200);
    return name;
  }
  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: Server };
    base = started.url;
    server = started.server;
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: project, name: project, skipDiscoveryBrief: true }),
    });
    expect(response.status).toBe(200);
  });
  afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('inspects saved records and the exact source hash without changing bytes', async () => {
    const released = releasedFixture();
    const name = await save(released.source);
    const response = await fetch(`${base}/api/projects/${project}/files/${name}?widthRelease=inspect`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ name, contentSha256: hash(released.source), records: released.records });
    expect(await read(name)).toBe(released.source);
  });

  it('restores one through the guarded writer, retaining unrelated edits', async () => {
    const released = releasedFixture();
    const source = released.source.replace('color:red', 'color:blue').replace('>Text<', '>Edited<');
    const name = await save(source);
    const response = await post({ name, expectedContentSha256: hash(source), widthRelease: { kind: 'restore', target: { targetId: 'copy', releaseId: released.record!.id } } });
    expect(response.status).toBe(200);
    const expected = editWidthRelease(source, { kind: 'restore', target: { targetId: 'copy' } });
    expect(expected.ok).toBe(true);
    expect(await read(name)).toBe(expected.source);
    expect(await response.json()).toMatchObject({ file: { name }, widthRelease: { records: [], restoredTargetIds: ['copy'], contentSha256: hash(expected.source) } });
  });

  it('restores all records in one guarded transaction', async () => {
    const first = releasedFixture('<p data-readable-id="copy">One</p><p data-readable-id="other">Two</p>');
    const released = releasedFixture(first.source, 'other');
    const name = await save(released.source);
    const response = await post({ name, expectedContentSha256: hash(released.source), widthRelease: { kind: 'restore', all: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ widthRelease: { records: [], restoredTargetIds: ['copy', 'other'] } });
    expect(editWidthRelease(await read(name), { kind: 'inspect' })).toMatchObject({ ok: true, records: [] });
  });

  it.each([
    ['owned-declarations-changed', (source: string) => source.replace('width: min(720px, 100%);', 'width: 999px;')],
    ['target-missing', () => '<section>Deleted</section>'],
    ['target-identity-changed', (source: string) => source.replace('<p ', '<div ').replace('</p>', '</div>')],
    ['unsupported-schema', (source: string) => source.replace('readable.width-release.v1', 'readable.width-release.v2')],
  ] as const)('returns typed %s conflict and never writes', async (reason, change) => {
    const source = change(releasedFixture().source);
    const name = await save(source);
    const response = await post({ name, expectedContentSha256: hash(source), widthRelease: { kind: 'restore', target: { targetId: 'copy' } } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'WIDTH_RELEASE_CONFLICT', details: { code: 'WIDTH_RELEASE_CONFLICT', reason } } });
    expect(await read(name)).toBe(source);
  });

  it('does not partially restore all when a later record conflicts', async () => {
    const first = releasedFixture('<p data-readable-id="copy">One</p><p data-readable-id="other">Two</p>');
    const released = releasedFixture(first.source, 'other');
    const source = released.source.replace('>Two</p>', '>Changed</p>').replace(/width: min\(720px, 100%\);(?=[^>]*>Changed)/u, 'width: 999px;');
    const name = await save(source);
    const response = await post({ name, expectedContentSha256: hash(source), widthRelease: { kind: 'restore', all: true } });
    expect(response.status).toBe(409);
    expect(await read(name)).toBe(source);
  });

  it('refuses a stale hash and requires an explicit hash and target selector', async () => {
    const released = releasedFixture();
    const name = await save(released.source);
    const operation = { kind: 'restore', target: { targetId: 'copy' } };
    const response = await post({ name, expectedContentSha256: '0'.repeat(64), widthRelease: operation });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await post({ name, widthRelease: operation })).status).toBe(400);
    expect((await post({ name, expectedContentSha256: hash(released.source), widthRelease: { kind: 'restore' } })).status).toBe(400);
    expect((await post({ name, content: 'replacement', expectedContentSha256: hash(released.source), widthRelease: operation })).status).toBe(400);
    expect(await read(name)).toBe(released.source);
  });

  it('executes the real CLI inspect and restore against the live daemon', async () => {
    const released = releasedFixture();
    const name = await save(released.source);
    const invoke = (args: string[]) => promisify(execFile)(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'files', 'width-release', ...args, '--json', '--daemon-url', base,
    ], { windowsHide: true, timeout: 15_000 });
    const inspected = JSON.parse((await invoke(['inspect', project, name])).stdout);
    expect(inspected.records).toEqual(released.records);
    const restored = JSON.parse((await invoke(['restore', project, name, '--all', '--expected-content-sha256', inspected.contentSha256])).stdout);
    expect(restored.widthRelease.restoredTargetIds).toEqual(['copy']);
    expect(await read(name)).not.toContain('data-readable-width-release');
  });

  it('returns the unsupported-source error through both HTML export endpoints', async () => {
    const source = releasedFixture().source + '<script type="module" src="/src/main.ts"></script>';
    expect((await post({ name: 'vite/index.html', content: source })).status).toBe(200);
    expect((await post({ name: 'vite/dist/index.html', content: '<p>Unrelated build</p>' })).status).toBe(200);
    const responses = [
      await fetch(`${base}/api/exports/standalone-html`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { kind: 'project', projectId: project, filePath: 'vite/index.html' } }),
      }),
      await fetch(`${base}/api/projects/${project}/export/vite/index.html?inline=1`),
    ];
    for (const response of responses) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'WIDTH_RELEASE_EXPORT_UNSUPPORTED' } });
    }
  });

  it('preserves layered containment and important declarations in a seeded record', async () => {
    const released = releasedFixture();
    const record = released.record!;
    record.after = [
      { property: 'width', value: 'min(720px, 100%)', priority: 'important' },
      ...['100%', '-moz-available', 'stretch'].map((value) => ({ property: 'max-width', value, priority: '' as const })),
    ];
    const css = 'color:red; width: min(720px, 100%) !important; max-width: 100%; max-width: -moz-available; max-width: stretch;';
    const $ = load(released.source);
    $('[data-readable-id="copy"]').attr('style', css).attr('data-readable-width-release', JSON.stringify(record));
    const name = await save($.html());
    const response = await fetch(`${base}/api/exports/standalone-html`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId: project, filePath: name } }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const exported = load(html)('[data-readable-id="copy"]');
    expect(exported.attr('style')).toBe(css);
    expect(exported.attr('data-readable-width-release')).toBe(JSON.stringify(record));
    expect(editWidthRelease(html, { kind: 'inspect' })).toMatchObject({ ok: true, records: [record] });
    expect(editWidthRelease(html, { kind: 'restore', target: { targetId: 'copy' } }).ok).toBe(true);
  });

  it.each(['fragment', 'document'])('exports saved %s records and declarations intact and restores from the download alone', async (kind) => {
    const content = '<p data-readable-id="copy" style="max-width:30ch !important; color:red">Text</p>';
    const released = releasedFixture(kind === 'fragment' ? content : `<!doctype html><html><head></head><body>${content}</body></html>`);
    const name = await save(released.source);
    const response = await fetch(`${base}/api/exports/standalone-html`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'project', projectId: project, filePath: name } }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(editWidthRelease(html, { kind: 'inspect' })).toMatchObject({ ok: true, records: released.records });
    expect(html).toContain('width: min(720px, 100%); max-width: stretch;');
    const restored = editWidthRelease(html, { kind: 'restore', target: { targetId: 'copy' } });
    expect(restored.ok).toBe(true);
    expect(restored.source).toContain('max-width: 30ch !important;');
  });
});
