// Session creation for the Hub composer: `POST /api/sessions` creates one
// workspace with one seeded conversation and lists it in the rail folder
// (`folderId`) or, with `null`, under recents as a standalone session.
//
// Same fail-soft contract as `state/projects.ts`: transport errors return
// `null` so the composer can show its own error row.

import type {
  ChatSessionMode,
  ConversationSelection,
  CreateSessionRequest,
  CreateSessionResponse,
  Project,
  ProjectMetadata,
} from '@readable-studio/contracts';
import { randomUUID } from '../utils/uuid';

export interface CreateSessionInput {
  /** Workspace name; the daemon mirrors it onto the session title. */
  name: string;
  /** Rail folder (`null` = standalone, listed in recents). */
  folderId: string | null;
  skillId: string | null;
  designSystemId: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
  conversationMode?: ChatSessionMode;
  selection?: ConversationSelection;
  pluginId?: string;
  appliedPluginSnapshotId?: string;
  pluginInputs?: Record<string, unknown>;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<CreateSessionResponse | null> {
  try {
    // `randomUUID` tolerates non-secure contexts (plain-HTTP LAN hosting),
    // where `crypto.randomUUID` is undefined; see `state/projects.ts`.
    const id = randomUUID();
    const body: CreateSessionRequest & { id: string } = { id, ...input };
    const resp = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as CreateSessionResponse;
  } catch {
    return null;
  }
}

/**
 * Claude Design ZIP import that lands the seeded session in a rail folder.
 * `folderId` travels as a multipart text field next to the file; an empty
 * value means standalone.
 */
export async function importClaudeDesignZipIntoFolder(
  file: File,
  folderId: string | null,
): Promise<{ project: Project; conversationId: string; entryFile: string }> {
  const form = new FormData();
  form.append('file', file);
  if (folderId) form.append('folderId', folderId);
  const resp = await fetch('/api/import/claude-design', { method: 'POST', body: form });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null);
    const message =
      payload != null &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Import failed (${resp.status})`;
    throw new Error(message);
  }
  return (await resp.json()) as { project: Project; conversationId: string; entryFile: string };
}
