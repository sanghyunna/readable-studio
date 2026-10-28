// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $createTextNode, $getRoot, $isElementNode, KEY_ARROW_DOWN_COMMAND, KEY_TAB_COMMAND, UNDO_COMMAND } from 'lexical';
import { createRef } from 'react';
import { ChatComposer, type ChatComposerHandle } from '../../src/components/ChatComposer';
import { composerText, flushMounts, getComposerEditor, pressEnter, typeAndSettle } from '../helpers/lexical-composer';

const skill = { id: 'deck-notes', name: 'Deck Notes', description: 'Prepare presentation notes.', triggers: ['deck'], mode: 'deck' as const, previewType: 'html', designSystemRequired: false, defaultFor: [], upstream: null, hasBody: true, examplePrompt: '', aggregatesExamples: false };
const template = { ...skill, id: 'slide-template', name: 'Slide Template' };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/plugins' ? { plugins: [] } : url === '/api/mcp/servers' ? { servers: [], templates: [] } : { project: { id: 'p', skillId: skill.id } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });
function setup() {
  const onSend = vi.fn();
  render(<ChatComposer projectId="p" projectFiles={[]} skills={[skill]} streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />);
  return onSend;
}
describe('Project mention preview confirmation', () => {
  it('previews a clicked skill without changing the draft or project', async () => {
    setup(); await typeAndSettle('@Deck');
    fireEvent.click(await screen.findByRole('option', { name: /Deck Notes/ }));
    await flushMounts();
    expect(composerText()).toBe('@Deck');
    expect(screen.getByTestId('mention-preview-detail').textContent).toContain(skill.description);
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/projects/p' && init?.method === 'PATCH')).toBe(false);
  });
  it('confirms a skill only for the current turn without patching the project default', async () => {
    const onSend = setup(); await typeAndSettle('@Deck');
    pressEnter(); await flushMounts();
    expect(composerText()).toContain('@Deck Notes');
    fireEvent.click(screen.getByTestId('chat-send'));
    await act(async () => {});
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds).toEqual([skill.id]);
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/projects/p' && init?.method === 'PATCH')).toBe(false);
  });
  it.each([skill, template])('retains the confirmed $name reference after a persisted draft remount', async (resource) => {
    const onSend = vi.fn();
    const composer = (catalogReady = true) => <ChatComposer projectId="p" projectFiles={[]} skills={catalogReady ? [skill, template] : []} designTemplates={catalogReady ? [template] : []} draftStorageKey={`readable:chat-composer:draft:p:${resource.id}`} streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />;
    const view = render(composer());
    await typeAndSettle(`Use @${resource.name}`);
    pressEnter();
    await flushMounts();
    expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-kind="skill"]')).toBeTruthy();
    view.unmount();
    const remounted = render(composer(false));
    await flushMounts();
    remounted.rerender(composer());
    await flushMounts();
    expect(composerText()).toContain(`@${resource.name}`);
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds).toEqual([resource.id]);
  });
  it('does not promote unconfirmed mention text to a reference after a persisted draft remount', async () => {
    const onSend = vi.fn();
    const composer = (catalogReady = true) => <ChatComposer projectId="p" projectFiles={[]} skills={catalogReady ? [skill] : []} draftStorageKey="readable:chat-composer:draft:p:plain" streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />;
    const view = render(composer());
    await typeAndSettle('Use @Deck Notes');
    view.unmount();
    const remounted = render(composer(false));
    await flushMounts();
    remounted.rerender(composer());
    await flushMounts();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
  });
  it('restores only the confirmed occurrence when an identical mention is also plain text', async () => {
    const onSend = vi.fn();
    const ref = createRef<ChatComposerHandle>();
    const composer = <ChatComposer ref={ref} projectId="p" projectFiles={[]} skills={[skill]} draftStorageKey="readable:chat-composer:draft:p:duplicate" streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />;
    const view = render(composer);
    await typeAndSettle('Use @Deck Notes');
    pressEnter();
    await flushMounts();
    act(() => getComposerEditor().update(() => {
      const paragraph = $getRoot().getLastChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const text = $createTextNode(' and @Deck Notes');
      paragraph.append(text);
      text.selectEnd();
    }, { discrete: true }));
    await flushMounts();
    act(() => { ref.current!.appendDraft('Keep notes'); });
    await flushMounts();
    view.unmount();
    render(composer);
    await flushMounts();
    expect(composerText()).toContain('Use @Deck Notes and @Deck Notes');
    expect(composerText()).toContain('Keep notes');
    expect(screen.getByTestId('chat-composer-input').querySelectorAll('[data-mention-kind="skill"]')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[0].split('@Deck Notes')).toHaveLength(3);
    expect(onSend.mock.calls[0]?.[3]?.skillIds).toEqual([skill.id]);
  });
  it('does not restore a binding undone while its identical plain text remains', async () => {
    const onSend = vi.fn();
    const composer = <ChatComposer projectId="p" projectFiles={[]} skills={[skill]} draftStorageKey="readable:chat-composer:draft:p:undo" streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />;
    const view = render(composer);
    await typeAndSettle('Use @Deck Notes');
    pressEnter();
    await flushMounts();
    expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-kind="skill"]')).toBeTruthy();
    act(() => { getComposerEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await flushMounts();
    expect(composerText()).toBe('Use @Deck Notes');
    expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-kind="skill"]')).toBeNull();
    view.unmount();
    render(composer);
    await flushMounts();
    expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-kind="skill"]')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
  });
  it('keeps a persisted reference plain when the skill was explicitly disabled before remount', async () => {
    const onSend = vi.fn();
    const composer = (disabled = false) => <ChatComposer projectId="p" projectFiles={[]} skills={[skill]} disabledSkillIds={disabled ? [skill.id] : []} draftStorageKey="readable:chat-composer:draft:p:disabled" streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />;
    const view = render(composer());
    await typeAndSettle('Use @Deck Notes');
    pressEnter();
    await flushMounts();
    expect(screen.getByTestId('chat-composer-input').querySelector('[data-mention-kind="skill"]')).toBeTruthy();
    view.unmount();
    render(composer(true));
    await flushMounts();
    expect(composerText()).toBe('Use @Deck Notes');
    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
  });
});

