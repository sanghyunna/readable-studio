import type {
  ImportGitHubDesignSystemRequest,
  ImportGitHubDesignSystemResponse,
  ImportShadcnDesignSystemRequest,
  ImportShadcnDesignSystemResponse,
  ImportLocalDesignSystemRequest,
  ImportLocalDesignSystemResponse,
  ReplaceProjectWorkingDirResponse,
  SocialShareRequest,
  SocialShareResponse,
  SystemFontFamily,
  SystemFontsResponse,
} from '@readable-studio/contracts';
import type {
  AgentInfo,
  AppVersionInfo,
  AppVersionResponse,
  ChatAttachment,
  CodexPetSummary,
  CodexPetsResponse,
  InstallDesignSystemResponse,
  InstallInput,
  InstallSkillResponse,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentUpsertRequest,
  CloudflarePagesDeploySelection,
  CloudflarePagesZonesResponse,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemGenerationJob,
  DesignSystemPackageAudit,
  DesignSystemProvenance,
  DesignSystemRevision,
  DesignSystemRevisionJobRequest,
  DesignSystemRevisionStatus,
  DesignSystemSummary,
  DesignSystemTokenContractRebuildJobRequest,
  DesignSystemTokenContractRebuildJobResponse,
  Project,
  ProjectDeploymentsResponse,
  ProjectFile,
  ProjectFolder,
  RenameProjectFileResponse,
  SkillDetail,
  SkillSummary,
  UpdateDeployConfigRequest,
} from '../types';
import type { ArtifactManifest } from '../artifacts/types';
import {
  isReadableStudioHostAvailable,
  openHostExternalUrl,
} from '@readable-studio/host';

export const DEFAULT_DEPLOY_PROVIDER_ID = 'vercel-self';
export const CLOUDFLARE_PAGES_PROVIDER_ID = 'cloudflare-pages';
export const DEPLOY_PROVIDER_IDS = [
  DEFAULT_DEPLOY_PROVIDER_ID,
  CLOUDFLARE_PAGES_PROVIDER_ID,
] as const;

export type WebDeployProviderId = (typeof DEPLOY_PROVIDER_IDS)[number];

export type WebDeployConfigResponse = DeployConfigResponse;
export type WebUpdateDeployConfigRequest = UpdateDeployConfigRequest;
export type WebDeploymentInfo = ProjectDeploymentsResponse['deployments'][number];
export type WebDeployProjectFileResponse = DeployProjectFileResponse;
export type WebCloudflarePagesDeploySelection = CloudflarePagesDeploySelection;
export type WebCloudflarePagesZonesResponse = CloudflarePagesZonesResponse;

export function isDeployProviderId(value: unknown): value is WebDeployProviderId {
  return typeof value === 'string' && (DEPLOY_PROVIDER_IDS as readonly string[]).includes(value);
}

function deployProviderQuery(providerId?: WebDeployProviderId): string {
  return providerId ? `?providerId=${encodeURIComponent(providerId)}` : '';
}

