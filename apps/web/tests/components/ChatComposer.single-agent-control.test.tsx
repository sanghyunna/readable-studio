// @vitest-environment jsdom
//
// Defect: the workspace composer footer rendered TWO agent pickers.
// User: "워크스페이스의 좌측패널 하단 채팅창에 왜 에이전트 선택 창이 두개야?"
//
// ProjectView passes its legacy `AvatarMenu` agent picker down as
// `composerFooterAccessory`, and ChatComposer rendered it right beside the
// newer `executionSwitcher` agent button — two agent controls side by side.
// The switcher pair is the single source of agent + model selection, so the
// legacy accessory yields to it whenever the switcher is mounted.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from '../../src/components/ChatComposer';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => undefined, t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/state/mcp', () => ({ fetchMcpServers: async () => null }));
vi.mock('../../src/state/projects', () => ({
  listPlugins: async () => [],
  patchProject: async () => null,
}));
vi.mock('../../src/providers/registry', () => ({
  projectRawUrl: () => '',
  uploadProjectFiles: async () => ({ uploaded: [], failed: [] }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderComposer(extra: Record<string, unknown> = {}) {
  return render(
    <ChatComposer
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      {...extra}
    />,
  );
}

describe('workspace composer renders exactly ONE agent control', () => {
  it('suppresses the legacy footer accessory when the execution switcher is mounted', () => {
    renderComposer({
      footerAccessory: (
        <button type="button" data-testid="legacy-agent-picker">
          legacy agent
        </button>
      ),
      executionSwitcher: (
        <button type="button" data-testid="switcher-agent-trigger">
          agent
        </button>
      ),
    });

    // Exactly one agent control survives, and it is the switcher's.
    expect(screen.getByTestId('switcher-agent-trigger')).toBeTruthy();
    expect(screen.queryByTestId('legacy-agent-picker')).toBeNull();
  });

  it('still renders the accessory on surfaces with no execution wiring', () => {
    // Nothing is lost where the switcher is not mounted — the accessory is
    // that surface's only agent affordance.
    renderComposer({
      footerAccessory: (
        <button type="button" data-testid="legacy-agent-picker">
          legacy agent
        </button>
      ),
    });

    expect(screen.getByTestId('legacy-agent-picker')).toBeTruthy();
  });
});
