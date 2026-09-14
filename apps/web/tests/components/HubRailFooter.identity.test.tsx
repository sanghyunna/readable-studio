// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HubRailFooter } from '../../src/components/hub/HubRailFooter';

afterEach(cleanup);

function renderFooter(username: string | null) {
  return render(
    <HubRailFooter
      username={username}
      onOpenDestination={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenWorkspaceFolder={vi.fn()}
      onThemeChange={vi.fn()}
    />,
  );
}

describe('HubRailFooter local runtime identity', () => {
  it('renders the supplied Windows username and derives its initials', () => {
    // Given: the daemon resolved the current Windows account.
    renderFooter('winuser');

    // When: the footer renders.
    const row = screen.getByTestId('hub-workspace-row');

    // Then: only the runtime identity is shown and abbreviated.
    expect(row.textContent).toContain('winuser');
    expect(row.querySelector('.hub__user-avatar')?.textContent).toBe('WI');
  });

  it('uses a neutral label when runtime identity is unavailable', () => {
    // Given: the daemon lookup is unavailable.
    renderFooter(null);

    // When: the footer renders.
    const row = screen.getByTestId('hub-workspace-row');

    // Then: the generic local-user label is used.
    expect(row.textContent).toContain('Local user');
  });

  it('keeps non-Latin initials intact', () => {
    // Given: a non-Latin Windows username.
    renderFooter('홍길동');

    // When: the footer renders.
    const avatar = screen.getByTestId('hub-workspace-row').querySelector('.hub__user-avatar');

    // Then: complete Unicode characters form the initials.
    expect(avatar?.textContent).toBe('홍길');
  });
});
