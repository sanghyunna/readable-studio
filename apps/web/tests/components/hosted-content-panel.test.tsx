// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostedContentPanel } from '../../src/components/HostedContentPanel';

const file = {
  name: 'index.html',
  path: 'index.html',
  type: 'file',
  kind: 'html',
  mime: 'text/html',
  size: 12,
  mtime: 1,
} as const;

const folder = { name: 'old-assets', path: 'old-assets', type: 'dir', size: 0, mtime: 1 } as const;

function client() {
  return {
    listProjectFiles: vi.fn().mockResolvedValue({ files: [file] }),
    listProjectFolders: vi.fn().mockResolvedValue({ folders: [folder] }),
    readProjectFile: vi.fn().mockResolvedValue(new Response('<h1>Hello</h1>')),
    writeProjectFile: vi.fn().mockResolvedValue({ file }),
    renameProjectFile: vi.fn().mockResolvedValue({
      file: { ...file, name: 'home.html', path: 'home.html' },
      oldName: 'index.html',
      newName: 'home.html',
    }),
    deleteProjectFile: vi.fn().mockResolvedValue({ ok: true }),
    createProjectFolder: vi.fn().mockResolvedValue({
      folder: { name: 'assets', path: 'assets', type: 'dir', size: 0, mtime: 1 },
    }),
    deleteProjectFolder: vi.fn().mockResolvedValue({ ok: true }),
    uploadProjectFiles: vi.fn().mockResolvedValue({ files: [] }),
    createProjectPreviewUrl: vi.fn().mockResolvedValue({
      url: '/api/projects/project-a/preview/scope/index.html',
      file: 'index.html',
      csp: "default-src 'none'",
      iframeSandbox: 'allow-scripts',
      opaqueOrigin: true,
    }),
    projectArchiveUrl: vi.fn().mockReturnValue('/api/projects/project-a/archive'),
  };
}

async function openProject() {
  fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'project-a' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open project' }));
  await screen.findByRole('button', { name: /index.html/ });
}

describe('HostedContentPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens an owned project and reads and writes through the hosted content client', async () => {
    const api = client();
    render(<HostedContentPanel client={api} />);

    await openProject();
    expect(api.listProjectFiles).toHaveBeenCalledWith('project-a');
    expect(api.listProjectFolders).toHaveBeenCalledWith('project-a');
    expect(screen.getByRole('link', { name: 'Download archive' }).getAttribute('href'))
      .toBe('/api/projects/project-a/archive');

    fireEvent.click(screen.getByRole('button', { name: /index.html/ }));
    expect(await screen.findByDisplayValue('<h1>Hello</h1>')).toBeTruthy();
    expect(api.readProjectFile).toHaveBeenCalledWith('project-a', 'index.html');

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: '<h1>Saved</h1>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() => expect(api.writeProjectFile).toHaveBeenCalledWith('project-a', {
      name: 'index.html',
      content: '<h1>Saved</h1>',
      overwrite: true,
    }));
  });

  it('exposes rename, delete, folder, upload, and opaque preview operations', async () => {
    const api = client();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<HostedContentPanel client={api} />);

    await openProject();
    fireEvent.click(screen.getByRole('button', { name: /index.html/ }));
    await screen.findByDisplayValue('<h1>Hello</h1>');

    fireEvent.change(screen.getByLabelText('Rename selected file'), {
      target: { value: 'home.html' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(api.renameProjectFile)
      .toHaveBeenCalledWith('project-a', 'index.html', 'home.html'));

    fireEvent.change(screen.getByLabelText('New folder path'), { target: { value: 'assets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
    await waitFor(() => expect(api.createProjectFolder).toHaveBeenCalledWith('project-a', 'assets'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete old-assets' }));
    await waitFor(() => expect(api.deleteProjectFolder)
      .toHaveBeenCalledWith('project-a', 'old-assets'));

    const upload = new File(['logo'], 'logo.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByLabelText('Upload files'), { target: { files: [upload] } });
    fireEvent.change(screen.getByLabelText('Upload directory (optional)'), {
      target: { value: 'assets' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(api.uploadProjectFiles)
      .toHaveBeenCalledWith('project-a', [upload], 'assets'));

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const frame = await screen.findByTitle('Preview of home.html');
    expect(frame.getAttribute('src')).toBe('/api/projects/project-a/preview/scope/index.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');

    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(api.deleteProjectFile).toHaveBeenCalledWith('project-a', 'home.html'));
  });

  it('rejects a preview URL outside the credentialless hosted preview scope', async () => {
    const api = client();
    api.createProjectPreviewUrl.mockResolvedValueOnce({
      url: '/api/hosted/provider',
      file: 'index.html',
      csp: '',
      iframeSandbox: '',
      opaqueOrigin: true,
    });
    render(<HostedContentPanel client={api} />);

    await openProject();
    fireEvent.click(screen.getByRole('button', { name: /index.html/ }));
    await screen.findByDisplayValue('<h1>Hello</h1>');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect((await screen.findByRole('alert')).textContent)
      .toBe('The hosted content request failed. Try again.');
    expect(screen.queryByTitle('Preview of index.html')).toBeNull();
  });
});
