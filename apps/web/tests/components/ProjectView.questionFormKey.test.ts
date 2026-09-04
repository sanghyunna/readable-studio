import { describe, expect, it } from 'vitest';

import {
  buildQuestionFormKey,
  mergeServerMessagesIntoConversation,
  parseBriefReceipt,
} from '../../src/components/ProjectView';
import type { ChatMessage, ProjectFile } from '../../src/types';

describe('buildQuestionFormKey', () => {
  it('is stable across a streaming form-id change (no remount mid-answer)', () => {
    // The streaming preview shows the `discovery` fallback id until the body id
    // streams in; a form that emits answerable questions before its id flips
    // the parsed id late. The React key must NOT change across that flip, or
    // the panel remounts and drops in-progress selections. Same conversation +
    // message ⇒ same key regardless of the parsed id.
    const early = buildQuestionFormKey('conv-1', 'msg-1', true);
    const settled = buildQuestionFormKey('conv-1', 'msg-1', true);
    expect(early).toBe('conv-1:msg-1');
    expect(settled).toBe(early);
  });

  it('gives a distinct key to a later form in a different assistant message', () => {
    // A second discovery form (same `discovery` template id) lives in its own
    // assistant message, so it still gets its own key and replays the reveal —
    // without folding the id into the key.
    expect(buildQuestionFormKey('conv-1', 'msg-1', true)).not.toBe(
      buildQuestionFormKey('conv-1', 'msg-2', true),
    );
  });

  it('returns null until a form, conversation, and message are all present', () => {
    expect(buildQuestionFormKey(null, 'msg-1', true)).toBeNull();
    expect(buildQuestionFormKey('conv-1', null, true)).toBeNull();
    expect(buildQuestionFormKey('conv-1', 'msg-1', false)).toBeNull();
  });
});

describe('parseBriefReceipt', () => {
  it('parses a complete receipt with all provenance values', () => {
    expect(parseBriefReceipt(`Working on it.\n<brief-receipt>{"assumptions":[
      {"id":"audience","label":"Audience","value":"buyers","provenance":"stated"},
      {"id":"tone","label":"Tone","value":["Modern minimal"],"provenance":"inferred"},
      {"id":"scale","label":"Scale","value":"8 slides","provenance":"default"}
    ]}</brief-receipt>`)).toEqual([
      { id: 'audience', label: 'Audience', value: 'buyers', provenance: 'stated' },
      { id: 'tone', label: 'Tone', value: ['Modern minimal'], provenance: 'inferred' },
      { id: 'scale', label: 'Scale', value: '8 slides', provenance: 'default' },
    ]);
  });

  it('returns the valid assumptions available from a streaming JSON prefix', () => {
    expect(parseBriefReceipt('<brief-receipt>{"assumptions":[{"id":"audience","label":"Audience","value":"buyers","provenance":"inferred"},'))
      .toEqual([{ id: 'audience', label: 'Audience', value: 'buyers', provenance: 'inferred' }]);
  });

  it('rejects malformed assumptions instead of persisting arbitrary metadata', () => {
    expect(parseBriefReceipt('<brief-receipt>{"assumptions":[{"id":"tone","label":"Tone","value":4,"provenance":"guessed"}]}</brief-receipt>'))
      .toBeNull();
  });
});

describe('mergeServerMessagesIntoConversation', () => {
  it('adds server-created CTA messages while preserving local produced files', () => {
    const producedFile: ProjectFile = {
      name: 'deck.html',
      size: 1024,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    const localMessages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Use this SKILL.md',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        runStatus: 'succeeded',
        producedFiles: [producedFile],
      },
    ];
    const serverMessages: ChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Use this SKILL.md',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        runStatus: 'succeeded',
      },
      {
        id: 'cta-1',
        role: 'assistant',
        content: '',
        events: [
          {
            kind: 'raw',
            line: 'cta',
          },
        ],
      },
    ];

    const merged = mergeServerMessagesIntoConversation(localMessages, serverMessages);

    expect(merged.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'cta-1']);
    expect(merged[1]?.producedFiles).toEqual([producedFile]);
  });
});
