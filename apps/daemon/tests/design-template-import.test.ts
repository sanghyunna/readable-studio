import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/design-template-thumbnails.js', () => ({
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import { requestTemplateThumbnails } from '../src/design-template-thumbnails.js';
import {
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_INNER_ZIP_BYTES,
  BUNDLE_MAX_TEMPLATES,
  BUNDLE_MAX_TOTAL_BYTES,
  BUNDLE_MAX_TOTAL_FILES,
  DesignTemplateImportError,
  createDesignTemplateBundleBudget,
  importDesignTemplateZip,
  inspectDesignTemplateArchive,
  prepareDesignTemplateZip,
  readDesignTemplateBundleEntry,
  renameUserDesignTemplate,
  requireUserImportedTemplate,
  type DesignTemplateBundleEntry,
} from '../src/design-template-import.js';
import { findSkillById, invalidateSkillListCache, listSkills } from '../src/skills.js';
import { composeSystemPrompt } from '../src/prompts/system.js';
import {
  PNG_1PX,
  buildBundleZip,
  buildTemplateZip,
  buildZip,
  centralOffsets,
  cp949Name,
  kitTemplateEntries,
  validTemplateEntries,
  type ZipEntryInput,
} from './helpers/template-zip.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rs-user-templates-'));
  vi.mocked(requestTemplateThumbnails).mockClear();
});
afterEach(() => {
  invalidateSkillListCache();
  rmSync(root, { recursive: true, force: true });
});

const importZip = (entries: { name: string; body: string | Buffer }[], originalFileName = 'deck.zip') =>
  importDesignTemplateZip({ root, zip: buildTemplateZip(entries), originalFileName });

async function expectBadRequest(promise: Promise<unknown>, pattern: RegExp) {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(DesignTemplateImportError);
  expect((err as DesignTemplateImportError).status).toBe(400);
  expect((err as Error).message).toMatch(pattern);
}

