import { moveCssCommitStyles } from './resize-geometry';
import { emptyManualEditStyles, MANUAL_EDIT_STYLE_PROPS, type ManualEditDuplicatePlan, type ManualEditFields, type ManualEditPatch, type ManualEditStyles } from './types';

export interface ManualEditPatchResult {
  ok: boolean;
  source: string;
  error?: string;
}

const INLINE_TEXT_WRAPPER_TAGS = new Set([
  'strong', 'span', 'small', 'em', 'b', 'i', 'u', 's', 'mark', 'code', 'time',
  'abbr', 'cite', 'q', 'sub', 'sup', 'kbd', 'samp', 'var', 'dfn', 'ins', 'del',
  'bdi', 'bdo',
]);

// Inline-formatting tags allowed to survive a `set-inner-html` save. This is the
// inline-text wrapper set plus the handful of formatting tags the rich-text edit
// bridge can produce (`<a>`, `<br>`). Everything else is light-normalized: tags
// outside this allowlist are unwrapped (their text is kept), `<script>`/`<style>`
// are dropped entirely, and event-handler attributes / `javascript:` URLs are
// stripped from the survivors.
const INLINE_HTML_ALLOWED_TAGS = new Set([
  ...INLINE_TEXT_WRAPPER_TAGS,
  'a', 'br',
]);
const DECORATIVE_HTML_ALLOWED_TAGS = new Set([
  'div', 'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use',
]);
const DUPLICATE_RUNTIME_ATTRIBUTES = new Set([
  'data-readable-source-path',
  'data-readable-edit-selected',
  'data-readable-editing',
  'data-readable-edit-mode',
  'data-readable-authored-size-probe',
  'data-readable-authored-size-probe-style',
]);
const DUPLICATE_UNSUPPORTED_TAGS = new Set([
  'audio', 'base', 'button', 'canvas', 'dialog', 'datalist', 'details', 'embed', 'form', 'frame', 'frameset',
  'iframe', 'input', 'link', 'meta', 'object', 'optgroup', 'option', 'portal', 'script',
  'select', 'slot', 'source', 'style', 'summary', 'template', 'textarea', 'title', 'track', 'video',
  'label',
  'animate', 'animatemotion', 'animatetransform', 'marquee', 'set',
]);
const DUPLICATE_ACTIVE_ROLES = new Set([
  'combobox', 'columnheader', 'grid', 'gridcell', 'listbox', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radiogroup', 'row', 'rowheader', 'scrollbar',
  'searchbox', 'slider', 'spinbutton', 'tab', 'tablist', 'textbox', 'tree', 'treegrid', 'treeitem',
]);
const DUPLICATE_FRAGMENT_ATTRIBUTES = new Set(['href', 'xlink:href']);
const DUPLICATE_TOKEN_IDREF_ATTRIBUTES = new Set([
  'for', 'form', 'headers', 'list',
  'aria-activedescendant', 'aria-controls', 'aria-describedby', 'aria-details',
  'aria-errormessage', 'aria-flowto', 'aria-labelledby', 'aria-owns',
]);
const DUPLICATE_CSS_URL_ATTRIBUTES = new Set([
  'clip-path', 'fill', 'filter', 'mask', 'marker-end', 'marker-mid', 'marker-start',
  'stroke', 'style',
]);
const DUPLICATE_IDREF_LIKE_ATTRIBUTE = /(?:^|[-_:])(?:id|ids|idref|idrefs|ref|refs)$/;

