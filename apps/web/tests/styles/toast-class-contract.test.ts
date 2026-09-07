import { readFileSync } from 'node:fs';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Toast stylesheet <-> component contract
//
// `viewer/routines.css` shipped a full toast treatment under
// `.readable-studio-toast`, but `Toast.tsx` renders `readable-toast`. The
// selector therefore matched NOTHING: every rule in that block - tones, icon
// colours, the placement-top offset, the code body, the dismiss button, and
// both entrance/exit animations - was dead. The live look came only from the
// four `.readable-toast*` rules `home/hub.css` later added, so the toast has
// been rendering with a partial treatment and NO animation at all.
//
// These assertions pin the rendered class names to the styled ones so a rename
// on either side fails here instead of silently deleting the styling.
// ---------------------------------------------------------------------------

const readText = (relativePath: string) =>
  readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');

const toastTsx = readText('components/Toast.tsx');
const routinesCss = readText('styles/viewer/routines.css');
const hubCss = readText('styles/home/hub.css');

const parse = (css: string) => postcss.parse(css);

/** Every class token that appears in a selector across the given sheets. */
const styledClasses = (...sheets: string[]) => {
  const found = new Set<string>();
  for (const sheet of sheets) {
    parse(sheet).walkRules((rule: Rule) => {
      for (const match of rule.selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
        const className = match[1];
        if (className) found.add(className);
      }
    });
  }
  return found;
};

/**
 * Class names Toast.tsx actually puts on the DOM. Covers both the plain
 * `className="..."` literals and the template-literal root className, whose
 * dynamic `tone-${tone}` / `placement-${placement}` parts are expanded from the
 * component's own prop unions.
 */
const renderedToastClasses = () => {
  const rendered = new Set<string>();
  for (const match of toastTsx.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    const raw = match[1] ?? match[2] ?? '';
    // Expand the two interpolations the root className builds.
    const expanded = raw
      .replace(/tone-\$\{tone\}/g, 'tone-default tone-success tone-error tone-loading')
      .replace(/placement-\$\{placement\}/g, 'placement-bottom placement-top')
      .replace(/\$\{leaving \? ' leaving' : ''\}/g, ' leaving')
      // Drop any interpolation we did not explicitly expand.
      .replace(/\$\{[^}]*\}/g, ' ');
    for (const token of expanded.split(/\s+/)) {
      if (token) rendered.add(token);
    }
  }
  return rendered;
};

describe('Toast stylesheet/component class contract', () => {
  it('renders the root class the toast stylesheet actually styles', () => {
    const rendered = renderedToastClasses();
    // Non-vacuous: the parser must have found the root class at all.
    expect(rendered.has('readable-toast')).toBe(true);

    const styled = styledClasses(routinesCss, hubCss);
    expect(
      styled.has('readable-toast'),
      'the toast stylesheet must style the class Toast.tsx renders',
    ).toBe(true);

    // The dead legacy name must be gone from the sheets entirely; leaving it
    // behind is what let the whole block rot unnoticed.
    expect(
      routinesCss.includes('readable-studio-toast'),
      'viewer/routines.css must not target the stale `.readable-studio-toast` name, '
        + 'which no component renders',
    ).toBe(false);
  });

  it('styles every class the Toast component renders', () => {
    const styled = styledClasses(routinesCss, hubCss);
    const rendered = renderedToastClasses();

    // `placement-bottom` is the default and intentionally carries no rule (the
    // base `.readable-toast` block already pins the bottom placement), and
    // `tone-default` is the no-op tone. Everything else must be styled.
    const unstyledByDesign = new Set(['placement-bottom', 'tone-default']);

    const orphans = [...rendered]
      .filter((cls) => !unstyledByDesign.has(cls))
      .filter((cls) => !styled.has(cls))
      .sort();

    expect(
      orphans,
      'Toast.tsx renders these classes but no toast stylesheet targets them, so they '
        + 'paint nothing',
    ).toEqual([]);
  });

  it('keeps the entrance and exit animations bound to the rendered class', () => {
    const root = parse(routinesCss);

    const animationSelectors: string[] = [];
    root.walkDecls('animation', (decl) => {
      if (!/readable-toast-(in|out)/.test(decl.value)) return;
      const parent = decl.parent as Rule | undefined;
      if (parent?.type === 'rule') animationSelectors.push(parent.selector);
    });

    // Non-vacuous: both halves of the pair must exist.
    expect(animationSelectors.length).toBeGreaterThanOrEqual(2);

    for (const selector of animationSelectors) {
      expect(
        selector.includes('.readable-toast') && !selector.includes('.readable-studio-toast'),
        `\`${selector}\` drives a toast animation but does not match the rendered class, `
          + 'so the animation never runs',
      ).toBe(true);
    }

    // The exit is the dangerous one: it runs `forwards`, so it must be bound to
    // the `.leaving` class the component toggles.
    const exitRule = animationSelectors.find((selector) => selector.includes('leaving'));
    expect(exitRule, 'the exit animation must be bound to the `.leaving` class').toBeDefined();
    expect(toastTsx.includes("' leaving'")).toBe(true);
  });

  it('keeps the reduced-motion escape hatch pointed at the rendered class', () => {
    const root = parse(routinesCss);
    let guarded = false;
    root.walkAtRules('media', (atRule) => {
      if (!atRule.params.includes('prefers-reduced-motion')) return;
      atRule.walkRules((rule) => {
        if (rule.selector.includes('.readable-toast')) guarded = true;
      });
    });
    expect(
      guarded,
      'the reduced-motion block must silence the toast animation on the class that '
        + 'actually renders',
    ).toBe(true);
  });
});
