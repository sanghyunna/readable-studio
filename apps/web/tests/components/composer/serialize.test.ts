import { describe, expect, it } from 'vitest';
import { createEditor, $getRoot } from 'lexical';

import { MentionNode } from '../../../src/components/composer/MentionNode';
import { serializeComposer, type ComposerMentionSnapshot } from '../../../src/components/composer/serialize';
import { rebaseMentionSnapshot, setComposerFromSnapshot, setComposerFromText } from '../../../src/components/composer/deserialize';
import type { InlineMentionEntity } from '../../../src/utils/inlineMentions';

// Headless Lexical editor — no DOM required. `createEditor` runs purely in
// memory, so these specs stay in the default `node` test environment.
function makeEditor() {
  return createEditor({
    namespace: 'serialize-test',
    nodes: [MentionNode],
    onError(err) {
      throw err;
    },
  });
}

const FILE_ENTITY: InlineMentionEntity = {
  id: 'designs/landing.html',
  kind: 'file',
  label: 'designs/landing.html',
  token: '@designs/landing.html',
  title: 'File: designs/landing.html',
};

const MCP_ENTITY: InlineMentionEntity = {
  id: 'slack',
  kind: 'mcp',
  label: 'Slack MCP',
  token: '@Slack MCP',
  title: 'MCP: Slack MCP',
};

const SKILL_ENTITY: InlineMentionEntity = {
  id: 'deck-builder',
  kind: 'skill',
  label: 'Deck Builder',
  token: '@Deck Builder',
};

describe('serializeComposer / setComposerFromText round-trip', () => {
  it('keeps a plain prompt with no mentions byte-identical', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'hello world', []);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('hello world');
    expect(result.present).toHaveLength(0);
  });

  it('round-trips a known file mention as a single @token plus trailing text', () => {
    const editor = makeEditor();
    const text = 'Use @designs/landing.html now';
    setComposerFromText(editor, text, [FILE_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe(text);
    expect(result.present).toHaveLength(1);
    expect(result.present[0]?.id).toBe('designs/landing.html');
    expect(result.present[0]?.kind).toBe('file');
  });

  it('preserves a Shift+Enter newline as a single \\n (no \\n\\n gap)', () => {
    const editor = makeEditor();
    // The exact shape a Shift+Enter produces: one LineBreakNode inside the
    // single paragraph. It must serialize back to a single `\n`.
    const text = '@designs/landing.html hi\nworld';
    setComposerFromText(editor, text, [FILE_ENTITY]);
    expect(serializeComposer(editor.getEditorState()).text).toBe(text);
  });

  it('preserves multi-newline spacing around a mention (no \\n collapse)', () => {
    const editor = makeEditor();
    const text = 'Plan:\n\n@designs/landing.html \n\nKeep spacing';
    setComposerFromText(editor, text, [FILE_ENTITY]);
    expect(serializeComposer(editor.getEditorState()).text).toBe(text);
  });

  it('emits the MCP token text verbatim including the space inside the label', () => {
    const editor = makeEditor();
    setComposerFromText(editor, '@Slack MCP ', [MCP_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('@Slack MCP ');
    expect(result.present[0]?.id).toBe('slack');
    expect(result.present[0]?.kind).toBe('mcp');
  });

  it('round-trips a skill mention carrying its real id', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'Plan with @Deck Builder please', [SKILL_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('Plan with @Deck Builder please');
    expect(result.present).toHaveLength(1);
    expect(result.present[0]?.id).toBe('deck-builder');
    expect(result.present[0]?.kind).toBe('skill');
  });

  it('keeps unknown @tokens as plain text (not a MentionNode)', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'hi @nobody there', [FILE_ENTITY]);
    const result = serializeComposer(editor.getEditorState());
    expect(result.text).toBe('hi @nobody there');
    expect(result.present).toHaveLength(0);
  });

  it('builds a single root paragraph (no \\n\\n block join)', () => {
    const editor = makeEditor();
    setComposerFromText(editor, 'line one\nline two', []);
    editor.getEditorState().read(() => {
      expect($getRoot().getChildrenSize()).toBe(1);
    });
    expect(serializeComposer(editor.getEditorState()).text).toBe('line one\nline two');
  });
});

