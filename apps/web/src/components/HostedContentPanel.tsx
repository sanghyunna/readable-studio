'use client';

import { Button, Input, Textarea } from '@readable-studio/components';
import type { HostedProjectFile, HostedProjectFolder } from '@readable-studio/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { useHostedT } from '../i18n/hosted';
import type { HostedProviderClient } from '../providers/hosted';
import styles from './HostedContentPanel.module.css';

type ContentApi = Pick<
  HostedProviderClient,
  | 'listProjectFiles'
  | 'listProjectFolders'
  | 'readProjectFile'
  | 'writeProjectFile'
  | 'renameProjectFile'
  | 'deleteProjectFile'
  | 'createProjectFolder'
  | 'deleteProjectFolder'
  | 'uploadProjectFiles'
  | 'createProjectPreviewUrl'
  | 'projectArchiveUrl'
>;

export function HostedContentPanel({ client }: { client: ContentApi }) {
  const t = useHostedT();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [projectDraft, setProjectDraft] = useState('');
  const [projectId, setProjectId] = useState('');
  const [files, setFiles] = useState<readonly HostedProjectFile[]>([]);
  const [folders, setFolders] = useState<readonly HostedProjectFolder[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [uploadFiles, setUploadFiles] = useState<readonly File[]>([]);
  const [uploadDirectory, setUploadDirectory] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = async (id = projectId) => {
    const [nextFiles, nextFolders] = await Promise.all([
      client.listProjectFiles(id),
      client.listProjectFolders(id),
    ]);
    setFiles(nextFiles.files);
    setFolders(nextFolders.folders);
  };

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await operation();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openProject = (event: FormEvent) => {
    event.preventDefault();
    const nextProjectId = projectDraft.trim();
    if (!nextProjectId) return;
    void act(async () => {
      await refresh(nextProjectId);
      setProjectId(nextProjectId);
      setSelectedPath('');
      setFileName('');
      setContent('');
      setPreviewUrl('');
    });
  };

  const openFile = (path: string) => void act(async () => {
    const response = await client.readProjectFile(projectId, path);
    setSelectedPath(path);
    setFileName(path);
    setRenameTo(path);
    setContent(await response.text());
    setPreviewUrl('');
  });

  const saveFile = (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !fileName) return;
    void act(async () => {
      const result = await client.writeProjectFile(projectId, {
        name: fileName,
        content,
        overwrite: true,
      });
      setSelectedPath(result.file.path);
      setRenameTo(result.file.path);
      await refresh();
    });
  };

  const renameFile = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPath || !renameTo) return;
    void act(async () => {
      const result = await client.renameProjectFile(projectId, selectedPath, renameTo);
      setSelectedPath(result.file.path);
      setFileName(result.file.path);
      setRenameTo(result.file.path);
      await refresh();
    });
  };

  const deleteFile = () => {
    if (!selectedPath || !window.confirm(t('hosted.content.confirmDelete', { path: selectedPath }))) return;
    void act(async () => {
      await client.deleteProjectFile(projectId, selectedPath);
      setSelectedPath('');
      setFileName('');
      setContent('');
      setRenameTo('');
      setPreviewUrl('');
      await refresh();
    });
  };

  const createFolder = (event: FormEvent) => {
    event.preventDefault();
    if (!folderPath) return;
    void act(async () => {
      await client.createProjectFolder(projectId, folderPath);
      setFolderPath('');
      await refresh();
    });
  };

  const deleteFolder = (path: string) => {
    if (!window.confirm(t('hosted.content.confirmDelete', { path }))) return;
    void act(async () => {
      await client.deleteProjectFolder(projectId, path);
      await refresh();
    });
  };

  const upload = (event: FormEvent) => {
    event.preventDefault();
    if (uploadFiles.length === 0) return;
    void act(async () => {
      await client.uploadProjectFiles(
        projectId,
        uploadFiles,
        uploadDirectory.trim() || undefined,
      );
      setUploadFiles([]);
      if (uploadInput.current) uploadInput.current.value = '';
      await refresh();
    });
  };

  const preview = () => {
    if (!selectedPath) return;
    void act(async () => {
      const result = await client.createProjectPreviewUrl(projectId, selectedPath);
      const parsed = new URL(result.url, window.location.origin);
      const prefix = `/api/projects/${encodeURIComponent(projectId)}/preview/`;
      if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith(prefix)) {
        throw new Error('invalid hosted preview URL');
      }
      setPreviewUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    });
  };

  const startFile = () => {
    setSelectedPath('');
    setFileName('');
    setContent('');
    setRenameTo('');
    setPreviewUrl('');
  };

  return (
    <section className={styles.panel} aria-labelledby="hosted-content-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{t('hosted.content.eyebrow')}</p>
          <h2 id="hosted-content-title">{t('hosted.content.title')}</h2>
          <p>{t('hosted.content.description')}</p>
        </div>
        {projectId ? (
          <a className={styles.download} href={client.projectArchiveUrl(projectId)}>
            {t('hosted.content.downloadArchive')}
          </a>
        ) : null}
      </header>

      <form className={styles.projectPicker} onSubmit={openProject}>
        <label>
          <span>{t('hosted.content.projectId')}</span>
          <Input
            value={projectDraft}
            onChange={(event) => setProjectDraft(event.target.value)}
            placeholder={t('hosted.content.projectIdPlaceholder')}
            disabled={busy}
            required
          />
        </label>
        <Button variant="primary" type="submit" disabled={busy || projectDraft.trim() === ''}>
          {t('hosted.content.openProject')}
        </Button>
      </form>

      {projectId ? (
        <div className={styles.workspace}>
          <aside className={styles.browser} aria-label={t('hosted.content.browserLabel')}>
            <div className={styles.browserHeading}>
              <h3>{t('hosted.content.files')}</h3>
              <Button variant="subtle" onClick={startFile} disabled={busy}>
                {t('hosted.content.newFile')}
              </Button>
            </div>
            {files.length === 0 ? <p className={styles.empty}>{t('hosted.content.noFiles')}</p> : (
              <ul className={styles.items}>
                {files.map((file) => (
                  <li key={file.path}>
                    <Button
                      className={file.path === selectedPath ? styles.selected : undefined}
                      onClick={() => openFile(file.path)}
                      disabled={busy}
                    >
                      <span>{file.path}</span>
                      <small>{t('hosted.content.fileSize', { bytes: file.size })}</small>
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <h3>{t('hosted.content.folders')}</h3>
            {folders.length === 0 ? <p className={styles.empty}>{t('hosted.content.noFolders')}</p> : (
              <ul className={styles.folders}>
                {folders.map((folder) => (
                  <li key={folder.path}>
                    <span>{folder.path}</span>
                    <Button
                      variant="subtle"
                      onClick={() => deleteFolder(folder.path)}
                      disabled={busy}
                      aria-label={t('hosted.content.deleteNamed', { path: folder.path })}
                    >
                      {t('hosted.content.delete')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form className={styles.compactForm} onSubmit={createFolder}>
              <label>
                <span>{t('hosted.content.newFolderPath')}</span>
                <Input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  disabled={busy}
                />
              </label>
              <Button type="submit" disabled={busy || folderPath === ''}>
                {t('hosted.content.createFolder')}
              </Button>
            </form>

            <form className={styles.compactForm} onSubmit={upload}>
              <label>
                <span>{t('hosted.content.uploadFiles')}</span>
                <input
                  ref={uploadInput}
                  type="file"
                  multiple
                  onChange={(event) => setUploadFiles(Array.from(event.target.files ?? []))}
                  disabled={busy}
                />
              </label>
              <label>
                <span>{t('hosted.content.uploadDirectory')}</span>
                <Input
                  value={uploadDirectory}
                  onChange={(event) => setUploadDirectory(event.target.value)}
                  disabled={busy}
                />
              </label>
              <Button type="submit" disabled={busy || uploadFiles.length === 0}>
                {t('hosted.content.upload')}
              </Button>
            </form>
          </aside>

          <div className={styles.editor}>
            <form onSubmit={saveFile}>
              <label>
                <span>{t('hosted.content.filePath')}</span>
                <Input
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder={t('hosted.content.filePathPlaceholder')}
                  disabled={busy}
                  required
                />
              </label>
              <label>
                <span>{t('hosted.content.content')}</span>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={14}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <div className={styles.actions}>
                <Button variant="primary" type="submit" disabled={busy || fileName === ''}>
                  {t('hosted.content.saveFile')}
                </Button>
                <Button type="button" onClick={preview} disabled={busy || !selectedPath}>
                  {t('hosted.content.preview')}
                </Button>
                <Button variant="subtle" type="button" onClick={deleteFile} disabled={busy || !selectedPath}>
                  {t('hosted.content.deleteFile')}
                </Button>
              </div>
            </form>

            <form className={styles.rename} onSubmit={renameFile}>
              <label>
                <span>{t('hosted.content.renameFile')}</span>
                <Input
                  value={renameTo}
                  onChange={(event) => setRenameTo(event.target.value)}
                  disabled={busy || !selectedPath}
                />
              </label>
              <Button type="submit" disabled={busy || !selectedPath || renameTo === ''}>
                {t('hosted.content.rename')}
              </Button>
            </form>

            {previewUrl ? (
              <iframe
                className={styles.preview}
                src={previewUrl}
                title={t('hosted.content.previewTitle', { path: selectedPath })}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {failed ? <p className={styles.error} role="alert">{t('hosted.content.error')}</p> : null}
    </section>
  );
}
