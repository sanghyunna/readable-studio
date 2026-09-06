import { readFileSync } from 'node:fs';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { modalOverlay } from '../../src/motion';

const readCss = (relativePath: string) =>
  postcss.parse(readFileSync(new URL(`../../src/styles/${relativePath}`, import.meta.url), 'utf8'));

const dragCss = readCss('modal-window-drag.css');
const entryLayoutCss = readCss('home/entry-layout.css');
const sheets = {
  shell: readCss('shell.css'),
  drawer: readCss('workspace/drawer.css'),
  designFiles: readCss('workspace/design-files.css'),
  hub: readCss('home/hub.css'),
  library: readCss('viewer/library.css'),
};

type SheetName = keyof typeof sheets;
type ExpectedDeclarations = Readonly<Record<string, string>>;

function hasRule(
  sheetName: SheetName,
  selector: string,
  expected: ExpectedDeclarations,
  media?: string,
): boolean {
  let found = false;
  sheets[sheetName].walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const parentMedia = rule.parent?.type === 'atrule' && (rule.parent as AtRule).name === 'media'
      ? (rule.parent as AtRule).params
      : undefined;
    if (parentMedia !== media) return;
    const declarations = new Map<string, string>();
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
    if (Object.entries(expected).every(([property, value]) => declarations.get(property) === value)) {
      found = true;
    }
  });
  return found;
}