export function planManualEditDuplicate(
  source: string,
  originalId: string,
): { ok: true; plan: ManualEditDuplicatePlan } | { ok: false; error: string } {
  const doc = parseSource(source);
  if (!doc) return { ok: false, error: 'Could not parse source.' };

  const located = findDuplicateSourceElement(doc, originalId);
  if ('error' in located) return { ok: false, error: located.error };
  const contentError = validateDuplicateContent(located.original);
  if (contentError) return { ok: false, error: contentError };

  const manualIds = collectIdentityValues(located.original, 'data-readable-id');
  const nativeIds = collectIdentityValues(located.original, 'id');
  if (manualIds.error) return { ok: false, error: manualIds.error };
  if (nativeIds.error) return { ok: false, error: nativeIds.error };
  const globalManualIds = collectGlobalIdentityValues(doc, 'data-readable-id');
  const globalNativeIds = collectGlobalIdentityValues(doc, 'id');
  if (globalManualIds.error) return { ok: false, error: globalManualIds.error };
  if (globalNativeIds.error) return { ok: false, error: globalNativeIds.error };
  const referenceError = validateDuplicateStylesheetReferences(doc, nativeIds.values, manualIds.values);
  if (referenceError) return { ok: false, error: referenceError };

  const manualIdMap = allocateDuplicateIds(manualIds.values, globalManualIds.values);
  const nativeIdMap = allocateDuplicateIds(nativeIds.values, globalNativeIds.values);
  const rootManualId = located.original.getAttribute('data-readable-id');
  const parent = located.original.parentElement;
  if (!parent) return { ok: false, error: 'Duplicate source target has no parent.' };
  const duplicateRootId = rootManualId
    ? manualIdMap[rootManualId]!
    : allocateDuplicateId(originalId, new Set([...globalManualIds.values, ...Object.values(manualIdMap)]));
  const baselineTranslate = (located.original as HTMLElement).style.getPropertyValue('translate').trim();
  if (!isSupportedDuplicateTranslate(baselineTranslate)) {
    return { ok: false, error: 'Duplicate baseline translate is unsupported.' };
  }

  const plan: ManualEditDuplicatePlan = {
    expectedSource: source,
    originalId,
    originalTagName: located.original.tagName.toLowerCase(),
    parentPath: sourcePathForElement(parent),
    expectedNextSiblingPath: located.original.nextElementSibling
      ? sourcePathForElement(located.original.nextElementSibling)
      : null,
    duplicateRootId,
    previewHtml: '',
    manualIdMap,
    nativeIdMap,
    baselineTranslate,
  };
  const identityError = validateDuplicateIdentity(doc, located.original, plan);
  if (identityError) return { ok: false, error: identityError };

  const duplicate = located.original.cloneNode(true) as Element;
  const rewriteError = rewriteDuplicateElement(duplicate, plan, baselineTranslate);
  if (rewriteError) return { ok: false, error: rewriteError };
  plan.previewHtml = duplicate.outerHTML;
  return { ok: true, plan };
}

export function applyManualEditPatch(source: string, patch: ManualEditPatch): ManualEditPatchResult {
  if (patch.kind === 'set-full-source') return { ok: true, source: patch.source };

  const doc = parseSource(source);
  if (!doc) return { ok: false, source, error: 'Could not parse source.' };

  if (patch.kind === 'duplicate-and-move') {
    return applyDuplicateAndMovePatch(doc, source, patch);
  }

  if (patch.kind === 'set-token') {
    const changed = setCssToken(doc, patch.token, patch.value);
    return changed
      ? { ok: true, source: serializeSource(doc, source) }
      : { ok: false, source, error: `Token not found: ${patch.token}` };
  }

  const el = findEditableElement(doc, patch.id);
  if (!el) return { ok: false, source, error: `Target not found: ${patch.id}` };

  if (patch.kind === 'set-text') {
    if (hasElementChildren(el)) {
      const textNode = singleEditableTextNode(el);
      if (!textNode) {
        return { ok: false, source, error: 'This element contains nested markup. Use the HTML tab instead.' };
      }
      textNode.textContent = patch.value;
    } else {
      el.textContent = patch.value;
    }
  } else if (patch.kind === 'set-link') {
    if (hasElementChildren(el)) {
      const currentText = el.textContent?.trim() ?? '';
      if (patch.text.trim() !== currentText) {
        return { ok: false, source, error: 'This link contains nested markup. Use the HTML tab to change its label.' };
      }
    } else {
      el.textContent = patch.text;
    }
    el.setAttribute('href', patch.href);
  } else if (patch.kind === 'set-image') {
    el.setAttribute('src', patch.src);
    el.setAttribute('alt', patch.alt);
  } else if (patch.kind === 'set-style') {
    setInlineStyles(el as HTMLElement, patch.styles);
  } else if (patch.kind === 'set-attributes') {
    setAttributes(el, patch.attributes);
  } else if (patch.kind === 'set-inner-html') {
    el.innerHTML = sanitizeInlineHtml(doc, patch.html);
  } else if (patch.kind === 'set-outer-html') {
    const replaced = replaceOuterHtml(doc, el, patch.html);
    if (!replaced.ok) {
      return {
        ok: false,
        source,
        error: 'error' in replaced ? replaced.error : 'Could not replace element HTML.',
      };
    }
  } else if (patch.kind === 'remove-element') {
    if (!el.parentElement) {
      return { ok: false, source, error: 'Cannot remove the root element.' };
    }
    if (el.parentElement === doc.body && doc.body.children.length === 1) {
      return { ok: false, source, error: 'Cannot remove the last element in the document.' };
    }
    el.remove();
  }

  return { ok: true, source: serializeSource(doc, source) };
}

