import { defaultTreeAdapter, html, parse, parseFragment, serializeOuter, type DefaultTreeAdapterMap, type ParserError } from 'parse5';
import { generate, ident, parse as parseCss, type CssNode } from 'css-tree';

export const WIDTH_RELEASE_SCHEMA = 'readable.width-release.v1';
const ID_ATTRIBUTE = 'data-readable-id';
const RECORD_ATTRIBUTE = 'data-readable-width-release';
const HTML_NAMESPACE = html.NS.HTML;

export type WidthReleaseCause = 'own-max-width' | 'own-max-inline-size' | 'own-inline-display' | 'own-width-cascade';
export type WidthReleaseFamily = 'horizontal-size' | 'vertical-size' | 'display' | 'margins';
export interface WidthReleaseDeclaration {
  property: string;
  value: string;
  priority: '' | 'important';
}
export interface WidthReleaseProvenance extends WidthReleaseDeclaration {
  selector?: string;
  href?: string;
  conditions: string[];
  complete?: boolean;
}
export interface WidthReleaseRecord {
  schema: typeof WIDTH_RELEASE_SCHEMA;
  id: string;
  targetId: string;
  tag: string;
  preferredCssPx: number;
  mode?: 'auto' | 'fill';
  causes: WidthReleaseCause[];
  before: WidthReleaseDeclaration[];
  after: WidthReleaseDeclaration[];
  ownedFamilies: WidthReleaseFamily[];
  provenance: WidthReleaseProvenance[];
}
export interface WidthReleaseSelection { targetId: string; tag: string }
export type WidthReleaseTarget =
  | { targetId: string; tag?: string; releaseId?: string }
  | { sourcePath: string; tag: string }
  | { startTagOffset: number; tag: string };
interface ReleaseIntent {
  preferredCssPx: number;
  /** Measured, selected-element-only patch, including necessary own-cascade priority. */
  declarations: WidthReleaseDeclaration[];
  causes?: WidthReleaseCause[];
  provenance?: WidthReleaseProvenance[];
  mode?: 'auto' | 'fill';
}
export type WidthReleaseOperation =
  | { kind: 'inspect'; target?: WidthReleaseTarget; expectedSource?: string }
  | ({ kind: 'apply'; target: WidthReleaseTarget; expectedSource: string; causes: WidthReleaseCause[] } & ReleaseIntent)
  | ({ kind: 'update'; target: { targetId: string; tag?: string; releaseId?: string }; expectedSource?: string } & ReleaseIntent)
  | { kind: 'restore'; target: { targetId: string; tag?: string; releaseId?: string }; expectedSource?: string };
export interface WidthReleaseConflict {
  code: 'WIDTH_RELEASE_CONFLICT';
  reason: 'source-changed' | 'target-missing' | 'target-identity-changed' | 'duplicate-target' | 'duplicate-release'
    | 'ambiguous-attributes' | 'unsupported-target' | 'record-missing' | 'record-exists' | 'invalid-record'
    | 'unsupported-schema' | 'owned-declarations-changed' | 'invalid-style' | 'invalid-operation';
  targetId?: string;
}
export interface WidthReleaseSuccess {
  ok: true;
  source: string;
  records: WidthReleaseRecord[];
  selection?: WidthReleaseSelection;
  record?: WidthReleaseRecord;
}
export type WidthReleaseResult = WidthReleaseSuccess | { ok: false; source: string; conflict: WidthReleaseConflict };

