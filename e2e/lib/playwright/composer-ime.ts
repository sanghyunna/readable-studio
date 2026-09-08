import type { Locator, Page } from '@playwright/test';

interface ImeEvent {
  type: string;
  data: string | null;
  inputType: string | null;
  isComposing: boolean | null;
  key: string | null;
  isTrusted: boolean;
}

interface EditorNode {
  type: string;
  text?: string;
  children?: EditorNode[];
}

interface ImeHost extends HTMLElement {
  // Read-only observation: never set Lexical's composition key, dispatch its
  // commands, or replace DOM text. Chromium must drive the production pipeline.
  __lexicalEditor: {
    isComposing(): boolean;
    getEditorState(): { toJSON(): { root: EditorNode } };
  };
  __imeContract: { events: ImeEvent[]; dispose(): void };
}

/**
 * Chromium's Input.imeSetComposition / Input.insertText call its native
 * ImeSetComposition / ImeCommitText editing pipeline. No JS-dispatched events.
 * This does not exercise a physical Windows IME or its candidate window.
 */
export async function observeComposerIme(page: Page, input: Locator) {
  const cdp = await page.context().newCDPSession(page);
  await input.evaluate((element) => {
    const host = element as ImeHost;
    const events: ImeEvent[] = [];
    const types = ['compositionstart', 'compositionupdate', 'beforeinput', 'input', 'compositionend', 'keydown', 'keyup'];
    const record = (event: Event) => {
      events.push({
        type: event.type,
        data: event instanceof CompositionEvent || event instanceof InputEvent ? event.data : null,
        inputType: event instanceof InputEvent ? event.inputType : null,
        isComposing: event instanceof InputEvent || event instanceof KeyboardEvent ? event.isComposing : null,
        key: event instanceof KeyboardEvent ? event.key : null,
        isTrusted: event.isTrusted,
      });
    };
    // Capture input before Lexical stops its propagation. Install and acknowledge
    // the subscription before sending any CDP input; command replies follow the
    // synchronous native event dispatch and Lexical's committed update.
    for (const type of types) host.addEventListener(type, record, true);
    host.__imeContract = {
      events,
      dispose() {
        for (const type of types) host.removeEventListener(type, record, true);
      },
    };
  });

  return {
    async update(text: string) {
      await cdp.send('Input.imeSetComposition', {
        text, selectionStart: text.length, selectionEnd: text.length,
      });
    },
    async composingEnter() {
      // Protocol IME confirm key (VK_PROCESSKEY): raw keydown sends no newline.
      // The IME commit itself follows separately, just as the candidate service
      // commits after the keydown rather than sending a normal Enter character.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229,
      });
    },
    async commit(text: string) {
      // insertText commits the active native composition (not a second string).
      await cdp.send('Input.insertText', { text });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      });
    },
    async snapshot() {
      return input.evaluate((element) => {
        const host = element as ImeHost;
        const nodeText = (node: EditorNode): string => node.type === 'linebreak'
          ? '\n' : node.text ?? (node.children ?? []).map(nodeText).join('');
        const compositionEnd = host.__imeContract.events.filter((event) => event.type === 'compositionend');
        return {
          // Detect, never manufacture, the browser's trust capability. Blink's
          // InputMethodController::DispatchCompositionEndEvent uses
          // EventDispatcher::DispatchScopedEvent, bypassing the SetTrusted(true)
          // in EventTarget::DispatchEvent used for compositionstart/update.
          // null means no complete single-end lifecycle was observed yet.
          trustedCompositionEnd: compositionEnd.length === 1 ? compositionEnd[0]!.isTrusted : null,
          composing: host.__lexicalEditor.isComposing(),
          text: (host.__lexicalEditor.getEditorState().toJSON().root.children ?? []).map(nodeText).join('\n'),
          domText: host.textContent,
          events: host.__imeContract.events,
        };
      });
    },
    async dispose() {
      try {
        await input.evaluate((element) => (element as ImeHost).__imeContract.dispose());
      } finally {
        await cdp.detach();
      }
    },
  };
}
