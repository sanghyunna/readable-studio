import { describe, expect, it } from 'vitest';
import {
  HostedCatalogueAdapterError,
  createHostedCatalogueAdapter,
} from '../src/hosted-catalogue-adapter.js';

function snapshot() {
  return {
    agents: [
      { id: 'pi', name: 'Pi', source: 'repository', bin: 'C:\\private\\pi.exe' },
      { id: 'local-agent', name: 'Local agent', source: 'local', path: '/home/user/bin' },
    ],
    skills: [
      {
        id: 'deck-maker',
        name: 'deck-maker',
        displayName: { en: 'Deck maker' },
        description: 'Creates decks without /frames/local-preview.html',
        descriptionI18n: { en: 'Creates decks' },
        triggers: ['deck', 'slides'],
        mode: 'deck',
        surface: 'web',
        platform: 'desktop',
        category: 'presentations',
        previewType: 'slides',
        designSystemRequired: false,
        defaultFor: ['deck'],
        featured: 1,
        fidelity: 'high-fidelity',
        speakerNotes: true,
        animations: false,
        craftRequires: ['visual-hierarchy'],
        examplePrompt: 'Build a deck; do not load /frames/deck.html',
        examplePromptI18n: { en: 'Build a deck' },
        aggregatesExamples: false,
        body: '# Deck\nUse /frames/deck.html and C:\\repo\\private\\seed.html.',
        source: 'built-in',
        dir: 'C:\\repo\\skills\\deck-maker',
        upstream: 'https://private.invalid/source',
        provenance: { sourcePath: '/home/user/skill' },
      },
      {
        id: 'user-skill',
        name: 'user-skill',
        description: 'Local only',
        triggers: [],
        mode: 'prototype',
        previewType: 'html',
        designSystemRequired: false,
        defaultFor: [],
        examplePrompt: '',
        aggregatesExamples: false,
        body: 'secret local body',
        source: 'user',
      },
      {
        id: 'deck-maker:derived',
        name: 'derived',
        description: 'Unsafe path id',
        triggers: [],
        mode: 'deck',
        previewType: 'slides',
        designSystemRequired: false,
        defaultFor: [],
        examplePrompt: '',
        aggregatesExamples: false,
        body: 'derived',
        source: 'built-in',
      },
    ],
    skillFiles: {
      'deck-maker': [
        { path: 'SKILL.md', kind: 'file', size: 100 },
        { path: 'assets', kind: 'directory', size: null },
        { path: 'assets/template.html', kind: 'file', size: 200 },
        { path: '../outside.txt', kind: 'file', size: 10 },
        { path: 'C:\\private\\secret.txt', kind: 'file', size: 10 },
      ],
      'user-skill': [{ path: 'secret.txt', kind: 'file', size: 1 }],
    },
    designSystems: [
      {
        id: 'calm-web',
        title: 'Calm Web',
        category: 'web',
        summary: 'A calm system with /frames/showcase.html removed.',
        swatches: ['#ffffff', '#111111'],
        surface: 'web',
        status: 'published',
        body: '# Calm\nNever load /frames/showcase.html.',
        source: 'built-in',
        isEditable: false,
        provenance: { localCodeFiles: ['C:\\repo\\secret.ts'] },
        packageInfo: { manifest: { source: { path: '/home/user/design-system' } } },
      },
      {
        id: 'user:private',
        title: 'Private',
        category: 'web',
        summary: 'Local only',
        swatches: [],
        surface: 'web',
        status: 'draft',
        body: 'private body',
        source: 'user',
        isEditable: true,
      },
    ],
  } as const;
}

