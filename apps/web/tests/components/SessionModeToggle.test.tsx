// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionModeToggle } from '../../src/components/SessionModeToggle';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { ko } from '../../src/i18n/locales/ko';

afterEach(() => cleanup());

function menuOption(name: string): HTMLElement {
  const option = screen
    .getAllByRole('menuitemradio', { hidden: true })
    .find((item) => item.getAttribute('aria-label') === name);
  if (!option) throw new Error(`Missing mode option: ${name}`);
  return option;
}

describe('SessionModeToggle', () => {
  it('shows only the active mode until the menu is opened', () => {
    render(<SessionModeToggle mode="design" onChange={vi.fn()} />);

    expect(screen.getByTestId('session-mode-trigger').textContent).toContain(en['chat.mode.design.label']);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTestId('session-mode-trigger'));

    expect(menuOption(en['chat.mode.design.title']).getAttribute('aria-checked')).toBe('true');
    expect(menuOption(en['chat.mode.chat.title']).getAttribute('aria-checked')).toBe('false');
  });

  it('switches mode from the menu', () => {
    const onChange = vi.fn();
    render(<SessionModeToggle mode="design" onChange={onChange} />);

    fireEvent.click(screen.getByTestId('session-mode-trigger'));
    fireEvent.click(menuOption(en['chat.mode.chat.title']));

    expect(onChange).toHaveBeenCalledWith('chat');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows localized guidance only after opening the menu', () => {
    render(
      <I18nProvider initial="ko">
        <SessionModeToggle mode="chat" onChange={vi.fn()} />
      </I18nProvider>,
    );

    const trigger = screen.getByTestId('session-mode-trigger');
    fireEvent.pointerEnter(trigger);

    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain(ko['chat.mode.chat.title']);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain(ko['chat.mode.chat.summary']);

    const designOption = menuOption(ko['chat.mode.design.title']);
    fireEvent.pointerEnter(designOption);

    const menu = screen.getByRole('menu', { hidden: true });
    const card = screen.getByRole('tooltip', { hidden: true });
    expect(menu.textContent).not.toContain(ko['chat.mode.design.summary']);
    expect(card.textContent).toContain(ko['chat.mode.design.summary']);
    expect(card.textContent).toContain(ko['chat.mode.design.solves']);
    expect(card.textContent).toContain(ko['chat.mode.design.query1']);
    expect(card.textContent).toContain(ko['chat.mode.design.query3']);
  });
});
