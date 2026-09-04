// @vitest-environment jsdom
//
// Screenshot + viewport-selector feature gating.
//
// Both capabilities ship OFF (`DEFAULT_FEATURE_FLAGS`). These tests pin three
// properties per capability:
//
//   1. Default OFF -> the control does not render.
//   2. Default OFF -> the handler is unreachable through EVERY entry point,
//      not merely the visible button. The non-vacuous proof is the alternate
//      path: we grab the handler via the rendered element while the flag is ON,
//      flip the flag OFF, and fire it again the way a shortcut / context-menu /
//      command-palette entry would. It must be inert.
//   3. Flag ON at runtime -> the control appears and works with no remount.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import { I18nProvider } from '../../src/i18n';
import type { ProjectFile } from '../../src/types';

const CONFIG_KEY = 'readable-studio:config';
const SNAPSHOT_DATA_URL = 'data:image/png;base64,c25hcHNob3Q=';

function writeFlags(flags: Record<string, boolean> | null): void {
  if (flags === null) {
    window.localStorage.removeItem(CONFIG_KEY);
    return;
  }
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ featureFlags: flags }));
}

/**
 * Flip a flag the way the Settings autosave does (localStorage write) and let
 * the mounted viewer observe it. `storage` does not fire in the writing tab, so
 * the same-tab path under test is the one production relies on: the
 * `useSyncExternalStore` snapshot is re-read on the next render, and window
 * focus forces that render for an otherwise idle viewer.
 */
async function toggleFlagsLive(flags: Record<string, boolean>): Promise<void> {
  await act(async () => {
    writeFlags(flags);
    window.dispatchEvent(new Event('focus'));
  });
}

function htmlPreviewFile(): ProjectFile {
  return {
    name: 'preview.html',
    path: 'preview.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      schema: 'readable-studio.artifact-manifest.v1',
      kind: 'html',
      title: 'Preview',
      entry: 'preview.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

/** Text of the portaled export toast, or null when no toast is mounted. */
function loadingToastText(): string | null {
  const toast = document.querySelector('.readable-toast');
  return toast ? (toast.textContent ?? '') : null;
}

function openViewportMenu(container: HTMLElement): void {
  const trigger = container.querySelector<HTMLButtonElement>('.viewer-viewport-trigger');
  if (!trigger) throw new Error('viewport trigger not rendered');
  fireEvent.click(trigger);
}

function renderViewer() {
  return render(
    <I18nProvider initial="en">
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml='<html><body><main data-readable-id="hero">Hero</main></body></html>'
      />
    </I18nProvider>,
  );
}

let writeTextMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: writeTextMock,
      write: vi.fn().mockResolvedValue(undefined),
    },
  });
  // Snapshot capture goes through the host bridge in the real app; stub the
  // iframe postMessage round-trip so the handler resolves deterministically.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response('<html><body>preview</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  ));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  window.localStorage.clear();
});

describe('FileViewer feature gating — defaults', () => {
  it('hides both controls when no featureFlags block is stored at all', async () => {
    writeFlags(null);
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Screenshot' })).toBeNull();
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();
  });

  it('hides both controls for an explicit both-off config', async () => {
    writeFlags({ previewScreenshot: false, previewViewportSelector: false });
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();
  });

  it('treats a non-boolean stored value as OFF', async () => {
    window.localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ featureFlags: { previewScreenshot: 'yes', previewViewportSelector: 1 } }),
    );
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();
  });

  it('treats an unparseable config payload as OFF', async () => {
    window.localStorage.setItem(CONFIG_KEY, '{not json');
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();
  });
});

