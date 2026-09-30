import type { ManualEditDeclaration, ManualEditRect } from './types';

export interface WidthReleasePreflight {
  source: string;
  targetId: string;
  viewportWidth: number;
  viewportHeight: number;
  baselineRect: ManualEditRect;
  declarations: ManualEditDeclaration[];
}
export type WidthReleaseFit = { ok: true; widths: number[] } | { ok: false; reason: string; width?: number };

/** Script-free, disposable measurement document. 100% is intentionally the
 * acceptance maximum, even on browsers implementing stretch. */
export async function preflightWidthRelease(input: WidthReleasePreflight): Promise<WidthReleaseFit> {
  const parsed = new DOMParser().parseFromString(input.source, 'text/html');
  if (parsed.querySelector('iframe,object,embed')) return { ok: false, reason: 'embedded-layout' };
  parsed.querySelectorAll('script').forEach(node => node.remove());
  parsed.querySelectorAll('meta[http-equiv="refresh"]').forEach(node => node.remove());
  parsed.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
  });
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.readableWidthPreflight = '';
  frame.style.cssText = `position:fixed;left:-100000px;top:0;border:0;visibility:hidden;width:${input.viewportWidth}px;height:${input.viewportHeight}px;pointer-events:none`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('resource-timeout')), 5000); });
  try {
    await Promise.race([new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error('resource-load'));
      frame.srcdoc = '<!doctype html>' + parsed.documentElement.outerHTML;
      document.body.appendChild(frame);
    }), deadline]);
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    if (!doc || !view) return { ok: false, reason: 'measurement-document-unavailable' };
    await Promise.race([doc.fonts.ready, deadline]);
    if ([...doc.fonts].some(font => font.status === 'error')) return { ok: false, reason: 'font-load' };
    if ([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some(link => !link.sheet)) return { ok: false, reason: 'stylesheet-load' };
    if ([...doc.images].some(image => !image.complete || image.naturalWidth === 0)) return { ok: false, reason: 'image-load' };
    const target = [...doc.querySelectorAll<HTMLElement>('[data-readable-id],[data-readable-source-path]')]
      .find(node => node.getAttribute('data-readable-id') === input.targetId || node.getAttribute('data-readable-source-path') === input.targetId);
    if (!target) return { ok: false, reason: 'target-missing' };
    const css = (el: Element) => view.getComputedStyle(el);
    const number = (value: string) => Number.parseFloat(value) || 0;
    const rect = (el: Element) => el.getBoundingClientRect();
    const parentFor = (el: Element) => {
      let parent = el.parentElement;
      while (parent && css(parent).display === 'contents') parent = parent.parentElement;
      return parent;
    };
    const parent = parentFor(target);
    if (!parent) return { ok: false, reason: 'parent-missing' };
    const baselineStyle = target.getAttribute('style');
    const reset = () => baselineStyle === null ? target.removeAttribute('style') : target.setAttribute('style', baselineStyle);
    const widths = new Set([input.viewportWidth, ...[768, 375, 320].filter(width => width < input.viewportWidth)]);
    const thresholds: number[] = [];
    const inspect = (rules: CSSRuleList) => {
      for (const rule of [...rules]) {
        if ('conditionText' in rule) {
          const condition = String(rule.conditionText);
          for (const match of condition.matchAll(/(?:min-|max-)?width\s*[:<>]=?\s*(\d+(?:\.\d+)?)(px|em|rem)/g)) {
            const px = Number(match[1]) * (match[2] === 'px' ? 1 : number(css(doc.documentElement).fontSize));
            thresholds.push(px);
            if (rule.constructor.name === 'CSSContainerRule') {
              let container = target.parentElement;
              while (container && css(container).containerType === 'normal') container = container.parentElement;
              if (!container) throw new Error('unresolved-container-query');
              thresholds.push(input.viewportWidth + px - container.clientWidth);
            }
          }
        }
        if ('cssRules' in rule) inspect((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...doc.styleSheets]) inspect(sheet.cssRules);
    thresholds.forEach(value => [value - 1, value, value + 1].forEach(width => {
      if (width >= 320 && width < input.viewportWidth) widths.add(width);
    }));
    if (widths.size > 40) return { ok: false, reason: 'responsive-checkpoint-limit' };
    const overlap = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    for (const width of widths) {
      frame.style.width = `${width}px`;
      reset();
      const before = rect(target);
      const baselineScrollWidth = doc.documentElement.scrollWidth;
      if (width === input.viewportWidth && (Math.abs(before.width - input.baselineRect.width) > 1 || Math.abs(before.height - input.baselineRect.height) > 1)) return { ok: false, reason: 'live-snapshot-mismatch', width };
      const siblingNodes = new Set<Element>();
      for (let branch: Element | null = target; branch?.parentElement; branch = branch.parentElement) {
        for (const node of [...branch.parentElement.children]) {
          if (node === branch) continue;
          if (branch === target || /absolute|fixed/.test(css(node).position)) siblingNodes.add(node);
        }
      }
      const siblings = [...siblingNodes].map(node => ({ node, rect: rect(node) }));
      const tracks = css(parent).gridTemplateColumns;
      for (const declaration of input.declarations) {
        target.style.setProperty(declaration.property, /^max-(width|inline-size)$/.test(declaration.property) ? '100%' : declaration.value, declaration.priority);
      }
      const after = rect(target), c = css(target), pc = css(parent), pr = rect(parent);
      const parentBorderWidth = number(pc.width) + (pc.boxSizing === 'border-box' ? 0 : number(pc.paddingLeft) + number(pc.paddingRight) + number(pc.borderLeftWidth) + number(pc.borderRightWidth));
      const scale = parentBorderWidth > 0 ? pr.width / parentBorderWidth : 1;
      const left = pr.left + (number(pc.borderLeftWidth) + number(pc.paddingLeft)) * scale;
      const right = pr.left + (number(pc.borderLeftWidth) + parent.clientWidth - number(pc.paddingRight)) * scale;
      if (after.left - number(c.marginLeft) * scale < left - scale || after.right + number(c.marginRight) * scale > right + scale) return { ok: false, reason: 'fallback-content-overflow', width };
      // An unrelated fixed grid/table may already overflow at this checkpoint.
      // Veto overflow caused by this release, not pre-existing document damage;
      // the released element itself must still fit the viewport and its parent.
      if (after.left < -1 || after.right > doc.documentElement.clientWidth + 1
        || doc.documentElement.scrollWidth > Math.max(baselineScrollWidth, doc.documentElement.clientWidth) + 1) return { ok: false, reason: 'viewport-overflow', width };
      if (target.scrollWidth > target.clientWidth + 1) return { ok: false, reason: 'intrinsic-overflow', width };
      for (const child of [...target.querySelectorAll('*')]) {
        const cr = rect(child);
        if (cr.width && (cr.left < after.left - scale || cr.right > after.right + scale)) return { ok: false, reason: 'descendant-overflow', width };
      }
      const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const range = doc.createRange();
        range.selectNodeContents(text);
        for (const line of [...range.getClientRects()]) if (line.width && (line.left < after.left - scale || line.right > after.right + scale)) return { ok: false, reason: 'text-overflow', width };
      }
      for (const sibling of siblings) {
        const current = rect(sibling.node);
        if (overlap(after, current) > overlap(before, sibling.rect) + scale) return { ok: false, reason: 'sibling-overlap', width };
        if (/flex|grid/.test(pc.display) && (Math.abs(current.x - sibling.rect.x) > scale || Math.abs(current.width - sibling.rect.width) > scale)) return { ok: false, reason: 'parent-allocation', width };
      }
      if (css(parent).gridTemplateColumns !== tracks) return { ok: false, reason: 'grid-allocation', width };
      for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
        const ac = css(ancestor), ar = rect(ancestor);
        if (ac.writingMode !== 'horizontal-tb' || /table/.test(ac.display) || ac.perspective !== 'none') return { ok: false, reason: 'responsive-unsupported-geometry', width };
        if ((ac.clipPath && ac.clipPath !== 'none') || (ac.maskImage && ac.maskImage !== 'none')) return { ok: false, reason: 'unresolved-clip', width };
        if (/hidden|clip|auto|scroll/.test(ac.overflowX) && (after.left < ar.left - scale || after.right > ar.right + scale)) return { ok: false, reason: 'ancestor-clip', width };
      }
    }
    return { ok: true, widths: [...widths] };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'measurement-failed' };
  } finally {
    clearTimeout(timeout);
    frame.remove();
  }
}
