import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { InlineMentionEntity, InlineMentionKind } from '../../utils/inlineMentions';
import { applyMentionBrandHue } from './mentionBrandHueManager';

// Mentions are inline decorators rather than TextNodes. A token-mode TextNode
// still exposes offsets inside its text to both Lexical and the browser (most
// visibly when it is the last child in a paragraph). An inline DecoratorNode is
// one opaque leaf: its text is rendered for display and serialization, while
// collapsed range selections can only live at its parent boundaries.
type Kind = InlineMentionKind;

export interface MentionPayload {
  mentionId: string;
  mentionKind: Kind;
  token: string;
  label: string;
  title?: string | undefined;
}

export type SerializedMentionNode = Spread<
  {
    mentionId: string;
    mentionKind: Kind;
    token: string;
    label: string;
    title?: string;
  },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<string> {
  __mentionId: string;
  __mentionKind: Kind;
  __token: string;
  __label: string;
  __title: string | undefined;

  static getType(): string {
    return 'composer-mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      {
        mentionId: node.__mentionId,
        mentionKind: node.__mentionKind,
        token: node.__token,
        label: node.__label,
        title: node.__title,
      },
      node.__key,
    );
  }

  constructor(p: MentionPayload, key?: NodeKey) {
    super(key);
    this.__mentionId = p.mentionId;
    this.__mentionKind = p.mentionKind;
    this.__token = p.token;
    this.__label = p.label;
    this.__title = p.title;
  }

  getEntity(): InlineMentionEntity {
    return {
      id: this.__mentionId,
      kind: this.__mentionKind,
      label: this.__label,
      token: this.__token,
      ...(this.__title ? { title: this.__title } : {}),
    };
  }

  getToken(): string {
    return this.__token;
  }

  getTextContent(): string {
    return this.__token;
  }

  getTextContentSize(): number {
    return this.__token.length;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('span');
    dom.className = `composer-inline-mention composer-inline-mention--${this.__mentionKind}`;
    dom.setAttribute('data-mention', '');
    dom.setAttribute('data-mention-id', this.__mentionId);
    dom.setAttribute('data-mention-kind', this.__mentionKind);
    dom.setAttribute('data-mention-label', this.__label);
    dom.contentEditable = 'false';
    if (this.__title) dom.setAttribute('title', this.__title);
    this.applyBrandHue(dom);
    return dom;
  }

  updateDOM(prev: MentionNode, dom: HTMLElement): boolean {
    if (prev.__mentionKind !== this.__mentionKind) {
      dom.className = `composer-inline-mention composer-inline-mention--${this.__mentionKind}`;
      dom.setAttribute('data-mention-kind', this.__mentionKind);
      this.applyBrandHue(dom);
    } else if (prev.__label !== this.__label || prev.__mentionId !== this.__mentionId) {
      this.applyBrandHue(dom);
    }
    if (prev.__mentionId !== this.__mentionId) {
      dom.setAttribute('data-mention-id', this.__mentionId);
    }
    if (prev.__label !== this.__label) {
      dom.setAttribute('data-mention-label', this.__label);
    }
    if (prev.__title !== this.__title) {
      if (this.__title) dom.setAttribute('title', this.__title);
      else dom.removeAttribute('title');
    }
    // The decorator string is reconciled separately by Lexical.
    return false;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): string {
    return this.__token;
  }

  isInline(): true {
    return true;
  }

  // Keep node-selection support for keyboard accessibility. Normal collapsed
  // caret movement is handled at the parent boundaries by the composer plugin.
  isKeyboardSelectable(): true {
    return true;
  }

  isIsolated(): true {
    return true;
  }

  isToken(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  private applyBrandHue(dom: HTMLElement): void {
    applyMentionBrandHue(dom, this.__mentionKind, this.__mentionId);
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: MentionNode.getType(),
      version: 1,
      mentionId: this.__mentionId,
      mentionKind: this.__mentionKind,
      token: this.__token,
      label: this.__label,
      ...(this.__title ? { title: this.__title } : {}),
    };
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode({
      mentionId: json.mentionId,
      mentionKind: json.mentionKind,
      token: json.token,
      label: json.label,
      title: json.title,
    });
  }
}

export function $createMentionNode(p: MentionPayload): MentionNode {
  return new MentionNode(p);
}

export function $isMentionNode(n: LexicalNode | null | undefined): n is MentionNode {
  return n instanceof MentionNode;
}
