import type {
  HostedAgentCatalogueResponse,
  HostedDesignSystemDetail,
  HostedDesignSystemResponse,
  HostedDesignSystemSummary,
  HostedDesignSystemsResponse,
  HostedSkillDetail,
  HostedSkillFileEntry,
  HostedSkillFilesResponse,
  HostedSkillResponse,
  HostedSkillSummary,
  HostedSkillsResponse,
} from '@readable-studio/contracts';
import { isSafeId } from './projects.js';

const MAX_AGENTS = 64;
const MAX_SKILLS = 500;
const MAX_DESIGN_SYSTEMS = 256;
const MAX_SKILL_FILES = 500;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FRAME_REFERENCE = /\/frames(?:\/[^\s"'`()<>]*)?/giu;
const WINDOWS_ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`()<>]*/gu;
const COMMON_POSIX_SOURCE_PATH = /\/(?:Users|home|tmp|workspace|workspaces)\/[^\s"'`()<>]*/gu;

export interface HostedCatalogueSnapshot {
  readonly agents: readonly unknown[];
  readonly skills: readonly unknown[];
  readonly skillFiles?: Readonly<Record<string, readonly unknown[]>>;
  readonly designSystems: readonly unknown[];
  readonly designSystemFiles?: Readonly<Record<string, readonly {
    readonly path: string;
    readonly content: string;
  }[]>>;
}

export type HostedCatalogueRequest =
  | { readonly kind: 'agents.list' }
  | { readonly kind: 'skills.list' }
  | { readonly kind: 'skill.get'; readonly id: string }
  | { readonly kind: 'skill.files'; readonly id: string }
  | { readonly kind: 'designSystems.list' }
  | { readonly kind: 'designSystem.get'; readonly id: string };

export type HostedCatalogueResponse =
  | HostedAgentCatalogueResponse
  | HostedSkillsResponse
  | HostedSkillResponse
  | HostedSkillFilesResponse
  | HostedDesignSystemsResponse
  | HostedDesignSystemResponse;

export class HostedCatalogueAdapterError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'HostedCatalogueAdapterError';
  }
}

/**
 * Builds a read-only hosted catalogue from one repository-owned snapshot.
 * The adapter copies and freezes its curated DTOs; local registries and
 * filesystem-backed source metadata never become part of the interface.
 */
export function createHostedCatalogueAdapter(snapshot: HostedCatalogueSnapshot): {
  dispatch(request: unknown): HostedCatalogueResponse;
} {
  const input = validateSnapshot(snapshot);
  const agents = uniqueEntries(input.agents.map(agentEntry).filter(isPresent), 'agent');
  const skills = uniqueEntries(input.skills.map(skillEntry).filter(isPresent), 'skill');
  const designSystems = uniqueEntries(
    input.designSystems.map(designSystemEntry).filter(isPresent),
    'design system',
  );
  limit(agents, MAX_AGENTS, 'agent catalogue');
  limit(skills, MAX_SKILLS, 'skill catalogue');
  limit(designSystems, MAX_DESIGN_SYSTEMS, 'design-system catalogue');

  const skillById = new Map(skills.map((skill) => [skill.id, deepFreeze(skill)]));
  const systemById = new Map(designSystems.map((system) => [system.id, deepFreeze(system)]));
  const filesBySkillId = new Map<string, readonly HostedSkillFileEntry[]>();
  for (const skill of skills) {
    const rawFiles = input.skillFiles !== undefined && Object.hasOwn(input.skillFiles, skill.id)
      ? input.skillFiles[skill.id]
      : undefined;
    if (rawFiles === undefined) {
      filesBySkillId.set(skill.id, deepFreeze([]));
      continue;
    }
    if (!Array.isArray(rawFiles)) throw internalError('skill file snapshot is invalid');
    const files = rawFiles.map(skillFileEntry).filter(isPresent);
    limit(files, MAX_SKILL_FILES, 'skill file response');
    filesBySkillId.set(skill.id, deepFreeze(files));
  }

  const agentResponse = boundedResponse({ agents: agents.map(({ id, name }) => ({ id, name })) });
  const skillsResponse = boundedResponse({
    skills: skills.map(({ body: _body, ...summary }) => summary),
  }) as HostedSkillsResponse;
  const systemsResponse = boundedResponse({
    designSystems: designSystems.map(({ body: _body, ...summary }) => summary),
  }) as HostedDesignSystemsResponse;

  return Object.freeze({
    dispatch(request: unknown): HostedCatalogueResponse {
      const operation = validateRequest(request);
      switch (operation.kind) {
        case 'agents.list':
          return agentResponse;
        case 'skills.list':
          return skillsResponse;
        case 'skill.get': {
          const skill = skillById.get(operation.id);
          if (skill === undefined) throw notFound('skill not found');
          return boundedResponse({ skill }) as HostedSkillResponse;
        }
        case 'skill.files': {
          if (!skillById.has(operation.id)) throw notFound('skill not found');
          return boundedResponse({
            files: filesBySkillId.get(operation.id) ?? [],
          }) as HostedSkillFilesResponse;
        }
        case 'designSystems.list':
          return systemsResponse;
        case 'designSystem.get': {
          const designSystem = systemById.get(operation.id);
          if (designSystem === undefined) throw notFound('design system not found');
          return boundedResponse({ designSystem }) as HostedDesignSystemResponse;
        }
      }
    },
  });
}

