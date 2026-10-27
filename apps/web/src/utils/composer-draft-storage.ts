import type { ComposerMentionSnapshot, ComposerMentionSpan } from '../components/composer/serialize';
import { inlineMentionToken } from './inlineMentions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only confirmed skill/template occurrences are durable; runtime configuration is not. */
function validatedSkillMentions(value: unknown, text: string): ComposerMentionSpan[] {
  if (!Array.isArray(value)) return [];
  const mentions: ComposerMentionSpan[] = [];
  let previousEnd = 0;
  for (const valueSpan of value) {
    if (!isRecord(valueSpan) || !isRecord(valueSpan.entity)) return [];
    const { start, end, entity } = valueSpan;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
      || start < previousEnd || end <= start || end > text.length) return [];
    if (entity.kind !== 'skill' || typeof entity.id !== 'string' || !entity.id
      || typeof entity.label !== 'string' || !entity.label) return [];
    const token = entity.token === undefined ? inlineMentionToken(entity.label) : entity.token;
    if (typeof token !== 'string' || !token.startsWith('@') || /[\r\n]/.test(token)
      || text.slice(start, end) !== token) return [];
    mentions.push({ start, end, entity: { kind: 'skill', id: entity.id, label: entity.label, token } });
    previousEnd = end;
  }
  return mentions;
}

export function skillMentionSnapshot(snapshot: ComposerMentionSnapshot): ComposerMentionSnapshot {
  return {
    text: snapshot.text,
    mentions: validatedSkillMentions(snapshot.mentions.filter(span => span.entity.kind === 'skill'), snapshot.text),
  };
}

/** Keep the original key as plain text for older versions and existing consumers. */
export function loadComposerDraft(key?: string): ComposerMentionSnapshot {
  let text = '';
  if (!key || typeof window === 'undefined') return { text, mentions: [] };
  try {
    text = window.localStorage.getItem(key) ?? '';
    const raw = window.localStorage.getItem(`${key}:mentions`);
    if (!text || !raw) return { text, mentions: [] };
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored) || stored.version !== 1 || stored.text !== text) return { text, mentions: [] };
    return { text, mentions: validatedSkillMentions(stored.mentions, text) };
  } catch {
    return { text, mentions: [] };
  }
}

export function clearComposerDraftMentions(key?: string): void {
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.removeItem(`${key}:mentions`); } catch { /* Storage is optional. */ }
}

export function saveComposerDraft(key: string | undefined, snapshot: ComposerMentionSnapshot): void {
  if (!key || typeof window === 'undefined') return;
  try {
    // Invalidate first: a failed replacement must never reuse old bindings for
    // identical text after Undo.
    window.localStorage.removeItem(`${key}:mentions`);
    if (!snapshot.text) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, snapshot.text);
    const safe = skillMentionSnapshot(snapshot);
    if (safe.mentions.length) window.localStorage.setItem(`${key}:mentions`, JSON.stringify({ version: 1, ...safe }));
  } catch {
    // Storage can be unavailable in privacy modes; the composer still works.
  }
}
