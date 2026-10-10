import { load } from 'cheerio';

export type ContrastIssue = { selector: string; text: string; ratio: number };
type RGB = [number, number, number];

function color(value: string | undefined, variables: Record<string, string>): RGB | undefined {
  if (!value) return;
  for (let i = 0; i < 8 && value.includes('var('); i++) {
    value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, key: string, fallback: string) => variables[key] ?? fallback ?? 'unknown');
  }
  value = value.trim().toLowerCase();
  value = ({ white: '#fff', black: '#000' } as Record<string, string>)[value] ?? value;
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(c => c + c).join('') : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as RGB;
  }
  const rgb = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(1|1\.0+))?\s*\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}
function luminance(rgb: RGB): number {
  const channels = rgb.map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function declarations(body: string): Array<[string, string, boolean]> {
  return body.split(';').flatMap(part => {
    const colon = part.indexOf(':'); if (colon < 0) return [];
    const key = part.slice(0, colon).trim().toLowerCase();
    const raw = part.slice(colon + 1).trim();
    return [[key, raw.replace(/\s*!important\s*$/i, ''), /!important\s*$/i.test(raw)] as [string, string, boolean]];
  });
}

/** Conservative static near-invisibility lint, not a browser accessibility audit.
 * Resolves simple selectors, specificity, inline declarations, inherited foreground,
 * solid backgrounds and custom properties. Skips conditional/nested CSS, dynamic
 * pseudo selectors, alpha colors, images/gradients and external stylesheets. Checks
 * inactive slides too. Unknown backgrounds never produce a guessed finding.
 */
export function lintDocumentContrast(html: string): ContrastIssue[] {
  const $ = load(html.replace(/^\uFEFF/, ''));
  const styles = new Map<object, Record<string, { value: string; rank: number }>>();
  const apply = (selector: string, body: string, rank: number) => {
    // Structural pseudo classes are static; never evaluate active slide state.
    const structural = /:(?:first|last|only)-(?:child|of-type)\b/g;
    if (/[:]/.test(selector.replace(/:root/g, 'html').replace(structural, '')) || /[\\@]/.test(selector)) return;
    const target = selector.replace(/:root/g, 'html');
    if (!/^[\w\s.#*>+~\[\]="'|^-]+$/.test(target.replace(structural, ''))) return;
    $(target).each((_, element) => {
      const computed = styles.get(element) ?? {};
      for (const [key, value, important] of declarations(body)) {
        const priority = rank + (important ? 1e15 : 0);
        if (!computed[key] || computed[key].rank <= priority) computed[key] = { value, rank: priority };
      }
      styles.set(element, computed);
    });
  };
  let order = 0;
  $('style').each((_, style) => {
    const css = $(style).text().replace(/\/\*[\s\S]*?\*\//g, '');
    let start = 0;
    while (start < css.length) {
      const open = css.indexOf('{', start); if (open < 0) break;
      let depth = 1, end = open + 1;
      while (end < css.length && depth) { if (css[end] === '{') depth++; if (css[end] === '}') depth--; end++; }
      const selector = css.slice(start, open).trim();
      const body = css.slice(open + 1, end - 1);
      if (!selector.startsWith('@') && !body.includes('{')) {
        for (const part of selector.split(',')) {
          const specificity = (part.match(/#/g)?.length ?? 0) * 10000 + (part.match(/[.\[:]/g)?.length ?? 0) * 100 + (part.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0);
          apply(part.trim(), body, specificity * 10000 + order++);
        }
      }
      start = end;
    }
  });
  $('[style]').each((_, element) => {
    const computed = styles.get(element) ?? {};
    for (const [key, value, important] of declarations($(element).attr('style') ?? '')) {
      const rank = 1e12 + (important ? 1e15 : 0);
      if (!computed[key] || computed[key].rank <= rank) computed[key] = { value, rank };
    }
    styles.set(element, computed);
  });
  const issues: ContrastIssue[] = [];
  $('body, body *').each((_, element) => {
    if (['script', 'style', 'noscript', 'title', 'template'].includes(element.tagName)) return;
    const text = element.children.filter(node => node.type === 'text').map(node => node.data).join(' ').trim();
    if (!text) return;
    const chain = [...$(element).parents().get().reverse(), element];
    const variables: Record<string, string> = {};
    let foreground: RGB | undefined, background: RGB | undefined, ownBackground = false;
    for (const ancestor of chain) {
      const rules = styles.get(ancestor) ?? {};
      for (const [key, entry] of Object.entries(rules)) if (key.startsWith('--')) variables[key] = entry.value;
      if (rules.display?.value === 'none' || rules.visibility?.value === 'hidden' || rules.opacity?.value === '0' || $(ancestor).attr('hidden') !== undefined) return;
      if (rules.color && !['inherit', 'unset'].includes(rules.color.value)) foreground = color(rules.color.value, variables);
      const bg = !rules['background-color'] ? rules.background : !rules.background || rules['background-color'].rank >= rules.background.rank ? rules['background-color'] : rules.background;
      if (bg && !['transparent', 'none', 'inherit'].includes(bg.value)) { background = color(bg.value, variables); ownBackground = true; }
      if (rules['background-image'] && rules['background-image'].value !== 'none') background = undefined;
    }
    const fg = foreground;
    if (!fg || !background || !ownBackground) return;
    const a = luminance(fg), b = luminance(background);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    // Narrow recovery gate: near-invisible, not every AA design disagreement.
    if (ratio >= 1.5) return;
    const selector = chain.slice(1).map(node => `${node.tagName}${node.attribs.id ? '#' + node.attribs.id : (node.attribs.class ?? '').split(/\s+/).filter(Boolean).map(c => '.' + c).join('')}:nth-child(${$(node).index() + 1})`).join(' > ');
    issues.push({ selector, text: text.slice(0, 160), ratio: Math.round(ratio * 100) / 100 });
  });
  return issues;
}

export function contrastRecoveryPrompt(artifact: string, issues: ContrastIssue[]): string {
  return `The saved document ${artifact} contains near-invisible text. Correct only its foreground/background contrast, preserving every user fact, layout and navigation. Set explicit text colors inside background-owning cards/panels, meeting WCAG AA (4.5:1 normal text, 3:1 large text). Verify the saved file. Static findings:\n${issues.map(issue => `${issue.selector}: ${JSON.stringify(issue.text)} (${issue.ratio}:1)`).join('\n')}`;
}
