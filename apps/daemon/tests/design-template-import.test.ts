import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/design-template-thumbnails.js', () => ({
  requestTemplateThumbnails: vi.fn(async () => undefined),
}));

import { requestTemplateThumbnails } from '../src/design-template-thumbnails.js';
import {
  DesignTemplateImportError,
  importDesignTemplateZip,
  renameUserDesignTemplate,
  requireUserImportedTemplate,
} from '../src/design-template-import.js';
import { findSkillById, invalidateSkillListCache, listSkills } from '../src/skills.js';
import { composeSystemPrompt } from '../src/prompts/system.js';
import { PNG_1PX, buildTemplateZip, validTemplateEntries } from './helpers/template-zip.js';

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
});
