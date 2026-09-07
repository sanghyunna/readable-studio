import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import { modalOverlay } from '../../src/motion';

const readCss = (relativePath: string) =>
  postcss.parse(readFileSync(new URL(`../../src/styles/${relativePath}`, import.meta.url), 'utf8'));

const dragCss = readCss('modal-window-drag.css');
const entryLayoutCss = readCss('home/entry-layout.css');
const entranceCss = readCss('entrance.css');
const sheets = {
  shell: readCss('shell.css'),
  drawer: readCss('workspace/drawer.css'),
  designFiles: readCss('workspace/design-files.css'),
  hub: readCss('home/hub.css'),
  library: readCss('viewer/library.css'),
};

type SheetName = keyof typeof sheets;
type ExpectedDeclarations = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Repo-wide keyframe sweep
//
// The invisible-but-interactive class recurs because each fix has covered only
// the reported surface. These helpers parse EVERY stylesheet under src/ - global
// sheets and `.module.css` alike - so the contract is asserted against the whole
// app rather than a hand-maintained list of files.
// ---------------------------------------------------------------------------

const stylesRoot = new URL('../../src/', import.meta.url);

function listStylesheets(directory: URL): readonly URL[] {
  const paths = execFileSync('fd', [
    '--type', 'f', '--extension', 'css', '--absolute-path', '.', fileURLToPath(directory),
  ], { encoding: 'utf8' });
  return paths.trim().split(/\r?\n/).filter(Boolean).map((path) => pathToFileURL(path));
}

interface KeyframeStep {
  readonly selector: string;
  /** Normalised percentage: `from` -> 0, `to` -> 100. */
  readonly offset: number;
  readonly opacity?: string;
  readonly pointerEvents?: string;
}

interface ZeroOpacityKeyframes {
  readonly name: string;
  readonly sheet: string;
  readonly steps: readonly KeyframeStep[];
  readonly zeroOpacitySteps: readonly KeyframeStep[];
  readonly applications: readonly { readonly sheet: string; readonly value: string }[];
}

const offsetOf = (selector: string): number =>
  selector === 'from' ? 0 : selector === 'to' ? 100 : Number.parseFloat(selector);

/**
 * Every `@keyframes` in the app that reaches exactly `opacity: 0` in some step
 * AND is actually referenced by an `animation` / `animation-name` declaration.
 * Unapplied keyframes are excluded because they gate nothing.
 */
