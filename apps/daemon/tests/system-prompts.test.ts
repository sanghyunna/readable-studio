import type http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SystemPromptResponse, SystemPromptsResponse } from '@readable-studio/contracts';
import { startServer } from '../src/server.js';
import { composeSystemPrompt } from '../src/prompts/system.js';
import {
  DECK_SKELETON_PLACEHOLDER,
  DIRECTION_LIBRARY_PLACEHOLDER,
  readEditableSystemPrompt,
  readEffectiveSystemPromptBodies,
  resetSystemPromptOverride,
  updateSystemPromptOverride,
} from '../src/prompts/user-overrides.js';

const dataDir = process.env.READABLE_DATA_DIR as string;
const storeFile = path.join(dataDir, 'system-prompt-overrides.json');
const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(daemonRoot, '../..');
const cliSource = path.join(daemonRoot, 'src', 'cli.ts');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let baseUrl: string;
let server: http.Server;
let shutdown: (() => Promise<void> | void) | undefined;

beforeAll(async () => {
  const started = await startServer({ port: 0, returnServer: true }) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(async () => {
  await rm(storeFile, { force: true });
});

async function runCli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cliSource, ...args], {
      cwd: daemonRoot,
      env: { ...process.env, READABLE_DAEMON_URL: baseUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('editable system prompts', () => {
  it('round-trips an override while retaining and exactly restoring the shipped default', async () => {
    const original = await readEditableSystemPrompt(dataDir, 'discovery-workflow');
    expect(original.overridden).toBe(false);
    expect(original.content).toBe(original.defaultContent);
    expect(original.requiredPlaceholders).toEqual([DIRECTION_LIBRARY_PLACEHOLDER]);

    const custom = `Custom discovery rules\n\n${DIRECTION_LIBRARY_PLACEHOLDER}\n`;
    const updated = await updateSystemPromptOverride(dataDir, original.id, custom);
    expect(updated.content).toBe(custom);
    expect(updated.overridden).toBe(true);
    expect(updated.defaultContent).toBe(original.defaultContent);

    const effective = await readEffectiveSystemPromptBodies(dataDir);
    expect(effective['discovery-workflow']).toContain('## Direction library');
    expect(effective['discovery-workflow']).not.toContain(DIRECTION_LIBRARY_PLACEHOLDER);
    const composed = composeSystemPrompt({ editablePromptBodies: effective });
    expect(composed).toContain('Custom discovery rules');
    expect(composed).not.toContain('# Readable Studio core directives');

    const reset = await resetSystemPromptOverride(dataDir, original.id);
    expect(reset.overridden).toBe(false);
    expect(reset.content).toBe(original.defaultContent);
    expect(reset.defaultContent).toBe(original.defaultContent);
  });

  it('rejects an override that drops a required placeholder without changing the effective prompt', async () => {
    const before = await readEffectiveSystemPromptBodies(dataDir);
    const response = await fetch(`${baseUrl}/api/system-prompts/deck-framework`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Deck instructions without the required scaffold.' }),
    });
    expect(response.status).toBe(400);
    const payload = await response.json() as {
      error: { code: string; missingPlaceholders: string[] };
    };
    expect(payload.error).toEqual(expect.objectContaining({
      code: 'INVALID_SYSTEM_PROMPT',
      missingPlaceholders: [DECK_SKELETON_PLACEHOLDER],
    }));
    expect(await readEffectiveSystemPromptBodies(dataDir)).toEqual(before);
  });

  it('lists, reads, updates, and resets through the HTTP API', async () => {
    const listResponse = await fetch(`${baseUrl}/api/system-prompts`);
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as SystemPromptsResponse;
    expect(list.prompts.map((prompt) => prompt.id)).toEqual([
      'designer-charter',
      'discovery-workflow',
      'deck-framework',
    ]);

    const content = 'My persistent designer charter.\n';
    const updateResponse = await fetch(`${baseUrl}/api/system-prompts/designer-charter`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const updated = await updateResponse.json() as SystemPromptResponse;
    expect(updated.prompt).toEqual(expect.objectContaining({ content, overridden: true }));

    const getResponse = await fetch(`${baseUrl}/api/system-prompts/designer-charter`);
    const fetched = await getResponse.json() as SystemPromptResponse;
    expect(fetched.prompt.content).toBe(content);

    const resetResponse = await fetch(`${baseUrl}/api/system-prompts/designer-charter`, { method: 'DELETE' });
    const reset = await resetResponse.json() as SystemPromptResponse;
    expect(reset.prompt.overridden).toBe(false);
    expect(reset.prompt.content).toBe(reset.prompt.defaultContent);
  });

  it('exercises CLI JSON listing and --prompt-file stdin update', async () => {
    const list = await runCli(['system-prompts', 'list', '--json']);
    expect(list.code).toBe(0);
    expect(list.stderr).toBe('');
    expect((JSON.parse(list.stdout) as SystemPromptsResponse).prompts).toHaveLength(3);

    const content = 'CLI supplied charter.\n';
    const set = await runCli([
      'system-prompts', 'set', 'designer-charter', '--prompt-file', '-', '--json',
    ], content);
    expect(set.code).toBe(0);
    expect(set.stderr).toBe('');
    const payload = JSON.parse(set.stdout) as SystemPromptResponse;
    expect(payload.prompt).toEqual(expect.objectContaining({ content, overridden: true }));

    const temp = await mkdtemp(path.join(tmpdir(), 'readable-system-prompts-'));
    try {
      const promptFile = path.join(temp, 'prompt.md');
      await writeFile(promptFile, `CLI deck override\n${DECK_SKELETON_PLACEHOLDER}\n`, 'utf8');
      const fileSet = await runCli([
        'system-prompts', 'set', 'deck-framework', '--prompt-file', promptFile, '--json',
      ]);
      expect(fileSet.code).toBe(0);
      expect((JSON.parse(fileSet.stdout) as SystemPromptResponse).prompt.overridden).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