describe('importDesignTemplateZip', () => {
  it('imports pages, assets, PROMPT.md with front matter and generates SKILL.md + import.json', async () => {
    const result = await importZip(validTemplateEntries());
    expect(result.id).toBe('user-quarterly-review');
    const dir = path.join(root, result.id);
    expect(readFileSync(path.join(dir, 'pages/assets/deck.css'), 'utf8')).toBe('h1{color:#123456}');
    expect(existsSync(path.join(dir, 'pages/assets/img/logo.svg'))).toBe(true);
    expect(existsSync(path.join(dir, 'pages/cover.html'))).toBe(true);
    expect(readFileSync(path.join(dir, 'PROMPT.md'), 'utf8')).toBe(validTemplateEntries()[0]!.body);

    const manifest = JSON.parse(readFileSync(path.join(dir, 'import.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'user-quarterly-review',
      name: 'Quarterly Review',
      originalFileName: 'deck.zip',
      cover: 'cover.html',
      pages: [
        { file: 'two-column.html', use: 'Comparison with two columns' },
        { file: 'cover.html', use: 'Title slide' },
      ],
      thumbnail: { status: 'pending', source: null },
    });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(requestTemplateThumbnails).toHaveBeenCalledWith({ templateDir: dir, id: 'user-quarterly-review' });

    const [template] = await listSkills([root]);
    expect(template).toMatchObject({
      id: 'user-quarterly-review',
      mode: 'deck',
      source: 'user',
      description: 'Clean quarterly business review deck',
      displayName: { en: 'Quarterly Review' },
    });
    const skillMd = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skillMd).toContain('hubType: deck');
    expect(skillMd).toContain('entry: "pages/cover.html"');
    expect(skillMd).toContain('userImported: true');
    expect(skillMd).toContain('user-imported deck template');
    expect(skillMd).toContain('`pages/cover.html` (cover) \u2014 Title slide');
    expect(skillMd).toContain('their example text is not factual input');
    expect(skillMd).toContain('PROMPT_BODY_MARKER_481');
    expect(skillMd).not.toContain('cover: cover.html');
  });

  it('accepts PROMPT.md without front matter: zip name and first html become name and cover', async () => {
    const entries = validTemplateEntries('Plain instructions PLAIN_PROMPT_77').map((e) => e);
    const result = await importZip(entries, 'My Sales Deck.zip');
    expect(result.id).toBe('user-my-sales-deck');
    expect(result.manifest).toMatchObject({ name: 'My Sales Deck', cover: 'two-column.html' });
    expect(result.manifest.pages).toEqual([{ file: 'two-column.html' }, { file: 'cover.html' }]);
    expect(readFileSync(path.join(result.dir, 'SKILL.md'), 'utf8')).toContain('Plain instructions PLAIN_PROMPT_77');
  });

  it('unwraps a zip whose contents sit in one top-level folder', async () => {
    const entries = validTemplateEntries().map((e) => ({ ...e, name: `wrapped/${e.name}` }));
    entries.push({ name: '__MACOSX/wrapped/._cover.html', body: 'junk' }, { name: 'wrapped/.DS_Store', body: 'junk' });
    const result = await importZip(entries);
    expect(existsSync(path.join(result.dir, 'pages/cover.html'))).toBe(true);
    expect(existsSync(path.join(result.dir, 'pages/assets/deck.css'))).toBe(true);
    expect(existsSync(path.join(result.dir, 'pages/.DS_Store'))).toBe(false);
  });

  it('uses a zip thumbnail.png as the ready cover thumbnail', async () => {
    const result = await importZip([...validTemplateEntries(), { name: 'thumbnail.png', body: PNG_1PX }]);
    expect(result.manifest.thumbnail).toMatchObject({ status: 'ready', source: 'zip' });
    expect(readFileSync(path.join(result.dir, 'thumbnails/cover.png')).equals(PNG_1PX)).toBe(true);
    expect(requestTemplateThumbnails).not.toHaveBeenCalled();
  });

  it('rejects a zip without PROMPT.md', async () => {
    await expectBadRequest(importZip(validTemplateEntries().slice(1)), /PROMPT\.md/);
  });

  it('rejects a zip without html pages', async () => {
    await expectBadRequest(importZip([{ name: 'PROMPT.md', body: 'x' }, { name: 'a.css', body: 'x' }]), /\.html/);
  });

  it.each(['../evil.html', '/abs/evil.html', 'C:/evil.html', 'pages/../../evil.html'])('rejects unsafe path %s', async (name) => {
    await expectBadRequest(importZip([...validTemplateEntries(), { name, body: 'x' }]), /unsafe zip path/);
    expect(existsSync(path.join(path.dirname(root), 'evil.html'))).toBe(false);
  });

  it('rejects disallowed extensions', async () => {
    await expectBadRequest(importZip([...validTemplateEntries(), { name: 'run.exe', body: 'MZ' }]), /not allowed.*run\.exe/);
  });

  it('appends -2 on id collision', async () => {
    const first = await importZip(validTemplateEntries());
    const second = await importZip(validTemplateEntries());
    expect(first.id).toBe('user-quarterly-review');
    expect(second.id).toBe('user-quarterly-review-2');
  });

  it('rename keeps the id and updates display name in SKILL.md and import.json', async () => {
    const { dir, manifest } = await importZip(validTemplateEntries());
    await renameUserDesignTemplate(dir, manifest, '  Board Update  ');
    invalidateSkillListCache();
    const [template] = await listSkills([root]);
    expect(template).toMatchObject({ id: manifest.id, displayName: { en: 'Board Update' } });
    expect(JSON.parse(readFileSync(path.join(dir, 'import.json'), 'utf8')).name).toBe('Board Update');
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('PROMPT_BODY_MARKER_481');
  });

  it('only resolves user-imported templates for mutation', async () => {
    await expect(requireUserImportedTemplate(root, 'blog-post', true)).rejects.toMatchObject({ status: 403 });
    await expect(requireUserImportedTemplate(root, 'nope', false)).rejects.toMatchObject({ status: 404 });
  });

  it('a run referencing the imported template composes the PROMPT.md body into the system prompt', async () => {
    const { id } = await importZip(validTemplateEntries());
    const template = findSkillById(await listSkills([root]), id)!;
    expect(template).toBeTruthy();
    const prompt = composeSystemPrompt({ skillBody: template.body, skillName: template.name });
    expect(prompt).toContain('PROMPT_BODY_MARKER_481: keep titles under 40 characters.');
    expect(prompt).toContain('their example text is not factual input');
    expect(prompt).toContain('`pages/two-column.html` \u2014 Comparison with two columns');
  });

  it('ignores Thumbs.db and desktop.ini like other junk', async () => {
    const result = await importZip([
      ...validTemplateEntries(),
      { name: 'Thumbs.db', body: 'junk' },
      { name: 'assets/DESKTOP.INI', body: 'junk' },
      { name: 'assets/img/thumbs.DB', body: 'junk' },
    ]);
    expect(existsSync(path.join(result.dir, 'pages/Thumbs.db'))).toBe(false);
    expect(existsSync(path.join(result.dir, 'pages/assets/DESKTOP.INI'))).toBe(false);
  });

  it('imports CP949-named pages under their Hangul names', async () => {
    const zip = buildZip([
      { name: 'PROMPT.md', body: 'Plain' },
      { name: cp949Name('\ud45c\uc9c0.html'), body: '<!doctype html><h1>Cover</h1>' },
    ]);
    const result = await importDesignTemplateZip({ root, zip, originalFileName: 'deck.zip' });
    expect(result.manifest.pages).toEqual([{ file: '\ud45c\uc9c0.html' }]);
    expect(existsSync(path.join(result.dir, 'pages', '\ud45c\uc9c0.html'))).toBe(true);
  });

  it.each([
    ['con.html', 'reserved Windows name'],
    ['page.html:stream', "':' is not allowed"],
    ['a./b.html', 'trailing dot or space'],
    ['a?.html', 'invalid character'],
    [`${'d'.repeat(100)}/${'e'.repeat(96)}.html`, 'path longer than 200 characters'],
  ])('rejects the Windows-unsafe path %s', async (name, reason) => {
    const err = await importZip([...validTemplateEntries(), { name, body: 'x' }]).then(() => null, (e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect((err as Error).message).toBe(`unsafe zip path: ${name} (${reason})`);
  });

  it('drops __MACOSX twins before the Windows length rules', async () => {
    const deep = `${'p'.repeat(100)}/${'q'.repeat(89)}.html`; // 195 chars; its twin is 206
    const wide = `${'s'.repeat(114)}.html`; // 119-char segment; its twin's is 121
    const result = await importZip([
      ...validTemplateEntries(),
      { name: deep, body: '<h1>deep</h1>' },
      { name: wide, body: '<h1>wide</h1>' },
      { name: `__MACOSX/${'p'.repeat(100)}/._${'q'.repeat(89)}.html`, body: 'junk' },
      { name: `__MACOSX/._${wide}`, body: 'junk' },
    ]);
    expect(existsSync(path.join(result.dir, 'pages', wide))).toBe(true);
    expect(existsSync(path.join(result.dir, 'pages', '__MACOSX'))).toBe(false);
  });

  it('rejects duplicate and case-colliding entries', async () => {
    await expectBadRequest(
      importZip([...validTemplateEntries(), { name: 'Cover.html', body: 'x' }]),
      /^zip contains duplicate or case-colliding entries: cover\.html and Cover\.html$/,
    );
  });

  it('rejects ZIP64 archives', async () => {
    const zip = buildTemplateZip(validTemplateEntries());
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    await expectBadRequest(importDesignTemplateZip({ root, zip, originalFileName: 'deck.zip' }), /^ZIP64 archives are not supported$/);
  });

  it('rejects a bundle zip on the one-shot path without writing anything', async () => {
    const zip = buildBundleZip([
      { name: 'a.zip', entries: validTemplateEntries() },
      { name: 'b.zip', entries: kitTemplateEntries() },
    ]);
    await expectBadRequest(
      importDesignTemplateZip({ root, zip, originalFileName: 'pack.zip' }),
      /^zip is a template bundle \(2 templates\); use the template upload wizard or "readable design-templates import <zip> --all"$/,
    );
    expect(await listSkills([root])).toEqual([]);
  });

  it('gives the bundle layout errors on the one-shot path too', async () => {
    const zip = buildZip([
      { name: 'a.zip', body: buildZip(validTemplateEntries()) },
      ...validTemplateEntries(),
    ]);
    await expectBadRequest(
      importDesignTemplateZip({ root, zip, originalFileName: 'mixed.zip' }),
      /^bundle zip mixes template zips with other files: PROMPT\.md, two-column\.html/,
    );
  });

  it('explains that folder-per-template archives are not supported', async () => {
    const entries = [
      ...validTemplateEntries().map((e) => ({ ...e, name: `pack/first/${e.name}` })),
      ...kitTemplateEntries().map((e) => ({ ...e, name: `pack/second/${e.name}` })),
    ];
    await expectBadRequest(
      importZip(entries),
      /^folder-per-template bundles are not supported; zip each template folder and put those zips in one bundle zip$/,
    );
  });

  it('keeps the plain PROMPT.md error for a single folder without one', async () => {
    const entries = validTemplateEntries().slice(1).map((e) => ({ ...e, name: `only/${e.name}` }));
    await expectBadRequest(importZip([...entries, { name: 'other/PROMPT.md', body: 'x' }]), /^template zip must contain PROMPT\.md at its root$/);
  });
});

describe('bundle archives', () => {
  const tpl = (name: string, entries: ZipEntryInput[] = validTemplateEntries()) => ({ name, entries });
  const inspectBad = (zip: Buffer) => {
    try {
      inspectDesignTemplateArchive(zip);
    } catch (err) {
      expect(err).toBeInstanceOf(DesignTemplateImportError);
      expect((err as DesignTemplateImportError).status).toBe(400);
      return (err as Error).message;
    }
    throw new Error('expected inspectDesignTemplateArchive to throw');
  };
  const bundleEntries = (zip: Buffer): DesignTemplateBundleEntry[] => {
    const layout = inspectDesignTemplateArchive(zip);
    if (layout.kind !== 'bundle') throw new Error(`expected a bundle, got ${layout.kind}`);
    return layout.entries;
  };

  it('exports the agreed limits', () => {
    expect({
      BUNDLE_MAX_TEMPLATES, BUNDLE_MAX_ENTRIES, BUNDLE_MAX_INNER_ZIP_BYTES, BUNDLE_MAX_TOTAL_BYTES, BUNDLE_MAX_TOTAL_FILES,
    }).toEqual({
      BUNDLE_MAX_TEMPLATES: 20,
      BUNDLE_MAX_ENTRIES: 200,
      BUNDLE_MAX_INNER_ZIP_BYTES: 50 * 1024 * 1024,
      BUNDLE_MAX_TOTAL_BYTES: 200 * 1024 * 1024,
      BUNDLE_MAX_TOTAL_FILES: 10_000,
    });
    expect(createDesignTemplateBundleBudget()).toEqual({ bytes: BUNDLE_MAX_TOTAL_BYTES, files: BUNDLE_MAX_TOTAL_FILES });
  });

  it('treats an archive without .zip entries as a single template', () => {
    expect(inspectDesignTemplateArchive(buildTemplateZip(validTemplateEntries()))).toEqual({ kind: 'single' });
  });

  it('lists inner zips in code-unit order with 0-based indexes', () => {
    const entries = bundleEntries(buildBundleZip([tpl('\uac00.zip'), tpl('a.zip'), tpl('B.zip')]));
    expect(entries.map(({ index, entryName }) => ({ index, entryName }))).toEqual([
      { index: 0, entryName: 'B.zip' },
      { index: 1, entryName: 'a.zip' },
      { index: 2, entryName: '\uac00.zip' },
    ]);
    expect(entries.every((e) => e.entry.name.endsWith('.zip'))).toBe(true);
  });

  it('strips one wrapping folder and ignores junk beside the zips', () => {
    const zip = buildBundleZip([tpl('a.zip'), tpl('b.ZIP')], {
      wrapper: 'pack',
      extra: [
        { name: '__MACOSX/pack/._a.zip', body: 'junk' },
        { name: 'pack/.DS_Store', body: 'junk' },
        { name: 'pack/Thumbs.db', body: 'junk' },
        { name: 'pack/desktop.ini', body: 'junk' },
        { name: 'pack/', body: '' },
      ],
    });
    expect(bundleEntries(zip).map((e) => e.entryName)).toEqual(['a.zip', 'b.ZIP']);
  });

  it('ignores the __MACOSX twin of a long inner zip name', () => {
    const name = `${'z'.repeat(115)}.zip`; // 119 chars; the twin's segment is 121
    const zip = buildBundleZip([tpl(name)], { extra: [{ name: `__MACOSX/._${name}`, body: 'junk' }] });
    expect(bundleEntries(zip).map((e) => e.entryName)).toEqual([name]);
  });

  it('sees a .zip name with a trailing backslash as a bundle entry', () => {
    const zip = buildZip([{ name: 'x.zip\\', body: buildZip(validTemplateEntries()) }]);
    expect(bundleEntries(zip).map((e) => e.entryName)).toEqual(['x.zip']);
  });

  it('decodes CP949 inner zip names', () => {
    const zip = buildZip([
      { name: cp949Name('\ubcf4\uace0\uc11c.zip'), body: buildZip(validTemplateEntries()) },
      { name: 'deck.zip', body: buildZip(validTemplateEntries()) },
    ]);
    expect(bundleEntries(zip).map((e) => e.entryName)).toEqual(['deck.zip', '\ubcf4\uace0\uc11c.zip']);
  });

  it('rejects zips mixed with loose files, listing at most 10 of them', () => {
    expect(inspectBad(buildBundleZip([tpl('a.zip')], { extra: [{ name: 'README.md', body: 'hi' }] })))
      .toBe('bundle zip mixes template zips with other files: README.md');
    const loose = Array.from({ length: 13 }, (_, i) => ({ name: `notes/n${String(i).padStart(2, '0')}.txt`, body: 'x' }));
    expect(inspectBad(buildBundleZip([tpl('a.zip')], { extra: loose }))).toBe(
      `bundle zip mixes template zips with other files: ${loose.slice(0, 10).map((l) => l.name).join(', ')}, \u2026 and 3 more`,
    );
  });

  it('applies the Windows and duplicate rules to outer zip names', () => {
    expect(inspectBad(buildBundleZip([tpl('A.zip'), tpl('a.zip')])))
      .toBe('zip contains duplicate or case-colliding entries: A.zip and a.zip');
    expect(inspectBad(buildBundleZip([tpl('con.zip')]))).toBe('unsafe zip path: con.zip (reserved Windows name)');
  });

  it('rejects template zips inside folders', () => {
    const zip = buildZip([
      { name: 'a.zip', body: buildZip(validTemplateEntries()) },
      { name: 'x/b.zip', body: buildZip(validTemplateEntries()) },
    ]);
    expect(inspectBad(zip)).toBe(
      'template zips inside folders are not supported; put each template zip at the top level of the bundle: x/b.zip',
    );
  });

  it('rejects more than 20 templates', () => {
    const zip = buildBundleZip(Array.from({ length: 21 }, (_, i) => tpl(`t${i}.zip`, [{ name: 'PROMPT.md', body: 'x' }])));
    expect(inspectBad(zip)).toBe('bundle contains 21 templates; the limit is 20');
    expect(bundleEntries(buildBundleZip(Array.from({ length: 20 }, (_, i) => tpl(`t${i}.zip`, [{ name: 'PROMPT.md', body: 'x' }]))))).toHaveLength(20);
  });

  it('rejects more than 200 central entries once a .zip is present, junk and folders included', () => {
    const junk = Array.from({ length: 200 }, (_, i) => ({ name: `.junk-${i}`, body: 'x' }));
    expect(inspectBad(buildBundleZip([tpl('a.zip')], { extra: junk }))).toBe('bundle archive has too many entries (201 > 200)');
    expect(bundleEntries(buildBundleZip([tpl('a.zip')], { extra: junk.slice(1) }))).toHaveLength(1);
    // The count runs before the mixed-files check, and directory entries count.
    const readme = [{ name: 'README.md', body: 'hi' }, ...junk.slice(1)];
    expect(inspectBad(buildBundleZip([tpl('a.zip')], { extra: readme }))).toBe('bundle archive has too many entries (201 > 200)');
    const folder = [...junk.slice(1), { name: 'pack/', body: '' }];
    expect(inspectBad(buildBundleZip([tpl('a.zip')], { extra: folder }))).toBe('bundle archive has too many entries (201 > 200)');
    // Without any .zip the single-template limits apply instead.
    const single = [...validTemplateEntries(), ...junk];
    expect(inspectDesignTemplateArchive(buildTemplateZip(single))).toEqual({ kind: 'single' });
  });

  it('reads stored and deflated inner zips byte for byte', () => {
    const inner = buildZip(validTemplateEntries());
    for (const method of [0, 8] as const) {
      const zip = buildBundleZip([tpl('a.zip')], { method });
      const [item] = bundleEntries(zip);
      expect(readDesignTemplateBundleEntry(zip, item!).equals(inner)).toBe(true);
    }
  });

  it('reads a 30 MiB inner zip, past the 25 MiB per-file default, with or without a declared size', () => {
    const size = 30 * 1024 * 1024;
    for (const declared of [true, false]) {
      const zip = buildZip([{ name: 'big.zip', body: Buffer.alloc(size) }]);
      if (!declared) zip.writeUInt32LE(0, centralOffsets(zip)[0]! + 24);
      expect(readDesignTemplateBundleEntry(zip, bundleEntries(zip)[0]!).length).toBe(size);
    }
  });

  it('fails an inner zip over 50 MiB by its declared size before inflating', () => {
    for (const field of [20, 24]) {
      const zip = buildBundleZip([tpl('a.zip')], { method: 0 });
      zip.writeUInt32LE(BUNDLE_MAX_INNER_ZIP_BYTES + 1, centralOffsets(zip)[0]! + field);
      const [item] = bundleEntries(zip);
      expect(() => readDesignTemplateBundleEntry(zip, item!)).toThrow(
        expect.objectContaining({ status: 400, message: 'template zip is larger than 50 MiB' }),
      );
    }
  });

  it('fails an inner zip that inflates past 50 MiB when its size is not declared', () => {
    const zip = buildZip([{ name: 'big.zip', body: Buffer.alloc(BUNDLE_MAX_INNER_ZIP_BYTES + 1) }]);
    zip.writeUInt32LE(0, centralOffsets(zip)[0]! + 24);
    const [item] = bundleEntries(zip);
    expect(() => readDesignTemplateBundleEntry(zip, item!)).toThrow(
      expect.objectContaining({ status: 400, message: 'template zip is larger than 50 MiB' }),
    );
  });

  it('fails an inner zip that inflates past its declared size', () => {
    const zip = buildBundleZip([tpl('a.zip')], { method: 8 });
    const field = centralOffsets(zip)[0]! + 24;
    zip.writeUInt32LE(zip.readUInt32LE(field) - 1, field);
    const [item] = bundleEntries(zip);
    expect(() => readDesignTemplateBundleEntry(zip, item!)).toThrow(
      expect.objectContaining({ status: 400, message: 'zip entry size mismatch: a.zip' }),
    );
  });

  it('rejects a zip inside an inner template as a nested bundle', () => {
    const inner = buildZip([...validTemplateEntries(), { name: 'more/inner.zip', body: buildZip(validTemplateEntries()) }]);
    expect(() => prepareDesignTemplateZip(inner, 'a.zip', { nested: true })).toThrow(
      expect.objectContaining({ status: 400, message: 'nested bundles are not supported' }),
    );
  });

  it('reports stats for non-junk files and their uncompressed bytes', () => {
    const entries = [...validTemplateEntries(), { name: '.DS_Store', body: 'junk' }, { name: 'Thumbs.db', body: 'junk' }];
    const prepared = prepareDesignTemplateZip(buildTemplateZip(entries), 'deck.zip');
    const bytes = validTemplateEntries().reduce((sum, e) => sum + Buffer.byteLength(e.body), 0);
    expect(prepared.stats).toEqual({ files: 5, bytes });
  });

  it('charges every inflated file to the shared budget, success or not, and fails everything after exhaustion', () => {
    const budget = { bytes: BUNDLE_MAX_TOTAL_BYTES, files: 12 };
    const ok = prepareDesignTemplateZip(buildTemplateZip(validTemplateEntries()), 'a.zip', { budget, nested: true });
    expect(budget).toEqual({ bytes: BUNDLE_MAX_TOTAL_BYTES - ok.stats.bytes, files: 7 });

    // Invalid template (no PROMPT.md): its 4 files and their bytes still count.
    const failing = validTemplateEntries().slice(1);
    expect(() => prepareDesignTemplateZip(buildTemplateZip(failing), 'b.zip', { budget, nested: true }))
      .toThrow(/PROMPT\.md/);
    const failingBytes = failing.reduce((sum, e) => sum + Buffer.byteLength(e.body), 0);
    expect(budget).toEqual({ bytes: BUNDLE_MAX_TOTAL_BYTES - ok.stats.bytes - failingBytes, files: 3 });

    const exhausted = /^bundle exceeds the combined limit of 200 MiB \/ 10,000 files$/;
    expect(() => prepareDesignTemplateZip(buildTemplateZip(validTemplateEntries()), 'c.zip', { budget, nested: true })).toThrow(exhausted);
    expect(budget.files).toBe(0);
    const tiny = [{ name: 'PROMPT.md', body: 'x' }, { name: 'a.html', body: '<h1>a</h1>' }];
    expect(() => prepareDesignTemplateZip(buildTemplateZip(tiny), 'd.zip', { budget, nested: true })).toThrow(exhausted);
  });

  it('fails once the combined bytes run out', () => {
    const budget = { bytes: 50, files: BUNDLE_MAX_TOTAL_FILES };
    expect(() => prepareDesignTemplateZip(buildTemplateZip(validTemplateEntries()), 'a.zip', { budget, nested: true }))
      .toThrow(/^bundle exceeds the combined limit/);
    expect(budget.bytes).toBeLessThan(0);
    const tiny = [{ name: 'PROMPT.md', body: '' }, { name: 'a.html', body: '' }];
    expect(() => prepareDesignTemplateZip(buildTemplateZip(tiny), 'b.zip', { budget, nested: true }))
      .toThrow(/^bundle exceeds the combined limit/);
  });

  it('gives a spent budget\'s reason before any other check, and skips the inner read', () => {
    const exhausted = expect.objectContaining({ status: 400, message: 'bundle exceeds the combined limit of 200 MiB / 10,000 files' });
    const unsafe = buildZip([{ name: 'con.html', body: 'x' }, ...validTemplateEntries()]);
    const nested = buildZip([{ name: 'x.zip', body: 'x' }, ...validTemplateEntries()]);
    const zip64 = buildZip(validTemplateEntries());
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 12);
    for (const inner of [unsafe, nested, zip64]) {
      for (const budget of [{ bytes: 0, files: 0 }, { bytes: -1, files: 5 }]) {
        expect(() => prepareDesignTemplateZip(inner, 'a.zip', { budget, nested: true })).toThrow(exhausted);
      }
    }

    // An oversized inner zip is not even inspected once the budget is spent.
    const outer = buildBundleZip([tpl('a.zip')], { method: 0 });
    outer.writeUInt32LE(BUNDLE_MAX_INNER_ZIP_BYTES + 1, centralOffsets(outer)[0]! + 24);
    const [item] = bundleEntries(outer);
    expect(() => readDesignTemplateBundleEntry(outer, item!, { bytes: 0, files: 0 })).toThrow(exhausted);
    // A live budget is only checked, never charged, by the outer read.
    const budget = createDesignTemplateBundleBudget();
    const ok = buildBundleZip([tpl('a.zip')]);
    readDesignTemplateBundleEntry(ok, bundleEntries(ok)[0]!, budget);
    expect(budget).toEqual(createDesignTemplateBundleBudget());
  });

  it('an inner ZIP64 template fails with the ZIP64 reason', () => {
    const inner = buildZip(validTemplateEntries());
    inner.writeUInt32LE(0xffffffff, inner.length - 22 + 12);
    expect(() => prepareDesignTemplateZip(inner, 'a.zip', { nested: true })).toThrow(
      expect.objectContaining({ status: 400, message: 'ZIP64 archives are not supported' }),
    );
  });
});
