import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  type EditorState,
} from 'lexical';
import { $isMentionNode } from './MentionNode';
import type { InlineMentionEntity } from '../../utils/inlineMentions';

export interface ComposerMentionSpan {
  start: number;
  end: number;
  entity: InlineMentionEntity;
}

export interface ComposerMentionSnapshot {
  text: string;
  /** UTF-16 offsets, with an exclusive end, for actual committed occurrences. */
  mentions: ComposerMentionSpan[];
}

export interface SerializedComposer extends ComposerMentionSnapshot {
  /** Entities backed by an actual MentionNode currently in the tree. */
  present: InlineMentionEntity[];
}

// Walk the tree by hand rather than calling `root.getTextContent()`, which
// joins block-level children with `\n\n`. The editor is constrained to a
// single paragraph (INSERT_PARAGRAPH is rewritten to a line break), so the
// outer block join is defensive only — when it does fire it uses a single
// `\n` so the wire format never grows a phantom blank line.
export function serializeComposer(state: EditorState): SerializedComposer {
  return state.read(() => {
    const present: InlineMentionEntity[] = [];
    const mentions: ComposerMentionSpan[] = [];
    const blocks: string[] = [];
    let blockOffset = 0;
    for (const block of $getRoot().getChildren()) {
      if (!$isParagraphNode(block)) {
        // Stray non-paragraph block (shouldn't happen): fall back to its text.
        const text = block.getTextContent();
        blocks.push(text);
        blockOffset += text.length + 1;
        continue;
      }
      let line = '';
      for (const child of block.getChildren()) {
        if ($isMentionNode(child)) {
          const token = child.getToken();
          const entity = child.getEntity();
          const start = blockOffset + line.length;
          mentions.push({ start, end: start + token.length, entity });
          line += token;
          present.push(entity);
        } else if ($isLineBreakNode(child)) {
          line += '\n';
        } else if ($isTextNode(child)) {
          line += child.getTextContent();
        } else if ($isElementNode(child)) {
          line += child.getTextContent();
        }
      }
      blocks.push(line);
      blockOffset += line.length + 1;
    }
    return { text: blocks.join('\n'), present, mentions };
  });
}
