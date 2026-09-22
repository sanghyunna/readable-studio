import type { ProjectFile } from '../types';

// Coalesce only simultaneous reads. A later switch or refresh always goes back
// to the daemon; no settled project state is retained across navigation.
const pendingFiles = new Map<string, Promise<Response>>();

export async function fetchProjectFilesResponse(projectId: string): Promise<Response> {
  const pending = pendingFiles.get(projectId);
  if (pending) return (await pending).clone();
  const request = fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
  pendingFiles.set(projectId, request);
  try {
    return (await request).clone();
  } finally {
    pendingFiles.delete(projectId);
  }
}

// Preserve the registry's existing soft-failure contract. The detail hook uses
// the response API so it can continue surfacing transport/HTTP errors instead.
export async function fetchProjectFiles(projectId: string): Promise<ProjectFile[]> {
  try {
    const resp = await fetchProjectFilesResponse(projectId);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: ProjectFile[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}
