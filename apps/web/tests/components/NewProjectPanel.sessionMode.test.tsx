// @vitest-environment jsdom

/**
 * Session mode moved out of the Hub composer footer into the New Project flow,
 * which is where a project is actually created. These tests pin the capability
 * that used to be reachable only through the composer chip: creating an
 * Ask/chat-mode project through the UI.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NewProjectPanel } from '../../src/components/NewProjectPanel';
import type { CreateInput } from '../../src/components/NewProjectPanel';
import type { DesignSystemSummary, SkillSummary } from '../../src/types';

const skills: SkillSummary[] = [];
const designSystems: DesignSystemSummary[] = [];

// The panel measures its tab strip on mount; jsdom ships neither API.
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

type OnCreate = (input: CreateInput & { requestId?: string }) => void;

function renderPanel(onCreate: OnCreate) {
  return render(
    <NewProjectPanel
      skills={skills}
      designSystems={designSystems}
      defaultDesignSystemId={null}
      templates={[]}
      onCreate={onCreate}
    />,
  );
}

describe('New Project: session mode', () => {
  it('offers mode as a radio group, never a checkbox', () => {
    renderPanel(vi.fn<OnCreate>());

    const group = screen.getByTestId('newproj-mode-picker');
    expect(group.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    const design = screen.getByTestId('newproj-mode-design');
    const chat = screen.getByTestId('newproj-mode-chat');
    expect(design.getAttribute('role')).toBe('radio');
    expect(chat.getAttribute('role')).toBe('radio');
    // Design is the default selection.
    expect(design.getAttribute('aria-checked')).toBe('true');
    expect(chat.getAttribute('aria-checked')).toBe('false');
  });

  it('creates a chat-mode project when Ask is selected', () => {
    const onCreate = vi.fn<OnCreate>();
    renderPanel(onCreate);

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Ask mode project' },
    });
    fireEvent.click(screen.getByTestId('newproj-mode-chat'));
    expect(screen.getByTestId('newproj-mode-chat').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      name: 'Ask mode project',
      conversationMode: 'chat',
    });
  });

  it('keeps design as the default mode on the create payload', () => {
    const onCreate = vi.fn<OnCreate>();
    renderPanel(onCreate);

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Design mode project' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ conversationMode: 'design' });
  });
});
