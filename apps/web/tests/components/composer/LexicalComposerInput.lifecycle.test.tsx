// @vitest-environment jsdom

import { StrictMode, useLayoutEffect, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode, type LexicalEditor } from 'lexical';
import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
  type LexicalComposerInputProps,
} from '../../../src/components/composer/LexicalComposerInput';

const entity = { id: 'file.html', kind: 'file', label: 'file.html', token: '@file.html' } as const;
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
