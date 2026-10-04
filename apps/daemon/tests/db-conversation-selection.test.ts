import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, getConversation, insertConversation, insertProject, listConversations, openDatabase, updateConversation, upsertMessage } from '../src/db.js';
import { initializeConversationSelection } from '../src/conversation-selection.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'readable-selection-')); });
afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
const first = { agentId: 'codex', agentModels: { codex: { model: 'gpt-5', reasoning: 'high' } } };
const second = { agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } };
function seed() {
  const db = openDatabase(dir, { dataDir: dir });
  insertProject(db, { id: 'p', name: 'P', createdAt: 1, updatedAt: 1 });
  for (const id of ['a', 'b']) insertConversation(db, { id, projectId: 'p', selection: first, createdAt: 1, updatedAt: 1 });
  return db;
}
describe('conversation selection persistence', () => {
  it('initializes older sessions from the last recorded run once, without losing global choices', () => {
    const db = seed();
    updateConversation(db, 'a', { selection: null });
    upsertMessage(db, 'a', { id: 'last-run', role: 'assistant', content: '', agentId: 'claude',
      events: [{ kind: 'status', label: 'initializing', detail: 'recorded-model' }], createdAt: 2 });
    const fallback = { ...first, agentModels: { ...first.agentModels, claude: { model: 'old-global-model', reasoning: 'high' } } };
    const saved = initializeConversationSelection(db, 'a', fallback);
    expect(saved?.selection).toEqual({ agentId: 'claude', agentModels: {
      codex: first.agentModels.codex, claude: { model: 'recorded-model', reasoning: 'high' },
    } });
    expect(initializeConversationSelection(db, 'a', second)?.selection).toEqual(saved?.selection);
    updateConversation(db, 'b', { selection: null });
    expect(initializeConversationSelection(db, 'b', first)?.selection).toEqual(first);
  });
  it('keeps two session selections independent across switch and restart', () => {
    const db = seed();
    updateConversation(db, 'a', { selection: second });
    expect(getConversation(db, 'a')?.selection).toEqual(second);
    expect(getConversation(db, 'b')?.selection).toEqual(first);
    closeDatabase();
    const reopened = openDatabase(dir, { dataDir: dir });
    expect(listConversations(reopened, 'p').find(c => c.id === 'a')?.selection).toEqual(second);
    expect(getConversation(reopened, 'b')?.selection).toEqual(first);
  });
  it('copies the initial recent selection and then diverges without mutating its source', () => {
    const db = seed();
    first.agentModels.codex.model = 'gpt-5-new';
    expect(getConversation(db, 'b')?.selection?.agentModels.codex.model).toBe('gpt-5');
    updateConversation(db, 'b', { selection: { agentId: null, agentModels: {} } });
    expect(getConversation(db, 'b')?.selection).toEqual({ agentId: null, agentModels: {} });
    expect(getConversation(db, 'a')?.selection?.agentModels.codex.model).toBe('gpt-5');
    first.agentModels.codex.model = 'gpt-5';
  });
});
