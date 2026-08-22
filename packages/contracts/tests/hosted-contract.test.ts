import { describe, expect, it } from 'vitest';

import {
  HOSTED_AG_UI_EVENT_KINDS,
  HOSTED_GEN_UI_SURFACE_KINDS,
  HOSTED_PROJECT_KINDS,
  HOSTED_RUN_STATUSES,
  type HostedArtifactDownloadMetadata,
  type HostedArtifactLintResponse,
  type HostedArtifactSaveResponse,
  type HostedArtifactSaveV1,
  type HostedDesignSystemReadV1,
  type HostedProjectArchiveQuery,
  type HostedProjectCreateV1,
  type HostedProjectFile,
  type HostedProjectFileRenameResponse,
  type HostedProjectFilePreviewResponse,
  type HostedProjectFileWriteV1,
  type HostedProjectFolder,
  type HostedProjectPreviewUrlV1,
  type HostedProjectSearchResponse,
  type HostedProjectUploadResponse,
  type HostedProjectUploadV1,
  type HostedRunCreateV1,
} from '../src/api/hosted.js';
import { API_ERROR_CODES } from '../src/errors.js';

describe('hosted PR07 contracts', () => {
  it('freezes the hosted project, run, GenUI, and AG-UI enums', () => {
    expect(HOSTED_PROJECT_KINDS).toEqual(['prototype', 'deck', 'template', 'other']);
    expect(HOSTED_RUN_STATUSES).toEqual([
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'interrupted',
    ]);
    expect(HOSTED_GEN_UI_SURFACE_KINDS).toEqual([
      'form',
      'choice',
      'confirmation',
      'oauth-prompt',
    ]);
    expect(HOSTED_AG_UI_EVENT_KINDS).toEqual([
      'agent.message',
      'tool_call',
      'state_update',
      'ui.surface_requested',
      'ui.surface_responded',
      'run.lifecycle',
    ]);
  });

  it('keeps authority-bearing hosted request shapes closed', () => {
    const project: HostedProjectCreateV1 = { title: 'Prototype', kind: 'prototype' };
    const run: HostedRunCreateV1 = {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'message-1',
      agentId: 'pi',
      message: 'Build it',
      clientRequestId: 'retry-1',
    };
    const designSystemRead: HostedDesignSystemReadV1 = { path: 'tokens/colors.json' };
    // @ts-expect-error Hosted projects never accept a filesystem root.
    const projectWithRoot: HostedProjectCreateV1 = { title: 'Unsafe', baseDir: 'C:\\outside' };
    // @ts-expect-error Hosted runs never accept a client tool bundle.
    const runWithTools: HostedRunCreateV1 = { ...run, toolBundle: { servers: [] } };
    // @ts-expect-error Broker grants are server-minted, never request fields.
    const readWithGrant: HostedDesignSystemReadV1 = { ...designSystemRead, grant: 'copied' };

    expect(project).toEqual({ title: 'Prototype', kind: 'prototype' });
    expect(run.clientRequestId).toBe('retry-1');
    expect(designSystemRead.path).toBe('tokens/colors.json');
    expect(projectWithRoot).toHaveProperty('baseDir');
    expect(runWithTools).toHaveProperty('toolBundle');
    expect(readWithGrant).toHaveProperty('grant');
  });

  it('publishes the PR07 cursor-expiry failure', () => {
    expect(API_ERROR_CODES).toContain('CURSOR_EXPIRED');
  });

  it('keeps hosted content contracts relative and path-free', () => {
    const write: HostedProjectFileWriteV1 = {
      name: 'pages/index.html',
      content: '<!doctype html>',
      expectedContentSha256: 'a'.repeat(64),
    };
    const file: HostedProjectFile = {
      name: 'pages/index.html',
      path: 'pages/index.html',
      type: 'file',
      size: 15,
      mtime: 1,
      kind: 'html',
      mime: 'text/html',
    };
    const folder: HostedProjectFolder = {
      name: 'pages',
      path: 'pages',
      type: 'dir',
      size: 0,
      mtime: 1,
    };
    const preview: HostedProjectFilePreviewResponse = {
      kind: 'document',
      title: 'brief.docx',
      sections: [{ title: 'Document', lines: ['Hello'] }],
    };
    const previewUrl: HostedProjectPreviewUrlV1 = { file: 'pages/index.html' };
    const archive: HostedProjectArchiveQuery = { root: 'pages' };
    const artifact: HostedArtifactSaveV1 = { html: '<!doctype html>' };
    const upload: HostedProjectUploadV1 = {
      dir: 'assets',
      files: [{ name: 'logo.svg', mime: 'image/svg+xml', size: 42 }],
    };
    const uploaded: HostedProjectUploadResponse = {
      files: [{ ...upload.files[0]!, originalName: 'logo.svg' }],
    };
    const renamed: HostedProjectFileRenameResponse = {
      file,
      oldName: 'pages/old.html',
      newName: file.name,
    };
    const search: HostedProjectSearchResponse = {
      query: 'hello',
      matches: [{ file: file.name, line: 1, snippet: 'hello' }],
    };
    const lint: HostedArtifactLintResponse = {
      findings: [{ severity: 'P1', id: 'rule', message: 'message', fix: 'fix' }],
      agentMessage: 'Review one finding.',
    };
    const saved: HostedArtifactSaveResponse = {
      artifactId: 'oda_opaque',
      url: '/api/artifacts/oda_opaque/download',
      lint: lint.findings,
    };
    const download: HostedArtifactDownloadMetadata = {
      artifactId: 'oda_opaque',
      contentType: 'text/html; charset=utf-8',
      fileName: 'artifact.html',
      size: 15,
    };
    // @ts-expect-error Hosted writes never accept a filesystem root.
    const writeWithRoot: HostedProjectFileWriteV1 = { ...write, root: 'C:\\outside' };
    // @ts-expect-error Preview grants accept only a relative file.
    const previewWithOwner: HostedProjectPreviewUrlV1 = { ...previewUrl, userKey: 'copied' };
    // @ts-expect-error Artifact saves never accept a destination path.
    const artifactWithPath: HostedArtifactSaveV1 = { ...artifact, path: '/tmp/artifact.html' };

    expect(file.path).toBe('pages/index.html');
    expect(folder.type).toBe('dir');
    expect(preview.sections[0]?.lines).toEqual(['Hello']);
    expect(archive.root).toBe('pages');
    expect(uploaded.files[0]?.name).toBe('logo.svg');
    expect(renamed.newName).toBe(file.name);
    expect(search.matches).toHaveLength(1);
    expect(saved.url).toContain('/api/artifacts/');
    expect(download.fileName).toBe('artifact.html');
    expect(writeWithRoot).toHaveProperty('root');
    expect(previewWithOwner).toHaveProperty('userKey');
    expect(artifactWithPath).toHaveProperty('path');
  });
});

describe('hosted PR09 contracts', () => {
  it('publishes the stable retry-key conflict failure', () => {
    expect(API_ERROR_CODES).toContain('RETRY_KEY_REUSED');
  });
});
