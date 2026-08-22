// @vitest-environment jsdom

import { act, cleanup, render, type RenderResult } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';
import { flushMounts, pressEnter, typeInComposer } from '../helpers/lexical-composer';

// The draft persist path was debounced off the typing hot path (it used to do a
// synchronous localStorage write per keystroke). These specs pin the contract
// that made that safe: writes coalesce, but every flush point (clear/send, key
// change, unmount, window hide) is eager, so durability matches the old
// per-keystroke write. None of these flush points were observable through the
// pre-existing jsdom suites — see refactor_ideas.md §9.2.

const DEBOUNCE_MS = 300;

let fetchMock: ReturnType<typeof vi.fn>;

function renderComposer(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
): RenderResult {
  return render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      skills={[]}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  cleanup();
});

// Mount + lazy-fetch/Lexical-attach settle happen on REAL timers (they lean on
// setTimeout(0) microtask draining that fake timers would stall). Only the
// debounce window itself is faked, installed after the editor is live. Faking
// just setTimeout/clearTimeout keeps Lexical's discrete-update microtask flush
// and RTL intact.
async function mountWithFakeDebounceTimers(
  overrides: Partial<ComponentProps<typeof ChatComposer>> = {},
): Promise<RenderResult> {
  const utils = renderComposer(overrides);
  await flushMounts();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return utils;
}

// Type `value`, then flush React's passive effects so the schedule effect has
// armed (or, for an empty draft, fired) its timer before we inspect storage.
// `await act(async)` drains the microtask queue; microtasks are not faked.
async function typeAndArm(value: string): Promise<void> {
  typeInComposer(value);
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ChatComposer draft persistence (debounced)', () => {
  it('coalesces rapid typing into a single trailing write after the debounce', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    await mountWithFakeDebounceTimers({ draftStorageKey: key });

    for (const value of ['h', 'he', 'hel', 'hell', 'hello']) {
      await typeAndArm(value);
    }

    // Still pending: nothing reaches storage mid-burst, and a partial advance
    // that does not cross the interval must not flush either.
    expect(window.localStorage.getItem(key)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    });
    expect(window.localStorage.getItem(key)).toBeNull();

    // Crossing the interval writes exactly the final text once.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(window.localStorage.getItem(key)).toBe('hello');
  });

  it('flushes the pending draft on unmount', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    const utils = await mountWithFakeDebounceTimers({ draftStorageKey: key });

    await typeAndArm('unsaved on unmount');
    expect(window.localStorage.getItem(key)).toBeNull(); // still debounced

    act(() => utils.unmount());

    // The cleanup-only effect flushes the pending write synchronously.
    expect(window.localStorage.getItem(key)).toBe('unsaved on unmount');
  });

  it('flushes the pending draft to the OLD key when draftStorageKey changes in place', async () => {
    const oldKey = 'readable:chat-composer:draft:project-1:conv-1';
    const newKey = 'readable:chat-composer:draft:project-1:conv-2';
    const utils = await mountWithFakeDebounceTimers({ draftStorageKey: oldKey });

    await typeAndArm('belongs to conv-1');
    expect(window.localStorage.getItem(oldKey)).toBeNull(); // still debounced

    // SideChatTab can swap the key without remounting ChatComposer. The pending
    // write carries its own key, so the cleanup flush lands on the PREVIOUS
    // conversation even though the schedule effect immediately re-points the
    // pending write at the new key.
    await act(async () => {
      utils.rerender(
        <ChatComposer
          projectId="project-1"
          projectFiles={[]}
          streaming={false}
          onEnsureProject={async () => 'project-1'}
          onSend={vi.fn()}
          onStop={vi.fn()}
          skills={[]}
          draftStorageKey={newKey}
        />,
      );
    });
    expect(window.localStorage.getItem(oldKey)).toBe('belongs to conv-1');

    // Preserved-not-fixed cross-key behavior (§9.2 item 3): the draft state
    // still holds the old text and is now scheduled under the NEW key, so once
    // the debounce elapses it also lands there. This is a pre-existing hazard
    // the refactor deliberately keeps; it is asserted here, not silently fixed.
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(window.localStorage.getItem(newKey)).toBe('belongs to conv-1');
  });

  it('does not resurrect a sent draft when a debounced write was still pending', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    const onSend = vi.fn();
    await mountWithFakeDebounceTimers({ draftStorageKey: key, onSend });

    await typeAndArm('send before the debounce fires');
    expect(window.localStorage.getItem(key)).toBeNull(); // pending, not yet flushed

    // Submitting runs reset() → draft '' → the schedule effect's immediate
    // empty-draft flush removes the key AND cancels the stale pending timer.
    act(() => pressEnter({ meta: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBeNull();

    // Advancing well past the interval must NOT bring the sent draft back.
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    });
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('removes the stored draft synchronously on submit — an unmount in the commit gap cannot resurrect it', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    const onSend = vi.fn();
    const utils = await mountWithFakeDebounceTimers({ draftStorageKey: key, onSend });

    await typeAndArm('sent then instantly closed');
    expect(window.localStorage.getItem(key)).toBeNull(); // pending, not yet flushed

    // Submit and unmount inside ONE act scope: the unmount cleanup flush runs
    // in the gap before the '' draft's empty-flush effect would have — exactly
    // where a stale pending {key, draft} used to get written back. reset()'s
    // imperative clear empties the pending entry synchronously inside the
    // submit handler, so the cleanup flush finds nothing to write.
    act(() => {
      pressEnter({ meta: true });
      utils.unmount();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    });
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('removes the stored draft synchronously on submit — a pagehide in the commit gap cannot resurrect it', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    const onSend = vi.fn();
    await mountWithFakeDebounceTimers({ draftStorageKey: key, onSend });

    await typeAndArm('sent then window closed');
    expect(window.localStorage.getItem(key)).toBeNull(); // pending, not yet flushed

    act(() => {
      pressEnter({ meta: true });
      // The user closes the packaged window right after hitting send. Probe
      // INSIDE the gap — after the listener flush, before React commits ''
      // and its empty-flush effect runs (which would mask a stale write).
      window.dispatchEvent(new Event('pagehide'));
      expect(window.localStorage.getItem(key)).toBeNull();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS * 4);
    });
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it('flushes the pending draft on pagehide', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    await mountWithFakeDebounceTimers({ draftStorageKey: key });

    await typeAndArm('open then close the window');
    expect(window.localStorage.getItem(key)).toBeNull(); // still debounced

    // The packaged window can close with a write pending and never unmount
    // React; pagehide flushes it.
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(window.localStorage.getItem(key)).toBe('open then close the window');
  });

  it('flushes the pending draft when the document is hidden (visibilitychange)', async () => {
    const key = 'readable:chat-composer:draft:project-1:conv-1';
    await mountWithFakeDebounceTimers({ draftStorageKey: key });

    await typeAndArm('background the tab');
    expect(window.localStorage.getItem(key)).toBeNull(); // still debounced

    const original = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(window.localStorage.getItem(key)).toBe('background the tab');
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
      else
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'visible',
        });
    }
  });
});
