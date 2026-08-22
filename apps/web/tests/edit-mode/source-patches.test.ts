import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  applyManualEditPatch,
  isManualEditFullHtmlDocument,
  planManualEditDuplicate,
  readManualEditAttributes,
  readManualEditFields,
  readManualEditOuterHtml,
  readManualEditStyles,
} from '../../src/edit-mode/source-patches';

const baseSource = `<!doctype html>
<html>
  <head>
    <style>:root { --brand: #111; }</style>
  </head>
  <body>
    <main>
      <h1 data-readable-id="hero-title">Original title</h1>
      <a data-readable-id="cta" href="/start">Start</a>
      <button data-readable-id="button-cta">Start button</button>
      <a data-readable-id="nested-cta" href="/nested"><span>Buy now</span><svg viewBox="0 0 1 1"></svg></a>
      <img data-readable-id="hero-image" src="/old.png" alt="Old image">
      <section data-readable-id="card" class="hero" style="color: red; padding: 8px;" data-keep="yes">Card</section>
      <p data-readable-id="nested"><strong>Nested</strong> copy</p>
      <p>Generated path text</p>
    </main>
  </body>
</html>`;

const duplicateSource = `<!doctype html>
<html>
  <body>
    <main>
      <section data-readable-id="card" data-readable-source-path="path-0-0" data-readable-runtime-id="runtime-card" data-readable-runtime-hovered="true" style="translate: 2px 3px">
        <h2 data-readable-id="card-title" id="title">Title</h2>
        <svg>
          <defs><linearGradient id="paint"></linearGradient></defs>
          <rect id="shape" fill="url(#paint)"></rect>
        </svg>
        <a href="#title" aria-describedby="title external">Jump</a>
        <a href="https://example.test/page#title">External</a>
      </section>
      <p data-readable-id="after">After</p>
    </main>
  </body>
</html>`;

