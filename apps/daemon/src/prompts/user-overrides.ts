import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  EditableSystemPrompt,
  EditableSystemPromptId,
} from '@readable-studio/contracts';
import { DECK_FRAMEWORK_DIRECTIVE, DECK_SKELETON_HTML } from './deck-framework.js';
import { DISCOVERY_AND_PHILOSOPHY } from './discovery.js';
import { renderDirectionSpecBlock } from './directions.js';
import { OFFICIAL_DESIGNER_PROMPT } from './official-system.js';

export const DIRECTION_LIBRARY_PLACEHOLDER = '{{DIRECTION_LIBRARY}}';
export const DECK_SKELETON_PLACEHOLDER = '{{DECK_SKELETON_HTML}}';

interface PromptDefinition {
  id: EditableSystemPromptId;
  label: string;
  description: string;
  defaultContent: string;
  requiredPlaceholders: string[];
  render: (content: string) => string;
}

function replaceExactlyOnce(source: string, rendered: string, placeholder: string): string {
  const first = source.indexOf(rendered);
  if (first < 0 || source.indexOf(rendered, first + rendered.length) >= 0) {
    throw new Error(`Shipped prompt cannot be converted to editable template: ${placeholder}`);
  }
  return source.slice(0, first) + placeholder + source.slice(first + rendered.length);
}

const directionLibrary = renderDirectionSpecBlock();
const discoveryTemplate = replaceExactlyOnce(
  DISCOVERY_AND_PHILOSOPHY,
  directionLibrary,
  DIRECTION_LIBRARY_PLACEHOLDER,
);
const deckTemplate = replaceExactlyOnce(
  DECK_FRAMEWORK_DIRECTIVE,
  DECK_SKELETON_HTML,
  DECK_SKELETON_PLACEHOLDER,
);

const DEFINITIONS: readonly PromptDefinition[] = [
  {
    id: 'designer-charter',
    label: 'Designer charter',
    description: 'Base identity, design workflow, content philosophy, and artifact handoff guidance.',
    defaultContent: OFFICIAL_DESIGNER_PROMPT,
    requiredPlaceholders: [],
    render: (content) => content,
  },
  {
    id: 'discovery-workflow',
    label: 'Discovery and artifact workflow',
    description: 'First-turn discovery, artifact-specific roles, planning, brand handling, and quality rules.',
    defaultContent: discoveryTemplate,
    requiredPlaceholders: [DIRECTION_LIBRARY_PLACEHOLDER],
    render: (content) => content.replace(DIRECTION_LIBRARY_PLACEHOLDER, directionLibrary),
  },
  {
    id: 'deck-framework',
    label: 'Slide deck framework',
    description: 'Deck-specific authoring rules and the canonical navigation, scaling, and print scaffold.',
    defaultContent: deckTemplate,
    requiredPlaceholders: [DECK_SKELETON_PLACEHOLDER],
    render: (content) => content.replace(DECK_SKELETON_PLACEHOLDER, DECK_SKELETON_HTML),
  },
];

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));
const STORE_FILE = 'system-prompt-overrides.json';
const writeLocks = new Map<string, Promise<unknown>>();

type OverrideStore = {
  version: 1;
  overrides: Partial<Record<EditableSystemPromptId, string>>;
};

export class UnknownSystemPromptError extends Error {
  constructor(readonly promptId: string) {
    super(`Unknown editable system prompt: ${promptId}`);
  }
}

export class SystemPromptValidationError extends Error {
  readonly code = 'INVALID_SYSTEM_PROMPT';
  constructor(
    message: string,
    readonly missingPlaceholders: string[],
    readonly duplicatePlaceholders: string[],
  ) {
    super(message);
  }
}

function storePath(dataDir: string): string {
  return path.join(dataDir, STORE_FILE);
}

function definitionFor(id: string): PromptDefinition {
  const definition = BY_ID.get(id as EditableSystemPromptId);
  if (!definition) throw new UnknownSystemPromptError(id);
  return definition;
}

function countOccurrences(content: string, token: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(token, offset)) >= 0) {
    count++;
    offset += token.length;
  }
  return count;
}