export async function fetchAgents(options?: { throwOnError?: boolean }): Promise<AgentInfo[]> {
  try {
    const resp = await fetch('/api/agents', { cache: 'no-store' });
    if (!resp.ok) {
      if (options?.throwOnError) throw new Error(`agents ${resp.status}`);
      return [];
    }
    const json = (await resp.json()) as { agents: AgentInfo[] };
    return json.agents ?? [];
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

// Incremental agent detection over Server-Sent Events: `onAgent` fires once
// per agent the moment its probe settles (completion order, not registry
// order), so a caller can paint cards as they resolve instead of waiting for
// the slowest CLI. Resolves with every agent collected once the stream's
// terminal `done` event arrives. This is additive: callers that don't need
// incremental delivery keep using `fetchAgents()` (whose batch probe is now
// parallelized per-agent and so is itself faster). Pass an AbortSignal to
// cancel the underlying request.
export async function fetchAgentsStream(args: {
  onAgent: (agent: AgentInfo) => void;
  signal?: AbortSignal;
}): Promise<AgentInfo[]> {
  const { onAgent, signal } = args;
  const resp = await fetch('/api/agents?stream=1', {
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`agents stream ${resp.status}`);
  }
  const collected: AgentInfo[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const errorMessageFromData = (data: string): string => {
    if (!data.trim()) return 'agents stream error';
    try {
      const parsed = JSON.parse(data) as { error?: unknown; message?: unknown };
      const message = parsed.error ?? parsed.message;
      if (typeof message === 'string' && message.trim()) return message;
    } catch {
      // Fall through to the raw data string below.
    }
    return data;
  };

  const handleEvent = (rawEvent: string) => {
    // Each SSE record is `event: <name>\ndata: <json>`; we act on `agent`
    // (one AgentInfo), `error` (terminal failure), and `done` (terminal
    // success). Unknown events are ignored so the protocol can grow without
    // breaking older clients.
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (eventName === 'done') {
      done = true;
      return;
    }
    if (eventName === 'error') {
      throw new Error(errorMessageFromData(data));
    }
    if (eventName === 'agent' && data) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        collected.push(agent);
        onAgent(agent);
      } catch {
        // Ignore a malformed record rather than aborting the whole stream.
      }
    }
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE records are separated by a blank line ("\n\n").
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (rawEvent.trim().length > 0) handleEvent(rawEvent);
        if (done) break;
      }
    }
    if (!done && buffer.trim().length > 0) {
      handleEvent(buffer);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed; nothing to do.
    }
  }
  if (!done) {
    throw new Error('agents stream ended before done');
  }
  return collected;
}

export async function fetchSkills(options?: { signal?: AbortSignal }): Promise<SkillSummary[]> {
  try {
    const resp = await fetch('/api/skills', { signal: options?.signal });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { skills: SkillSummary[] };
    return json.skills ?? [];
  } catch {
    return [];
  }
}

// Fonts installed on the machine running the daemon. Empty on unsupported
// platforms (or any failure) so the picker falls back to the curated list.
export async function fetchSystemFonts(options?: { signal?: AbortSignal }): Promise<SystemFontFamily[]> {
  try {
    const resp = await fetch('/api/system/fonts', { signal: options?.signal });
    if (!resp.ok) return [];
    const json = (await resp.json()) as SystemFontsResponse;
    return json.fonts ?? [];
  } catch {
    return [];
  }
}

// Design templates — the rendering catalogue (decks, prototypes, image/
// video/audio templates). Same SkillSummary shape as functional skills,
// fetched from a separate registry root so the EntryView Templates tab
// and Settings → Skills surface stay decoupled. See
// specs/current/skills-and-design-templates.md.
export async function fetchDesignTemplates(options?: { signal?: AbortSignal }): Promise<SkillSummary[]> {
  try {
    const resp = await fetch('/api/design-templates', { signal: options?.signal });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { designTemplates: SkillSummary[] };
    return json.designTemplates ?? [];
  } catch {
    return [];
  }
}

