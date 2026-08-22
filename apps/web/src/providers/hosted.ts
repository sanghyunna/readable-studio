import type {
  HostedArtifactLintResponse,
  HostedArtifactSaveResponse,
  HostedArtifactSaveV1,
  HostedProjectFileDeleteResponse,
  HostedProjectFilePreviewResponse,
  HostedProjectFileRenameResponse,
  HostedProjectFilesResponse,
  HostedProjectFileWriteResponse,
  HostedProjectFileWriteV1,
  HostedProjectFolderCreateResponse,
  HostedProjectFolderDeleteResponse,
  HostedProjectFoldersResponse,
  HostedProjectPreviewUrlResponse,
  HostedProjectSearchQuery,
  HostedProjectSearchResponse,
  HostedProjectUploadResponse,
  HostedProviderClearResponse,
  HostedProviderSetRequest,
  HostedProviderSetResponse,
  HostedProviderStatusResponse,
  HostedProviderTestRequest,
  HostedProviderTestResponse,
  HostedConversationCreateV1,
  HostedConversationResponse,
  HostedConversationsResponse,
  HostedMessageResponse,
  HostedMessageUpsertV1,
  HostedProjectCreateV1,
  HostedProjectResponse,
  HostedProjectsResponse,
  HostedRunCancelResponse,
  HostedRunCreateResponse,
  HostedRunCreateV1,
  HostedSessionResponse,
} from '@readable-studio/contracts';
import { HOSTED_CSRF_HEADER } from '@readable-studio/contracts';

const ENCODED_SEPARATOR = /%(?:2f|5c|25(?:2f|5c))/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function invalidInput(): never {
  throw new HostedProviderRequestError(400);
}

function segment(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('/')
    || value.includes('\\')
    || ENCODED_SEPARATOR.test(value)
    || CONTROL_CHARACTER.test(value)
  ) invalidInput();
  return encodeURIComponent(value);
}

function opaqueSegment(value: string): string {
  if (typeof value !== 'string' || !/^(?!\.+$)[A-Za-z0-9._-]{1,256}$/u.test(value)) invalidInput();
  return segment(value);
}

function canonicalRelativePath(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > 1_024
    || value.startsWith('/')
    || value.includes('\\')
    || ENCODED_SEPARATOR.test(value)
    || CONTROL_CHARACTER.test(value)
  ) invalidInput();
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) invalidInput();
  return value;
}

function relativePath(value: string): string {
  return canonicalRelativePath(value).split('/').map(segment).join('/');
}