export function validateSystemPromptOverride(id: string, content: unknown): string {
  const definition = definitionFor(id);
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SystemPromptValidationError('System prompt content must be a non-empty string.', [], []);
  }
  const missingPlaceholders = definition.requiredPlaceholders.filter(
    (placeholder) => countOccurrences(content, placeholder) === 0,
  );
  const duplicatePlaceholders = definition.requiredPlaceholders.filter(
    (placeholder) => countOccurrences(content, placeholder) > 1,
  );
  if (missingPlaceholders.length > 0 || duplicatePlaceholders.length > 0) {
    const details = [
      missingPlaceholders.length ? `missing: ${missingPlaceholders.join(', ')}` : '',
      duplicatePlaceholders.length ? `duplicated: ${duplicatePlaceholders.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new SystemPromptValidationError(`Required template placeholders are invalid (${details}).`, missingPlaceholders, duplicatePlaceholders);
  }
  return content;
}

async function readStore(dataDir: string): Promise<OverrideStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(dataDir), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, overrides: {} };
    const raw = (parsed as { overrides?: unknown }).overrides;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, overrides: {} };
    const overrides: OverrideStore['overrides'] = {};
    for (const definition of DEFINITIONS) {
      const value = (raw as Record<string, unknown>)[definition.id];
      try {
        if (typeof value === 'string') overrides[definition.id] = validateSystemPromptOverride(definition.id, value);
      } catch (error) {
        if (!(error instanceof SystemPromptValidationError)) throw error;
        console.warn(`[system-prompts] Ignoring invalid persisted override for ${definition.id}: ${error.message}`);
      }
    }
    return { version: 1, overrides };
  } catch (error) {
    const cause = error as { code?: string; name?: string; message?: string };
    if (cause.code === 'ENOENT') return { version: 1, overrides: {} };
    if (cause.name === 'SyntaxError') {
      console.warn(`[system-prompts] Ignoring corrupted override store: ${cause.message ?? 'invalid JSON'}`);
      return { version: 1, overrides: {} };
    }
    throw error;
  }
}

async function writeStore(dataDir: string, store: OverrideStore): Promise<void> {
  const file = storePath(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(temporary, file);
}

async function withWriteLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(dataDir) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeLocks.set(dataDir, current);
  try {
    return await current;
  } finally {
    if (writeLocks.get(dataDir) === current) writeLocks.delete(dataDir);
  }
}

function toContract(definition: PromptDefinition, override: string | undefined): EditableSystemPrompt {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    content: override ?? definition.defaultContent,
    defaultContent: definition.defaultContent,
    overridden: override !== undefined,
    requiredPlaceholders: [...definition.requiredPlaceholders],
  };
}

export async function listEditableSystemPrompts(dataDir: string): Promise<EditableSystemPrompt[]> {
  const store = await readStore(dataDir);
  return DEFINITIONS.map((definition) => toContract(definition, store.overrides[definition.id]));
}

export async function readEditableSystemPrompt(dataDir: string, id: string): Promise<EditableSystemPrompt> {
  const definition = definitionFor(id);
  const store = await readStore(dataDir);
  return toContract(definition, store.overrides[definition.id]);
}

export async function updateSystemPromptOverride(dataDir: string, id: string, content: unknown): Promise<EditableSystemPrompt> {
  const definition = definitionFor(id);
  const validated = validateSystemPromptOverride(id, content);
  return withWriteLock(dataDir, async () => {
    const store = await readStore(dataDir);
    store.overrides[definition.id] = validated;
    await writeStore(dataDir, store);
    return toContract(definition, validated);
  });
}

export async function resetSystemPromptOverride(dataDir: string, id: string): Promise<EditableSystemPrompt> {
  const definition = definitionFor(id);
  return withWriteLock(dataDir, async () => {
    const store = await readStore(dataDir);
    delete store.overrides[definition.id];
    await writeStore(dataDir, store);
    return toContract(definition, undefined);
  });
}

/** Resolve editable templates to the concrete strings injected into a run. */
export async function readEffectiveSystemPromptBodies(dataDir: string): Promise<Record<EditableSystemPromptId, string>> {
  const store = await readStore(dataDir);
  return Object.fromEntries(DEFINITIONS.map((definition) => {
    const template = store.overrides[definition.id] ?? definition.defaultContent;
    return [definition.id, definition.render(template)];
  })) as Record<EditableSystemPromptId, string>;
}