type Element = DefaultTreeAdapterMap['element'];
type Parent = DefaultTreeAdapterMap['parentNode'];
type LocatedDeclaration = WidthReleaseDeclaration & { start: number; end: number; semantic: string };
const families: Record<WidthReleaseFamily, readonly string[]> = {
  'horizontal-size': ['width', 'inline-size', 'max-width', 'max-inline-size'],
  'vertical-size': ['height', 'block-size', 'max-height', 'max-block-size'],
  display: ['display'],
  // A physical shorthand can affect both axes. Own its complete overlapping family,
  // including logical aliases, rather than restoring just margin-left incorrectly.
  margins: ['margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'margin-inline', 'margin-inline-start', 'margin-inline-end', 'margin-block', 'margin-block-start', 'margin-block-end'],
};
const causes: readonly string[] = ['own-max-width', 'own-max-inline-size', 'own-inline-display', 'own-width-cascade'];
class Conflict extends Error {
  constructor(readonly reason: WidthReleaseConflict['reason'], readonly targetId?: string) { super(reason); }
}
function fail(reason: WidthReleaseConflict['reason'], targetId?: string): never { throw new Conflict(reason, targetId); }
function attribute(element: Element, name: string): string | undefined { return element.attrs.find((item) => item.name === name)?.value; }
function familyOf(property: string): WidthReleaseFamily | undefined {
  return (Object.keys(families) as WidthReleaseFamily[]).find((family) => families[family].includes(property));
}
function owns(owned: readonly WidthReleaseFamily[], property: string): boolean { const family = familyOf(property); return family !== undefined && owned.includes(family); }
function plain(declaration: WidthReleaseDeclaration): WidthReleaseDeclaration { return { property: declaration.property, value: declaration.value, priority: declaration.priority }; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }

function declarationsFrom(style: string): LocatedDeclaration[] {
  let ast: CssNode;
  try {
    ast = parseCss(style, { context: 'declarationList', positions: true, onParseError: () => fail('invalid-style') });
  } catch (error) {
    if (error instanceof Conflict) throw error;
    if (error instanceof SyntaxError) fail('invalid-style');
    throw error;
  }
  if (ast.type !== 'DeclarationList') fail('invalid-style');
  const result: LocatedDeclaration[] = [];
  for (const node of ast.children) {
    if (node.type !== 'Declaration' || !node.loc || !node.value.loc) fail('invalid-style');
    const property = ident.decode(node.property).toLowerCase();
    if (property === 'all') fail('invalid-style'); // overlaps every owned family
    if (node.value.type === 'Raw' && !property.startsWith('--')) fail('invalid-style');
    const value = style.slice(node.value.loc.start.offset, node.value.loc.end.offset).trim();
    if (!value) fail('invalid-style');
    let end = node.loc.end.offset;
    if (style[end] === ';') end++;
    result.push({ property, value, priority: node.important ? 'important' : '', start: node.loc.start.offset, end, semantic: generate(node.value) });
  }
  return result;
}
function validDeclaration(value: unknown): value is WidthReleaseDeclaration {
  if (!object(value) || !keys(value, ['property', 'value', 'priority']) || typeof value.property !== 'string'
    || !familyOf(value.property) || typeof value.value !== 'string' || !['', 'important'].includes(String(value.priority))) return false;
  try {
    const parsed = declarationsFrom(`${value.property}:${value.value}${value.priority === 'important' ? ' !important' : ''}`);
    return parsed.length === 1 && parsed[0].property === value.property && parsed[0].priority === value.priority
      && parsed[0].value === value.value.trim();
  } catch (error) { if (error instanceof Conflict) return false; throw error; }
}
function validProvenance(value: unknown): value is WidthReleaseProvenance {
  return object(value) && keys(value, ['property', 'value', 'priority', 'selector', 'href', 'conditions', 'complete'])
    && typeof value.property === 'string' && familyOf(value.property) !== undefined && typeof value.value === 'string'
    && (value.priority === '' || value.priority === 'important') && strings(value.conditions)
    && (value.selector === undefined || typeof value.selector === 'string') && (value.href === undefined || typeof value.href === 'string')
    && (value.complete === undefined || typeof value.complete === 'boolean');
}
function readRecord(text: string): WidthReleaseRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) fail('invalid-record'); throw error; }
  if (!object(value)) fail('invalid-record');
  if (typeof value.schema === 'string' && value.schema !== WIDTH_RELEASE_SCHEMA) fail('unsupported-schema');
  if (!keys(value, ['schema', 'id', 'targetId', 'tag', 'preferredCssPx', 'mode', 'causes', 'before', 'after', 'ownedFamilies', 'provenance'])
    || value.schema !== WIDTH_RELEASE_SCHEMA || !nonempty(value.id) || !nonempty(value.targetId) || !nonempty(value.tag)
    || !/^[a-z][a-z0-9-]*$/u.test(value.tag) || typeof value.preferredCssPx !== 'number' || !Number.isFinite(value.preferredCssPx) || value.preferredCssPx <= 0
    || (value.mode !== undefined && value.mode !== 'auto' && value.mode !== 'fill')
    || !Array.isArray(value.causes) || value.causes.length === 0 || !value.causes.every((cause) => causes.includes(cause))
    || !Array.isArray(value.ownedFamilies) || value.ownedFamilies.length === 0 || !value.ownedFamilies.includes('horizontal-size')
    || !value.ownedFamilies.every((family) => Object.hasOwn(families, family)) || new Set(value.ownedFamilies).size !== value.ownedFamilies.length
    || !Array.isArray(value.before) || !value.before.every(validDeclaration) || !Array.isArray(value.after) || !value.after.every(validDeclaration)
    || !Array.isArray(value.provenance) || !value.provenance.every(validProvenance)) fail('invalid-record');
  const record = value as unknown as WidthReleaseRecord;
  if (![...record.before, ...record.after].every((declaration) => owns(record.ownedFamilies, declaration.property))
    || !record.after.some((declaration) => declaration.property === 'width' || declaration.property === 'inline-size')) fail('invalid-record');
  return record;
}
function sameDeclarations(current: WidthReleaseDeclaration[], expected: WidthReleaseDeclaration[]): boolean {
  const normalized = (items: WidthReleaseDeclaration[]) => items.map((item) => [item.property, declarationsFrom(`${item.property}:${item.value}`)[0].semantic, item.priority]);
  return JSON.stringify(normalized(current)) === JSON.stringify(normalized(expected));
}
function parseSource(source: string) {
  const errors: ParserError[] = [];
  const options = { sourceCodeLocationInfo: true, onParseError: (error: ParserError) => { errors.push(error); } };
  const firstToken = source.replace(/^(?:\s|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)*/u, '');
  const full = /^<(?:!doctype\b|html\b|head\b|body\b)/iu.test(firstToken);
  const root = full ? parse(source, options) : parseFragment(source, options);
  const elements: Element[] = [];
  const visit = (parent: Parent) => {
    for (const child of parent.childNodes) if ('tagName' in child) {
      elements.push(child);
      visit(child);
      if ('content' in child) visit(child.content);
    }
  };
  visit(root);
  return { elements, root, errors, full };
}
function checkElement(element: Element, errors: ParserError[]) {
  const location = element.sourceCodeLocation?.startTag;
  if (!location || element.namespaceURI !== HTML_NAMESPACE) fail('unsupported-target');
  if (errors.some((error) => error.code === 'duplicate-attribute' && error.startOffset >= location.startOffset && error.startOffset < location.endOffset)) fail('ambiguous-attributes');
}
function locate(parsed: ReturnType<typeof parseSource>, target: WidthReleaseTarget, expectedSource: string | undefined): Element {
  let found: Element | undefined;
  if ('targetId' in target) {
    const matches = parsed.elements.filter((element) => attribute(element, ID_ATTRIBUTE) === target.targetId);
    if (matches.length > 1) fail('duplicate-target', target.targetId);
    found = matches[0];
  } else {
    if (expectedSource === undefined) fail('source-changed');
    if ('startTagOffset' in target) {
      const matches = parsed.elements.filter((element) => element.sourceCodeLocation?.startTag?.startOffset === target.startTagOffset);
      if (matches.length > 1) fail('unsupported-target');
      found = matches[0];
    } else {
      if (!/^path-\d+(?:-\d+)*$/u.test(target.sourcePath)) fail('target-missing');
      // Preview paths use DOMParser's document body, not fragment child indexes:
      // a leading style/title belongs to the head and must not shift the target.
      const document = parsed.full ? parsed.root : parse(expectedSource, { sourceCodeLocationInfo: true });
      const documentElement = document.childNodes.find((child): child is Element => 'tagName' in child && child.tagName === 'html');
      let current: Parent | undefined = documentElement?.childNodes.find((child): child is Element => 'tagName' in child && child.tagName === 'body');
      for (const index of target.sourcePath.slice(5).split('-').map(Number)) current = current?.childNodes.filter((child): child is Element => 'tagName' in child)[index];
      const offset = current && 'tagName' in current ? current.sourceCodeLocation?.startTag?.startOffset : undefined;
      if (offset !== undefined) {
        const matches = parsed.elements.filter((element) => element.sourceCodeLocation?.startTag?.startOffset === offset);
        if (matches.length > 1) fail('unsupported-target');
        found = matches[0];
      }
    }
  }
  if (!found) fail('target-missing', 'targetId' in target ? target.targetId : undefined);
  if (target.tag !== undefined && target.tag !== found.tagName) fail('target-identity-changed');
  checkElement(found, parsed.errors);
  return found;
}
function collect(parsed: ReturnType<typeof parseSource>): Map<Element, WidthReleaseRecord> {
  const records = new Map<Element, WidthReleaseRecord>();
  const ids = new Set<string>();
  for (const element of parsed.elements) {
    const id = attribute(element, ID_ATTRIBUTE);
    if (id !== undefined) { if (ids.has(id)) fail('duplicate-target', id); ids.add(id); }
  }
  const releaseIds = new Set<string>();
  for (const element of parsed.elements) {
    const raw = attribute(element, RECORD_ATTRIBUTE);
    if (raw === undefined) continue;
    checkElement(element, parsed.errors);
    const record = readRecord(raw);
    if (record.targetId !== attribute(element, ID_ATTRIBUTE) || record.tag !== element.tagName) fail('target-identity-changed', record.targetId);
    if (releaseIds.has(record.id)) fail('duplicate-release', record.targetId);
    releaseIds.add(record.id);
    const current = declarationsFrom(attribute(element, 'style') ?? '').filter((declaration) => owns(record.ownedFamilies, declaration.property));
    if (!sameDeclarations(current, record.after)) fail('owned-declarations-changed', record.targetId);
    records.set(element, record);
  }
  return records;
}
function allocate(prefix: string, used: Set<string>): string { let index = 1; while (used.has(`${prefix}-${index}`)) index++; return `${prefix}-${index}`; }
function validateIntent(intent: ReleaseIntent, applying: boolean): void {
  if (!Number.isFinite(intent.preferredCssPx) || intent.preferredCssPx <= 0 || !Array.isArray(intent.declarations) || intent.declarations.length === 0
    || !intent.declarations.every(validDeclaration)
    || (intent.mode !== undefined && intent.mode !== 'auto' && intent.mode !== 'fill')
    || (intent.causes !== undefined && (!Array.isArray(intent.causes) || !intent.causes.every((cause) => causes.includes(cause))))
    || (intent.provenance !== undefined && (!Array.isArray(intent.provenance) || !intent.provenance.every(validProvenance)))
    || (applying && (!intent.causes?.length || !intent.declarations.some((declaration) => ['width', 'inline-size'].includes(declaration.property))))) fail('invalid-operation');
  for (const declaration of intent.declarations) {
    if (['max-width', 'max-inline-size'].includes(declaration.property)
      && !['100%', '-moz-available', 'stretch'].includes(declaration.value.trim())) fail('invalid-operation');
    if (declaration.property === 'display' && declaration.value.trim() !== 'inline-block') fail('invalid-operation');
  }
}
function declarationText(declaration: WidthReleaseDeclaration): string {
  return `${declaration.property}: ${declaration.value}${declaration.priority ? ' !important' : ''};`;
}
function rewriteStyle(style: string, current: LocatedDeclaration[], owned: WidthReleaseFamily[], replacement: WidthReleaseDeclaration[]): string {
  let result = style;
  // Removing complete owned families preserves all unowned declarations and comments.
  for (const declaration of [...current].reverse()) if (owns(owned, declaration.property)) result = result.slice(0, declaration.start) + result.slice(declaration.end);
  const append = replacement.map(declarationText).join(' ');
  if (!append) return result.trim() ? result : '';
  if (result.trim() && !result.trimEnd().endsWith(';')) result += ';';
  return result + (result && !/\s$/u.test(result) ? ' ' : '') + append;
}
/** Serialize only a synthetic attribute carrier, never the artifact document. */
function serializedAttribute(name: string, value: string): string {
  const carrier = defaultTreeAdapter.createElement('span', HTML_NAMESPACE, [{ name, value }]);
  const text = serializeOuter(carrier);
  return text.slice('<span '.length, -'></span>'.length);
}
function spliceAttributes(source: string, element: Element, changes: Record<string, string | undefined>): string {
  const location = element.sourceCodeLocation!;
  const tag = location.startTag!;
  const edits: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries(changes)) {
    const existing = location.attrs?.[name];
    if (existing) {
      let start = existing.startOffset;
      if (value === undefined) while (start > tag.startOffset && /\s/u.test(source[start - 1])) start--;
      edits.push({ start, end: existing.endOffset, text: value === undefined ? '' : serializedAttribute(name, value) });
    } else if (value !== undefined) additions.push(serializedAttribute(name, value));
  }
  if (additions.length) {
    // In an unquoted value, the slash in title=x/> belongs to the value.
    const closingSlash = source[tag.endOffset - 2] === '/'
      && !Object.values(location.attrs ?? {}).some((attr) => attr.endOffset > tag.endOffset - 2);
    const start = closingSlash ? tag.endOffset - 2 : tag.endOffset - 1;
    edits.push({ start, end: start, text: ` ${additions.join(' ')}` });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/**
 * Pure source transaction. The caller supplies already-measured safe declarations;
 * this module does not infer layout safety, run scripts or relax parent allocation.
 * Positional identities are accepted only against the exact expectedSource snapshot.
 */
export function editWidthRelease(source: string, operation: WidthReleaseOperation): WidthReleaseResult {
  try {
    if (operation.expectedSource !== undefined && operation.expectedSource !== source) fail('source-changed');
    const parsed = parseSource(source);
    const records = collect(parsed);
    if (operation.kind === 'inspect' && !operation.target) return { ok: true, source, records: [...records.values()] };
    if (!operation.target) fail('invalid-operation');
    const element = locate(parsed, operation.target, operation.expectedSource);
    const existing = records.get(element);
    if ('releaseId' in operation.target && operation.target.releaseId !== undefined && existing?.id !== operation.target.releaseId) fail('target-identity-changed');
    let targetId = attribute(element, ID_ATTRIBUTE);
    if (operation.kind === 'inspect') return {
      ok: true, source, records: [...records.values()], record: existing,
      ...(targetId === undefined ? {} : { selection: { targetId, tag: element.tagName } }),
    };
    if (operation.kind === 'apply' && existing) fail('record-exists', targetId);
    if (operation.kind !== 'apply' && !existing) fail('record-missing', targetId);
    const style = attribute(element, 'style') ?? '';
    const current = declarationsFrom(style);
    if (operation.kind === 'restore') {
      const record = existing!;
      const restored = rewriteStyle(style, current, record.ownedFamilies, record.before);
      const nextSource = spliceAttributes(source, element, { style: restored || undefined, [RECORD_ATTRIBUTE]: undefined });
      records.delete(element);
      return { ok: true, source: nextSource, records: [...records.values()], selection: { targetId: record.targetId, tag: element.tagName } };
    }
    validateIntent(operation, operation.kind === 'apply');
    if (operation.kind === 'apply' && operation.expectedSource === undefined) fail('source-changed');
    if (targetId !== undefined && !nonempty(targetId)) fail('target-identity-changed');
    targetId ??= allocate('rw', new Set(parsed.elements.map((item) => attribute(item, ID_ATTRIBUTE)).filter((id): id is string => id !== undefined)));
    const ownedFamilies: WidthReleaseFamily[] = [...(existing?.ownedFamilies ?? ['horizontal-size'])];
    for (const declaration of operation.declarations) {
      const family = familyOf(declaration.property)!;
      if (!ownedFamilies.includes(family)) ownedFamilies.push(family);
    }
    const newlyOwned = ownedFamilies.filter((family) => !existing?.ownedFamilies.includes(family));
    const before = existing ? [...existing.before, ...current.filter((declaration) => owns(newlyOwned, declaration.property)).map(plain)]
      : current.filter((declaration) => owns(ownedFamilies, declaration.property)).map(plain);
    const patched = new Set(operation.declarations.map((declaration) => declaration.property));
    const after = [...current.filter((declaration) => owns(ownedFamilies, declaration.property) && !patched.has(declaration.property)).map(plain), ...operation.declarations.map(plain)];
    const mode = operation.mode ?? (patched.has('width') || patched.has('inline-size') ? undefined : existing?.mode);
    const record: WidthReleaseRecord = {
      schema: WIDTH_RELEASE_SCHEMA,
      id: existing?.id ?? allocate('wr', new Set([...records.values()].map((item) => item.id))),
      targetId, tag: element.tagName, preferredCssPx: operation.preferredCssPx,
      ...(mode === undefined ? {} : { mode }),
      causes: [...new Set([...(existing?.causes ?? []), ...(operation.causes ?? [])])],
      before, after, ownedFamilies,
      provenance: [...new Map([...(existing?.provenance ?? []), ...(operation.provenance ?? [])].map((item) => [JSON.stringify(item), item])).values()],
    };
    const nextStyle = rewriteStyle(style, current, ownedFamilies, after);
    const nextSource = spliceAttributes(source, element, {
      ...(attribute(element, ID_ATTRIBUTE) === undefined ? { [ID_ATTRIBUTE]: targetId } : {}),
      [RECORD_ATTRIBUTE]: JSON.stringify(record), style: nextStyle,
    });
    records.set(element, record);
    return { ok: true, source: nextSource, records: [...records.values()], selection: { targetId, tag: element.tagName }, record };
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    return { ok: false, source, conflict: { code: 'WIDTH_RELEASE_CONFLICT', reason: error.reason, ...(error.targetId === undefined ? {} : { targetId: error.targetId }) } };
  }
}