function applyDuplicateAndMovePatch(
  doc: Document,
  source: string,
  patch: Extract<ManualEditPatch, { kind: 'duplicate-and-move' }>,
): ManualEditPatchResult {
  const plan = patch.plan;
  if (source !== plan.expectedSource) {
    return { ok: false, source, error: 'Source changed while preparing the duplicate.' };
  }
  if (patch.id !== plan.originalId) {
    return { ok: false, source, error: 'Duplicate target does not match its source plan.' };
  }

  const locator = locateDuplicateSourceElement(doc, plan);
  if ('error' in locator) return { ok: false, source, error: locator.error };

  const contentError = validateDuplicateContent(locator.original);
  if (contentError) return { ok: false, source, error: contentError };
  const manualIds = collectIdentityValues(locator.original, 'data-readable-id');
  const nativeIds = collectIdentityValues(locator.original, 'id');
  if (manualIds.error) return { ok: false, source, error: manualIds.error };
  if (nativeIds.error) return { ok: false, source, error: nativeIds.error };
  const referenceError = validateDuplicateStylesheetReferences(doc, nativeIds.values, manualIds.values);
  if (referenceError) return { ok: false, source, error: referenceError };

  const identityError = validateDuplicateIdentity(doc, locator.original, plan);
  if (identityError) return { ok: false, source, error: identityError };

  const translate = duplicateTranslate(patch.finalTranslate, patch.placementOffset);
  if ('error' in translate) return { ok: false, source, error: translate.error };

  const duplicate = locator.original.cloneNode(true) as Element;
  const rewriteError = rewriteDuplicateElement(duplicate, plan, translate.value);
  if (rewriteError) return { ok: false, source, error: rewriteError };

  locator.parent.insertBefore(duplicate, locator.original.nextSibling);
  return { ok: true, source: serializeSource(doc, source) };
}

function locateDuplicateSourceElement(
  doc: Document,
  plan: Extract<ManualEditPatch, { kind: 'duplicate-and-move' }>['plan'],
): { original: Element; parent: Element } | { error: string } {
  if (!plan.originalTagName || typeof plan.parentPath !== 'string') {
    return { error: 'Duplicate source locator is incomplete.' };
  }
  const found = findDuplicateSourceElement(doc, plan.originalId);
  if ('error' in found) return found;
  const original = found.original;
  if (original.tagName.toLowerCase() !== plan.originalTagName.toLowerCase()) {
    return { error: 'Duplicate source target tag does not match its plan.' };
  }
  const parent = original.parentElement;
  if (!parent || sourcePathForElement(parent) !== plan.parentPath) {
    return { error: 'Duplicate source parent does not match its plan.' };
  }
  const nextSibling = original.nextElementSibling;
  const nextSiblingPath = nextSibling ? sourcePathForElement(nextSibling) : null;
  if (nextSiblingPath !== plan.expectedNextSiblingPath) {
    return { error: 'Duplicate source sibling does not match its plan.' };
  }
  return { original, parent };
}

function findDuplicateSourceElement(
  doc: Document,
  originalId: string,
): { original: Element } | { error: string } {
  if (!originalId) return { error: 'Duplicate source locator is incomplete.' };
  // Authored IDs win over the path-shaped fallback, matching the normal
  // Manual Edit resolver. `data-readable-id="path-0"` is valid authored content and
  // must not be mistaken for a generated locator.
  const authoredMatches = Array.from(doc.querySelectorAll('*')).filter((el) =>
    el.getAttribute('data-readable-id') === originalId
    || el.getAttribute('data-readable-source-path') === originalId);
  const matches = authoredMatches.length > 0
    ? authoredMatches
    : [findElementByPath(doc, originalId)].filter((el): el is Element => el !== null);
  if (matches.length !== 1) {
    return {
      error: matches.length === 0 ? 'Duplicate source target not found.' : 'Duplicate source target is ambiguous.',
    };
  }
  return { original: matches[0]! };
}

function sourcePathForElement(el: Element): string {
  const parts: number[] = [];
  let current: Element | null = el;
  while (current && current !== current.ownerDocument.body) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    parts.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return parts.length ? 'path-' + parts.join('-') : '';
}

function duplicateElements(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))];
}