export async function fetchDesignTemplate(id: string): Promise<SkillDetail | null> {
  try {
    const resp = await fetch(`/api/design-templates/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as SkillDetail;
  } catch {
    return null;
  }
}

// Pets packaged by the Codex `hatch-pet` skill — surfaced so the web
// pet settings can offer one-click adoption right after the agent run
// finishes. Returns an empty list (not an error) when the registry
// folder is missing so the "Recently hatched" UI can simply render an
// empty state.
export async function fetchCodexPets(): Promise<CodexPetsResponse> {
  try {
    const resp = await fetch('/api/codex-pets');
    if (!resp.ok) return { pets: [], rootDir: '' };
    return (await resp.json()) as CodexPetsResponse;
  } catch {
    return { pets: [], rootDir: '' };
  }
}

export function codexPetSpritesheetUrl(pet: CodexPetSummary): string {
  // The daemon stamps an absolute path-prefix in `spritesheetUrl`; if
  // that prefix is empty (default), it is already a same-origin path
  // we can hand to <img src> or fetch() as-is.
  return pet.spritesheetUrl;
}

// Body for POST /api/skills/import. Mirrors the contracts type but is
// repeated here so the registry module is self-describing for callers.
export interface SkillImportInput {
  name: string;
  description?: string;
  body: string;
  triggers?: string[];
}

export interface SkillImportError {
  code?: string;
  message: string;
}

export async function importSkill(
  input: SkillImportInput,
): Promise<{ skill: SkillSummary } | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: SkillImportError }
        | null;
      return {
        error: {
          code: payload?.error?.code,
          message: payload?.error?.message ?? `Import failed (${resp.status}).`,
        },
      };
    }
    return (await resp.json()) as { skill: SkillSummary };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

// Update an existing skill's body. For built-in skills the daemon writes
// a "shadow" copy under the user-skills root; the next listSkills() pass
// surfaces it in place of the bundled copy. The id passed here must
// match the SKILL.md frontmatter `name` — the daemon refuses cross-id
// renames so callers can drop "edit" into the same surface they use for
// "edit my own draft".
export interface SkillUpdateInput {
  name?: string;
  description?: string;
  body: string;
  triggers?: string[];
}

export async function updateSkill(
  id: string,
  input: SkillUpdateInput,
): Promise<{ skill: SkillSummary } | { error: SkillImportError }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: SkillImportError }
        | null;
      return {
        error: {
          code: payload?.error?.code,
          message:
            payload?.error?.message ?? `Update failed (${resp.status}).`,
        },
      };
    }
    return (await resp.json()) as { skill: SkillSummary };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Update request failed.',
      },
    };
  }
}

export interface SkillFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

export async function fetchSkillFiles(id: string): Promise<SkillFileEntry[]> {
  try {
    const resp = await fetch(
      `/api/skills/${encodeURIComponent(id)}/files`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: SkillFileEntry[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}

export async function deleteSkill(
  id: string,
): Promise<{ ok: true } | { error: SkillImportError }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: SkillImportError }
        | null;
      return {
        error: {
          code: payload?.error?.code,
          message: payload?.error?.message ?? `Delete failed (${resp.status}).`,
        },
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Delete request failed.',
      },
    };
  }
}

export async function fetchSkill(id: string): Promise<SkillDetail | null> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as SkillDetail;
  } catch {
    return null;
  }
}

export async function fetchDesignSystems(options?: { signal?: AbortSignal }): Promise<DesignSystemSummary[]> {
  const result = await fetchDesignSystemsResult(options);
  return result.ok ? result.designSystems : [];
}

// Discriminated-union variant: surfaces the fetch outcome instead of
// collapsing a network/HTTP failure into an empty array. The mid-chat
// design-system picker uses this so it can render a load-failure state
// instead of silently showing an empty catalog, which would otherwise
// be indistinguishable from "registry truly has no systems."
export type DesignSystemsResult =
  | { ok: true; designSystems: DesignSystemSummary[] }
  | { ok: false };

export async function fetchDesignSystemsResult(options?: { signal?: AbortSignal }): Promise<DesignSystemsResult> {
  try {
    const resp = await fetch('/api/design-systems', { signal: options?.signal });
    if (!resp.ok) return { ok: false };
    const json = (await resp.json()) as { designSystems?: DesignSystemSummary[] };
    return { ok: true, designSystems: json.designSystems ?? [] };
  } catch {
    return { ok: false };
  }
}

export async function fetchDesignSystem(id: string): Promise<DesignSystemDetail | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

export async function fetchDesignSystemFiles(
  id: string,
): Promise<DesignSystemFileSummary[]> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/files`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: DesignSystemFileSummary[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}

export async function fetchDesignSystemFile(
  id: string,
  filePath: string,
): Promise<DesignSystemFileDetail | null> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`,
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file?: DesignSystemFileDetail };
    return json.file ?? null;
  } catch {
    return null;
  }
}

export async function ensureDesignSystemWorkspace(
  id: string,
): Promise<{ project: Project; files: ProjectFile[] } | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/workspace`, {
      method: 'POST',
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { project: Project; files: ProjectFile[] };
  } catch {
    return null;
  }
}

function parseDesignSystemDetail(json: unknown): DesignSystemDetail | null {
  if (!json || typeof json !== 'object') return null;
  const wrapper = json as { designSystem?: DesignSystemDetail };
  return wrapper.designSystem ?? (json as DesignSystemDetail);
}

export interface DesignSystemDraftInput {
  title: string;
  summary?: string;
  category?: string;
  surface?: 'web' | 'image' | 'video' | 'audio';
  status?: 'draft' | 'published';
  artifactMode?: 'generated' | 'agent-managed';
  body?: string;
  sourceNotes?: string;
  provenance?: DesignSystemProvenance;
}

export async function createDesignSystemDraft(
  input: DesignSystemDraftInput,
): Promise<DesignSystemDetail | null> {
  try {
    const resp = await fetch('/api/design-systems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

export async function startDesignSystemGenerationJob(
  input: DesignSystemDraftInput,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const resp = await fetch('/api/design-systems/generation-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function fetchDesignSystemGenerationJob(
  id: string,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const resp = await fetch(`/api/design-systems/generation-jobs/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function fetchProjectDesignSystemPackageAudit(
  projectId: string,
): Promise<DesignSystemPackageAudit | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/design-system-package-audit`,
      { cache: 'no-store' },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { audit?: DesignSystemPackageAudit };
    return json.audit ?? null;
  } catch {
    return null;
  }
}

export async function fetchDesignSystemRevisions(
  id: string,
): Promise<DesignSystemRevision[]> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/revisions`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { revisions?: DesignSystemRevision[] };
    return json.revisions ?? [];
  } catch {
    return [];
  }
}

export async function updateDesignSystemRevisionStatus(
  id: string,
  revisionId: string,
  status: Extract<DesignSystemRevisionStatus, 'accepted' | 'rejected'>,
): Promise<DesignSystemRevision | null> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { revision?: DesignSystemRevision };
    return json.revision ?? null;
  } catch {
    return null;
  }
}

export async function startDesignSystemRevisionJob(
  id: string,
  input: DesignSystemRevisionJobRequest,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/revision-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function startDesignSystemTokenContractRebuildJob(
  id: string,
  input: DesignSystemTokenContractRebuildJobRequest = {},
): Promise<DesignSystemTokenContractRebuildJobResponse | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/token-contract/rebuild-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DesignSystemTokenContractRebuildJobResponse;
  } catch {
    return null;
  }
}

export async function updateDesignSystemDraft(
  id: string,
  input: Partial<DesignSystemDraftInput>,
): Promise<DesignSystemDetail | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

export async function deleteDesignSystemDraft(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function importLocalDesignSystem(
  input: ImportLocalDesignSystemRequest,
): Promise<ImportLocalDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      return { error: await readImportError(resp) };
    }
    return (await resp.json()) as ImportLocalDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

export async function importGitHubDesignSystem(
  input: ImportGitHubDesignSystemRequest,
): Promise<ImportGitHubDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { error: await readImportError(resp) };
    return (await resp.json()) as ImportGitHubDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

export async function importShadcnDesignSystem(
  input: ImportShadcnDesignSystemRequest,
): Promise<ImportShadcnDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/shadcn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { error: await readImportError(resp) };
    return (await resp.json()) as ImportShadcnDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

async function readImportError(resp: Response): Promise<SkillImportError> {
  const payload = (await resp.json().catch(() => null)) as
    | { error?: SkillImportError | string; message?: string }
    | null;
  const error = payload?.error;
  if (typeof error === 'object' && error !== null) return error;
  return {
    message:
      typeof error === 'string'
        ? error
        : payload?.message ?? `Import failed (${resp.status}).`,
  };
}

export async function daemonIsLive(): Promise<boolean> {
  try {
    const resp = await fetch('/api/health');
    return resp.ok;
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (isReadableStudioHostAvailable()) {
    const opened = await openHostExternalUrl(url);
    if (opened.ok) return true;
  }
  try {
    const resp = await fetch('/api/system/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (resp.ok) {
      const json = (await resp.json().catch(() => null)) as { ok?: unknown } | null;
      if (json?.ok === true) return true;
    }
  } catch {
    // Fall through to current-tab navigation below.
  }
  try {
    window.location.assign(url);
  } catch {
    return false;
  }
  return false;
}

function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppVersionInfo>;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.channel === 'string' &&
    typeof candidate.packaged === 'boolean' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.arch === 'string'
  );
}

export async function fetchAppVersionInfo(options?: { signal?: AbortSignal }): Promise<AppVersionInfo | null> {
  try {
    const resp = await fetch('/api/version', { signal: options?.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<AppVersionResponse>;
    return isAppVersionInfo(json.version) ? json.version : null;
  } catch {
    return null;
  }
}

export type SkillExampleResult =
  | { html: string }
  // The skill declares a non-HTML preview surface (image / markdown / …)
  // and the daemon's `/example` endpoint only ships HTML, so calling it
  // would 404 into a misleading "failed to fetch" state. The modal
  // renders a calm "no shipped preview" affordance instead. The `kind`
  // is the raw `readable.preview.type` from SKILL.md so future preview kinds
  // can be picked up by name without a registry change. Issue #897.
  | { unavailable: true; kind: string }
  | { error: string };

// Returns a discriminated result so callers can distinguish a real
// failure (network error, daemon unreachable, server error) from a
// normal load or a missing shipped preview. Previously this collapsed
// every failure into `null`, which left the example preview modal stuck
// at its loading state with no recovery affordance. Issue #860.
//
// `previewType` is the skill's `readable.preview.type` (defaults to `'html'`
// daemon-side). Anything other than `'html'` short-circuits to an
// `unavailable` result so we don't fire a network call against a
// daemon endpoint that only resolves HTML files. Issue #897.
export async function fetchSkillExample(
  id: string,
  previewType: string = 'html',
): Promise<SkillExampleResult> {
  if (previewType !== 'html') {
    return { unavailable: true, kind: previewType };
  }
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}/example`);
    if (!resp.ok) {
      if (resp.status === 404) {
        return { unavailable: true, kind: 'html' };
      }
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

export async function fetchDeployConfig(
  providerId?: WebDeployProviderId,
): Promise<WebDeployConfigResponse | null> {
  try {
    const resp = await fetch(`/api/deploy/config${deployProviderQuery(providerId)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as WebDeployConfigResponse;
  } catch {
    return null;
  }
}

export async function updateDeployConfig(
  input: WebUpdateDeployConfigRequest,
): Promise<WebDeployConfigResponse | null> {
  try {
    const resp = await fetch('/api/deploy/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;
      throw new Error(payload?.error?.message || payload?.message || `Could not save deploy config (${resp.status})`);
    }
    return (await resp.json()) as WebDeployConfigResponse;
  } catch (err) {
    if (err instanceof Error) throw err;
    return null;
  }
}

export async function fetchCloudflarePagesZones(): Promise<WebCloudflarePagesZonesResponse | null> {
  try {
    const resp = await fetch('/api/deploy/cloudflare-pages/zones');
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;
      throw new Error(payload?.error?.message || payload?.message || `Could not load Cloudflare zones (${resp.status})`);
    }
    return (await resp.json()) as WebCloudflarePagesZonesResponse;
  } catch (err) {
    if (err instanceof Error) throw err;
    return null;
  }
}

export async function fetchProjectDeployments(
  projectId: string,
): Promise<WebDeploymentInfo[]> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/deployments`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as ProjectDeploymentsResponse;
    return (json.deployments ?? []) as WebDeploymentInfo[];
  } catch {
    return [];
  }
}

export async function deployProjectFile(
  projectId: string,
  fileName: string,
  providerId: WebDeployProviderId = DEFAULT_DEPLOY_PROVIDER_ID,
  cloudflarePages?: WebCloudflarePagesDeploySelection,
): Promise<WebDeployProjectFileResponse> {
  const body = {
    fileName,
    providerId,
    ...(cloudflarePages ? { cloudflarePages } : {}),
  };
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string }; message?: string }
      | null;
    throw new Error(payload?.error?.message || payload?.message || `Deploy failed (${resp.status})`);
  }
  return (await resp.json()) as WebDeployProjectFileResponse;
}

export async function checkDeploymentLink(
  projectId: string,
  deploymentId: string,
): Promise<WebDeployProjectFileResponse> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/check-link`,
    { method: 'POST' },
  );
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string }; message?: string }
      | null;
    throw new Error(payload?.error?.message || payload?.message || `Link check failed (${resp.status})`);
  }
  return (await resp.json()) as WebDeployProjectFileResponse;
}

export async function createSocialSharePayload(
  input: SocialShareRequest,
): Promise<SocialShareResponse> {
  const resp = await fetch('/api/social-share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(payload?.error?.message || payload?.message || `Share payload failed (${resp.status})`);
  }
  return (await resp.json()) as SocialShareResponse;
}

// Project files — all paths are scoped under .readable-studio/projects/<id>/ on disk.

export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: ProjectFile[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}

export async function fetchProjectFolders(projectId: string): Promise<ProjectFolder[]> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { folders?: ProjectFolder[] };
    return json.folders ?? [];
  } catch {
    return [];
  }
}

export async function createProjectFolder(
  projectId: string,
  name: string,
): Promise<ProjectFolder | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { folder?: ProjectFolder };
    return json.folder ?? null;
  } catch {
    return null;
  }
}

export async function deleteProjectFolder(
  projectId: string,
  folderPath: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folderPath }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function readApiErrorBody(resp: Response): Promise<{ message: string; code?: string }> {
  try {
    const json = (await resp.json()) as { error?: { code?: string; message?: string }; message?: string };
    const message = json.error?.message ?? json.message;
    return {
      message: typeof message === 'string' && message.length > 0 ? message : `Request failed (${resp.status}).`,
      ...(typeof json.error?.code === 'string' ? { code: json.error.code } : {}),
    };
  } catch {
    return { message: `Request failed (${resp.status}).` };
  }
}

export function projectFileUrl(projectId: string, name: string): string {
  return projectRawUrl(projectId, name);
}

export interface ProjectFilePreviewSection {
  title: string;
  lines: string[];
}

export interface ProjectFilePreview {
  kind: 'pdf' | 'document' | 'presentation' | 'spreadsheet';
  title: string;
  sections: ProjectFilePreviewSection[];
}

export async function fetchProjectFilePreview(
  projectId: string,
  name: string,
): Promise<ProjectFilePreview | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}/preview`,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFilePreview;
  } catch {
    return null;
  }
}

export async function fetchProjectFileText(
  projectId: string,
  name: string,
  options?: { cache?: RequestCache; cacheBustKey?: string | number },
): Promise<string | null> {
  const url = projectFileUrl(projectId, name);
  const cacheBustKey = options?.cacheBustKey;
  const requestUrl =
    cacheBustKey == null
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}cacheBust=${encodeURIComponent(String(cacheBustKey))}`;
  const init: RequestInit = {};
  if (options?.cache) init.cache = options.cache;

  try {
    const resp = await fetch(requestUrl, init);
    if (!resp.ok) {
      console.warn('[fetchProjectFileText] failed:', {
        name,
        projectId,
        status: resp.status,
        statusText: resp.statusText,
        url: requestUrl,
      });
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn('[fetchProjectFileText] failed:', {
      error: err,
      name,
      projectId,
      url: requestUrl,
    });
    return null;
  }
}

export async function fetchPreviewComments(
  projectId: string,
  conversationId: string,
): Promise<PreviewComment[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { comments: PreviewComment[] };
    return json.comments ?? [];
  } catch {
    return [];
  }
}

export async function upsertPreviewComment(
  projectId: string,
  conversationId: string,
  input: PreviewCommentUpsertRequest,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function patchPreviewCommentStatus(
  projectId: string,
  conversationId: string,
  commentId: string,
  status: PreviewCommentStatus,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function deletePreviewComment(
  projectId: string,
  conversationId: string,
  commentId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function writeProjectTextFile(
  projectId: string,
  name: string,
  content: string,
  options?: { artifactManifest?: ArtifactManifest; expectedContentSha256?: string },
): Promise<ProjectFile | null> {
  const result = await writeProjectTextFileDetailed(projectId, name, content, options);
  return result.ok ? result.file : null;
}

export type WriteProjectTextFileResult =
  | { ok: true; file: ProjectFile }
  | { ok: false; conflict: true; status: 409; code: 'CONFLICT'; message: string }
  | { ok: false; conflict?: false; status?: number; code?: string; message: string };

export async function writeProjectTextFileDetailed(
  projectId: string,
  name: string,
  content: string,
  options?: { artifactManifest?: ArtifactManifest; expectedContentSha256?: string },
): Promise<WriteProjectTextFileResult> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        content,
        artifactManifest: options?.artifactManifest,
        expectedContentSha256: options?.expectedContentSha256,
      }),
    });
    if (!resp.ok) {
      const body = await readApiErrorBody(resp);
      if (resp.status === 409 && body.code === 'CONFLICT') {
        return {
          ok: false,
          conflict: true,
          status: 409,
          code: 'CONFLICT',
          message: body.message,
        };
      }
      return {
        ok: false,
        status: resp.status,
        code: body.code,
        message: body.message || resp.statusText || 'Save failed',
      };
    }
    const json = (await resp.json()) as { file: ProjectFile };
    return { ok: true, file: json.file };
  } catch {
    return { ok: false, message: 'Network error while saving the file' };
  }
}

export async function writeProjectBase64File(
  projectId: string,
  name: string,
  base64: string,
): Promise<ProjectFile | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content: base64, encoding: 'base64' }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  desiredName?: string,
): Promise<ProjectFile | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    if (desiredName) form.append('name', desiredName);
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

// Multi-file project upload used by the chat composer's paste / drop /
// picker. Each file lands flat in the project folder; the response is
// reshaped into ChatAttachments so the composer can stage them without a
// follow-up listFiles round-trip.
const PROJECT_UPLOAD_BATCH_SIZE = 12;

export interface ProjectUploadFailure {
  name: string;
  code?: string;
  error?: string;
}

export interface UploadProjectFilesResult {
  uploaded: ChatAttachment[];
  failed: ProjectUploadFailure[];
  error?: string;
}

export async function uploadProjectFiles(
  projectId: string,
  files: File[],
  dir?: string,
): Promise<UploadProjectFilesResult> {
  if (files.length === 0) return { uploaded: [], failed: [] };

  const uploaded: ChatAttachment[] = [];
  const failed: ProjectUploadFailure[] = [];
  let error: string | undefined;
  const targetDir = dir?.trim() ?? '';

  for (let i = 0; i < files.length; i += PROJECT_UPLOAD_BATCH_SIZE) {
    const batch = files.slice(i, i + PROJECT_UPLOAD_BATCH_SIZE);
    const remaining = files.slice(i + PROJECT_UPLOAD_BATCH_SIZE);
    const form = new FormData();
    // The `dir` field MUST be appended before the file parts: the daemon's
    // multer destination resolver reads req.body.dir as each file streams in,
    // and busboy only exposes fields parsed earlier in the multipart body.
    if (targetDir) form.append('dir', targetDir);
    for (const f of batch) form.append('files', f);

    try {
      const resp = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/upload`,
        { method: 'POST', body: form },
      );

      if (!resp.ok) {
        const payload = (await resp.json().catch(() => null)) as
          | { code?: string; error?: string }
          | null;
        error = payload?.error ?? `upload failed (${resp.status})`;
        for (const f of batch) {
          failed.push({ name: f.name, code: payload?.code, error: error });
        }
        for (const f of remaining) {
          failed.push({ name: f.name, code: payload?.code, error: error });
        }
        break;
      }

      const json = (await resp.json()) as {
        files: { name: string; path: string; size?: number; originalName?: string }[];
      };
      const responseFiles = json.files ?? [];
      uploaded.push(
        ...responseFiles.map((f) => ({
          path: f.path,
          name: f.originalName ?? f.name,
          kind: looksLikeImage(f.name) ? ('image' as const) : ('file' as const),
          size: f.size,
        })),
      );
      // Server preserves request order; any dropped files are unmatched at the batch tail.
      if (responseFiles.length < batch.length) {
        error ??= 'some files could not be stored';
        for (const f of batch.slice(responseFiles.length)) {
          failed.push({
            name: f.name,
            error: error ?? 'some files could not be stored',
          });
        }
      }
    } catch {
      error = 'upload request failed';
      for (const f of batch) {
        failed.push({ name: f.name, error });
      }
      for (const f of remaining) {
        failed.push({ name: f.name, error });
      }
      break;
    }
  }

  return { uploaded, failed, error };
}

