import type http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, getConversation, listMessages, openDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';

describe('deleting a last-message fork through the session delete endpoint', () => {
  let server: http.Server;
  let baseUrl: string;
  const dataDir = process.env.READABLE_DATA_DIR;
  if (!dataDir) throw new Error('isolated READABLE_DATA_DIR required');

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { server: http.Server; url: string };
    server = started.server;
    baseUrl = started.url;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  for (const deleted of ['fork', 'original'] as const) {
    it(`keeps the ${deleted === 'fork' ? 'original' : 'fork'} and shared project files when deleting the ${deleted}`, async () => {
      // Given: one project with an agent-produced file and a completed final assistant turn.
      const projectId = crypto.randomUUID();
      const post = (url: string, body: object) => fetch(`${baseUrl}${url}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const projectResponse = await post('/api/projects', { id: projectId, name: 'Shared project' });
      expect(projectResponse.status).toBe(200);
      const projectDir = path.join(dataDir, 'projects', projectId);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(path.join(projectDir, 'agent-output.txt'), 'agent work');
      const conversations = `/api/projects/${projectId}/conversations`;
      const lastId = `last-${projectId}`;
      const firstId = `first-${projectId}`;
      const originalResponse = await post(conversations, { title: 'Original' });
      expect(originalResponse.status).toBe(200);
      const original = (await originalResponse.json()) as { conversation: { id: string; title: string } };
      for (const [id, role, content] of [
        [firstId, 'user', 'do the work'], [lastId, 'assistant', 'completed work'],
      ]) {
        const response = await fetch(`${baseUrl}${conversations}/${original.conversation.id}/messages/${id}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, role, content, producedFiles: role === 'assistant' ? ['agent-output.txt'] : [] }),
        });
        expect(response.status).toBe(200);
      }
      // When: fork FROM the last message, then delete one side through the left-rail endpoint.
      const forkResponse = await post(conversations, {
        title: 'Fork', seedFromConversationId: original.conversation.id, forkAfterMessageId: lastId,
        seedMessages: [
          { id: firstId, role: 'user', content: 'do the work' },
          { id: lastId, role: 'assistant', content: 'completed work', producedFiles: ['agent-output.txt'] },
        ],
      });
      expect(forkResponse.status).toBe(200);
      const fork = (await forkResponse.json()) as { conversation: { id: string; title: string } };
      const victimId = deleted === 'fork' ? fork.conversation.id : original.conversation.id;
      const survivor = deleted === 'fork' ? original.conversation : fork.conversation;
      const deleteResponse = await fetch(`${baseUrl}${conversations}/${victimId}`, { method: 'DELETE' });
      expect(deleteResponse.status).toBe(200);
      // Then: only the selected conversation and its exclusively owned message rows are gone.
      const db = openDatabase('', { dataDir });
      expect(getConversation(db, victimId)).toBeNull();
      expect(getConversation(db, survivor.id)?.title).toBe(survivor.title);
      expect(listMessages(db, survivor.id).map((message) => [message.role, message.content]))
        .toEqual([['user', 'do the work'], ['assistant', 'completed work']]);
      expect(existsSync(projectDir)).toBe(true);
      expect(readFileSync(path.join(projectDir, 'agent-output.txt'), 'utf8')).toBe('agent work');
    });
  }
});