function validateDuplicateContent(root: Element): string | null {
  for (const el of duplicateElements(root)) {
    const tag = el.tagName.toLowerCase();
    if (DUPLICATE_UNSUPPORTED_TAGS.has(tag)) {
      return 'Duplicate content is unsupported: <' + tag + '>.';
    }
    if (tag.includes('-')) {
      return 'Duplicate custom elements are unsupported: <' + tag + '>.';
    }
    const role = el.getAttribute('role')?.trim().toLowerCase();
    if (role && DUPLICATE_ACTIVE_ROLES.has(role)) {
      return 'Duplicate active content is unsupported: role=\"' + role + '\".';
    }
    const contenteditable = el.getAttribute('contenteditable')?.toLowerCase();
    if (contenteditable !== undefined && contenteditable !== 'false') {
      return 'Duplicate active content is unsupported: contenteditable.';
    }
    if (el.getAttribute('data-readable-editing') === 'true') {
      return 'Cannot duplicate content while it is being edited.';
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) return 'Duplicate active content is unsupported: ' + attr.name + '.';
      if (
        name === 'autofocus'
        || name === 'formaction'
        || name === 'formenctype'
        || name === 'formmethod'
        || name === 'formnovalidate'
        || name === 'formtarget'
        || name === 'srcdoc'
      ) {
        return 'Duplicate active content is unsupported: ' + attr.name + '.';
      }
      if (name === 'name') {
        return 'Duplicate form/name-group semantics are unsupported: ' + attr.name + '.';
      }
      if (name === 'itemref') {
        return 'Duplicate reference attribute is unsupported: ' + attr.name + '.';
      }
      if (
        DUPLICATE_IDREF_LIKE_ATTRIBUTE.test(name)
        && name !== 'id'
        && name !== 'data-readable-id'
        && !name.startsWith('data-readable-runtime-')
      ) {
        return 'Duplicate reference attribute is unsupported: ' + attr.name + '.';
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && isActiveDuplicateUrl(attr.value)) {
        return 'Duplicate active content is unsupported: ' + attr.name + '.';
      }
    }
  }
  return null;
}

function validateDuplicateStylesheetReferences(
  doc: Document,
  nativeIds: readonly string[],
  manualIds: readonly string[],
): string | null {
  const stylesheetText = Array.from(doc.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n');
  if (!stylesheetText) return null;
  for (const id of nativeIds) {
    const escaped = escapeRegExp(id);
    if (
      new RegExp(`#${escaped}(?![a-zA-Z0-9_-])`, 'i').test(stylesheetText)
      || new RegExp(`url\\(\\s*["']?#${escaped}(?:["']?\\s*)\\)`, 'i').test(stylesheetText)
    ) {
      return 'Duplicate stylesheet reference to a cloned id is unsupported: ' + id + '.';
    }
  }
  for (const id of manualIds) {
    const escaped = escapeRegExp(id);
    if (new RegExp(`\\[\\s*data-readable-id\\s*=\\s*["']?${escaped}(?:["']?\\s*\\])`, 'i').test(stylesheetText)) {
      return 'Duplicate stylesheet reference to a cloned data-readable-id is unsupported: ' + id + '.';
    }
  }
  return null;
}

function isActiveDuplicateUrl(value: string): boolean {
  const normalized = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return /^(?:javascript|vbscript|file):/.test(normalized);
}

function validateDuplicateIdentity(
  doc: Document,
  root: Element,
  plan: Extract<ManualEditPatch, { kind: 'duplicate-and-move' }>['plan'],
): string | null {
  const manualIds = collectIdentityValues(root, 'data-readable-id');
  const nativeIds = collectIdentityValues(root, 'id');
  if (manualIds.error) return manualIds.error;
  if (nativeIds.error) return nativeIds.error;
  const globalManualIds = collectGlobalIdentityValues(doc, 'data-readable-id');
  const globalNativeIds = collectGlobalIdentityValues(doc, 'id');
  if (globalManualIds.error) return globalManualIds.error;
  if (globalNativeIds.error) return globalNativeIds.error;

  if (!isDuplicateId(plan.duplicateRootId)) return 'Duplicate root id is invalid.';
  const manualMapError = validateDuplicateIdMap(
    manualIds.values,
    plan.manualIdMap,
    globalManualIds.values,
    'data-readable-id',
  );
  if (manualMapError) return manualMapError;
  const nativeMapError = validateDuplicateIdMap(nativeIds.values, plan.nativeIdMap, globalNativeIds.values, 'id');
  if (nativeMapError) return nativeMapError;

  const rootManualId = root.getAttribute('data-readable-id');
  if (rootManualId && plan.manualIdMap[rootManualId] !== plan.duplicateRootId) {
    return 'Duplicate root id map does not match its plan.';
  }
  const nextManualIds = Object.values(plan.manualIdMap);
  if (!rootManualId && nextManualIds.includes(plan.duplicateRootId)) {
    return 'Duplicate root id collides with a nested manual id.';
  }
  const allNextManualIds = rootManualId ? nextManualIds : [...nextManualIds, plan.duplicateRootId];
  if (new Set(allNextManualIds).size !== allNextManualIds.length) {
    return 'Duplicate manual ids are not unique.';
  }
  if (globalManualIds.values.has(plan.duplicateRootId)) return 'Duplicate root id already exists.';
  return null;
}

function collectIdentityValues(root: Element, attribute: string): { values: string[]; error?: string } {
  const values: string[] = [];
  for (const el of duplicateElements(root)) {
    if (!el.hasAttribute(attribute)) continue;
    const value = el.getAttribute(attribute) ?? '';
    if (!isDuplicateId(value)) return { values, error: 'Duplicate ' + attribute + ' is invalid.' };
    values.push(value);
  }
  if (new Set(values).size !== values.length) {
    return { values, error: 'Duplicate ' + attribute + ' is ambiguous.' };
  }
  return { values };
}

function collectGlobalIdentityValues(doc: Document, attribute: string): { values: Set<string>; error?: string } {
  const values = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    if (!el.hasAttribute(attribute)) continue;
    const value = el.getAttribute(attribute) ?? '';
    if (!isDuplicateId(value)) return { values, error: 'Duplicate ' + attribute + ' is invalid.' };
    if (values.has(value)) return { values, error: 'Duplicate ' + attribute + ' is ambiguous.' };
    values.add(value);
  }
  return { values };
}

