// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewModal } from '../../src/components/PreviewModal';

// Regression coverage for image export: the PreviewModal share menu must
// include an "Export as image" button that snapshots the srcdoc iframe and
// downloads a PNG. The snapshot bridges (requestPreviewSnapshot) and the
// Blob download (exportAsImage) come from the shared exports module —
// mock them so the test can exercise the full button flow without a real
// iframe or DOM snapshot.

const { captureHostIframeSnapshotMock, exportAsImageMock, exportStandaloneHtmlMock, requestPreviewSnapshotMock } = vi.hoisted(() => ({
  captureHostIframeSnapshotMock: vi.fn(),
  exportAsImageMock: vi.fn(),
  exportStandaloneHtmlMock: vi.fn(),
  requestPreviewSnapshotMock: vi.fn(),
}));

vi.mock('../../src/runtime/exports', () => ({
  captureHostIframeSnapshot: captureHostIframeSnapshotMock,
  exportStandaloneHtml: exportStandaloneHtmlMock,
  exportAsImage: exportAsImageMock,
  exportAsPdf: vi.fn(),
  exportAsZip: vi.fn(),
  openSandboxedPreviewInNewTab: vi.fn(),
  requestPreviewSnapshot: requestPreviewSnapshotMock,
}));

const baseProps = {
  title: 'Sample',
  views: [{
    id: 'main',
    label: 'Main',
    html: '<p>hello</p>',
    standaloneSource: { kind: 'plugin' as const, pluginId: 'plugin-1' },
  }],
  exportTitleFor: (id: string) => id,
};

function openShareMenu() {
  const share = screen.getByRole('button', { name: /share/i });
  fireEvent.click(share);
}

describe('PreviewModal image export', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the Export as image button in the share menu', () => {
    render(
      <PreviewModal {...baseProps} onClose={() => {}} />,
    );

    openShareMenu();

    expect(
      screen.getByRole('menuitem', { name: /export as image/i }),
    ).toBeTruthy();
  });

  it('exports HTML through the active view standalone source', async () => {
    exportStandaloneHtmlMock.mockResolvedValueOnce({
      outputBytes: 10,
      externalReferenceCount: 0,
      missingLocalReferenceCount: 0,
      skippedSystemFontCount: 0,
    });
    render(<PreviewModal {...baseProps} onClose={() => {}} />);
    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as html/i }));
    await waitFor(() => {
      expect(exportStandaloneHtmlMock).toHaveBeenCalledWith({
        source: { kind: 'plugin', pluginId: 'plugin-1' },
        title: 'main',
      });
    });
  });

  it('switches standalone sources with the active design-system view and shows warnings', async () => {
    exportStandaloneHtmlMock.mockResolvedValueOnce({
      outputBytes: 10,
      externalReferenceCount: 3,
      missingLocalReferenceCount: 2,
      skippedSystemFontCount: 0,
    });
    render(<PreviewModal
      title="Design system"
      views={[
        { id: 'showcase', label: 'Showcase', html: '<p>showcase</p>', standaloneSource: { kind: 'design-system', designSystemId: 'ds-1', view: 'showcase' } },
        { id: 'tokens', label: 'Tokens', html: '<p>tokens</p>', standaloneSource: { kind: 'design-system', designSystemId: 'ds-1', view: 'preview' } },
      ]}
      exportTitleFor={(id) => id}
      onClose={() => {}}
    />);
    fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));
    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as html/i }));
    await waitFor(() => {
      expect(exportStandaloneHtmlMock).toHaveBeenCalledWith({
        source: { kind: 'design-system', designSystemId: 'ds-1', view: 'preview' },
        title: 'tokens',
      });
      expect(document.body.textContent).toContain('3 external');
      expect(document.body.textContent).toContain('2 missing');
    });
  });

  it('shows a server bundle failure and never saves active preview HTML as a fallback', async () => {
    const error = new Error('invalid module');
    error.name = 'BUNDLE_FAILED';
    exportStandaloneHtmlMock.mockRejectedValueOnce(error);
    render(<PreviewModal {...baseProps} onClose={() => {}} />);
    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as html/i }));
    await waitFor(() => expect(document.body.textContent).toContain('Could not export standalone HTML'));
    expect(exportStandaloneHtmlMock).toHaveBeenCalledTimes(1);
  });

  it('hides the share menu (including image export) when the view is custom (no iframe)', () => {
    render(
      <PreviewModal
        {...baseProps}
        views={[{ id: 'custom', label: 'Custom', custom: <div>media</div> }]}
        onClose={() => {}}
      />,
    );

    // The share button itself must not render for custom views.
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull();
  });

  it('calls requestPreviewSnapshot and exportAsImage on success', async () => {
    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    captureHostIframeSnapshotMock.mockResolvedValueOnce(null);
    requestPreviewSnapshotMock.mockResolvedValueOnce({
      dataUrl: fakeDataUrl,
      w: 800,
      h: 600,
    });

    render(
      <PreviewModal {...baseProps} onClose={() => {}} />,
    );

    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as image/i }));

    await waitFor(() => {
      expect(requestPreviewSnapshotMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(exportAsImageMock).toHaveBeenCalledWith(fakeDataUrl, 'main');
    });
  });

  it('prefers the desktop host iframe snapshot when available', async () => {
    const fakeDataUrl = 'data:image/png;base64,host';
    captureHostIframeSnapshotMock.mockResolvedValueOnce({
      dataUrl: fakeDataUrl,
      w: 1024,
      h: 768,
    });

    render(
      <PreviewModal {...baseProps} onClose={() => {}} />,
    );

    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as image/i }));

    await waitFor(() => {
      expect(captureHostIframeSnapshotMock).toHaveBeenCalledTimes(1);
    });

    expect(requestPreviewSnapshotMock).not.toHaveBeenCalled();
    expect(exportAsImageMock).toHaveBeenCalledWith(fakeDataUrl, 'main');
  });

  it('alerts when snapshot capture returns null', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    captureHostIframeSnapshotMock.mockResolvedValueOnce(null);
    requestPreviewSnapshotMock.mockResolvedValueOnce(null);

    render(
      <PreviewModal {...baseProps} onClose={() => {}} />,
    );

    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as image/i }));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    // exportAsImage must not be called when snapshot is null.
    expect(exportAsImageMock).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('alerts when exportAsImage throws', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    captureHostIframeSnapshotMock.mockResolvedValueOnce(null);
    requestPreviewSnapshotMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,ok',
      w: 800,
      h: 600,
    });
    exportAsImageMock.mockImplementationOnce(() => {
      throw new Error('blob conversion failed');
    });

    render(
      <PreviewModal {...baseProps} onClose={() => {}} />,
    );

    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as image/i }));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    alertSpy.mockRestore();
  });

  it('fires onSharePopoverItemClick with "image"', () => {
    const onItemClick = vi.fn();
    captureHostIframeSnapshotMock.mockResolvedValueOnce(null);
    requestPreviewSnapshotMock.mockResolvedValueOnce({
      dataUrl: 'data:image/png;base64,ok',
      w: 800,
      h: 600,
    });

    render(
      <PreviewModal
        {...baseProps}
        onClose={() => {}}
        onSharePopoverItemClick={onItemClick}
      />,
    );

    openShareMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /export as image/i }));

    expect(onItemClick).toHaveBeenCalledWith('image');
  });
});