describe('manual edit source patches', () => {
  beforeEach(() => {
    const dom = new JSDOM('');
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.CSS = { escape: (value: string) => value.replace(/"/g, '\\"') } as typeof CSS;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'DOMParser');
    Reflect.deleteProperty(globalThis, 'CSS');
  });

  it('updates only the selected text target', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-text', id: 'hero-title', value: 'Edited title' });

    expect(result.ok).toBe(true);
    expect(readManualEditFields(result.source, 'hero-title').text).toBe('Edited title');
    expect(readManualEditFields(result.source, 'cta').text).toBe('Start');
  });

  it('updates link label and href', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-link', id: 'cta', text: 'Buy now', href: '/buy' });

    expect(result.ok).toBe(true);
    expect(readManualEditFields(result.source, 'cta')).toEqual({ text: 'Buy now', href: '/buy' });
  });

  it('treats buttons as label-only text targets instead of persisting href attributes', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-text', id: 'button-cta', value: 'Buy button' });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'button-cta');
    expect(html).toContain('Buy button');
    expect(html).not.toContain('href=');
    expect(readManualEditFields(result.source, 'button-cta')).toEqual({ text: 'Buy button' });
  });

  it('preserves nested link markup when only href changes', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-link', id: 'nested-cta', text: 'Buy now', href: '/buy' });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'nested-cta');
    expect(html).toContain('href="/buy"');
    expect(html).toContain('<span>Buy now</span>');
    expect(html).toContain('<svg');
  });

  it('rejects label edits for links with nested markup', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-link', id: 'nested-cta', text: 'Purchase', href: '/buy' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nested markup');
  });

  it('updates image src and alt', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-image', id: 'hero-image', src: '/new.png', alt: 'New image' });

    expect(result.ok).toBe(true);
    expect(readManualEditFields(result.source, 'hero-image')).toEqual({ src: '/new.png', alt: 'New image' });
  });

  it('adds and removes inline style properties', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-style',
      id: 'card',
      styles: {
        color: '',
        backgroundColor: '#ff0000',
        fontSize: '24px',
        paddingTop: '12px',
        marginLeft: '4px',
        borderTopWidth: '2px',
        borderStyle: 'solid',
        borderColor: '#000000',
        borderRadius: '8px',
        opacity: '0.5',
      },
    });

    expect(result.ok).toBe(true);
    const styles = readManualEditStyles(result.source, 'card');
    expect(styles.color).toBe('');
    expect(styles.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(styles.fontSize).toBe('24px');
    expect(styles.padding).toBe('12px 8px 8px');
    expect(styles.paddingTop).toBe('12px');
    expect(styles.marginLeft).toBe('4px');
    expect(styles.borderTopWidth).toBe('2px');
    expect(styles.borderStyle).toBe('solid');
    expect(styles.borderColor).toBe('rgb(0, 0, 0)');
    expect(styles.borderRadius).toBe('8px');
    expect(styles.opacity).toBe('0.5');
  });

  it('applies styles to a semantic SVG source-path target without flattening its markup', () => {
    const source = '<main><section><svg role="img" aria-label="Diagram"><defs><linearGradient id="paint"></linearGradient></defs><text>Label</text></svg></section></main>';
    const result = applyManualEditPatch(source, {
      kind: 'set-style',
      id: 'path-0-0-0',
      styles: { translate: '8px 4px', opacity: '0.75' },
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'path-0-0-0');
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Diagram"');
    expect(html).toContain('translate: 8px 4px');
    expect(readManualEditStyles(result.source, 'path-0-0-0').opacity).toBe('0.75');
  });

  it('applies attributes additively and preserves class/style unless explicitly updated', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-attributes',
      id: 'card',
      attributes: { 'aria-label': 'Hero card', 'data-empty': '', 'data-readable-id': 'blocked' },
    });

    expect(result.ok).toBe(true);
    const attrs = readManualEditAttributes(result.source, 'card');
    expect(attrs['aria-label']).toBe('Hero card');
    expect(attrs.class).toBe('hero');
    expect(attrs.style).toContain('color: red');
    expect(attrs['data-readable-id']).toBe('card');
    expect(attrs['data-empty']).toBeUndefined();
  });

  it('preserves data-readable-id when selected outerHTML omits it', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-outer-html',
      id: 'card',
      html: '<section class="replacement">Replaced</section>',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'card');
    expect(html).toContain('data-readable-id="card"');
    expect(html).toContain('class="replacement"');
  });

  it('replaces full source for snapshot-based undo history', () => {
    const source = '<!doctype html><html><body><h1 data-readable-id="hero-title">Snapshot</h1></body></html>';
    const result = applyManualEditPatch(baseSource, { kind: 'set-full-source', source });

    expect(result).toEqual({ ok: true, source });
  });

  it('updates CSS tokens in style tags', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-token', token: '--brand', value: '#f00' });

    expect(result.ok).toBe(true);
    expect(result.source).toContain('--brand: #f00;');
  });

  it('preserves fragment-shaped HTML when saving patches', () => {
    const source = '<main><h1 data-readable-id="hero-title">Original title</h1></main>';
    const result = applyManualEditPatch(source, { kind: 'set-text', id: 'hero-title', value: 'Edited title' });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('<main><h1 data-readable-id="hero-title">Edited title</h1></main>');
    expect(result.source).not.toContain('<!doctype');
    expect(result.source).not.toContain('<html');
    expect(result.source).not.toContain('<body');
  });

  it('detects full documents after leading comments and keeps fragments distinct', () => {
    expect(isManualEditFullHtmlDocument('<!-- generated -->\n<!doctype html><html></html>')).toBe(true);
    expect(isManualEditFullHtmlDocument('<?xml version="1.0"?>\n<html></html>')).toBe(true);
    expect(isManualEditFullHtmlDocument('<main><h1>Fragment</h1></main>')).toBe(false);
  });

  it('preserves full documents with leading comments when saving patches', () => {
    const source = [
      '<!-- generated by open design -->',
      '<!doctype html><html><head><style>:root { --brand: #111; }</style></head>',
      '<body><main><h1 data-readable-id="hero-title">Original title</h1></main></body></html>',
    ].join('\n');
    const result = applyManualEditPatch(source, { kind: 'set-text', id: 'hero-title', value: 'Edited title' });

    expect(result.ok).toBe(true);
    expect(result.source).toContain('<!doctype html>');
    expect(result.source).toContain('<html>');
    expect(result.source).toContain('<head><style>:root { --brand: #111; }</style></head>');
    expect(result.source).toContain('<h1 data-readable-id="hero-title">Edited title</h1>');
  });

  it('addresses unannotated elements with generated DOM path ids', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-text', id: 'path-0-7', value: 'Path target' });

    expect(result.ok).toBe(true);
    expect(result.source).toContain('Path target');
  });

  it('updates single-inline value wrappers without dropping the inline wrapper', () => {
    const source = '<main><div class="value"><strong>42</strong></div></main>';
    const result = applyManualEditPatch(source, { kind: 'set-text', id: 'path-0-0', value: '43' });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('<main><div class="value"><strong>43</strong></div></main>');
  });

  it('rejects text patches for nested markup', () => {
    const result = applyManualEditPatch(baseSource, { kind: 'set-text', id: 'nested', value: 'Flat text' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nested markup');
  });

  it('keeps mixed inline wrappers on the HTML editing path', () => {
    const source = '<main><div class="value"><strong>2019</strong> — San Francisco</div></main>';
    const result = applyManualEditPatch(source, { kind: 'set-text', id: 'path-0-0', value: '2020' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nested markup');
  });

  it('replaces inner html for mixed-markup elements via set-inner-html', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'nested',
      html: '<strong>Nested</strong> updated copy',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'nested');
    expect(html).toContain('<strong>Nested</strong>');
    expect(html).toContain('updated copy');
    // Sibling target text outside this element is untouched.
    expect(readManualEditFields(result.source, 'hero-title').text).toBe('Original title');
  });

  it('sanitizes script tags, event handlers, and javascript: urls in set-inner-html', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'hero-title',
      html: 'Safe <strong onclick="evil()">bold</strong><script>alert(1)</script> <a href="javascript:steal()">link</a>',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'hero-title');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('Safe');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('javascript:');
  });

  it('strips unsafe url schemes (data:/vbscript:/obfuscated javascript:) but keeps safe ones', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'hero-title',
      html: [
        '<a href="data:text/html,evil">data</a>',
        '<a href="vbscript:msgbox(1)">vb</a>',
        '<a href="ja\tvascript:steal()">obf</a>',
        '<a href="https://safe.example/x">https</a>',
        '<a href="http://safe.example/x">http</a>',
        '<a href="mailto:a@b.co">mail</a>',
        '<a href="tel:+1555">tel</a>',
        '<a href="/rooted/path">rooted</a>',
        '<a href="relative/path">rel</a>',
        '<a href="#anchor">anchor</a>',
      ].join(''),
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'hero-title');
    // Unsafe schemes (and obfuscated javascript: with an embedded tab) are dropped.
    expect(html).not.toContain('data:');
    expect(html).not.toContain('vbscript:');
    expect(html).not.toContain('vascript');
    expect(html).not.toContain('steal');
    expect(html).not.toContain('msgbox');
    // Safe schemes and scheme-less URLs survive untouched.
    expect(html).toContain('href="https://safe.example/x"');
    expect(html).toContain('href="http://safe.example/x"');
    expect(html).toContain('href="mailto:a@b.co"');
    expect(html).toContain('href="tel:+1555"');
    expect(html).toContain('href="/rooted/path"');
    expect(html).toContain('href="relative/path"');
    expect(html).toContain('href="#anchor"');
  });

  it('normalizes execCommand-produced <b>/<i> tags to canonical <strong>/<em> in set-inner-html', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'hero-title',
      html: 'Safe <b>bold</b> and <i>italic</i> and <u>under</u>',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'hero-title');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<u>under</u>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
  });

  it('normalizes nested <b><i> tags to nested <strong><em>', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'hero-title',
      html: '<b><i>both</i></b>',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'hero-title');
    expect(html).toContain('<strong><em>both</em></strong>');
  });

  it('preserves textless decorative structure in structured rich text saves', () => {
    const source = '<main><div data-readable-id="fancy-title">Big Headline<div class="glow-underline"></div></div></main>';
    const result = applyManualEditPatch(source, {
      kind: 'set-inner-html',
      id: 'fancy-title',
      html: 'Edited Headline<div class="glow-underline"></div>',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('<main><div data-readable-id="fancy-title">Edited Headline<div class="glow-underline"></div></div></main>');
  });

  it('preserves empty icon wrappers and textless svgs in structured rich text saves', () => {
    const source = '<main><div data-readable-id="label">Label<i class="icon"></i><svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path></svg></div></main>';
    const result = applyManualEditPatch(source, {
      kind: 'set-inner-html',
      id: 'label',
      html: 'Edited<i class="icon"></i><svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path><use xlink:href="javascript:alert(1)"></use></svg>',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('<main><div data-readable-id="label">Edited<i class="icon"></i><svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path><use></use></svg></div></main>');
  });

  it('keeps allowlisted inline formatting but unwraps unknown block tags in set-inner-html', () => {
    const result = applyManualEditPatch(baseSource, {
      kind: 'set-inner-html',
      id: 'hero-title',
      html: '<u>Underlined</u> <div>blocky</div> <em>emph</em>',
    });

    expect(result.ok).toBe(true);
    const html = readManualEditOuterHtml(result.source, 'hero-title');
    expect(html).toContain('<u>Underlined</u>');
    expect(html).toContain('<em>emph</em>');
    expect(html).toContain('blocky');
    expect(html).not.toContain('<div>');
  });

  it('plans and applies a source-backed duplicate with remapped ids and references', () => {
    const planned = planManualEditDuplicate(duplicateSource, 'card');

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan).toMatchObject({
      originalId: 'card',
      originalTagName: 'section',
      parentPath: 'path-0',
      expectedNextSiblingPath: 'path-0-1',
      baselineTranslate: '2px 3px',
    });
    expect(planned.plan?.previewHtml).not.toContain('data-readable-runtime-id');
    expect(planned.plan?.previewHtml).not.toContain('data-readable-source-path');

    const plan = planned.plan!;
    const result = applyManualEditPatch(duplicateSource, {
      id: 'card',
      kind: 'duplicate-and-move',
      plan,
      finalTranslate: '10px 20px',
      placementOffset: { x: 1.25, y: -2.5 },
    });

    expect(result.ok).toBe(true);
    const dom = new JSDOM(result.source);
    const main = dom.window.document.querySelector('main')!;
    const sections = Array.from(main.children).filter((el) => el.tagName.toLowerCase() === 'section');
    const original = sections[0]!;
    const duplicate = sections[1]!;
    expect(main.children[0]).toBe(original);
    expect(main.children[1]).toBe(duplicate);
    expect(main.children[2]?.getAttribute('data-readable-id')).toBe('after');
    expect(original.getAttribute('data-readable-id')).toBe('card');
    expect(original.getAttribute('data-readable-runtime-id')).toBe('runtime-card');
    expect(original.querySelector('[data-readable-id="card-title"]')?.getAttribute('id')).toBe('title');
    expect(duplicate.getAttribute('data-readable-id')).toBe(plan.duplicateRootId);
    expect(duplicate.querySelector('[data-readable-id="card-title-copy"]')?.getAttribute('id')).toBe('title-copy');
    expect(duplicate.querySelector('a')?.getAttribute('href')).toBe('#title-copy');
    expect(duplicate.querySelector('a')?.getAttribute('aria-describedby')).toBe('title-copy external');
    expect(duplicate.querySelector('rect')?.getAttribute('fill')).toBe('url(#paint-copy)');
    expect(duplicate.querySelectorAll('a')[1]?.getAttribute('href')).toBe('https://example.test/page#title');
    expect(duplicate.getAttribute('data-readable-runtime-id')).toBeNull();
    expect(duplicate.getAttribute('data-readable-source-path')).toBeNull();
    expect(duplicate.getAttribute('data-readable-runtime-hovered')).toBeNull();
    expect((duplicate as HTMLElement).style.getPropertyValue('translate')).toBe('11.25px 17.5px');
    expect(dom.window.document.querySelectorAll('[data-readable-id]')).toHaveLength(5);
    expect(dom.window.document.querySelectorAll('[id]')).toHaveLength(6);
  });

  it('rejects stale, ambiguous, and active duplicate plans without changing source', () => {
    const planned = planManualEditDuplicate(duplicateSource, 'card');
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const plan = planned.plan!;

    const stale = applyManualEditPatch(duplicateSource + ' ', {
      id: 'card',
      kind: 'duplicate-and-move',
      plan,
      finalTranslate: '1px 2px',
    });
    expect(stale.ok).toBe(false);
    expect(stale.source).toBe(duplicateSource + ' ');

    const ambiguousSource = duplicateSource.replace(
      '<p data-readable-id="after">After</p>',
      '<p data-readable-id="card">After</p>',
    );
    expect(planManualEditDuplicate(ambiguousSource, 'card').ok).toBe(false);

    const activeSource = '<main><div data-readable-id="card" onclick="run()"><script>run()</script></div></main>';
    expect(planManualEditDuplicate(activeSource, 'card').ok).toBe(false);
    const activePlan = {
      ...plan,
      expectedSource: activeSource,
      parentPath: '',
      expectedNextSiblingPath: null,
    };
    const active = applyManualEditPatch(activeSource, {
      id: 'card',
      kind: 'duplicate-and-move',
      plan: activePlan,
      finalTranslate: '1px 2px',
    });
    expect(active.ok).toBe(false);
    expect(active.source).toBe(activeSource);
  });

  it('rejects unsupported identity-coupled attributes instead of guessing their references', () => {
    for (const attribute of ['data-ref="card-title"', 'data-idrefs="card-title"', 'name="card-title"']) {
      const source = `<main><section data-readable-id="card"><h2 data-readable-id="card-title" id="title">Title</h2><p ${attribute}>Copy</p></section></main>`;
      expect(planManualEditDuplicate(source, 'card').ok).toBe(false);
    }
  });

  it('rejects native interactive content and microdata itemref references', () => {
    const buttonSource = '<main><section data-readable-id="card"><button>Copy</button></section></main>';
    expect(planManualEditDuplicate(buttonSource, 'card').ok).toBe(false);

    const itemrefSource = '<main><section data-readable-id="card"><h2 id="title">Title</h2><div itemref="title">Copy</div></section></main>';
    expect(planManualEditDuplicate(itemrefSource, 'card').ok).toBe(false);
  });

  it('rejects stylesheet identity references and animated content instead of guessing', () => {
    const stylesheetReference = [
      '<style>#card-title { color: red; }</style>',
      '<main><section data-readable-id="card"><h2 id="card-title">Title</h2></section></main>',
    ].join('');
    expect(planManualEditDuplicate(stylesheetReference, 'card').ok).toBe(false);

    const animated = '<main><svg data-readable-id="card"><animate attributeName="x" from="0" to="10" /></svg></main>';
    expect(planManualEditDuplicate(animated, 'card').ok).toBe(false);
  });

  it('allocates safe maps for identity values that are object-prototype names', () => {
    const source = '<main><div data-readable-id="__proto__" id="constructor">Copy</div></main>';
    const planned = planManualEditDuplicate(source, '__proto__');

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const result = applyManualEditPatch(source, {
      id: '__proto__',
      kind: 'duplicate-and-move',
      plan: planned.plan,
      finalTranslate: '1px 2px',
    });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('data-readable-id="__proto__-copy"');
    expect(result.source).toContain('id="constructor-copy"');
  });

  it('prefers an authored path-shaped id over generated path lookup', () => {
    const source = '<main><div data-readable-id="path-0">Copy</div><p>Other</p></main>';
    const planned = planManualEditDuplicate(source, 'path-0');

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const result = applyManualEditPatch(source, {
      id: 'path-0',
      kind: 'duplicate-and-move',
      plan: planned.plan,
      finalTranslate: '3px 4px',
    });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('data-readable-id="path-0-copy"');
    expect(result.source).toContain('<p>Other</p>');
  });

  it('uses a strict path locator for unannotated source elements', () => {
    const source = '<main><div>Original</div><p>After</p></main>';
    const planned = planManualEditDuplicate(source, 'path-0-0');

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const plan = planned.plan!;
    expect(plan.duplicateRootId).toBe('path-0-0-copy');
    const result = applyManualEditPatch(source, {
      id: 'path-0-0',
      kind: 'duplicate-and-move',
      plan,
      finalTranslate: '4px 5px',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toContain('data-readable-id="path-0-0-copy"');
    expect(result.source).toContain('<div>Original</div><div data-readable-id="path-0-0-copy"');
  });
});
