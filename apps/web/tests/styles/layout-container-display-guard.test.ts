/**
 * Layout-container display guard.
 *
 * The Databricks `CLI 프로필` row declared `grid-template-columns` and relied on
 * a shared primitive (`ToggleCard`) to supply `display: grid`. When that
 * inherited display did not apply, the tracks became inert, the element fell
 * back to the user-agent layout and three sibling spans collapsed into one
 * run-on line. The stylesheet looked correct in isolation and jsdom tests that
 * read the rule's declarations kept passing - the class fails silently and
 * only in the composed context.
 *
 * This guard parses EVERY stylesheet under `src/` and fails when a rule
 * declares container-layout properties (grid tracks, flex direction/wrap)
 * without owning a `display: grid | inline-grid | flex | inline-flex`
 * in the same rule, unless a base rule on the same class (the rule a
 * state/media/compound selector refines) supplies it from the same cascade:
 *  - CSS Modules scope their classes locally, so the base must live in the
 *    SAME module file; `:global(.x)` subjects resolve against the global sheets.
 *  - Global sheets (`src/styles/**` and non-module component CSS) are all
 *    imported unconditionally through `index.css`, so they form one cascade
 *    and a base rule in any of them counts.
 * Display that comes from an external primitive (`@readable-studio/components`)
 * or from a class the markup might not carry is exactly the failure mode, so
 * it does not count.
 *
 * `grid-column` / `grid-row` / `flex` / `align-self` are ITEM properties and
 * are deliberately not scanned: they are valid on a child that owns no display.
 *
 * The allowlist below carries the rules verified as legitimately inheriting
 * their display. Keep it small; every entry says where the display comes from.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const srcRoot = new URL('../../src/', import.meta.url);

/**
 * Properties whose loss silently WRECKS the layout when the display is
 * missing: tracks and flow direction. `gap` / `align-items` /
 * `justify-content` are deliberately not scanned - they are set on hundreds of
 * `Button`-backed global classes whose inline-flex comes from the primitive,
 * and their loss degrades spacing rather than collapsing structure; scanning
 * them produced ~60 legitimate hits, which is a wrong detector, not a big
 * allowlist.
 */
const CONTAINER_LAYOUT_PROPERTIES: ReadonlySet<string> = new Set([
  'grid',
  'grid-template',
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  'place-items',
  'flex-direction',
  'flex-wrap',
  'flex-flow',
]);

const CONTAINER_DISPLAYS = /^(inline-)?(grid|flex)\b/;

/**
 * Rules verified as legitimately taking their display from elsewhere.
 * Key: `src`-relative path -> exact selector list -> where the display comes
 * from. Anything not listed here must own its display.
 */
const ALLOWLIST: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Sibling global class on the SAME element in markup supplies the display.
  // The pairing is hard-coded in the JSX, so the base cannot be absent.
  'styles/viewer/library.css': {
    '.memory-records-section .memory-extraction-card':
      'Rendered as `library-card memory-extraction-card`; `.library-card` is display:flex, so ' +
      'this grid-template-columns is already inert today. Adding display:grid would CHANGE the ' +
      'shipped layout, so it stays as-is.',
    '.memory-chat-learning-toggle.memory-chat-learning-toggle':
      'Rendered as `memory-source-toggle memory-chat-learning-toggle`; `.memory-source-toggle` is inline-flex.',
  },
  'styles/viewer/memory.css': {
    '.library-install-form .library-import-source-control': 'Rendered as `seg-control ...`; `.seg-control` is display:grid.',
    '.library-install-form .library-import-mode-control': 'Rendered as `seg-control ...`; `.seg-control` is display:grid.',
  },
  'styles/viewer/viewer-shared.css': {
    '.cloudflare-domain-grid': 'Rendered as `deploy-field-grid cloudflare-domain-grid`; `.deploy-field-grid` is display:grid.',
    '.deploy-field-grid, .cloudflare-domain-grid': 'Second selector: same pairing as above.',
    '.ds-modal-error': 'Rendered as `ds-modal-empty ds-modal-error`; `.ds-modal-empty` is display:flex.',
    '.ds-modal-unavailable': 'Rendered as `ds-modal-empty ds-modal-unavailable`; `.ds-modal-empty` is display:flex.',
  },
  'styles/workspace/artifacts.css': {
    '.agent-grid-installed': 'Rendered as `agent-grid agent-grid-installed`; `.agent-grid` is display:grid.',
  },
  'styles/workspace/design-browser.css': {
    '.db-menu button.db-browser-use-action': '`.db-menu button` (same file) is display:grid.',
  },
  'styles/workspace/design-files.css': {
    '.df-row-plugin-folder': 'Rendered as `df-row df-row-plugin-folder`; `.df-row` is display:grid.',
  },
  // Dead rules: no markup under src/ carries these classes (rg over *.ts/*.tsx
  // finds nothing). Nothing renders, so nothing can collapse. Deleting them is
  // a cleanup, not a correctness fix, and is out of this sweep's scope.
  'styles/design-system-flow.css': {
    '.ds-manager-card__head, .ds-user-row': 'Dead `.ds-manager-card__head`; `.ds-user-row` is display:flex in the same file.',
    '.ds-editor-grid, .ds-source-card__row': 'Dead: neither class appears in markup.',
  },
  'styles/social-share.css': {
    '.entry-settings-social-share': 'Dead: class does not appear in markup.',
  },
  'styles/viewer/routines.css': {
    '.app .df-controls-primary': 'Dead: class does not appear in markup.',
  },
  'styles/workspace/mention-home.css': {
    '.mention-skill-item': 'Dead: class does not appear in markup.',
    '.staged-skills-row': 'Dead: class does not appear in markup.',
  },
  // Owned by a sibling lane; NOT verified safe. `Switch` supplies inline-grid
  // from `@readable-studio/components` - the same external-primitive dependency
  // that broke the profile row. That file should declare `display: inline-grid`
  // itself; this entry only keeps the guard green until that lane lands.
};

