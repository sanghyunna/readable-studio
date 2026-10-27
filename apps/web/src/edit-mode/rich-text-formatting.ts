export const MANUAL_EDIT_RICH_TEXT_FORMAT_CSS = '@layer readableTextFormat{[data-readable-text-format]{display:inline!important;font:inherit!important;color:inherit!important;letter-spacing:inherit!important;line-height:inherit!important;text-transform:inherit!important;text-shadow:inherit!important}[data-readable-text-underline="off"]{text-decoration-line:none!important}}';

// Kept self-contained so the iframe bridge can serialize this function.
export function createManualEditRichTextFormatter(doc: Document, root: HTMLElement, css: string): {
  format(command: string): boolean;
  dispose(): void;
} {
  const win = doc.defaultView;
  type Position = { anchor: number; focus: number };
  type FormatRecord = { beforeHtml: string; afterHtml: string; beforeSelection: Position; afterSelection: Position };
  const records: FormatRecord[] = [];
  let pendingHistory: { inputType: string; html: string } | null = null;
  let disposed = false;

  function ensureStyles(): void {
    let style = doc.querySelector<HTMLStyleElement>('style[data-readable-text-format-style="1"]');
    if (!style) {
      style = doc.createElement('style');
      style.setAttribute('data-readable-text-format-style', '1');
    }
    if (style !== doc.head.firstChild) doc.head.prepend(style);
    if (style.textContent !== css) style.textContent = css;
  }

  function textOffset(node: Node, offset: number): number {
    const range = doc.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    const fragment = range.cloneContents();
    return (fragment.textContent?.length ?? 0) + fragment.querySelectorAll('br').length;
  }

  function captureSelection(): Position | null {
    const selection = win?.getSelection();
    if (!selection?.anchorNode || !selection.focusNode
      || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
    return {
      anchor: textOffset(selection.anchorNode, selection.anchorOffset),
      focus: textOffset(selection.focusNode, selection.focusOffset),
    };
  }

  function textPoint(offset: number, forward: boolean): { node: Node; offset: number } {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let last: Node | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const lineBreak = node.nodeName === 'BR';
      if (!lineBreak && node.nodeType !== Node.TEXT_NODE) continue;
      last = node;
      const length = lineBreak ? 1 : node.textContent?.length ?? 0;
      if (offset < length || (offset === length && !forward)) {
        return lineBreak
          ? { node: node.parentNode!, offset: Array.prototype.indexOf.call(node.parentNode!.childNodes, node) + offset }
          : { node, offset };
      }
      offset -= length;
    }
    return last?.nodeName === 'BR'
      ? { node: last.parentNode!, offset: Array.prototype.indexOf.call(last.parentNode!.childNodes, last) + 1 }
      : last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: root, offset: 0 };
  }

  function restoreSelection(position: Position): void {
    const anchor = textPoint(position.anchor, position.anchor <= position.focus);
    const focus = textPoint(position.focus, position.focus < position.anchor);
    win?.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  function fullySelected(element: Element, range: Range): boolean {
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let first: Node | null = null;
    let last: Node | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.length) continue;
      first ??= node;
      last = node;
    }
    return !!first && !!last && range.comparePoint(first, 0) === 0
      && range.comparePoint(last, last.textContent?.length ?? 0) === 0;
  }

  function onBeforeInput(event: InputEvent): void {
    pendingHistory = event.inputType === 'historyUndo' || event.inputType === 'historyRedo'
      ? { inputType: event.inputType, html: root.innerHTML }
      : null;
  }

  function onInput(event: Event): void {
    const before = pendingHistory;
    pendingHistory = null;
    if (!before || (event as InputEvent).inputType !== before.inputType) return;
    const html = root.innerHTML;
    const undo = before.inputType === 'historyUndo';
    const record = [...records].reverse().find((item) => undo
      ? before.html === item.afterHtml && html === item.beforeHtml
      : before.html === item.beforeHtml && html === item.afterHtml);
    if (!record) return;
    queueMicrotask(() => {
      if (!disposed && root.isConnected && root.isContentEditable && doc.activeElement === root
        && doc.hasFocus() && root.innerHTML === html) {
        restoreSelection(undo ? record.beforeSelection : record.afterSelection);
      }
    });
  }

  root.addEventListener('beforeinput', onBeforeInput);
  root.addEventListener('input', onInput);

  return {
    format(command: string): boolean {
      if (disposed || !win || !['bold', 'italic', 'underline'].includes(command)) return false;
      const position = captureSelection();
      const selection = win.getSelection();
      if (!position || position.anchor === position.focus || !selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      const elements = Array.from(root.querySelectorAll('*'));
      const wrappers = elements.filter((element) => element.matches('b,strong,i,em,u') && fullySelected(element, range));
      if (!wrappers.length) return false;

      ensureStyles();
      const enabled = !doc.queryCommandState(command);
      const undecorate: number[] = [];
      if (command === 'underline' && !enabled) {
        // A child cannot cancel a decoration drawn by a partly selected ancestor.
        for (let element: Element | null = root; element; element = element.parentElement) {
          if (win.getComputedStyle(element).textDecorationLine.includes('underline')) return false;
        }
        for (let index = 0; index < elements.length; index++) {
          const element = elements[index]!;
          if (!range.intersectsNode(element) || !win.getComputedStyle(element).textDecorationLine.includes('underline')) continue;
          undecorate.push(index);
        }
      }

      const beforeHtml = root.innerHTML;
      const clone = root.cloneNode(true) as HTMLElement;
      const clonedElements = clone.querySelectorAll<HTMLElement>('*');
      const from = Math.min(position.anchor, position.focus);
      const to = Math.max(position.anchor, position.focus);
      const affected: Node[] = [...wrappers, ...undecorate.map((index) => elements[index]!)];
      const originalWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let original: Node | null;
      let originalOffset = 0;
      while ((original = originalWalker.nextNode())) {
        const lineBreak = original.nodeName === 'BR';
        if (!lineBreak && original.nodeType !== Node.TEXT_NODE) continue;
        const end = originalOffset + (lineBreak ? 1 : original.textContent?.length ?? 0);
        if (Math.max(from, originalOffset) < Math.min(to, end)) affected.push(original);
        originalOffset = end;
      }
      let container = affected[0]!;
      while (!affected.every((node) => container.contains(node))) container = container.parentNode!;
      if (container.nodeType === Node.TEXT_NODE) container = container.parentNode!;
      const replacement = doc.createRange();
      let replacementHtml: () => string;
      if (container !== root && affected.includes(container)) {
        replacement.selectNode(container);
        const clonedContainer = clonedElements[elements.indexOf(container as Element)]!;
        replacementHtml = () => clonedContainer.outerHTML;
      } else {
        const children = Array.from(container.childNodes);
        const indices = affected.map((node) => {
          let child = node;
          while (child.parentNode !== container) child = child.parentNode!;
          return children.indexOf(child as ChildNode);
        });
        const first = Math.min(...indices);
        const last = Math.max(...indices);
        replacement.setStart(container, first);
        replacement.setEnd(container, last + 1);
        const clonedContainer = container === root ? clone : clonedElements[elements.indexOf(container as Element)]!;
        const firstChild = clonedContainer.childNodes[first]!;
        const lastChild = clonedContainer.childNodes[last]!;
        const startMarker = doc.createComment('');
        const endMarker = doc.createComment('');
        clonedContainer.insertBefore(startMarker, firstChild);
        clonedContainer.insertBefore(endMarker, lastChild.nextSibling);
        replacementHtml = () => {
          const fragment = doc.createElement('div');
          for (let child = startMarker.nextSibling; child && child !== endMarker; child = child.nextSibling) {
            fragment.append(child.cloneNode(true));
          }
          return fragment.innerHTML;
        };
      }
      const disabledDecorations = new Map<Element, string[]>();
      for (const index of undecorate) {
        const element = clonedElements[index]!;
        disabledDecorations.set(element, win.getComputedStyle(elements[index]!).textDecorationLine.split(' '));
        element.style.removeProperty('text-decoration-line');
        element.setAttribute('data-readable-text-underline', 'off');
      }
      const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      const texts: { node: Node; start: number; end: number; lineBreak: boolean }[] = [];
      let cursor = 0;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const lineBreak = node.nodeName === 'BR';
        if (!lineBreak && node.nodeType !== Node.TEXT_NODE) continue;
        const start = cursor;
        cursor += lineBreak ? 1 : node.textContent?.length ?? 0;
        texts.push({ node, start, end: cursor, lineBreak });
      }
      const property = command === 'bold' ? 'font-weight' : command === 'italic' ? 'font-style' : 'text-decoration-line';
      const value = command === 'bold' ? (enabled ? '700' : '400')
        : command === 'italic' ? (enabled ? 'italic' : 'normal') : (enabled ? 'underline' : 'none');
      function formatSpan(property: string, value: string): HTMLSpanElement {
        const span = doc.createElement('span');
        span.setAttribute('data-readable-text-format', '');
        span.style.setProperty(property, value, 'important');
        return span;
      }
      for (const item of texts) {
        const start = Math.max(from, item.start) - item.start;
        const end = Math.min(to, item.end) - item.start;
        const decorations = new Set<string>();
        for (let element = item.node.parentElement; element && element !== clone; element = element.parentElement) {
          for (const decoration of disabledDecorations.get(element) ?? []) decorations.add(decoration);
        }
        const restoreDecoration = [...decorations].join(' ');
        const remainingDecoration = [...decorations].filter((decoration) => decoration !== 'underline').join(' ') || 'none';
        const selectedValue = command === 'underline' && !enabled ? remainingDecoration : value;
        if (item.lineBreak) {
          const span = start < end ? formatSpan(property, selectedValue)
            : restoreDecoration ? formatSpan('text-decoration-line', restoreDecoration) : null;
          if (span) {
            item.node.parentNode!.replaceChild(span, item.node);
            span.append(item.node);
          }
          continue;
        }
        if (start >= end && !restoreDecoration) continue;
        const text = item.node.textContent ?? '';
        const fragment = doc.createDocumentFragment();
        function outside(value: string): void {
          if (!value) return;
          if (!restoreDecoration) { fragment.append(doc.createTextNode(value)); return; }
          const span = formatSpan('text-decoration-line', restoreDecoration);
          span.textContent = value;
          fragment.append(span);
        }
        if (start >= end) outside(text);
        else {
          outside(text.slice(0, start));
          const span = formatSpan(property, selectedValue);
          span.textContent = text.slice(start, end);
          fragment.append(span);
          outside(text.slice(end));
        }
        item.node.parentNode!.replaceChild(fragment, item.node);
      }

      selection.removeAllRanges();
      selection.addRange(replacement);
      // Keep Chromium from merging adjacent runs or retaining an empty wrapper at a line break.
      const siblings = replacement.startContainer.childNodes;
      const protectedNodes = [
        container !== root && affected.includes(container) ? container : null,
        siblings[replacement.startOffset - 1], siblings[replacement.endOffset],
      ]
        .filter((node): node is Element => !!node && node.nodeType === Node.ELEMENT_NODE)
        .map((node) => ({ node, editable: node.getAttribute('contenteditable') }));
      for (const { node } of protectedNodes) node.setAttribute('contenteditable', 'false');
      try {
        doc.execCommand('insertHTML', false, replacementHtml());
      } finally {
        for (const { node, editable } of protectedNodes) {
          if (editable === null) node.removeAttribute('contenteditable');
          else node.setAttribute('contenteditable', editable);
        }
      }
      restoreSelection(position);
      const afterHtml = root.innerHTML;
      if (afterHtml !== beforeHtml) records.push({ beforeHtml, afterHtml, beforeSelection: position, afterSelection: position });
      return true;
    },
    dispose(): void {
      disposed = true;
      pendingHistory = null;
      records.length = 0;
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('input', onInput);
    },
  };
}