describe('interactive reachability contracts', () => {
  it('carves every modal child subtree out of the native drag strip', () => {
    let dragRule: Rule | undefined;
    let noDragRule: Rule | undefined;
    dragCss.walkRules((rule) => {
      const appRegion = rule.nodes.find(
        (node): node is Declaration => node.type === 'decl' && node.prop === '-webkit-app-region',
      );
      if (appRegion?.value === 'drag') dragRule = rule;
      if (appRegion?.value === 'no-drag' && rule.selector.trimEnd().endsWith(') *')) noDragRule = rule;
    });

    expect(dragRule, 'the test must discover the native drag strip').toBeDefined();
    expect(noDragRule, 'the test must discover a descendant no-drag carve-out').toBeDefined();
    expect(new Set(noDragRule!.selector.match(/\.[a-z0-9_-]+/gi) ?? [])).toEqual(
      new Set(dragRule!.selector.match(/\.[a-z0-9_-]+/gi) ?? []),
    );
    const declaration = noDragRule!.nodes.find(
      (node): node is Declaration => node.type === 'decl' && node.prop === '-webkit-app-region',
    );
    expect(declaration).toMatchObject({ value: 'no-drag', important: true });
  });

  it('makes the shared full-screen overlay non-hit-testable on exit', () => {
    expect(modalOverlay.exit).toMatchObject({ opacity: 0, pointerEvents: 'none' });
  });

  it('stacks portalled Hub menus above the interactive rail', () => {
    const zIndexFor = (selector: string): number => {
      let value: string | undefined;
      sheets.hub.walkRules((rule) => {
        if (!rule.selectors.includes(selector)) return;
        const declaration = rule.nodes.find(
          (node): node is Declaration => node.type === 'decl' && node.prop === 'z-index',
        );
        if (declaration) value = declaration.value;
      });
      if (!value) throw new Error(`${selector} must declare a z-index`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${selector} must use a numeric z-index`);
      return parsed;
    };

    // HubMenu is portalled to document.body rather than nested in the rail.
    // Its whole surface must therefore beat the rail's stacking context.
    expect(zIndexFor('.hub-menu')).toBeGreaterThan(zIndexFor('.hub__nav'));

    // Interaction-layer convention: a wrapper containing native controls stays
    // in normal hit testing. Visibility belongs to the controls themselves and
    // overlap arbitration belongs to stacking order. Making the wrapper inert
    // creates a hover deadlock: the row wins the initial hit, so automation (and
    // touch/pointer users) cannot reliably establish the child hover state that
    // would opt the button back in.
    expect(
      hasRule('hub', '.hub-row__actions', { 'pointer-events': 'none' }),
      'native-control wrappers must not use pointer-events:none',
    ).toBe(false);
  });

  it('pairs every opacity-hidden action with non-hit-testable and restoring states', () => {
    const controls: readonly {
      sheet: SheetName;
      base: string;
      reveal: string;
      touch: string;
    }[] = [
      {
        sheet: 'shell',
        base: '.workspace-tab__close',
        reveal: '.workspace-tab.is-active .workspace-tab__close',
        touch: '.workspace-tab__close',
      },
      {
        sheet: 'drawer',
        base: '.design-card-close',
        reveal: '.design-kanban-card:hover .design-card-close',
        touch: '.design-kanban-card .design-card-close',
      },
      {
        sheet: 'drawer',
        base: '.design-card-more',
        reveal: '.design-card-more[aria-expanded="true"]',
        touch: '.design-card .design-card-more',
      },
      {
        sheet: 'designFiles',
        base: '.df-row-menu',
        reveal: '.df-row-menu[aria-expanded="true"]',
        touch: '.df-row-menu',
      },
      {
        sheet: 'hub',
        base: '.hub-row__action',
        reveal: '.hub-row:hover .hub-row__action',
        touch: '.hub-row__action',
      },
      {
        sheet: 'library',
        base: '.library-ds-edit',
        reveal: '.library-ds-edit:focus-visible',
        touch: '.library-ds-edit',
      },
    ];

    for (const control of controls) {
      expect(
        hasRule(control.sheet, control.base, { opacity: '0', 'pointer-events': 'none' }),
        `${control.base} must not intercept pointers while invisible`,
      ).toBe(true);
      expect(
        hasRule(control.sheet, control.reveal, { opacity: '1', 'pointer-events': 'auto' }),
        `${control.reveal} must restore visibility and pointer interaction together`,
      ).toBe(true);
      expect(
        hasRule(
          control.sheet,
          control.touch,
          { opacity: '1', 'pointer-events': 'auto' },
          '(hover: none)',
        ),
        `${control.touch} must remain visible and reachable without hover`,
      ).toBe(true);
    }
  });

  it('keeps the narrow Home main surface in a real content track', () => {
    const narrow = entryLayoutCss.nodes.find(
      (node): node is AtRule =>
        node.type === 'atrule' && node.name === 'media' && node.params === '(max-width: 900px)',
    );
    expect(narrow, 'the test must exercise the narrow breakpoint that collapsed Home').toBeDefined();
    if (!narrow) throw new Error('narrow Home breakpoint was not found');
    const narrowNodes = narrow.nodes;
    if (!narrowNodes) throw new Error('narrow Home breakpoint has no CSS rules');

    const tracks = new Map<string, Declaration>();
    narrow.walkRules((rule) => {
      const declaration = rule.nodes.find(
        (node): node is Declaration => node.type === 'decl' && node.prop === 'grid-template-columns',
      );
      if (declaration) tracks.set(rule.selector, declaration);
    });

    const generic = tracks.get('.entry-shell--no-header .entry');
    const home = tracks.get(
      '.entry-shell--no-header .entry:has(.entry-main__inner--home)',
    );

    // Non-vacuous regression proof: the generic narrow shell really does
    // reserve the 44px rail track that swallowed Home when it won the cascade.
    expect(generic).toMatchObject({
      value: 'var(--entry-rail-strip-width, 44px) minmax(0, 1fr)',
      important: true,
    });
    expect(home).toMatchObject({ value: 'minmax(0, 1fr)', important: true });
    if (!generic || !home) throw new Error('narrow Home track declarations were not found');
    expect(generic.value).not.toBe('minmax(0, 1fr)');

    // Home owns a ProjectRail inside HubHome, so its `.entry` has one child and
    // must have one track. This later, equally-important rule is the effective
    // narrow declaration; the main/composer can consume the viewport instead
    // of being auto-placed into the synthetic 44px first track.
    const genericRule = generic.parent;
    const homeRule = home.parent;
    if (genericRule?.type !== 'rule' || homeRule?.type !== 'rule') {
      throw new Error('narrow Home track declarations must belong to CSS rules');
    }
    expect(narrowNodes.indexOf(homeRule)).toBeGreaterThan(
      narrowNodes.indexOf(genericRule),
    );
  });
});