function listStylesheets(): readonly URL[] {
  const paths = execFileSync(
    'fd',
    ['--type', 'f', '--extension', 'css', '--absolute-path', '.', fileURLToPath(srcRoot)],
    { encoding: 'utf8' },
  );
  return paths.trim().split(/\r?\n/).filter(Boolean).map((path) => pathToFileURL(path));
}

const relativeTo = (file: URL): string =>
  fileURLToPath(file).slice(fileURLToPath(srcRoot).length).replaceAll('\\', '/');

function ownsContainerDisplay(rule: Rule): boolean {
  return rule.some(
    (node) => node.type === 'decl' && node.prop === 'display' && CONTAINER_DISPLAYS.test(node.value.trim()),
  );
}

function containerProps(rule: Rule): readonly string[] {
  const props: string[] = [];
  for (const node of rule.nodes) {
    if (node.type === 'decl' && CONTAINER_LAYOUT_PROPERTIES.has(node.prop)) props.push(node.prop);
  }
  return props;
}

interface Finding {
  readonly file: string;
  readonly selector: string;
  readonly props: readonly string[];
}

function parseRules(file: URL): readonly Rule[] {
  const root = postcss.parse(readFileSync(file, 'utf8'));
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    // Keyframe steps are not selectors.
    if (rule.parent?.type === 'atrule' && /keyframes$/.test((rule.parent as { name: string }).name)) return;
    rules.push(rule);
  });
  return rules;
}

/**
 * Classes that are the sole subject of a rule owning a container display.
 * `.row:hover`, `.row.active`, `.app .row`, `.row` inside `@media` all match
 * the same element as `.row`, so they may refine it without re-declaring.
 */
function baseClassesWithDisplay(rules: readonly Rule[]): ReadonlySet<string> {
  const classes = new Set<string>();
  for (const rule of rules) {
    if (!ownsContainerDisplay(rule)) continue;
    for (const single of rule.selector.split(',')) {
      // The whole selector, so `.files li` may be refined by an identical
      // `.files li` later in the file (or inside @media).
      classes.add(normalise(single));
      const compounds = single.trim().split(/\s*[>+~]\s*|\s+/);
      const match = /^(?::global\()?\.([\w-]+)\)?$/.exec(compounds.at(-1) ?? '');
      if (match) classes.add(match[1]!);
    }
  }
  return classes;
}

const normalise = (selector: string): string => selector.trim().replace(/\s+/g, ' ');

const isModule = (file: URL): boolean => file.pathname.endsWith('.module.css');

function scan(file: URL, rules: readonly Rule[], globalBases: ReadonlySet<string>): readonly Finding[] {
  const localBases = isModule(file) ? baseClassesWithDisplay(rules) : globalBases;
  const findings: Finding[] = [];
  for (const rule of rules) {
    const props = containerProps(rule);
    if (props.length === 0 || ownsContainerDisplay(rule)) continue;
    const covered = rule.selector.split(',').every((single) => {
      if (localBases.has(normalise(single))) return true;
      const stripped = single.replace(/:(?:where|is|not|has)\([^)]*\)/g, '');
      const last = stripped.trim().split(/\s*[>+~]\s*|\s+/).at(-1) ?? '';
      const globalSubject = /:global\(/.test(last);
      const bases = globalSubject ? globalBases : localBases;
      // A BEM modifier (`.hub--inspecting`) only ever sits beside its base
      // (`.hub`), so the base rule's display applies to the same element.
      return [...last.matchAll(/\.([\w-]+)/g)].some(
        (match) => bases.has(match[1]!) || bases.has(match[1]!.replace(/--[\w-]+$/, '')),
      );
    });
    if (covered) continue;
    findings.push({ file: relativeTo(file), selector: rule.selector.replace(/\s+/g, ' '), props });
  }
  return findings;
}

function scanAll(): readonly Finding[] {
  const sheets = listStylesheets().map((file) => ({ file, rules: parseRules(file) }));
  const globalBases = baseClassesWithDisplay(sheets.filter(({ file }) => !isModule(file)).flatMap(({ rules }) => rules));
  return sheets.flatMap(({ file, rules }) => scan(file, rules, globalBases));
}

describe('layout container display guard', () => {
  const findings = scanAll();

  it('every grid/flex container rule owns its display or is an allowlisted verified inheritor', () => {
    const unexpected = findings.filter((finding) => ALLOWLIST[finding.file]?.[finding.selector] === undefined);
    const report = unexpected
      .map((finding) => `${finding.file}\n  ${finding.selector}\n    ${finding.props.join(', ')}`)
      .join('\n');
    expect(report, `rules declaring container-layout properties without display:\n${report}`).toBe('');
  });

  it('every allowlist entry still matches a real finding', () => {
    const stale: string[] = [];
    for (const [file, selectors] of Object.entries(ALLOWLIST)) {
      for (const selector of Object.keys(selectors)) {
        if (!findings.some((finding) => finding.file === file && finding.selector === selector)) {
          stale.push(`${file} :: ${selector}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
