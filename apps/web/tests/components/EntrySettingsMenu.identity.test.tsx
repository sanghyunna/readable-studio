// @vitest-environment jsdom
//
// The home topbar account control presents as an identity avatar. Its initials
// must come from the real runtime user boundary (`/api/runtime/user` ->
// `os.userInfo().username` -> `workspaceInitials`), never from a literal baked
// into a component or a stylesheet. Call sites with no user boundary (the
// in-project artifact header, ProjectView) keep the gear glyph.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntrySettingsMenu } from '../../src/components/EntrySettingsMenu';
import { I18nProvider } from '../../src/i18n';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

const config = {
  mode: 'daemon',
  agentId: null,
  agentModels: {},
  apiProtocol: 'anthropic',
  apiProtocolConfigs: {},
  apiKey: '',
  baseUrl: '',
  model: '',
  theme: 'system',
} as AppConfig;

function renderMenu(username?: string | null) {
  return render(
    <I18nProvider initial="en">
      <EntrySettingsMenu
        config={config}
        onThemeChange={vi.fn()}
        onOpenSettings={vi.fn()}
        username={username}
      />
    </I18nProvider>,
  );
}

function trigger(): HTMLElement {
  return screen.getByTestId('entry-settings-menu-trigger');
}

describe('EntrySettingsMenu identity trigger', () => {
  afterEach(cleanup);

  it('renders the runtime user initials as real text', () => {
    renderMenu('User');

    expect(trigger().textContent).toBe('US');
    expect(trigger().querySelector('svg')).toBeNull();
  });

  it('uses one letter per word for a multi-word runtime user', () => {
    renderMenu('Ada Lovelace');

    expect(trigger().textContent).toBe('AL');
  });

  it('keeps the gear when no runtime user is supplied (artifact header)', () => {
    renderMenu(undefined);

    expect(trigger().textContent).toBe('');
    expect(trigger().querySelector('svg')).not.toBeNull();
  });

  it('keeps the gear while the runtime user request is still unresolved', () => {
    renderMenu(null);

    expect(trigger().querySelector('svg')).not.toBeNull();
  });
});