function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${opaqueSegment(projectId)}/${suffix}`;
}

function queryPath(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

export class HostedProviderRequestError extends Error {
  constructor(readonly status: number) {
    super(`Hosted provider request failed (${status})`);
    this.name = 'HostedProviderRequestError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new HostedProviderRequestError(502);
  }
}

export class HostedProviderClient {
  private session: HostedSessionResponse | null = null;
  private sessionRequest: Promise<HostedSessionResponse> | null = null;

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  status(): Promise<HostedProviderStatusResponse> {
    return this.request('GET', '/api/hosted/provider');
  }

  set(request: HostedProviderSetRequest): Promise<HostedProviderSetResponse> {
    return this.request('PUT', '/api/hosted/provider', request);
  }

  test(request: HostedProviderTestRequest): Promise<HostedProviderTestResponse> {
    return this.request('POST', '/api/hosted/provider/test', request);
  }

  clear(): Promise<HostedProviderClearResponse> {
    return this.request('DELETE', '/api/hosted/provider');
  }

  listProjects(): Promise<HostedProjectsResponse> {
    return this.request('GET', '/api/projects');
  }

  createProject(value: HostedProjectCreateV1): Promise<HostedProjectResponse> {
    return this.request('POST', '/api/projects', value);
  }

  listConversations(projectId: string): Promise<HostedConversationsResponse> {
    return this.request('GET', projectPath(projectId, 'conversations'));
  }

  createConversation(
    projectId: string,
    value: HostedConversationCreateV1 = {},
  ): Promise<HostedConversationResponse> {
    return this.request('POST', projectPath(projectId, 'conversations'), value);
  }

  upsertMessage(
    projectId: string,
    conversationId: string,
    messageId: string,
    value: HostedMessageUpsertV1,
  ): Promise<HostedMessageResponse> {
    return this.request(
      'PUT',
      `${projectPath(projectId, `conversations/${opaqueSegment(conversationId)}/messages`)}/${opaqueSegment(messageId)}`,
      value,
    );
  }

  createRun(value: HostedRunCreateV1): Promise<HostedRunCreateResponse> {
    return this.request('POST', '/api/runs', value);
  }

  cancelRun(runId: string): Promise<HostedRunCancelResponse> {
    return this.request('POST', `/api/runs/${opaqueSegment(runId)}/cancel`);
  }

  runEventsUrl(runId: string): string {
    return `/api/runs/${opaqueSegment(runId)}/events`;
  }

  listProjectFiles(projectId: string, since?: number): Promise<HostedProjectFilesResponse> {
    return this.request('GET', queryPath(projectPath(projectId, 'files'), { since }));
  }

  readProjectFile(projectId: string, filePath: string): Promise<Response> {
    return this.requestResponse(
      'GET',
      `${projectPath(projectId, 'files')}/${relativePath(filePath)}`,
    );
  }

  writeProjectFile(
    projectId: string,
    value: HostedProjectFileWriteV1,
  ): Promise<HostedProjectFileWriteResponse> {
    return this.request('POST', projectPath(projectId, 'files'), {
      name: canonicalRelativePath(value.name),
      content: value.content,
      ...(value.encoding === undefined ? {} : { encoding: value.encoding }),
      ...(value.overwrite === undefined ? {} : { overwrite: value.overwrite }),
      ...(value.expectedContentSha256 === undefined
        ? {}
        : { expectedContentSha256: value.expectedContentSha256 }),
    });
  }

  renameProjectFile(
    projectId: string,
    from: string,
    to: string,
  ): Promise<HostedProjectFileRenameResponse> {
    return this.request('POST', projectPath(projectId, 'files/rename'), {
      from: canonicalRelativePath(from),
      to: canonicalRelativePath(to),
    });
  }

  deleteProjectFile(projectId: string, filePath: string): Promise<HostedProjectFileDeleteResponse> {
    return this.request('DELETE', `${projectPath(projectId, 'files')}/${relativePath(filePath)}`);
  }

  searchProjectFiles(
    projectId: string,
    value: HostedProjectSearchQuery,
  ): Promise<HostedProjectSearchResponse> {
    return this.request('GET', queryPath(projectPath(projectId, 'search'), {
      q: value.q,
      pattern: value.pattern,
      max: value.max,
    }));
  }

  listProjectFolders(projectId: string): Promise<HostedProjectFoldersResponse> {
    return this.request('GET', projectPath(projectId, 'folders'));
  }

  createProjectFolder(
    projectId: string,
    folderPath: string,
  ): Promise<HostedProjectFolderCreateResponse> {
    return this.request('POST', projectPath(projectId, 'folders'), {
      path: canonicalRelativePath(folderPath),
    });
  }

  deleteProjectFolder(
    projectId: string,
    folderPath: string,
  ): Promise<HostedProjectFolderDeleteResponse> {
    return this.request('DELETE', projectPath(projectId, 'folders'), {
      path: canonicalRelativePath(folderPath),
    });
  }

  uploadProjectFiles(
    projectId: string,
    files: readonly File[],
    directory?: string,
  ): Promise<HostedProjectUploadResponse> {
    const body = new FormData();
    if (directory !== undefined) body.append('dir', canonicalRelativePath(directory));
    for (const file of files) body.append('files', file);
    return this.requestPrepared('POST', projectPath(projectId, 'upload'), body);
  }

  previewProjectFile(
    projectId: string,
    filePath: string,
  ): Promise<HostedProjectFilePreviewResponse> {
    return this.request('POST', projectPath(projectId, 'files/preview'), {
      path: canonicalRelativePath(filePath),
    });
  }

  createProjectPreviewUrl(
    projectId: string,
    filePath: string,
  ): Promise<HostedProjectPreviewUrlResponse> {
    return this.request('POST', projectPath(projectId, 'preview-url'), {
      file: canonicalRelativePath(filePath),
    });
  }

  saveArtifact(value: HostedArtifactSaveV1): Promise<HostedArtifactSaveResponse> {
    return this.request('POST', '/api/artifacts/save', {
      html: value.html,
      ...(value.identifier === undefined ? {} : { identifier: value.identifier }),
      ...(value.title === undefined ? {} : { title: value.title }),
    });
  }

  lintArtifact(html: string): Promise<HostedArtifactLintResponse> {
    return this.request('POST', '/api/artifacts/lint', { html });
  }

  projectArchiveUrl(projectId: string, root?: string): string {
    return queryPath(projectPath(projectId, 'archive'), {
      root: root === undefined ? undefined : canonicalRelativePath(root),
    });
  }

  projectExportManifestUrl(projectId: string): string {
    return projectPath(projectId, 'export/manifest');
  }

  artifactDownloadUrl(artifactId: string): string {
    return `/api/artifacts/${opaqueSegment(artifactId)}/download`;
  }

  async getSession(force = false): Promise<HostedSessionResponse> {
    if (!force && this.session && this.session.csrfExpiresAt > Date.now()) return this.session;
    if (!force && this.sessionRequest) return this.sessionRequest;

    const request = this.fetcher('/api/hosted/session', {
      method: 'GET',
      credentials: 'include',
      redirect: 'error',
    }).then(async (response) => {
      if (!response.ok) throw new HostedProviderRequestError(response.status);
      const session = await parseResponse<HostedSessionResponse>(response);
      let publicOrigin: string;
      try {
        publicOrigin = new URL(session.publicOrigin).origin;
      } catch {
        throw new HostedProviderRequestError(502);
      }
      if (publicOrigin !== session.publicOrigin) throw new HostedProviderRequestError(502);
      if (typeof window !== 'undefined' && publicOrigin !== window.location.origin) {
        throw new HostedProviderRequestError(502);
      }
      this.session = session;
      return session;
    }).finally(() => {
      this.sessionRequest = null;
    });

    this.sessionRequest = request;
    return request;
  }

  private async request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    value?: unknown,
  ): Promise<T> {
    const body = value === undefined ? undefined : JSON.stringify(value);
    return this.requestPrepared(method, path, body, method === 'GET' ? undefined : 'application/json');
  }

  private async requestPrepared<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: BodyInit,
    contentType?: string,
  ): Promise<T> {
    return parseResponse<T>(await this.requestResponse(method, path, body, contentType));
  }

  private async requestResponse(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: BodyInit,
    contentType?: string,
  ): Promise<Response> {
    let session = await this.getSession();
    let response = await this.send(method, path, session, body, contentType);
    if (response.status === 401 || response.status === 419) {
      this.session = null;
      session = await this.getSession(true);
      response = await this.send(method, path, session, body, contentType);
    }
    if (!response.ok) throw new HostedProviderRequestError(response.status);
    return response;
  }

  private send(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    session: HostedSessionResponse,
    body?: BodyInit,
    contentType?: string,
  ): Promise<Response> {
    const unsafe = method !== 'GET';
    return this.fetcher(path, {
      method,
      body,
      credentials: 'include',
      redirect: 'error',
      headers: unsafe
        ? {
            ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
            'Origin': session.publicOrigin,
            [HOSTED_CSRF_HEADER]: session.csrfToken,
          }
        : undefined,
    });
  }
}