function validateSnapshot(snapshot: HostedCatalogueSnapshot): HostedCatalogueSnapshot {
  if (!isRecord(snapshot)
    || !Array.isArray(snapshot.agents)
    || !Array.isArray(snapshot.skills)
    || !Array.isArray(snapshot.designSystems)
    || (snapshot.skillFiles !== undefined
      && (!isRecord(snapshot.skillFiles) || Array.isArray(snapshot.skillFiles)))) {
    throw internalError('hosted catalogue snapshot is invalid');
  }
  return snapshot;
}

function validateRequest(request: unknown): HostedCatalogueRequest {
  if (!isRecord(request)) throw badRequest('hosted catalogue request must be an object');
  switch (request.kind) {
    case 'agents.list':
    case 'skills.list':
    case 'designSystems.list':
      exactKeys(request, ['kind']);
      return { kind: request.kind };
    case 'skill.get':
    case 'skill.files':
    case 'designSystem.get':
      exactKeys(request, ['kind', 'id']);
      return { kind: request.kind, id: requestId(request.id) };
    default:
      throw badRequest('hosted catalogue operation is not enabled');
  }
}

function agentEntry(input: unknown): { id: string; name: string } | null {
  if (!isRecord(input) || !isRepositorySource(input.source)) return null;
  const id = safeId(input.id);
  const name = text(input.name, 1, 256);
  return id === null || name === null ? null : { id, name };
}

function skillEntry(input: unknown): HostedSkillDetail | null {
  if (!isRecord(input) || input.source !== 'built-in') return null;
  const id = safeId(input.id);
  const name = text(input.name, 1, 256);
  const description = text(input.description, 0, 4_096);
  const triggers = stringArray(input.triggers, 128, 256);
  const previewType = text(input.previewType, 1, 128);
  const defaultFor = idArray(input.defaultFor, 128);
  const examplePrompt = text(input.examplePrompt, 0, 4_096);
  const body = text(input.body, 0, MAX_BODY_BYTES);
  if (id === null || name === null || description === null || triggers === null
    || !isSkillMode(input.mode) || previewType === null
    || typeof input.designSystemRequired !== 'boolean' || defaultFor === null
    || examplePrompt === null || typeof input.aggregatesExamples !== 'boolean' || body === null) {
    return null;
  }
  const displayName = localizedStrings(input.displayName);
  const descriptionI18n = localizedStrings(input.descriptionI18n);
  const examplePromptI18n = localizedStrings(input.examplePromptI18n);
  const surface = isSurface(input.surface) ? input.surface : undefined;
  const platform = input.platform === 'desktop' || input.platform === 'mobile' || input.platform === null
    ? input.platform
    : undefined;
  const category = input.category === null ? null : optionalText(input.category, 128);
  const featured = input.featured === null ? null : optionalFiniteNumber(input.featured);
  const fidelity = input.fidelity === 'wireframe' || input.fidelity === 'high-fidelity'
    || input.fidelity === null ? input.fidelity : undefined;
  const speakerNotes = input.speakerNotes === null || typeof input.speakerNotes === 'boolean'
    ? input.speakerNotes : undefined;
  const animations = input.animations === null || typeof input.animations === 'boolean'
    ? input.animations : undefined;
  const craftRequires = input.craftRequires === undefined
    ? undefined
    : idArray(input.craftRequires, 128) ?? undefined;
  return {
    id,
    name,
    ...(displayName === undefined ? {} : { displayName }),
    description,
    ...(descriptionI18n === undefined ? {} : { descriptionI18n }),
    triggers,
    mode: input.mode,
    ...(surface === undefined ? {} : { surface }),
    ...(platform === undefined ? {} : { platform }),
    ...(category === undefined ? {} : { category }),
    previewType,
    designSystemRequired: input.designSystemRequired,
    defaultFor,
    ...(featured === undefined ? {} : { featured }),
    ...(fidelity === undefined ? {} : { fidelity }),
    ...(speakerNotes === undefined ? {} : { speakerNotes }),
    ...(animations === undefined ? {} : { animations }),
    ...(craftRequires === undefined ? {} : { craftRequires }),
    hasBody: body.length > 0,
    examplePrompt,
    ...(examplePromptI18n === undefined ? {} : { examplePromptI18n }),
    aggregatesExamples: input.aggregatesExamples,
    body,
  };
}

function skillFileEntry(input: unknown): HostedSkillFileEntry | null {
  if (!isRecord(input) || !relativePath(input.path)) return null;
  if (input.kind !== 'file' && input.kind !== 'directory') return null;
  if (input.size !== null && (!Number.isSafeInteger(input.size) || (input.size as number) < 0)) {
    return null;
  }
  return { path: input.path as string, kind: input.kind, size: input.size as number | null };
}