describe('committed mention occurrence snapshots', () => {
  it('reports UTF-16 offsets across emoji and line breaks', () => {
    const editor = makeEditor();
    const text = '🙂\n@Deck Builder\n@Slack MCP';
    setComposerFromText(editor, text, [SKILL_ENTITY, MCP_ENTITY]);

    expect(serializeComposer(editor.getEditorState())).toEqual({
      text,
      present: [SKILL_ENTITY, MCP_ENTITY],
      mentions: [
        { start: 3, end: 16, entity: SKILL_ENTITY },
        { start: 17, end: 27, entity: MCP_ENTITY },
      ],
    });
  });

  it('restores only the second occurrence when the identical first token was plain', () => {
    const editor = makeEditor();
    const snapshot: ComposerMentionSnapshot = {
      text: '@Deck Builder\n@Deck Builder',
      mentions: [{ start: 14, end: 27, entity: SKILL_ENTITY }],
    };
    setComposerFromSnapshot(editor, snapshot);

    expect(serializeComposer(editor.getEditorState())).toEqual({ ...snapshot, present: [SKILL_ENTITY] });
  });

  it('ignores stale, invalid and overlapping spans without consuming their text', () => {
    const editor = makeEditor();
    const text = '@Deck Builder @Slack MCP';
    setComposerFromSnapshot(editor, {
      text,
      mentions: [
        { start: -1, end: 12, entity: SKILL_ENTITY },
        { start: 0.5, end: 13, entity: SKILL_ENTITY },
        { start: 0, end: 13, entity: SKILL_ENTITY },
        { start: 0, end: 13, entity: SKILL_ENTITY },
        { start: 14, end: 24, entity: SKILL_ENTITY },
        { start: 14, end: 25, entity: MCP_ENTITY },
      ],
    });

    expect(serializeComposer(editor.getEditorState())).toEqual({
      text, present: [SKILL_ENTITY], mentions: [{ start: 0, end: 13, entity: SKILL_ENTITY }],
    });
  });

  it('preserves the committed occurrence when a plain duplicate is wrapped with other text', () => {
    const snapshot: ComposerMentionSnapshot = {
      text: '@Deck Builder @Deck Builder',
      mentions: [{ start: 14, end: 27, entity: SKILL_ENTITY }],
    };
    expect(rebaseMentionSnapshot(snapshot, '🙂 ' + snapshot.text + '\nnotes')).toEqual({
      text: '🙂 @Deck Builder @Deck Builder\nnotes',
      mentions: [{ start: 17, end: 30, entity: SKILL_ENTITY }],
    });
  });

  it('keeps an untouched binding when a replacement edits through another mention', () => {
    const snapshot: ComposerMentionSnapshot = {
      text: '@Deck Builder and @Slack MCP',
      mentions: [
        { start: 0, end: 13, entity: SKILL_ENTITY },
        { start: 18, end: 28, entity: MCP_ENTITY },
      ],
    };
    expect(rebaseMentionSnapshot(snapshot, 'Notes and @Slack MCP')).toEqual({
      text: 'Notes and @Slack MCP',
      mentions: [{ start: 10, end: 20, entity: MCP_ENTITY }],
    });
  });

  it('does not bind a new plain copy when duplicate insertion has no known direction', () => {
    const snapshot: ComposerMentionSnapshot = {
      text: '@Deck Builder',
      mentions: [{ start: 0, end: 13, entity: SKILL_ENTITY }],
    };
    expect(rebaseMentionSnapshot(snapshot, '@Deck Builder @Deck Builder')).toEqual({
      text: '@Deck Builder @Deck Builder', mentions: [],
    });
  });

  it('preserves other bindings when deleting a duplicate with unknown occurrence identity', () => {
    const snapshot: ComposerMentionSnapshot = {
      text: '@Slack MCP @Deck Builder @Deck Builder',
      mentions: [
        { start: 0, end: 10, entity: MCP_ENTITY },
        { start: 11, end: 24, entity: SKILL_ENTITY },
      ],
    };
    expect(rebaseMentionSnapshot(snapshot, '@Slack MCP @Deck Builder')).toEqual({
      text: '@Slack MCP @Deck Builder', mentions: [{ start: 0, end: 10, entity: MCP_ENTITY }],
    });
  });
});

describe('MentionNode atomic behaviour', () => {
  it('reports token text while remaining an inline atomic decorator', () => {
    const editor = makeEditor();
    setComposerFromText(editor, '@designs/landing.html', [FILE_ENTITY]);
    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild();
      const mention =
        para && 'getFirstChild' in para
          ? (para as unknown as { getFirstChild: () => unknown }).getFirstChild()
          : null;
      expect(mention).toBeInstanceOf(MentionNode);
      expect((mention as MentionNode).getTextContent()).toBe('@designs/landing.html');
      expect((mention as MentionNode).getToken()).toBe('@designs/landing.html');
      expect((mention as MentionNode).isInline()).toBe(true);
      expect((mention as MentionNode).isIsolated()).toBe(true);
    });
  });
});