describe('FileViewer feature gating — screenshot', () => {
  it('renders the screenshot action and runs the handler when the flag is ON', async () => {
    writeFlags({ previewScreenshot: true, previewViewportSelector: false });
    renderViewer();

    const button = await screen.findByTestId('screenshot-copy-button');
    expect(button).toBeTruthy();

    fireEvent.click(button);

    // The handler is reachable: it announces itself through the export toast
    // before the capture even resolves.
    await waitFor(() => {
      expect(loadingToastText()).toContain('Copying screenshot');
    });
  });

  it('appears at runtime when the flag flips ON without a remount', async () => {
    writeFlags({ previewScreenshot: false, previewViewportSelector: false });
    renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();

    await toggleFlagsLive({ previewScreenshot: true, previewViewportSelector: false });

    await waitFor(() => {
      expect(screen.getByTestId('screenshot-copy-button')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('screenshot-copy-button'));
    await waitFor(() => {
      expect(loadingToastText()).toContain('Copying screenshot');
    });
  });

  it('disappears again when the flag flips OFF', async () => {
    writeFlags({ previewScreenshot: true, previewViewportSelector: false });
    renderViewer();

    await screen.findByTestId('screenshot-copy-button');

    await toggleFlagsLive({ previewScreenshot: false, previewViewportSelector: false });

    await waitFor(() => {
      expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
    });
  });

  // THE ALTERNATE-ENTRY-POINT PROOF.
  //
  // Hiding the button is not enough: a keyboard shortcut, context-menu item,
  // command-palette entry or toolbar-overflow item that still reaches
  // `handleCopyScreenshot` would leave the capability live while Settings says
  // it is hidden. `handleCopyScreenshot` therefore carries its own capability
  // guard.
  //
  // We exercise that guard the only way a non-rendered entry point can be
  // simulated from the outside: flip the stored flag OFF WITHOUT giving React a
  // chance to re-render (no focus event, no state change), so the button is
  // still mounted and still wired to the same handler — precisely the state an
  // ungated shortcut would be in — then fire it.
  it('handler is inert once the flag is OFF even when its entry point is still wired up', async () => {
    writeFlags({ previewScreenshot: true, previewViewportSelector: false });
    renderViewer();

    // Non-vacuousness pass: the same element, fired the same way, with the
    // flag ON, DOES reach the handler. Without this the negative assertion
    // below could pass for any reason at all.
    const liveButton = await screen.findByTestId('screenshot-copy-button');
    fireEvent.click(liveButton);
    await waitFor(() => {
      expect(loadingToastText()).toContain('Copying screenshot');
    });

    // Fresh mount so no in-flight capture or toast carries over.
    cleanup();
    writeFlags({ previewScreenshot: true, previewViewportSelector: false });
    renderViewer();
    const button = await screen.findByTestId('screenshot-copy-button');
    expect(loadingToastText()).toBeNull();

    // Flip the capability off in storage only. The button is deliberately left
    // mounted and still wired to the handler it closed over: this is exactly
    // the state an ungated shortcut / stale menu registration would be in.
    writeFlags({ previewScreenshot: false, previewViewportSelector: false });
    expect(screen.getByTestId('screenshot-copy-button')).toBe(button);

    writeTextMock.mockClear();
    await act(async () => {
      fireEvent.click(button);
    });

    expect(loadingToastText()).toBeNull();
    expect(writeTextMock).not.toHaveBeenCalled();
  });
});

describe('FileViewer feature gating — viewport selector', () => {
  it('renders the selector and applies a selection when the flag is ON', async () => {
    writeFlags({ previewScreenshot: false, previewViewportSelector: true });
    const { container } = renderViewer();

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeTruthy();
    });

    openViewportMenu(container);
    fireEvent.click(screen.getByRole('option', { name: /Mobile/ }));

    await waitFor(() => {
      expect(container.querySelector('.preview-viewport-mobile')).toBeTruthy();
    });
  });

  it('falls back to the desktop preview when the flag is OFF, without dropping the stored selection', async () => {
    writeFlags({ previewScreenshot: false, previewViewportSelector: true });
    const { container } = renderViewer();

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeTruthy();
    });
    openViewportMenu(container);
    fireEvent.click(screen.getByRole('option', { name: /Tablet/ }));
    await waitFor(() => {
      expect(container.querySelector('.preview-viewport-tablet')).toBeTruthy();
    });

    // Hiding the selector must not strand the preview at 820px.
    await toggleFlagsLive({ previewScreenshot: false, previewViewportSelector: false });

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();
      expect(container.querySelector('.preview-viewport-tablet')).toBeNull();
      expect(container.querySelector('.preview-viewport-desktop')).toBeTruthy();
    });

    // Turning it back on restores the user's selection rather than resetting it.
    await toggleFlagsLive({ previewScreenshot: false, previewViewportSelector: true });

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeTruthy();
      expect(container.querySelector('.preview-viewport-tablet')).toBeTruthy();
    });
  });

  it('appears at runtime when the flag flips ON without a remount', async () => {
    writeFlags({ previewScreenshot: false, previewViewportSelector: false });
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.queryByTestId('draw-overlay-toggle')).toBeTruthy();
    });
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();

    await toggleFlagsLive({ previewScreenshot: false, previewViewportSelector: true });

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeTruthy();
    });

    openViewportMenu(container);
    expect(screen.getByRole('option', { name: /Desktop/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Tablet/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Mobile/ })).toBeTruthy();
  });

  it('leaves the two flags independent', async () => {
    writeFlags({ previewScreenshot: true, previewViewportSelector: false });
    const { container } = renderViewer();

    await waitFor(() => {
      expect(screen.getByTestId('screenshot-copy-button')).toBeTruthy();
    });
    expect(container.querySelector('.viewer-viewport-switcher')).toBeNull();

    await toggleFlagsLive({ previewScreenshot: false, previewViewportSelector: true });

    await waitFor(() => {
      expect(container.querySelector('.viewer-viewport-switcher')).toBeTruthy();
    });
    expect(screen.queryByTestId('screenshot-copy-button')).toBeNull();
  });
});