// Stable URL that serves a project file with its original mime — for
// thumbnails in the staged-attachment chips and for any preview iframe
// that needs to point at the live file (not a srcDoc).
export function projectRawUrl(projectId: string, filePath: string): string {
  // Encode each path segment individually so a slash inside the file
  // path stays a path separator, not %2F.
  const safePath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${safePath}`;
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

export async function deleteProjectFile(
  projectId: string,
  name: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      projectRawUrl(projectId, name),
      { method: 'DELETE' },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function renameProjectFile(
  projectId: string,
  from: string,
  to: string,
): Promise<RenameProjectFileResponse> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!resp.ok) {
    const errorBody = await readApiErrorBody(resp);
    throw new Error(errorBody.message);
  }
  return (await resp.json()) as RenameProjectFileResponse;
}

export async function openFolderDialog(): Promise<string | null> {
  try {
    const resp = await fetch('/api/dialog/open-folder', { method: 'POST' });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.path === 'string' && data.path.length > 0 ? data.path : null;
  } catch {
    return null;
  }
}

// "Replace working directory" — points an existing project at a new
// folder. Mirrors the import-folder trust gate but updates the current
// project record instead of creating a new project.
export async function replaceProjectWorkingDir(
  projectId: string,
  baseDir: string,
  desktopImportToken?: string,
): Promise<ReplaceProjectWorkingDirResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (desktopImportToken) {
    headers['x-readable-studio-desktop-import-token'] = desktopImportToken;
  }
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/working-dir`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseDir }),
    },
  );
  if (!resp.ok) {
    const body = await readApiErrorBody(resp);
    throw new Error(body.message);
  }
  return (await resp.json()) as ReplaceProjectWorkingDirResponse;
}

