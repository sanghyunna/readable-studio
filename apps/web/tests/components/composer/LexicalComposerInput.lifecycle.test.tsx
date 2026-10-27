// @vitest-environment jsdom

import { StrictMode, useLayoutEffect, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode, UNDO_COMMAND, type LexicalEditor } from 'lexical';
import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
  type LexicalComposerInputProps,
} from '../../../src/components/composer/LexicalComposerInput';

const entity = { id: 'file.html', kind: 'file', label: 'file.html', token: '@file.html' } as const;
const skill = { id: 'deck-builder', kind: 'skill', label: 'Deck Builder', token: '@Deck Builder' } as const;
const draft = 'Use @file.html now';

function props(onChange: LexicalComposerInputProps['onChange']): LexicalComposerInputProps {
  return {
    placeholder: 'Message', knownEntities: [entity], onChange,
    onTrigger: vi.fn(), onEnterSend: vi.fn(), onPopoverKey: () => false, popoverOpen: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Subscribe before the action and await Lexical's actual committed update.
// Vitest's test timeout bounds a missing signal without polling or sleeps.
async function commit(editor: LexicalEditor, action: () => void) {
  const committed = deferred<void>();
  const unsubscribe = editor.registerUpdateListener(() => committed.resolve());
  try {
    act(action);
    await act(async () => {
      await committed.promise;
    });
  } finally {
    unsubscribe();
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LexicalComposerInput controlled seeding lifecycle', () => {
  it('seeds mention decorators once outside React lifecycle and preserves controlled typing and caret', async () => {
    // Pass-through spy: any regression still prints its real warning.
    const errors = vi.spyOn(console, 'error');
    const seeded = deferred<void>();
    const onChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const inputProps = props((text, present) => {
      onChange(text, present);
      seeded.resolve();
    });
    function Host() {
      const [value, setValue] = useState(draft);
      return <LexicalComposerInput {...inputProps} ref={ref} draft={value} onChange={(text, present) => {
        inputProps.onChange(text, present);
        setValue(text);
      }} />;
    }
    await act(async () => {
      render(<StrictMode><Host /></StrictMode>);
    });
    await seeded.promise;

    const host = document.querySelector<HTMLElement>('[data-testid="chat-composer-input"]')!;
    const editor = (host as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    expect(host.querySelector('.composer-inline-mention')?.textContent).toBe(entity.token);
    expect(onChange.mock.calls).toEqual([[draft, [entity]]]);
    expect(ref.current?.getText()).toBe(draft);
    expect(errors).not.toHaveBeenCalled();

    await commit(editor, () => editor.update(() => {
      const text = $getRoot().getFirstDescendant();
      expect($isTextNode(text)).toBe(true);
      if ($isTextNode(text)) text.select(2, 2);
    }, { discrete: true }));
    const beforeTyping = editor.getEditorState();
    expect(onChange).toHaveBeenCalledTimes(1);
    await commit(editor, () => ref.current!.insertText('!'));
    expect(onChange.mock.calls).toEqual([[draft, [entity]], ['Us!e @file.html now', [entity]]]);
    const afterTyping = editor.getEditorState();
    expect(afterTyping).not.toBe(beforeTyping);
    afterTyping.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect(selection.anchor.offset).toBe(3);
        expect(selection.anchor.getNode().getTextContent()).toBe('Us!e ');
      }
    });
    expect(editor.getEditorState()).toBe(afterTyping);
    expect(inputProps.onTrigger).toHaveBeenCalledTimes(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it('applies and clears external mention drafts with one change per commit', async () => {
    const errors = vi.spyOn(console, 'error');
    const onChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const inputProps = props(onChange);
    const view = render(<LexicalComposerInput {...inputProps} ref={ref} draft="" />);
    const host = view.getByTestId('chat-composer-input');
    const editor = (host as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    await commit(editor, () => view.rerender(<LexicalComposerInput {...inputProps} ref={ref} draft={draft} />));
    expect(ref.current?.getText()).toBe(draft);
    expect(host.querySelector('.composer-inline-mention')?.textContent).toBe(entity.token);
    await commit(editor, () => view.rerender(<LexicalComposerInput {...inputProps} ref={ref} draft="" />));
    expect(ref.current?.getText()).toBe('');
    expect(host.querySelector('.composer-inline-mention')).toBeNull();
    expect(onChange.mock.calls).toEqual([[draft, [entity]], ['', []]]);
    expect(inputProps.onTrigger).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('preserves confirmed mentions without committing a pending exact-name search on controlled reseed', async () => {
    const onChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    let setHostDraft!: (text: string) => void;
    function Host() {
      const [value, setValue] = useState('');
      setHostDraft = setValue;
      return <LexicalComposerInput {...props(onChange)} ref={ref} draft={value}
        knownEntities={[entity, skill]} committedMentionsOnly
        onChange={(text, present) => { onChange(text, present); setValue(text); }} />;
    }
    const view = render(<Host />);
    await act(async () => {});
    act(() => ref.current!.insertMention({ token: entity.token, entity }));
    act(() => ref.current!.insertText(' @Deck Builder'));
    expect(onChange.mock.calls.at(-1)).toEqual(['@file.html @Deck Builder', [entity]]);

    await act(async () => setHostDraft('Before @file.html @Deck Builder'));
    expect(onChange.mock.calls.at(-1)).toEqual(['Before @file.html @Deck Builder', [entity]]);

    await act(async () => setHostDraft('Before @Deck Builder'));
    expect(onChange.mock.calls.at(-1)).toEqual(['Before @Deck Builder', []]);
    expect(view.getByTestId('chat-composer-input').querySelector('[data-mention]')).toBeNull();
  });

  it('keeps initial catalog matches plain without explicit committed references', async () => {
    const onChange = vi.fn();
    const view = render(<LexicalComposerInput {...props(onChange)}
      knownEntities={[entity, skill]} committedMentionsOnly draft="@file.html @Deck Builder" />);
    await act(async () => {});

    expect(onChange.mock.calls.at(-1)).toEqual(['@file.html @Deck Builder', []]);
    expect(view.getByTestId('chat-composer-input').querySelector('[data-mention]')).toBeNull();
  });

  it('restores only explicit initial committed references while leaving another catalog match plain', async () => {
    const onChange = vi.fn();
    const view = render(<LexicalComposerInput {...props(onChange)}
      knownEntities={[entity, skill]} committedMentionsOnly initialCommittedEntities={[entity]}
      draft="@file.html @Deck Builder" />);
    await act(async () => {});

    expect(onChange.mock.calls.at(-1)).toEqual(['@file.html @Deck Builder', [entity]]);
    expect(view.getByTestId('chat-composer-input').querySelectorAll('[data-mention]')).toHaveLength(1);
  });

  it('uses explicit restore references for setText and preserves only live mentions on later rewrites', async () => {
    const onChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const view = render(<LexicalComposerInput {...props(onChange)} ref={ref}
      knownEntities={[entity, skill]} committedMentionsOnly draft="" />);
    await act(async () => {});

    act(() => ref.current!.setText('@file.html @Deck Builder', [entity]));
    expect(onChange.mock.calls.at(-1)).toEqual(['@file.html @Deck Builder', [entity]]);
    act(() => ref.current!.setText('Before @file.html @Deck Builder'));
    expect(onChange.mock.calls.at(-1)).toEqual(['Before @file.html @Deck Builder', [entity]]);

    act(() => ref.current!.setText('@Deck Builder', []));
    expect(onChange.mock.calls.at(-1)).toEqual(['@Deck Builder', []]);
    expect(view.getByTestId('chat-composer-input').querySelector('[data-mention]')).toBeNull();
  });

  it.each(['imperative', 'controlled'] as const)('preserves occurrence identity through %s prepend and append', async (rewrite) => {
    const onChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    let setHostDraft!: (text: string) => void;
    function Host() {
      const [value, setValue] = useState('');
      setHostDraft = setValue;
      return <LexicalComposerInput {...props(onChange)} ref={ref} draft={value} committedMentionsOnly
        onChange={(text, present) => { onChange(text, present); setValue(text); }} />;
    }
    const view = render(<Host />);
    await act(async () => {});
    act(() => ref.current!.insertMention({ token: entity.token, entity }));
    act(() => ref.current!.insertText(' @file.html'));
    const host = view.getByTestId('chat-composer-input');
    expect(host.querySelectorAll('[data-mention]')).toHaveLength(1);

    for (const next of ['Prefix @file.html @file.html', 'Prefix @file.html @file.html\nKeep notes']) {
      await act(async () => {
        if (rewrite === 'imperative') ref.current!.setText(next);
        else setHostDraft(next);
      });
      expect(ref.current!.getText()).toBe(next);
      expect(host.querySelectorAll('[data-mention]')).toHaveLength(1);
      expect(onChange.mock.calls.at(-1)).toEqual([next, [entity]]);
    }
  });

  it('restores an occurrence snapshot without promoting an identical plain query', async () => {
    const onChange = vi.fn();
    const onMentionSnapshotChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const inputProps = { ...props(onChange), committedMentionsOnly: true, onMentionSnapshotChange };
    const view = render(<LexicalComposerInput {...inputProps} ref={ref} draft="" />);
    await act(async () => {});
    act(() => ref.current!.insertMention({ token: entity.token, entity }));
    act(() => ref.current!.insertText(' @file.html'));
    const expected = {
      text: '@file.html @file.html',
      mentions: [{ start: 0, end: 10, entity }],
    };
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith(expected);
    view.unmount();

    const restored = render(<LexicalComposerInput {...inputProps}
      draft={expected.text} initialMentionSnapshot={expected} />);
    await act(async () => {});
    expect(restored.getByTestId('chat-composer-input').querySelectorAll('[data-mention]')).toHaveLength(1);
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith(expected);
  });

  it('reports occurrence changes when confirmation and undo leave the text unchanged', async () => {
    const onMentionSnapshotChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const view = render(<LexicalComposerInput {...props(vi.fn())} ref={ref} draft=""
      committedMentionsOnly onMentionSnapshotChange={onMentionSnapshotChange} />);
    await act(async () => {});
    act(() => ref.current!.insertText(entity.token));
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith({ text: entity.token, mentions: [] });
    act(() => ref.current!.insertMention({ token: entity.token, entity }));
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith({
      text: entity.token, mentions: [{ start: 0, end: 10, entity }],
    });
    const editor = (view.getByTestId('chat-composer-input') as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    await act(async () => editor.dispatchCommand(UNDO_COMMAND, undefined));
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith({ text: entity.token, mentions: [] });
  });

  it.each(['imperative', 'controlled'] as const)('clears only ambiguous bindings on %s text-only duplicate insertion', async (rewrite) => {
    const onChange = vi.fn();
    const onMentionSnapshotChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    let setHostDraft!: (text: string) => void;
    const initial = {
      text: '@file.html @Deck Builder',
      mentions: [{ start: 0, end: 10, entity }, { start: 11, end: 24, entity: skill }],
    };
    function Host() {
      const [value, setValue] = useState(initial.text);
      setHostDraft = setValue;
      return <LexicalComposerInput {...props(onChange)} ref={ref} draft={value} committedMentionsOnly
        initialMentionSnapshot={initial} onMentionSnapshotChange={onMentionSnapshotChange}
        onChange={(text, present) => { onChange(text, present); setValue(text); }} />;
    }
    const view = render(<Host />);
    await act(async () => {});
    const next = '@file.html @Deck Builder @Deck Builder';
    await act(async () => {
      if (rewrite === 'imperative') ref.current!.setText(next);
      else setHostDraft(next);
    });

    expect(ref.current!.getText()).toBe(next);
    expect(onChange.mock.calls.at(-1)).toEqual([next, [entity]]);
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith({
      text: next, mentions: [{ start: 0, end: 10, entity }],
    });
    expect(view.getByTestId('chat-composer-input').querySelectorAll('[data-mention]')).toHaveLength(1);
  });

  it.each(['append', 'prepend'] as const)('preserves the original occurrence when an explicit snapshot identifies duplicate %s intent', async (operation) => {
    const onMentionSnapshotChange = vi.fn();
    const ref = { current: null as LexicalComposerInputHandle | null };
    const view = render(<LexicalComposerInput {...props(vi.fn())} ref={ref} draft=""
      committedMentionsOnly onMentionSnapshotChange={onMentionSnapshotChange} />);
    await act(async () => {});
    act(() => ref.current!.insertMention({ token: entity.token, entity }));
    const start = operation === 'append' ? 0 : 11;
    const next = {
      text: '@file.html @file.html',
      mentions: [{ start, end: start + 10, entity }],
    };
    act(() => ref.current!.setText(next.text, next));

    expect(ref.current!.getText()).toBe(next.text);
    expect(onMentionSnapshotChange).toHaveBeenLastCalledWith(next);
    expect(view.getByTestId('chat-composer-input').querySelectorAll('[data-mention]')).toHaveLength(1);
  });

  it('cancels a seed when its editor unmounts before the scheduled commit', async () => {
    const errors = vi.spyOn(console, 'error');
    const onChange = vi.fn();
    const inputProps = props(onChange);
    function Host() {
      const [visible, setVisible] = useState(true);
      useLayoutEffect(() => setVisible(false), []);
      return visible ? <LexicalComposerInput {...inputProps} draft={draft} /> : null;
    }
    await act(async () => {
      render(<Host />);
    });
    expect(onChange).not.toHaveBeenCalled();
    // Lexical detaches its root with one selection-only commit; cancellation
    // must preserve that event, without adding a seed change after unmount.
    expect(vi.mocked(inputProps.onTrigger).mock.calls).toEqual([
      [{ mention: null, slash: null, anchorRect: null }],
    ]);
    expect(errors).not.toHaveBeenCalled();
  });
});
