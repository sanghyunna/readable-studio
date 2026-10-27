// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { loadComposerDraft, saveComposerDraft } from '../../src/utils/composer-draft-storage';
import type { ComposerMentionSnapshot } from '../../src/components/composer/serialize';

const key = 'readable:chat-composer:draft:p:conversation';
const confirmed: ComposerMentionSnapshot = {
  text: '@Deck Notes and @Deck Notes',
  mentions: [{ start: 0, end: 11, entity: { kind: 'skill', id: 'deck', label: 'Deck Notes', token: '@Deck Notes' } }],
};
afterEach(() => window.localStorage.clear());

describe('composer draft storage compatibility and provenance', () => {
  it('round-trips only the confirmed occurrence while retaining the legacy text value', () => {
    saveComposerDraft(key, confirmed);
    expect(window.localStorage.getItem(key)).toBe(confirmed.text);
    expect(loadComposerDraft(key)).toEqual(confirmed);
  });

  it('loads legacy plaintext without promoting matching names', () => {
    window.localStorage.setItem(key, confirmed.text);
    expect(loadComposerDraft(key)).toEqual({ text: confirmed.text, mentions: [] });
  });

  it.each([
    '{broken',
    JSON.stringify({ version: 2, ...confirmed }),
    JSON.stringify({ version: 1, ...confirmed, text: 'older text' }),
    JSON.stringify({ version: 1, ...confirmed, mentions: [{ ...confirmed.mentions[0], start: -1 }] }),
    JSON.stringify({ version: 1, ...confirmed, mentions: [{ ...confirmed.mentions[0], end: 10 }] }),
  ])('keeps text but rejects invalid or stale metadata: %s', raw => {
    window.localStorage.setItem(key, confirmed.text);
    window.localStorage.setItem(`${key}:mentions`, raw);
    expect(loadComposerDraft(key)).toEqual({ text: confirmed.text, mentions: [] });
  });

  it('removes prior bindings when Undo returns identical text without confirmation', () => {
    saveComposerDraft(key, confirmed);
    saveComposerDraft(key, { text: confirmed.text, mentions: [] });
    expect(window.localStorage.getItem(`${key}:mentions`)).toBeNull();
    expect(loadComposerDraft(key).mentions).toEqual([]);
  });

  it('does not serialize non-skill references or extra runtime fields', () => {
    const decorated = { ...confirmed.mentions[0]!, entity: { ...confirmed.mentions[0]!.entity, title: 'runtime-only-title', secret: 'do-not-store' } };
    saveComposerDraft(key, { text: confirmed.text, mentions: [decorated, { start: 16, end: 27, entity: { id: 'mcp', kind: 'mcp', label: 'Deck Notes' } }] });
    const stored = window.localStorage.getItem(`${key}:mentions`)!;
    expect(stored).not.toContain('runtime-only-title');
    expect(stored).not.toContain('do-not-store');
    expect(stored).not.toContain('mcp');
    expect(loadComposerDraft(key)).toEqual(confirmed);
  });

  it('clears both storage values after a sent draft', () => {
    saveComposerDraft(key, confirmed);
    saveComposerDraft(key, { text: '', mentions: [] });
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(`${key}:mentions`)).toBeNull();
  });
});