function validateDuplicateIdMap(
  oldIds: readonly string[],
  map: Record<string, string>,
  existingIds: ReadonlySet<string>,
  attribute: string,
): string | null {
  const entries = Object.entries(map);
  if (entries.length !== oldIds.length || oldIds.some((id) => !Object.prototype.hasOwnProperty.call(map, id))) {
    return 'Duplicate ' + attribute + ' map is incomplete.';
  }
  const newIds = entries.map(([, value]) => value);
  if (newIds.some((id) => !isDuplicateId(id))) {
    return 'Duplicate ' + attribute + ' map contains an invalid id.';
  }
  if (new Set(newIds).size !== newIds.length) return 'Duplicate ' + attribute + ' map is ambiguous.';
  if (newIds.some((id) => existingIds.has(id))) return 'Duplicate ' + attribute + ' map collides with the source.';
  return null;
}

function isDuplicateId(value: string): boolean {
  return value.length > 0 && !/[\t\n\f\r ]/.test(value);
}

function allocateDuplicateIds(oldIds: readonly string[], existingIds: ReadonlySet<string>): Record<string, string> {
  const used = new Set(existingIds);
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const oldId of oldIds) {
    const nextId = allocateDuplicateId(oldId, used);
    map[oldId] = nextId;
    used.add(nextId);
  }
  return map;
}

function allocateDuplicateId(oldId: string, used: ReadonlySet<string>): string {
  const base = oldId + '-copy';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = base + '-' + suffix;
    suffix += 1;
  }
  return candidate;
}