describe('hosted catalogue adapter', () => {
  it('publishes only curated repository entries and strips local authority fields', () => {
    const adapter = createHostedCatalogueAdapter(snapshot());

    expect(adapter.dispatch({ kind: 'agents.list' })).toEqual({
      agents: [{ id: 'pi', name: 'Pi' }],
    });
    const skills = adapter.dispatch({ kind: 'skills.list' });
    expect(skills).toMatchObject({ skills: [{ id: 'deck-maker', hasBody: true }] });
    expect(JSON.stringify(skills)).not.toMatch(/user-skill|derived|source|upstream|dir|provenance|C:\\/u);
    const systems = adapter.dispatch({ kind: 'designSystems.list' });
    expect(systems).toEqual({
      designSystems: [{
        id: 'calm-web',
        title: 'Calm Web',
        category: 'web',
        summary: 'A calm system with # removed.',
        swatches: ['#ffffff', '#111111'],
        surface: 'web',
        status: 'published',
      }],
    });
    expect(JSON.stringify(systems)).not.toMatch(/isEditable|provenance|packageInfo|source|private/u);
  });

  it('returns bounded detail DTOs with local frame and absolute-path references scrubbed', () => {
    const adapter = createHostedCatalogueAdapter(snapshot());

    const skill = adapter.dispatch({ kind: 'skill.get', id: 'deck-maker' });
    expect(skill).toMatchObject({ skill: { id: 'deck-maker', body: '# Deck\nUse # and [path removed]' } });
    expect(JSON.stringify(skill)).not.toMatch(/\/frames|C:\\repo|source|dir|upstream/u);
    const designSystem = adapter.dispatch({ kind: 'designSystem.get', id: 'calm-web' });
    expect(designSystem).toEqual({
      designSystem: {
        id: 'calm-web',
        title: 'Calm Web',
        category: 'web',
        summary: 'A calm system with # removed.',
        swatches: ['#ffffff', '#111111'],
        surface: 'web',
        status: 'published',
        body: '# Calm\nNever load #',
      },
    });
    expect(Object.isFrozen(skill)).toBe(true);
    expect(Object.isFrozen((skill as { skill: unknown }).skill)).toBe(true);
  });

  it('exposes only canonical relative skill file metadata', () => {
    const adapter = createHostedCatalogueAdapter(snapshot());

    expect(adapter.dispatch({ kind: 'skill.files', id: 'deck-maker' })).toEqual({
      files: [
        { path: 'SKILL.md', kind: 'file', size: 100 },
        { path: 'assets', kind: 'directory', size: null },
        { path: 'assets/template.html', kind: 'file', size: 200 },
      ],
    });
  });

  it.each([
    { kind: 'agents.list', query: {} },
    { kind: 'skills.list', body: {} },
    { kind: 'designSystems.list', id: 'calm-web' },
    { kind: 'skill.get', id: '../deck-maker' },
    { kind: 'skill.files', id: 'deck-maker', query: {} },
    { kind: 'designSystem.get', id: '/calm-web' },
    { kind: 'designSystem.read', id: 'calm-web' },
  ])('rejects unsupported or non-exact request shape %#', (request) => {
    const adapter = createHostedCatalogueAdapter(snapshot());
    expect(() => adapter.dispatch(request)).toThrowError(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    );
  });

  it('uses exact ids and returns typed not-found errors', () => {
    const adapter = createHostedCatalogueAdapter(snapshot());
    expect(() => adapter.dispatch({ kind: 'skill.get', id: 'Deck-Maker' })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => adapter.dispatch({ kind: 'designSystem.get', id: 'missing' })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('fails closed when a repository snapshot exceeds a response bound', () => {
    const oversized = snapshot();
    const agents = Array.from({ length: 65 }, (_, index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      source: 'repository',
    }));
    expect(() => createHostedCatalogueAdapter({ ...oversized, agents })).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
  });

  it('uses a dedicated typed error without exposing snapshot values', () => {
    const error = new HostedCatalogueAdapterError('BAD_REQUEST', 'invalid request');
    expect(error).toMatchObject({ name: 'HostedCatalogueAdapterError', code: 'BAD_REQUEST' });
  });
});