function collectZeroOpacitySteps(): readonly ZeroOpacityKeyframes[] {
  const parsed = listStylesheets(stylesRoot).map((url) => ({
    sheet: url.href.slice(stylesRoot.href.length),
    root: postcss.parse(readFileSync(url, 'utf8')),
  }));

  const candidates = new Map<string, { sheet: string; steps: KeyframeStep[] }>();
  for (const { sheet, root } of parsed) {
    root.walkAtRules('keyframes', (atRule) => {
      const steps: KeyframeStep[] = [];
      atRule.walkRules((step) => {
        const declarations = new Map<string, string>();
        step.walkDecls((declaration) => {
          declarations.set(declaration.prop, declaration.value);
        });
        for (const selector of step.selectors) {
          steps.push({
            selector,
            offset: offsetOf(selector),
            opacity: declarations.get('opacity'),
            pointerEvents: declarations.get('pointer-events'),
          });
        }
      });
      if (steps.some((step) => step.opacity !== undefined && Number(step.opacity) === 0)) {
        candidates.set(atRule.params, { sheet, steps });
      }
    });
  }

  const applications = new Map<string, { sheet: string; value: string }[]>();
  for (const { sheet, root } of parsed) {
    root.walkDecls(/^animation(-name)?$/, (declaration) => {
      const tokens = new Set(declaration.value.split(/[\s,()]+/).filter(Boolean));
      for (const name of candidates.keys()) {
        if (!tokens.has(name)) continue;
        const existing = applications.get(name) ?? [];
        existing.push({ sheet, value: declaration.value });
        applications.set(name, existing);
      }
    });
  }

  return [...candidates]
    .filter(([name]) => applications.has(name))
    .map(([name, { sheet, steps }]) => ({
      name,
      sheet,
      steps,
      zeroOpacitySteps: steps.filter(
        (step) => step.opacity !== undefined && Number(step.opacity) === 0,
      ),
      applications: applications.get(name) ?? [],
    }));
}

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

  it('never leaves an entrance-animated subtree transparent and pointer-active', () => {
    // `animation-fill-mode: both` paints the `from` frame backwards through the
    // animation-delay. An entrance starting at `opacity: 0` therefore holds its
    // whole subtree at exactly transparent, laid out, semantic and hit-testable,
    // for delay + first frame. The Hub composer shipped that for 100ms on every
    // Home mount: the primary composer was clickable while invisible.
    //
    // This is the same contract the stacking-order cases above assert, moved
    // into the time dimension, so it is carried by the shared keyframes rather
    // than by each call site.
    const keyframes = new Map<string, AtRule>();
    entranceCss.walkAtRules('keyframes', (atRule) => {
      keyframes.set(atRule.params, atRule);
    });

    // Non-vacuous: the sweep must actually find the shared entrance keyframes.
    expect(keyframes.size).toBeGreaterThan(0);

    const fillModeBoth = new Set<string>();
    for (const sheet of [entranceCss]) {
      sheet.walkDecls('animation', (declaration) => {
        if (!/(^|\s)both(\s|$)/.test(declaration.value)) return;
        for (const name of keyframes.keys()) {
          if (new RegExp(`(^|\\s)${name}(\\s|$)`).test(declaration.value)) fillModeBoth.add(name);
        }
      });
    }

    // Non-vacuous: `both` fill really is how these entrances ship, which is what
    // makes the zero-opacity `from` frame user-reachable rather than theoretical.
    expect(fillModeBoth.size).toBeGreaterThan(0);

    for (const name of fillModeBoth) {
      const atRule = keyframes.get(name);
      if (!atRule) throw new Error(`${name} keyframes were not found`);

      const opacityAt = new Map<string, string>();
      const pointerEventsAt = new Map<string, string>();
      atRule.walkRules((step) => {
        for (const selector of step.selectors) {
          step.walkDecls((declaration) => {
            if (declaration.prop === 'opacity') opacityAt.set(selector, declaration.value);
            if (declaration.prop === 'pointer-events') pointerEventsAt.set(selector, declaration.value);
          });
        }
      });

      const transparentSteps = [...opacityAt].filter(([, value]) => Number(value) === 0);
      if (transparentSteps.length === 0) continue;

      for (const [selector] of transparentSteps) {
        expect(
          pointerEventsAt.get(selector),
          `${name} @ ${selector} is at opacity 0 and must not be pointer-active: `
            + 'visibility and pointer availability have to share one timeline',
        ).toBe('none');
      }

      // The guarantee is worthless if pointers never come back: the surface has
      // to be interactive again for the visible remainder of the entrance.
      expect(
        [...pointerEventsAt.values()].some((value) => value === 'auto'),
        `${name} must restore pointer-events once it carries luminance`,
      ).toBe(true);

      const restored = [...pointerEventsAt]
        .filter(([, value]) => value === 'auto')
        .map(([selector]) => (selector === 'from' ? 0 : selector === 'to' ? 100 : Number.parseFloat(selector)));
      // Restoration must happen at the very start of the visible phase, not at
      // the end, or the fade would read as a dead surface the user cannot use.
      expect(
        Math.min(...restored),
        `${name} must restore pointer-events at the start of its visible phase`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the Hub composer entrance out of the invisible-but-clickable window', () => {
    // The composer is the primary control on Home and the specific surface the
    // browser sentinel caught: 350ms entrance, 100ms delay, `both` fill.
    let composerAnimation: string | undefined;
    entranceCss.walkRules((rule) => {
      if (!rule.selectors.includes('.home-hero__input-card')) return;
      rule.walkDecls('animation', (declaration) => {
        composerAnimation = declaration.value;
      });
    });

    expect(
      composerAnimation,
      'the test must exercise the real Hub composer entrance',
    ).toBeDefined();
    if (!composerAnimation) throw new Error('Hub composer entrance was not found');

    // Non-vacuous regression proof: the delay that made the window user-sized,
    // and the `both` fill that painted opacity 0 through it, both still ship.
    // The defect is fixed by pointer synchronisation, not by deleting the fade.
    expect(composerAnimation).toContain('100ms');
    expect(composerAnimation).toContain('both');
    expect(composerAnimation).toContain('readable-fade-slide-up');

    let entrance: AtRule | undefined;
    entranceCss.walkAtRules('keyframes', (atRule) => {
      if (atRule.params === 'readable-fade-slide-up') entrance = atRule;
    });
    if (!entrance) throw new Error('readable-fade-slide-up keyframes were not found');

    const fromStep = entrance.nodes?.find(
      (node): node is Rule => node.type === 'rule' && node.selectors.includes('from'),
    );
    if (!fromStep) throw new Error('readable-fade-slide-up has no `from` step');

    const declarations = new Map<string, string>();
    fromStep.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });

    // The fade the user praised is preserved verbatim; only reachability changes.
    expect(declarations.get('opacity')).toBe('0');
    expect(declarations.get('transform')).toBe('translateY(10px)');
    expect(declarations.get('pointer-events')).toBe('none');
  });

  it('synchronises pointers on every delayed entrance outside the shared keyframes', () => {
    // The composer was not the only surface with a delay + fill-mode window.
    // A delay is what turns the transparent `from` frame from a single frame
    // into a human-sized click target, so every delayed entrance that fades an
    // interactive subtree carries the same handoff.
    const delayed: readonly { sheet: string; keyframes: string; appliedTo: string }[] = [
      { sheet: 'viewer/code.css', keyframes: 'chat-example-in', appliedTo: '.chat-connect-repo' },
      {
        sheet: 'viewer/viewer-shared.css',
        keyframes: 'ds-modal-sidebar-content-in',
        appliedTo: '.ds-modal-sidebar .plugin-info-pane',
      },
    ];

    for (const entry of delayed) {
      const sheet = readCss(entry.sheet);

      let application: string | undefined;
      sheet.walkRules((rule) => {
        if (!rule.selectors.includes(entry.appliedTo)) return;
        rule.walkDecls('animation', (declaration) => {
          application = declaration.value;
        });
      });
      expect(application, `${entry.appliedTo} must still declare its entrance`).toBeDefined();
      if (!application) throw new Error(`${entry.appliedTo} has no animation declaration`);

      // Non-vacuous: the delay that makes the window user-reachable still ships.
      expect(application).toMatch(/\b\d+ms\b.*\b\d+ms\b/);
      expect(application).toContain(entry.keyframes);

      let atRule: AtRule | undefined;
      sheet.walkAtRules('keyframes', (candidate) => {
        if (candidate.params === entry.keyframes) atRule = candidate;
      });
      if (!atRule) throw new Error(`${entry.keyframes} keyframes were not found`);

      const pointerEventsAt = new Map<string, string>();
      let transparentStep: string | undefined;
      atRule.walkRules((step) => {
        const declarations = new Map<string, string>();
        step.walkDecls((declaration) => {
          declarations.set(declaration.prop, declaration.value);
        });
        for (const selector of step.selectors) {
          const pointerEvents = declarations.get('pointer-events');
          if (pointerEvents) pointerEventsAt.set(selector, pointerEvents);
          if (Number(declarations.get('opacity')) === 0) transparentStep = selector;
        }
      });

      // Non-vacuous: the fade the user praised is still a real fade from zero.
      expect(transparentStep, `${entry.keyframes} must still fade from zero`).toBeDefined();
      if (!transparentStep) throw new Error(`${entry.keyframes} has no transparent step`);

      expect(
        pointerEventsAt.get(transparentStep),
        `${entry.keyframes} @ ${transparentStep} must not be pointer-active while transparent`,
      ).toBe('none');
      expect(
        [...pointerEventsAt.values()].some((value) => value === 'auto'),
        `${entry.keyframes} must restore pointer-events once visible`,
      ).toBe(true);
    }
  });

  it('keeps the reduced-motion path coherent with the pointer handoff', () => {
    // Reduced motion collapses delay to 0 and duration to 0.01ms, so the
    // pointer-inert phase collapses with it instead of becoming a stuck state.
    const reduced = entranceCss.nodes.find(
      (node): node is AtRule =>
        node.type === 'atrule'
        && node.name === 'media'
        && node.params === '(prefers-reduced-motion: reduce)',
    );
    expect(reduced, 'the reduced-motion path must still exist').toBeDefined();
    if (!reduced) throw new Error('reduced-motion path was not found');

    const declarations = new Map<string, Declaration>();
    reduced.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration);
    });

    expect(declarations.get('animation-delay')).toMatchObject({ value: '0ms', important: true });
    expect(declarations.get('animation-duration')).toMatchObject({ value: '0.01ms', important: true });

    // Nothing in the reduced-motion path may pin pointer-events, which would
    // freeze the surface on whichever side of the handoff it happened to pin.
    expect(declarations.has('pointer-events')).toBe(false);
  });

  // Decorative loops on non-interactive pseudo-elements and carets. Each gates
  // no interactive subtree: they animate a `::after` sheen, a blinking caret
  // glyph, or a coachmark that no component renders (CSS with no TSX consumer).
  // Listed by name rather than pattern-matched so adding one is a deliberate,
  // reviewable act rather than a silent widening of the exemption.
  const decorativeKeyframes = new Set([
    'home-hero-attention-sheen',
    'stream-caret-blink',
    'df-tip-caret-blink',
    'amr-coachmark-in',
    'amr-coachmark-ring',
  ]);

  it('never leaves an EXIT animation transparent and pointer-active after it ends', () => {
    // An exit is strictly worse than an entrance. An entrance's transparent
    // frame is bounded: the animation runs and the surface becomes visible. An
    // exit with `forwards` fades TO `opacity: 0` and then HOLDS that frame, so
    // the element stays laid out, semantic and hit-testable at zero opacity
    // until something unmounts it - not for 100ms, but indefinitely. Nothing
    // ever brings it back, so an invisible element keeps eating every click
    // aimed at whatever sits beneath it.
    const exits = collectZeroOpacitySteps()
      .filter((entry) => !decorativeKeyframes.has(entry.name))
      .filter((entry) =>
        entry.applications.some((application) =>
          /(^|\s)(forwards|both)(\s|$)/.test(application.value),
        ),
      )
      .filter((entry) => entry.zeroOpacitySteps.some((step) => step.offset >= 99));

    // Non-vacuous: the sweep has to actually find an exit of this shape. The
    // toast is the known one; if it is ever deleted this expectation fires
    // rather than silently passing on an empty set.
    expect(
      exits.map((entry) => entry.name),
      'the sweep must discover the fill-mode exit animations it exists to guard',
    ).toContain('readable-toast-out');

    for (const entry of exits) {
      for (const step of entry.zeroOpacitySteps) {
        expect(
          step.pointerEvents,
          `${entry.name} @ ${step.selector} holds opacity 0 under a fill mode and must not `
            + 'stay pointer-active: nothing re-shows the element, so the hit area would persist '
            + 'until unmount',
        ).toBe('none');
      }
    }
  });

  it('pairs pointer-events with opacity in every applied keyframe across the app', () => {
    // Repo-wide, not per-sheet: the defect class is "a keyframe reaches exactly
    // opacity 0 while its subtree stays hit-testable", and it has shipped
    // repeatedly because each fix covered only the surface that was reported.
    // Sweeping every stylesheet means a new offender fails here on the commit
    // that introduces it instead of on a later browser round.
    const offenders = collectZeroOpacitySteps().filter((entry) =>
      entry.zeroOpacitySteps.some((step) => step.pointerEvents !== 'none'),
    );

    // Non-vacuous: the sweep must be reading real keyframes and real
    // applications, otherwise "no offenders" would be meaningless.
    const swept = collectZeroOpacitySteps();
    expect(swept.length, 'the sweep must discover applied zero-opacity keyframes').toBeGreaterThan(10);
    expect(
      swept.some((entry) => entry.name === 'readable-fade-slide-up'),
      'the sweep must reach the shared entrance keyframes',
    ).toBe(true);
    expect(
      swept.some((entry) => entry.name === 'hubEnter'),
      'the sweep must reach CSS-module keyframes, not just global stylesheets',
    ).toBe(true);

    const unexcused = offenders.filter((entry) => !decorativeKeyframes.has(entry.name));
    expect(
      unexcused.map((entry) => `${entry.name} (${entry.sheet})`),
      'every applied keyframe that reaches opacity 0 must declare pointer-events in the same '
        + 'step: pointer-events is discrete, so pairing it with opacity makes visibility and '
        + 'clickability one timeline that cannot desynchronise',
    ).toEqual([]);
  });

  it('restores pointers at the start of the visible phase on every swept entrance', () => {
    // The contract above is satisfiable by leaving a surface dead for its whole
    // fade, which would trade an invisible-but-clickable defect for a
    // visible-but-dead one. Pointers must return as soon as the surface carries
    // real luminance.
    const entrances = collectZeroOpacitySteps().filter((entry) =>
      entry.zeroOpacitySteps.every((step) => step.offset <= 1),
    );
    expect(entrances.length, 'the sweep must discover entrance-shaped keyframes').toBeGreaterThan(10);

    for (const entry of entrances) {
      const restored = entry.steps
        .filter((step) => step.pointerEvents === 'auto')
        .map((step) => step.offset);
      if (restored.length === 0) continue;
      expect(
        Math.min(...restored),
        `${entry.name} must return pointers at the start of its visible phase, not at the end`,
      ).toBeLessThanOrEqual(1);
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
    // The rail belongs to App's grid on ALL routes. EntryShell has one child
    // and one content track, including below the forced-collapse breakpoint.
    expect(generic).toMatchObject({ value: 'minmax(0, 1fr)', important: true });
    expect(tracks.has('.entry-shell--no-header .entry.entry--rail-open')).toBe(false);
    expect(tracks.has('.entry-shell--no-header .entry:has(.entry-main__inner--home)')).toBe(false);
  });
});