function rewriteDuplicateElement(
  root: Element,
  plan: Extract<ManualEditPatch, { kind: 'duplicate-and-move' }>['plan'],
  translate: string,
): string | null {
  const elements = duplicateElements(root);
  for (const el of elements) {
    const manualId = el.getAttribute('data-readable-id');
    if (manualId) el.setAttribute('data-readable-id', duplicateMapValue(plan.manualIdMap, manualId) ?? plan.duplicateRootId);
    else if (el === root) el.setAttribute('data-readable-id', plan.duplicateRootId);
    const nativeId = el.getAttribute('id');
    if (nativeId) el.setAttribute('id', duplicateMapValue(plan.nativeIdMap, nativeId) ?? nativeId);
    for (const attr of Array.from(el.attributes)) {
      if (isDuplicateRuntimeAttribute(attr.name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const name = attr.name.toLowerCase();
      const nextValue = rewriteDuplicateAttribute(name, attr.value, plan.nativeIdMap);
      if (nextValue !== attr.value) el.setAttribute(attr.name, nextValue);
    }
  }
  const rootStyle = (root as HTMLElement).style;
  if (translate.trim()) rootStyle.setProperty('translate', translate.trim());
  else rootStyle.removeProperty('translate');
  return null;
}

function isDuplicateRuntimeAttribute(name: string): boolean {
  const normalized = name.toLowerCase();
  return DUPLICATE_RUNTIME_ATTRIBUTES.has(normalized) || normalized.startsWith('data-readable-runtime-');
}

function rewriteDuplicateAttribute(name: string, value: string, nativeIdMap: Record<string, string>): string {
  if (DUPLICATE_FRAGMENT_ATTRIBUTES.has(name)) return rewriteDuplicateFragment(value, nativeIdMap);
  if (DUPLICATE_TOKEN_IDREF_ATTRIBUTES.has(name)) return rewriteDuplicateTokens(value, nativeIdMap);
  if (DUPLICATE_CSS_URL_ATTRIBUTES.has(name)) return rewriteDuplicateCssUrls(value, nativeIdMap);
  return value;
}

function duplicateMapValue(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function rewriteDuplicateFragment(value: string, nativeIdMap: Record<string, string>): string {
  const match = /^(\s*)#([^\s#]+)(\s*)$/.exec(value);
  if (!match?.[2]) return value;
  const replacement = duplicateMapValue(nativeIdMap, match[2]);
  return replacement ? match[1] + '#' + replacement + match[3] : value;
}

function rewriteDuplicateTokens(value: string, nativeIdMap: Record<string, string>): string {
  return value.replace(/\S+/g, (token) => duplicateMapValue(nativeIdMap, token) ?? token);
}

function rewriteDuplicateCssUrls(value: string, nativeIdMap: Record<string, string>): string {
  return value.replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/gi, (full, quote: string, id: string) => {
    const replacement = duplicateMapValue(nativeIdMap, id);
    return replacement ? 'url(' + quote + '#' + replacement + quote + ')' : full;
  });
}

function duplicateTranslate(
  finalTranslate: string,
  placementOffset: { x: number; y: number } | undefined,
): { value: string } | { error: string } {
  if (typeof finalTranslate !== 'string' || !isSupportedDuplicateTranslate(finalTranslate)) {
    return { error: 'Duplicate final translate is unsupported.' };
  }
  if (!placementOffset) return { value: finalTranslate.trim() };
  if (!Number.isFinite(placementOffset.x) || !Number.isFinite(placementOffset.y)) {
    return { error: 'Duplicate placement offset is invalid.' };
  }
  return {
    value: moveCssCommitStyles({
      deltaRect: placementOffset,
      baseTranslate: finalTranslate,
      fractional: { x: true, y: true },
    }).translate,
  };
}

function isSupportedDuplicateTranslate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') return true;
  const tokens = trimmed.split(/\s+/);
  return tokens.length <= 2 && tokens.every((token) => /^-?\d+(?:\.\d+)?px$/.test(token));
}

export function readManualEditFields(source: string, id: string): ManualEditFields {
  const doc = parseSource(source);
  const el = doc ? findEditableElement(doc, id) : null;
  if (!el) return {};
  const kind = inferKind(el);
  if (kind === 'link') {
    return {
      text: el.textContent?.trim() ?? '',
      href: el.getAttribute('href') ?? '',
    };
  }
  if (kind === 'image') {
    return {
      src: el.getAttribute('src') ?? '',
      alt: el.getAttribute('alt') ?? '',
    };
  }
  return { text: el.textContent?.trim() ?? '' };
}

export function readManualEditStyles(source: string, id: string): ManualEditStyles {
  const doc = parseSource(source);
  const el = doc ? findEditableElement(doc, id) : null;
  if (!el) return emptyManualEditStyles();
  const style = (el as HTMLElement).style;
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    acc[key] = (style[key as unknown as keyof CSSStyleDeclaration] as string | undefined) ?? '';
    return acc;
  }, {} as ManualEditStyles);
}

export function readManualEditAttributes(source: string, id: string): Record<string, string> {
  const doc = parseSource(source);
  const el = doc ? findEditableElement(doc, id) : null;
  if (!el) return {};
  const attrs: Record<string, string> = {};
  Array.from(el.attributes).forEach((attr) => {
    if (attr.name === 'data-readable-runtime-id') return;
    attrs[attr.name] = attr.value;
  });
  return attrs;
}