function designSystemEntry(input: unknown): HostedDesignSystemDetail | null {
  if (!isRecord(input) || input.source !== 'built-in' || input.status === 'draft') return null;
  const id = safeId(input.id);
  const title = text(input.title, 1, 256);
  const category = text(input.category, 1, 128);
  const summary = text(input.summary, 0, 4_096);
  const body = text(input.body, 0, MAX_BODY_BYTES);
  if (id === null || title === null || category === null || summary === null || body === null) return null;
  const swatches = input.swatches === undefined ? undefined : stringArray(input.swatches, 64, 256);
  if (input.swatches !== undefined && swatches === null) return null;
  const surface = isSurface(input.surface) ? input.surface : undefined;
  return {
    id,
    title,
    category,
    summary,
    ...(swatches === undefined || swatches === null ? {} : { swatches }),
    ...(surface === undefined ? {} : { surface }),
    ...(input.status === 'published' ? { status: 'published' as const } : {}),
    body,
  };
}

function isRepositorySource(value: unknown): boolean {
  return value === 'repository' || value === 'built-in';
}

function isSkillMode(value: unknown): value is HostedSkillSummary['mode'] {
  return value === 'prototype' || value === 'deck' || value === 'template'
    || value === 'design-system' || value === 'image' || value === 'video' || value === 'audio';
}

function isSurface(value: unknown): value is 'web' | 'image' | 'video' | 'audio' {
  return value === 'web' || value === 'image' || value === 'video' || value === 'audio';
}

function localizedStrings(input: unknown): Record<string, string> | undefined {
  if (input === undefined || !isRecord(input)) return undefined;
  const entries = Object.entries(input);
  if (entries.length > 32) return undefined;
  const output: Record<string, string> = {};
  for (const [locale, value] of entries) {
    const localized = text(value, 0, 4_096);
    if (!/^[A-Za-z0-9-]{1,35}$/u.test(locale) || localized === null) return undefined;
    output[locale] = localized;
  }
  return output;
}

function idArray(input: unknown, max: number): string[] | null {
  if (!Array.isArray(input) || input.length > max) return null;
  const output = input.map(safeId);
  return output.some((value) => value === null) ? null : output as string[];
}

function stringArray(input: unknown, max: number, maxStringBytes: number): string[] | null {
  if (!Array.isArray(input) || input.length > max) return null;
  const output = input.map((value) => text(value, 0, maxStringBytes));
  return output.some((value) => value === null) ? null : output as string[];
}

function safeId(input: unknown): string | null {
  return isSafeId(input) ? input as string : null;
}

function requestId(input: unknown): string {
  const id = safeId(input);
  if (id === null) throw badRequest('catalogue id is invalid');
  return id;
}

function optionalText(input: unknown, maxBytes: number): string | undefined {
  return input === undefined ? undefined : text(input, 0, maxBytes) ?? undefined;
}

function optionalFiniteNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function text(input: unknown, minBytes: number, maxBytes: number): string | null {
  if (typeof input !== 'string' || input.includes('\0')
    || Buffer.from(input, 'utf8').toString('utf8') !== input) return null;
  const sanitized = input
    .replace(FRAME_REFERENCE, '#')
    .replace(WINDOWS_ABSOLUTE_PATH, '[path removed]')
    .replace(COMMON_POSIX_SOURCE_PATH, '[path removed]');
  const bytes = Buffer.byteLength(sanitized, 'utf8');
  return bytes >= minBytes && bytes <= maxBytes ? sanitized : null;
}

function relativePath(input: unknown): boolean {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') < 1
    || Buffer.byteLength(input, 'utf8') > 1_024 || /[\\\u0000-\u001f\u007f]/u.test(input)
    || input.startsWith('/') || /^[A-Za-z]:/u.test(input)) return false;
  return input.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function uniqueEntries<T extends { id: string }>(entries: T[], name: string): T[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw internalError(`duplicate hosted ${name} id`);
    ids.add(entry.id);
  }
  return entries;
}

function limit(values: readonly unknown[], max: number, name: string): void {
  if (values.length > max) throw internalError(`${name} exceeds its hosted bound`);
}

function boundedResponse<T>(response: T): T {
  let encoded: string;
  try {
    encoded = JSON.stringify(response);
  } catch {
    throw internalError('hosted catalogue response is not JSON');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) {
    throw internalError('hosted catalogue response exceeds its bound');
  }
  return deepFreeze(response);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw badRequest('hosted catalogue request contains unsupported fields');
  }
}

function badRequest(message: string): HostedCatalogueAdapterError {
  return new HostedCatalogueAdapterError('BAD_REQUEST', message);
}

function notFound(message: string): HostedCatalogueAdapterError {
  return new HostedCatalogueAdapterError('NOT_FOUND', message);
}

function internalError(message: string): HostedCatalogueAdapterError {
  return new HostedCatalogueAdapterError('INTERNAL_ERROR', message);
}
