import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import { $createMentionNode } from './MentionNode';
import { buildInlineMentionParts, inlineMentionToken, type InlineMentionEntity, type InlineMentionPart } from '../../utils/inlineMentions';
import type { ComposerMentionSnapshot } from './serialize';

// Rebuild the whole editor from a plain `@token` string. Known `@token`
// runs (matched against `entities`) become atomic MentionNodes; everything
// else is plain text. Newlines map to LineBreakNodes inside a single
// paragraph so serialization round-trips to single `\n`. Caret is placed at
// the end inside the same update so post-seed typing keeps the caret.
export function setComposerFromText(
  editor: LexicalEditor,
  text: string,
  entities: InlineMentionEntity[],
): void {
  const parts: InlineMentionPart[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) parts.push({ kind: 'text', text: '\n' });
    parts.push(...(buildInlineMentionParts(line, entities, { highlightUnknown: false })
      ?? [{ kind: 'text', text: line }]));
  });
  setComposerFromParts(editor, parts);
}

export function setComposerFromSnapshot(editor: LexicalEditor, snapshot: ComposerMentionSnapshot): void {
  const parts: InlineMentionPart[] = [];
  let offset = 0;
  for (const { start, end, entity } of snapshot.mentions) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < offset || end <= start || end > snapshot.text.length) continue;
    const token = entity.token ?? inlineMentionToken(entity.label);
    if (entity.kind === 'unknown' || token.includes('\n') || snapshot.text.slice(start, end) !== token) continue;
    if (start > offset) parts.push({ kind: 'text', text: snapshot.text.slice(offset, start) });
    parts.push({ kind: 'mention', text: token, entity });
    offset = end;
  }
  parts.push({ kind: 'text', text: snapshot.text.slice(offset) });
  setComposerFromParts(editor, parts);
}

export function rebaseMentionSnapshot(snapshot: ComposerMentionSnapshot, text: string): ComposerMentionSnapshot {
  const previous = snapshot.text;
  if (text === previous) return snapshot;
  if (!previous) return { text, mentions: [] };
  const embeddedAt = text.indexOf(previous);
  if (embeddedAt > 0 && embeddedAt + previous.length < text.length
    && text.indexOf(previous, embeddedAt + 1) < 0) {
    return { text, mentions: snapshot.mentions.map(span => ({
      ...span, start: span.start + embeddedAt, end: span.end + embeddedAt,
    })) };
  }
  // shortcut: infer one contiguous replacement; independent edits need explicit occurrence spans.
  let prefix = 0;
  while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length && suffix < text.length
    && previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  // Overlapping matches leave the edit position ambiguous in repeated text.
  // Retain only spans outside every possible insertion/deletion position.
  const stablePrefix = Math.min(prefix, Math.min(previous.length, text.length) - suffix);
  const stableSuffix = Math.max(previous.length - suffix, prefix + Math.max(0, previous.length - text.length));
  const delta = text.length - previous.length;
  return { text, mentions: snapshot.mentions.flatMap(span => {
    if (span.end <= stablePrefix) return [span];
    if (span.start >= stableSuffix) return [{ ...span, start: span.start + delta, end: span.end + delta }];
    return [];
  }) };
}

function setComposerFromParts(editor: LexicalEditor, parts: InlineMentionPart[]): void {
  // `discrete: true` commits the update synchronously. This matters both for
  // tests reading the state back on the next line AND for the host's
  // setText/clear → onChange round-trip, where a deferred update could let a
  // stale serialize slip through before the rebuild lands. On a mounted editor
  // it behaves like a normal update (just flushed immediately).
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      for (const part of parts) {
        if (part.kind === 'mention' && part.entity.kind !== 'unknown') {
          p.append(
            $createMentionNode({
              mentionId: part.entity.id,
              mentionKind: part.entity.kind,
              token: part.text,
              label: part.entity.label,
              title: part.entity.title,
            }),
          );
        } else {
          part.text.split('\n').forEach((line, index) => {
            if (index > 0) p.append($createLineBreakNode());
            if (line) p.append($createTextNode(line));
          });
        }
      }
      root.append(p);
      p.selectEnd();
    },
    { discrete: true },
  );
}