// jsdom does not route keydown into Lexical commands; dispatch them directly
// so the real KeyboardPlugin -> handlePopoverKey path runs.
function press(key: 'Enter' | 'Tab' | 'ArrowDown') {
  if (key === 'Enter') { pressEnter(); return; }
  act(() => { getComposerEditor().dispatchCommand(key === 'Tab' ? KEY_TAB_COMMAND : KEY_ARROW_DOWN_COMMAND, new KeyboardEvent('keydown', { key })); });
}

describe('Project mention picker keyboard default', () => {
  const second = { ...skill, id: 'pitch-outline', name: 'Pitch Outline', description: 'Outline a pitch.', triggers: ['pitch'] };
  function setupTwo() {
    const onSend = vi.fn();
    render(<ChatComposer projectId="p" projectFiles={[]} skills={[skill, second]} streaming={false} onEnsureProject={async () => 'p'} onSend={onSend} onStop={vi.fn()} />);
    return onSend;
  }
  const input = () => screen.getByTestId('chat-composer-input');

  it.each(['Enter', 'Tab'] as const)('bare @ + %s applies nothing and leaves no row active', async (key) => {
    const onSend = setupTwo(); await typeAndSettle('@');
    await screen.findByRole('option', { name: /Deck Notes/ });
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
    expect(screen.queryByTestId('mention-preview-use')).toBeNull();
    press(key); await flushMounts();
    expect(input().querySelector('[data-mention-kind]')).toBeNull();
    expect(screen.queryByTestId('mention-popover')).toBeNull();
    if (key === 'Enter') {
      // Enter falls through to the composer's normal send.
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0]?.[0]).toBe('@');
      expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
    } else {
      expect(composerText()).toBe('@');
      expect(onSend).not.toHaveBeenCalled();
    }
  });

  it.each(['Enter', 'Tab'] as const)('a whitespace-only "@ " query + %s applies nothing and leaves no row active', async (key) => {
    // The filter ignores whitespace, so "@ " still lists the whole catalogue.
    const onSend = setupTwo(); await typeAndSettle('@ ');
    await screen.findByRole('option', { name: /Deck Notes/ });
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
    press(key); await flushMounts();
    expect(input().querySelector('[data-mention-kind]')).toBeNull();
    expect(screen.queryByTestId('mention-popover')).toBeNull();
    if (key === 'Enter') {
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
    } else {
      expect(onSend).not.toHaveBeenCalled();
    }
  });

  it.each(['Enter', 'Tab'] as const)('bare @ + ArrowDown + %s applies the first row', async (key) => {
    const onSend = setupTwo(); await typeAndSettle('@');
    await screen.findByRole('option', { name: /Deck Notes/ });
    press('ArrowDown'); await flushMounts();
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe(skill.id);
    press(key); await flushMounts();
    expect(input().querySelector('[data-mention-kind="skill"]')?.getAttribute('data-mention-id')).toBe(skill.id);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a row that opens under a resting pointer stays unselected, so Enter applies nothing', async () => {
    const onSend = setupTwo(); await typeAndSettle('@');
    const row = await screen.findByRole('option', { name: /Deck Notes/ });
    // The browser re-hovers whatever lands under a still pointer: boundary events plus,
    // on some engines, a synthetic mousemove at the same coordinates.
    fireEvent.mouseEnter(row, { clientX: 40, clientY: 20 });
    fireEvent.mouseMove(row, { clientX: 40, clientY: 20 });
    fireEvent.mouseMove(row, { clientX: 40, clientY: 20 });
    await flushMounts();
    expect(screen.queryByRole('option', { selected: true })).toBeNull();
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    press('Enter'); await flushMounts();
    expect(input().querySelector('[data-mention-kind]')).toBeNull();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]?.[3]?.skillIds ?? []).toEqual([]);
  });

  it('a real pointer move highlights the row under it and Enter applies that row', async () => {
    const onSend = setupTwo(); await typeAndSettle('@');
    const row = await screen.findByRole('option', { name: /Pitch Outline/ });
    fireEvent.mouseMove(row, { clientX: 40, clientY: 60 });
    fireEvent.mouseMove(row, { clientX: 42, clientY: 61 });
    await flushMounts();
    expect(screen.getByTestId('mention-preview-detail').getAttribute('data-resource-id')).toBe(second.id);
    press('Enter'); await flushMounts();
    expect(input().querySelector('[data-mention-kind="skill"]')?.getAttribute('data-mention-id')).toBe(second.id);
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each(['Enter', 'Tab'] as const)('a typed filter + %s applies the first match', async (key) => {
    const onSend = setupTwo(); await typeAndSettle('@De');
    await screen.findByRole('option', { name: /Deck Notes/ });
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy();
    press(key); await flushMounts();
    expect(composerText()).toContain('@Deck Notes');
    expect(input().querySelector('[data-mention-kind="skill"]')?.getAttribute('data-mention-id')).toBe(skill.id);
    expect(onSend).not.toHaveBeenCalled();
  });
});