export function readManualEditOuterHtml(source: string, id: string): string {
  const doc = parseSource(source);
  return (doc ? findEditableElement(doc, id)?.outerHTML : '') ?? '';
}

function parseSource(source: string): Document | null {
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(source, 'text/html');
  }
  if (typeof document !== 'undefined') {
    const doc = document.implementation.createHTMLDocument('');
    doc.documentElement.innerHTML = source;
    return doc;
  }
  return null;
}

function serializeSource(doc: Document, originalSource: string): string {
  if (!isManualEditFullHtmlDocument(originalSource)) return doc.body.innerHTML;
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

export function isManualEditFullHtmlDocument(source: string): boolean {
  const normalized = firstSourceToken(source).slice(0, 32).toLowerCase();
  return normalized.startsWith('<!doctype') || normalized.startsWith('<html');
}

function firstSourceToken(source: string): string {
  let rest = source.trimStart();
  while (rest.startsWith('<!--') || rest.startsWith('<?')) {
    const close = rest.startsWith('<!--') ? '-->' : '?>';
    const end = rest.indexOf(close);
    if (end === -1) return rest;
    rest = rest.slice(end + close.length).trimStart();
  }
  return rest;
}

function inferKind(el: Element): 'text' | 'link' | 'image' | 'container' {
  const explicit = el.getAttribute('data-readable-edit');
  if (explicit === 'text' || explicit === 'link' || explicit === 'image' || explicit === 'container') return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'img') return 'image';
  if (['section', 'main', 'nav', 'div', 'article', 'header', 'footer'].includes(tag)) {
    return hasElementChildren(el) && !singleEditableTextNode(el) ? 'container' : 'text';
  }
  return 'text';
}

function findEditableElement(doc: Document, id: string): Element | null {
  if (id === '__body__') return doc.body;
  return (
    doc.querySelector(`[data-readable-id="${cssEscape(id)}"]`) ??
    doc.querySelector(`[data-readable-runtime-id="${cssEscape(id)}"]`) ??
    doc.querySelector(`[data-readable-source-path="${cssEscape(id)}"]`) ??
    findElementByPath(doc, id)
  );
}

function findElementByPath(doc: Document, id: string): Element | null {
  if (!id.startsWith('path-')) return null;
  const indexes = id
    .slice('path-'.length)
    .split('-')
    .map((part) => Number(part));
  if (indexes.some((index) => !Number.isInteger(index) || index < 0)) return null;
  let current: Element | null = doc.body;
  for (const index of indexes) {
    current = current?.children.item(index) ?? null;
    if (!current) return null;
  }
  return current;
}

function hasElementChildren(el: Element): boolean {
  return Array.from(el.children).some((child) => child.nodeType === 1);
}

function singleEditableTextNode(el: Element): Text | null {
  let textNode: Text | null = null;
  const visit = (node: Node): boolean => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        if (!child.textContent?.trim()) continue;
        if (textNode) return false;
        textNode = child as Text;
        continue;
      }
      if (child.nodeType === 1) {
        const childEl = child as Element;
        if (!INLINE_TEXT_WRAPPER_TAGS.has(childEl.tagName.toLowerCase())) return false;
        if (!visit(child)) return false;
        continue;
      }
      if (child.nodeType === 8) continue;
      return false;
    }
    return true;
  };
  return visit(el) ? textNode : null;
}

function setInlineStyles(el: HTMLElement, styles: Partial<ManualEditStyles>): void {
  for (const [name, value] of Object.entries(styles)) {
    const cssName = camelToKebab(name);
    if (typeof value !== 'string' || value.trim() === '') el.style.removeProperty(cssName);
    else el.style.setProperty(cssName, value.trim());
  }
}

function setAttributes(el: Element, attributes: Record<string, string>): void {
  const protectedAttrs = new Set(['data-readable-id', 'data-readable-edit', 'data-readable-label', 'data-readable-runtime-id']);
  for (const [name, value] of Object.entries(attributes)) {
    if (!isSafeAttributeName(name) || protectedAttrs.has(name)) continue;
    if (value.trim() === '') el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
}

// URL schemes allowed to survive on `href`/`src` after a rich-text save. Anything
// outside this set (and any scheme-less URL: relative, anchor, `/`-rooted, or
// scheme-relative `//host`) is treated below; unknown schemes (`data:`,
// `vbscript:`, `file:`, `javascript:`, …) get the URL-bearing attribute dropped.
const SAFE_URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp']);

// Decide whether a URL attribute value is safe to keep. DOMParser has already
// entity-decoded the value, so `&#106;avascript:` arrives as `javascript:`. We
// additionally strip ASCII control/whitespace characters before the scheme test
// so interior-obfuscated schemes (`ja\tvascript:`, newline-split) are caught.
function isSafeUrlValue(value: string): boolean {
  const stripped = value.replace(/[\u0000-\u0020]+/g, '');
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!schemeMatch) return true; // relative / anchor / `/`-rooted / `//host`
  return SAFE_URL_SCHEMES.has((schemeMatch[1] ?? '').toLowerCase());
}