export async function fetchDesignSystemPreview(id: string): Promise<string | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/preview`);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function fetchDesignSystemShowcase(id: string): Promise<string | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/showcase`);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Fetch the sandboxed HTML preview the daemon serves for a plugin.
// Mirrors fetchSkillExample's discriminated result so the modal can
// surface a Retry button instead of staying stuck at "Loading…" when
// a plugin ships no preview entry or the asset is missing on disk.
//
// 404 is mapped to `unavailable` (mirroring the skill helper's #897
// behavior) because the daemon returns 404 when the manifest's
// `preview.entry` points at a file that doesn't ship — a missing
// asset for an otherwise valid plugin is not an error the user can
// retry their way out of. Surfacing the calm "no shipped preview"
// placeholder is the truthful UX.
export async function fetchPluginPreviewHtml(
  id: string,
): Promise<SkillExampleResult> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(id)}/preview`,
    );
    if (!resp.ok) {
      if (resp.status === 404) return { unavailable: true, kind: 'html' };
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

// Fetch a single example output by stem (matches the basename of the
// `readable.useCase.exampleOutputs[].path` minus its extension). 404 is
// mapped to `unavailable` for the same reason as fetchPluginPreviewHtml.
export async function fetchPluginExampleHtml(
  pluginId: string,
  stem: string,
): Promise<SkillExampleResult> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/example/${encodeURIComponent(stem)}`,
    );
    if (!resp.ok) {
      if (resp.status === 404) return { unavailable: true, kind: 'html' };
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

// Fetch a raw text asset shipped inside a plugin (DESIGN.md,
// SKILL.md, README.md, etc.). Returns null on any error so the
// caller can fall back to a placeholder; callers that need a
// distinguishable failure should switch to the discriminated
// SkillExampleResult shape used by the HTML helpers above.
export async function fetchPluginAssetText(
  pluginId: string,
  relpath: string,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `/api/plugins/${encodeURIComponent(pluginId)}/asset/${encodePluginAssetPath(relpath)}`,
    );
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function encodePluginAssetPath(relpath: string): string {
  return relpath
    .replace(/^\.\//, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export async function installSkill(
  input: InstallInput,
): Promise<{ skill: SkillSummary } | { error: string }> {
  try {
    const resp = await fetch('/api/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await resp.json();
    if (!resp.ok) return { error: json.error ?? 'Install failed' };
    return json as InstallSkillResponse;
  } catch {
    return { error: 'Network error' };
  }
}

export async function uninstallSkill(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const json = await resp.json();
    if (!resp.ok) return { error: json.error ?? 'Uninstall failed' };
    return { ok: true };
  } catch {
    return { error: 'Network error' };
  }
}

export async function installDesignSystem(
  input: InstallInput,
): Promise<{ designSystem: DesignSystemSummary } | { error: string }> {
  try {
    const resp = await fetch('/api/design-systems/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await resp.json();
    if (!resp.ok) return { error: json.error ?? 'Install failed' };
    return json as InstallDesignSystemResponse;
  } catch {
    return { error: 'Network error' };
  }
}

export async function uninstallDesignSystem(
  id: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const json = await resp.json();
    if (!resp.ok) return { error: json.error ?? 'Uninstall failed' };
    return { ok: true };
  } catch {
    return { error: 'Network error' };
  }
}
