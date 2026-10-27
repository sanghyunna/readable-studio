/** Replay one canonical source edit without restarting the preview's document. */
export function applyManualEditPreviewSource(
  document: Document,
  beforeSource: string,
  afterSource: string,
  beforeId: string | null,
  afterId: string | null,
  targetSelector?: string,
  autoIdSelector?: string,
  richTextCss?: string,
): boolean {
  try {
    const fullDocument = (source: string) => {
      let rest = source.trimStart();
      while (rest.startsWith('<!--') || rest.startsWith('<?')) {
        const close = rest.startsWith('<!--') ? '-->' : '?>';
        const end = rest.indexOf(close);
        if (end === -1) return false;
        rest = rest.slice(end + close.length).trimStart();
      }
      const token = rest.slice(0, 32).toLowerCase();
      return token.startsWith('<!doctype') || token.startsWith('<html');
    };
    const parser = new DOMParser();
    const parseSource = (source: string) => parser.parseFromString(fullDocument(source)
      ? source : `<!doctype html><html><head></head><body>${source}</body></html>`, 'text/html');
    const before = parseSource(beforeSource);
    const after = parseSource(afterSource);
    if (richTextCss) {
      const attribute = 'data-readable-text-format-style';
      const oldStyles = before.querySelectorAll(`[${attribute}]`);
      const newStyles = after.querySelectorAll(`[${attribute}]`);
      if (oldStyles.length || newStyles.length) {
        const exactStyle = (node: Element) => node.tagName === 'STYLE' && node.attributes.length === 1
          && node.getAttribute(attribute) === '1' && node.textContent === richTextCss;
        const canonicalStyle = (node: Element, doc: Document, source: string) => exactStyle(node)
          && node.parentElement === doc.head && node === doc.head.firstElementChild && fullDocument(source);
        const oldStyle = oldStyles[0];
        const newStyle = newStyles[0];
        const liveStyles = document.querySelectorAll(`[${attribute}]`);
        if (oldStyles.length > 1 || newStyles.length > 1
          || (oldStyle && !canonicalStyle(oldStyle, before, beforeSource))
          || (newStyle && !canonicalStyle(newStyle, after, afterSource))
          || liveStyles.length !== 1 || !exactStyle(liveStyles[0]!)) return false;
        if (oldStyle && !newStyle && after.querySelector('[data-readable-text-format], [data-readable-text-underline]')) return false;
        // The exact runtime rule already exists; source promotion need not restart the preview.
        oldStyle?.remove();
        newStyle?.remove();
      }
    }
    const paths = new Map<Element, string>();
    const rememberPaths = (parent: Element, prefix: string) => {
      Array.from(parent.children).forEach((child, index) => {
        const value = prefix ? `${prefix}-${index}` : `path-${index}`;
        paths.set(child, value);
        rememberPaths(child, value);
      });
    };
    rememberPaths(before.body, '');
    rememberPaths(after.body, '');
    const path = (element: Element): string => paths.get(element) ?? '';
    const sourceTarget = (doc: Document, id: string | null): Element | null => {
      if (id === null) return null;
      if (id === '__body__') return doc.body;
      const explicit = Array.from(doc.querySelectorAll('[data-readable-id]')).filter((node) => node.getAttribute('data-readable-id') === id);
      if (explicit.length) return explicit.length === 1 ? explicit[0]! : null;
      if (!/^path-\d+(?:-\d+)*$/.test(id)) return null;
      let node: Element | null = doc.body;
      for (const index of id.slice(5).split('-').map(Number)) node = node?.children.item(index) ?? null;
      return node;
    };
    const oldTarget = sourceTarget(before, beforeId);
    const newTarget = sourceTarget(after, afterId);
    if ((!oldTarget && beforeId !== null) || (!newTarget && afterId !== null) || (!oldTarget && !newTarget)) return false;
    if ((oldTarget && !before.body.contains(oldTarget)) || (newTarget && !after.body.contains(newTarget))) return false;
    if ((oldTarget === before.body || newTarget === after.body) && (oldTarget !== before.body || newTarget !== after.body || oldTarget.innerHTML !== newTarget.innerHTML)) return false;
    const context = (doc: Document, target: Element | null, marker: boolean): string => {
      const clone = doc.cloneNode(true) as Document;
      const copied = sourceTarget(clone, target === doc.body ? '__body__' : target ? target.getAttribute('data-readable-id') || path(target) : null);
      if (copied) {
        if (marker) copied.replaceWith(clone.createComment('readable-preview-target'));
        else copied.remove();
      }
      return clone.documentElement.outerHTML;
    };
    if (context(before, oldTarget, !!newTarget && !!oldTarget) !== context(after, newTarget, !!oldTarget && !!newTarget)) return false;
    const activeMarkup = 'script, style, link, iframe, object, embed, base';
    if (oldTarget?.matches(activeMarkup) || newTarget?.matches(activeMarkup)) return false;
    if (oldTarget?.innerHTML !== newTarget?.innerHTML && (oldTarget?.querySelector(activeMarkup) || newTarget?.querySelector(activeMarkup))) return false;

    const operations: Array<() => void> = [];
    const mapped = new Map<Element, Element>();
    const previousPaths = new Map<Element, string>();
    mapped.set(after.body, document.body);
    const liveElements = Array.from(document.body.querySelectorAll('*'));
    const transient = (node: Element) => !!node.closest('[data-readable-edit-transient="true"]');
    const liveIds = new Map<string, Element | null>();
    const livePaths = new Map<string, Element | null>();
    const livePositions = new Map<string, Element>();
    const transientIds = new Map<string, Element | null>();
    for (const live of liveElements) {
      const id = live.getAttribute('data-readable-id');
      const sourcePath = live.getAttribute('data-readable-source-path');
      const ids = transient(live) ? transientIds : liveIds;
      if (id) ids.set(id, ids.has(id) ? null : live);
      if (sourcePath && !transient(live)) livePaths.set(sourcePath, livePaths.has(sourcePath) ? null : live);
    }
    const rememberLivePositions = (parent: Element, prefix: string) => {
      Array.from(parent.children).filter((child) => !transient(child)).forEach((child, index) => {
        const value = prefix ? `${prefix}-${index}` : `path-${index}`;
        livePositions.set(value, child);
        rememberLivePositions(child, value);
      });
    };
    rememberLivePositions(document.body, '');
    const liveFor = (node: Element): Element | null => {
      if (node === before.body) return document.body;
      const id = node.getAttribute('data-readable-id');
      const sourcePath = path(node);
      for (const [index, value] of [[liveIds, id], [livePaths, sourcePath]] as const) {
        if (!value) continue;
        if (!index.has(value)) continue;
        const found = index.get(value);
        return found?.tagName === node.tagName ? found : null;
      }
      const live = livePositions.get(sourcePath);
      return live?.tagName === node.tagName ? live : null;
    };
    const outsideOld = Array.from(before.body.querySelectorAll('*')).filter((node) => !oldTarget?.contains(node));
    const outsideNew = Array.from(after.body.querySelectorAll('*')).filter((node) => !newTarget?.contains(node));
    if (outsideOld.length !== outsideNew.length) return false;
    for (let index = 0; index < outsideOld.length; index += 1) {
      const live = liveFor(outsideOld[index]!);
      if (!live || live.tagName !== outsideNew[index]!.tagName) return false;
      mapped.set(outsideNew[index]!, live);
      previousPaths.set(outsideNew[index]!, path(outsideOld[index]!));
    }
    const attributes = (live: Element, previous: Element | null, next: Element) => {
      const names = new Set([...Array.from(previous?.attributes ?? [], (item) => item.name), ...Array.from(next.attributes, (item) => item.name)]);
      for (const name of names) {
        const oldValue = previous?.getAttribute(name) ?? null;
        const newValue = next.getAttribute(name);
        if (oldValue === newValue) continue;
        if (name === 'class') {
          const oldTokens = (oldValue ?? '').split(/\s+/).filter(Boolean);
          const newTokens = (newValue ?? '').split(/\s+/).filter(Boolean);
          operations.push(() => {
            for (const token of oldTokens) if (!newTokens.includes(token)) live.classList.remove(token);
            for (const token of newTokens) if (!oldTokens.includes(token)) live.classList.add(token);
          });
        } else if (name === 'style' && 'style' in live && 'style' in next) {
          const liveStyle = (live as HTMLElement).style;
          const oldStyle = (previous as HTMLElement | null)?.style;
          const newStyle = (next as HTMLElement).style;
          for (const property of new Set([...Array.from(oldStyle ?? []), ...Array.from(newStyle)])) {
            const value = newStyle.getPropertyValue(property);
            const priority = newStyle.getPropertyPriority(property);
            if (value === oldStyle?.getPropertyValue(property) && priority === oldStyle?.getPropertyPriority(property)) continue;
            operations.push(() => {
              if (value) liveStyle.setProperty(property, value, priority);
              else liveStyle.removeProperty(property);
            });
          }
        } else {
          operations.push(() => {
            if (newValue === null) live.removeAttribute(name);
            else if (live.getAttribute(name) !== newValue) live.setAttribute(name, newValue);
          });
        }
      }
    };
    const mapInserted = (source: Element, live: Element) => {
      mapped.set(source, live);
      const sources = Array.from(source.querySelectorAll('*'));
      const targets = Array.from(live.querySelectorAll('*'));
      sources.forEach((node, index) => mapped.set(node, targets[index]!));
    };
    const sameContent = (live: Node, next: Node): boolean => {
      if (live.nodeType !== next.nodeType || live.nodeName !== next.nodeName) return false;
      if (live.nodeType !== 1) return live.nodeValue === next.nodeValue;
      return live.childNodes.length === next.childNodes.length && Array.from(next.childNodes).every((child, index) => sameContent(live.childNodes[index]!, child));
    };
    const readyContent = (live: Element, previous: Element | null, next: Element) => {
      mapped.set(next, live);
      if (previous) previousPaths.set(next, path(previous));
      attributes(live, previous, next);
      const oldMarkup = new Map<string, Element | null>();
      for (const child of Array.from(previous?.children ?? [])) {
        const markup = child.outerHTML;
        oldMarkup.set(markup, oldMarkup.has(markup) ? null : child);
      }
      Array.from(next.children).forEach((child, index) => {
        const oldChild = oldMarkup.get(child.outerHTML) ?? (previous?.children.length === next.children.length ? previous.children.item(index) : null);
        readyContent(live.children.item(index)!, oldChild?.tagName === child.tagName ? oldChild : null, child);
      });
    };
    const plan = (live: Node, previous: Node, next: Node): boolean => {
      if (live.nodeType !== previous.nodeType || live.nodeName !== previous.nodeName) return false;
      if (previous.nodeType !== next.nodeType || previous.nodeName !== next.nodeName) {
        if (!live.parentNode) return false;
        const replacement = document.importNode(next, true);
        if (next.nodeType === 1) mapInserted(next as Element, replacement as Element);
        operations.push(() => live.parentNode!.replaceChild(replacement, live));
        return true;
      }
      if (next.nodeType !== 1) {
        if (previous.nodeValue !== next.nodeValue && live.nodeValue !== next.nodeValue) operations.push(() => { live.nodeValue = next.nodeValue; });
        return true;
      }
      const element = live as Element;
      const oldElement = previous as Element;
      const nextElement = next as Element;
      mapped.set(nextElement, element);
      previousPaths.set(nextElement, path(oldElement));
      attributes(element, oldElement, nextElement);
      if (oldElement.innerHTML === nextElement.innerHTML) {
        const oldDescendants = Array.from(oldElement.querySelectorAll('*'));
        const nextDescendants = Array.from(nextElement.querySelectorAll('*'));
        for (let index = 0; index < oldDescendants.length; index += 1) {
          const unchanged = liveFor(oldDescendants[index]!);
          if (!unchanged) return false;
          mapped.set(nextDescendants[index]!, unchanged);
          previousPaths.set(nextDescendants[index]!, path(oldDescendants[index]!));
        }
        return true;
      }
      if (sameContent(element, nextElement)) {
        readyContent(element, oldElement, nextElement);
        return true;
      }
      const oldChildren = Array.from(previous.childNodes);
      const newChildren = Array.from(next.childNodes);
      const children = Array.from(live.childNodes);
      if (children.length !== oldChildren.length) return false;
      let prefix = 0;
      while (prefix < oldChildren.length && prefix < newChildren.length && oldChildren[prefix]!.isEqualNode(newChildren[prefix]!)) prefix += 1;
      let suffix = 0;
      while (suffix < oldChildren.length - prefix && suffix < newChildren.length - prefix && oldChildren[oldChildren.length - 1 - suffix]!.isEqualNode(newChildren[newChildren.length - 1 - suffix]!)) suffix += 1;
      for (let index = 0; index < prefix; index += 1) if (!plan(children[index]!, oldChildren[index]!, newChildren[index]!)) return false;
      for (let offset = 1; offset <= suffix; offset += 1) if (!plan(children[children.length - offset]!, oldChildren[oldChildren.length - offset]!, newChildren[newChildren.length - offset]!)) return false;
      const oldMiddle = oldChildren.slice(prefix, oldChildren.length - suffix);
      const newMiddle = newChildren.slice(prefix, newChildren.length - suffix);
      if (oldMiddle.length === newMiddle.length) {
        for (let offset = 0; offset < oldMiddle.length; offset += 1) if (!plan(children[prefix + offset]!, oldMiddle[offset]!, newMiddle[offset]!)) return false;
      } else {
        const inserted = newMiddle.map((node) => {
          const clone = document.importNode(node, true);
          if (node.nodeType === 1) mapInserted(node as Element, clone as Element);
          return clone;
        });
        const removed = children.slice(prefix, children.length - suffix);
        const anchor = children[children.length - suffix] ?? null;
        operations.push(() => {
          for (const node of removed) live.removeChild(node);
          for (const node of inserted) live.insertBefore(node, anchor);
        });
      }
      return true;
    };
    if (oldTarget && newTarget) {
      const live = liveFor(oldTarget);
      if (!live || !plan(live, oldTarget, newTarget)) return false;
    } else if (oldTarget) {
      const live = liveFor(oldTarget);
      if (!live?.parentNode) return false;
      operations.push(() => live.remove());
    } else if (newTarget) {
      const parent = newTarget.parentElement && mapped.get(newTarget.parentElement);
      const next = newTarget.nextElementSibling;
      let anchor: Node | null = next ? mapped.get(next) ?? null : null;
      const previous = newTarget.previousElementSibling;
      const previousLive = previous ? mapped.get(previous) : null;
      if (!parent || (next && (!anchor || anchor.parentNode !== parent)) || (previous && (!previousLive || previousLive.parentElement !== parent))) return false;
      let prefix = '';
      let suffix = '';
      for (let node: Node | null = previous ? previous.nextSibling : newTarget.parentNode!.firstChild; node && node !== next; node = node.nextSibling) {
        if (node === newTarget) continue;
        if (node.nodeType !== 3) return false;
        if (node.compareDocumentPosition(newTarget) & 4) prefix += node.nodeValue ?? '';
        else suffix += node.nodeValue ?? '';
      }
      const authored = new Set(mapped.values());
      const textNodes: Text[] = [];
      for (let node: Node | null = previousLive ? previousLive.nextSibling : parent.firstChild; node && node !== anchor; node = node.nextSibling) {
        if (node.nodeType === 1 && transient(node as Element)) continue;
        if (node.nodeType === 1 && !authored.has(node as Element) && /^(SCRIPT|STYLE)$/.test(node.nodeName) && Array.from((node as Element).attributes).some((item) => item.name.startsWith('data-readable-'))) {
          anchor = node;
          break;
        }
        if (node.nodeType !== 3) return false;
        textNodes.push(node as Text);
      }
      if (textNodes.map((node) => node.data).join('') !== prefix + suffix) return false;
      let offset = prefix.length;
      let split: { node: Text; offset: number } | null = null;
      for (const node of textNodes) {
        if (offset === 0) { anchor = node; break; }
        if (offset < node.length) { split = { node, offset }; break; }
        offset -= node.length;
      }
      const candidate = afterId === null ? undefined : transientIds.get(afterId);
      if (candidate === null) return false;
      const inserted = candidate ?? document.importNode(newTarget, true);
      if (candidate && (!sameContent(inserted, newTarget) || inserted.parentElement !== parent)) return false;
      mapInserted(newTarget, inserted);
      attributes(inserted, null, newTarget);
      operations.push(() => {
        inserted.removeAttribute('data-readable-edit-transient');
        inserted.querySelectorAll('[data-readable-edit-transient]').forEach((node) => node.removeAttribute('data-readable-edit-transient'));
        if (split) anchor = split.node.splitText(split.offset);
        parent.insertBefore(inserted, anchor);
      });
    }
    if (Array.from(after.body.querySelectorAll('*')).some((node) => !mapped.has(node))) return false;
    for (const operation of operations) operation();
    for (const [source, live] of mapped) {
      if (source === after.body) continue;
      const nextPath = path(source);
      const oldPath = live.getAttribute('data-readable-source-path');
      const previousPath = previousPaths.get(source) || oldPath;
      const autoId = !!autoIdSelector && !source.hasAttribute('data-screen-label') && !/^(script|style|template|noscript|iframe|object|embed)$/i.test(source.tagName) && source.matches(autoIdSelector);
      if (!source.hasAttribute('data-readable-id') && previousPath && live.getAttribute('data-readable-id') === previousPath) {
        if (!autoIdSelector || autoId) {
          if (previousPath !== nextPath) live.setAttribute('data-readable-id', nextPath);
        } else live.removeAttribute('data-readable-id');
      }
      if (!source.hasAttribute('data-readable-id') && previousPath && previousPath !== nextPath && live.getAttribute('data-readable-runtime-id') === previousPath) live.setAttribute('data-readable-runtime-id', nextPath);
      if (autoId && !source.hasAttribute('data-readable-id') && !live.hasAttribute('data-readable-id')) live.setAttribute('data-readable-id', nextPath);
      if (oldPath !== nextPath && (oldPath !== null || !targetSelector || source.matches(targetSelector))) live.setAttribute('data-readable-source-path', nextPath);
    }
    return true;
  } catch {
    return false;
  }
}
