// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalViewer } from '../../src/components/workspace/TerminalViewer';
import { I18nProvider } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';

const terminalMockState = vi.hoisted(() => ({
  instances: [] as Array<{ options: { theme?: Record<string, string> } }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { theme?: Record<string, string> };

    constructor(options: { theme?: Record<string, string> }) {
      this.options = { theme: options.theme };
      terminalMockState.instances.push(this);
    }

    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('../../src/state/projects', () => ({
  createTerminal: vi.fn(),
  killTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  sendTerminalStdin: vi.fn(),
  terminalStreamUrl: vi.fn(
    (projectId: string, terminalId: string) =>
      `/api/projects/${projectId}/terminals/${terminalId}/stream`,
  ),
}));

class StubEventSource {
  static CLOSED = 2;

  readyState = 0;

  constructor(readonly url: string) {}

  addEventListener() {}

  close() {
    this.readyState = StubEventSource.CLOSED;
  }
}

beforeEach(() => {
  terminalMockState.instances.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('EventSource', StubEventSource);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-scheme');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('TerminalViewer', () => {
  it('shows localized loading copy while the initial terminal connection is pending', () => {
    render(
      <I18nProvider initial="en">
        <TerminalViewer
          terminalId="term-1"
          projectId="project-1"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    const loading = screen.getByTestId('terminal-loading');
    expect(loading.textContent).toContain(en['workspace.terminalStarting']);
    expect(loading.textContent).toContain(en['workspace.terminalStartingDescription']);
  });

  it('refreshes the xterm theme when data-theme-scheme changes', async () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => {
            const dark =
              document.documentElement.getAttribute('data-theme-scheme') === 'dark';
            const vars: Record<string, string> = dark
              ? {
                  '--terminal-fg': '#eeeeee',
                  '--terminal-bg': '#111111',
                }
              : {
                  '--terminal-fg': '#111111',
                  '--terminal-bg': '#ffffff',
                };
            return vars[name] ?? '';
          },
        }) as CSSStyleDeclaration,
    );

    render(
      <I18nProvider initial="en">
        <TerminalViewer
          terminalId="term-1"
          projectId="project-1"
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(terminalMockState.instances).toHaveLength(1));
    const terminal = terminalMockState.instances[0];
    if (!terminal) {
      throw new Error('Expected TerminalViewer to construct an xterm instance');
    }
    expect(terminal.options.theme?.foreground).toBe('#111111');
    expect(terminal.options.theme?.background).toBe('#ffffff');

    document.documentElement.setAttribute('data-theme-scheme', 'dark');

    await waitFor(() => {
      expect(terminal.options.theme?.foreground).toBe('#eeeeee');
      expect(terminal.options.theme?.background).toBe('#111111');
    });
  });
});