// Chromium's execCommand('bold'/'italic') (the edit bridge's formatting path;
// see bridge.ts) produces `<b>`/`<i>`, but this app's canonical inline markup
// is `<strong>`/`<em>`. Rename on save so the two stay equivalent everywhere
// else that reads saved source (both tags are already in the allowlist, so
// this is a rename, not a behavior change).
const CANONICAL_TAG_RENAMES: Record<string, string> = { b: 'strong', i: 'em' };

// Light, dependency-free normalization for rich-text inner HTML. The goal is
// clean inline markup; blocking obvious script injection is a bonus rather than a
// hardened security boundary. We allowlist inline-formatting tags, preserve
// textless decorative structure that generated text effects rely on, unwrap
// unknown tags (keeping their text), remove `<script>`/`<style>` outright, and
// strip `on*` handlers plus URLs whose scheme is not on the safe allowlist from
// the tags we keep.
function sanitizeInlineHtml(doc: Document, html: string): string {
  const template = doc.createElement('template');
  template.innerHTML = html;
  // Pre-order (parents before children) so unwrapping/renaming a parent still
  // lets the surviving children get visited in the same static snapshot.
  const elements = Array.from(template.content.querySelectorAll('*'));
  for (const original of elements) {
    const tag = original.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') {
      original.remove();
      continue;
    }
    const textless = !(original.textContent ?? '').trim();
    const canonicalTag = textless ? undefined : CANONICAL_TAG_RENAMES[tag];
    const el = canonicalTag ? renameElement(original, canonicalTag) : original;
    const finalTag = el.tagName.toLowerCase();
    const textlessDecorative = DECORATIVE_HTML_ALLOWED_TAGS.has(finalTag) && textless;
    if (!INLINE_HTML_ALLOWED_TAGS.has(finalTag) && !textlessDecorative) {
      unwrapElement(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name.endsWith(':href')) && !isSafeUrlValue(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return template.innerHTML;
}

// Swap an element's tag name in place: create the replacement, move over
// attributes and children (same nodes, so already-visited descendants in the
// caller's element snapshot stay attached and correctly parented), then swap
// it into the original's spot.
function renameElement(el: Element, tagName: string): Element {
  const replacement = el.ownerDocument.createElement(tagName);
  for (const attr of Array.from(el.attributes)) replacement.setAttribute(attr.name, attr.value);
  while (el.firstChild) replacement.appendChild(el.firstChild);
  el.replaceWith(replacement);
  return replacement;
}

function unwrapElement(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function replaceOuterHtml(doc: Document, el: Element, html: string): { ok: true } | { ok: false; error: string } {
  const template = doc.createElement('template');
  template.innerHTML = html.trim();
  const elements = Array.from(template.content.children);
  if (elements.length !== 1) return { ok: false, error: 'Replacement HTML must contain exactly one root element.' };
  const next = elements[0]!;
  if (el.getAttribute('data-readable-id') && !next.getAttribute('data-readable-id')) {
    next.setAttribute('data-readable-id', el.getAttribute('data-readable-id') ?? '');
  }
  if (el.getAttribute('data-readable-edit') && !next.getAttribute('data-readable-edit')) {
    next.setAttribute('data-readable-edit', el.getAttribute('data-readable-edit') ?? '');
  }
  el.replaceWith(next);
  return { ok: true };
}

function setCssToken(doc: Document, token: string, value: string): boolean {
  const styles = Array.from(doc.querySelectorAll('style'));
  const pattern = new RegExp(`(${escapeRegExp(token)}\\s*:\\s*)([^;]+)(;)`);
  for (const style of styles) {
    const text = style.textContent ?? '';
    if (!pattern.test(text)) continue;
    style.textContent = text.replace(pattern, `$1${value}$3`);
    return true;
  }
  return false;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function isSafeAttributeName(value: string): boolean {
  return /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/.test(value);
}
