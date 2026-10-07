// @vitest-environment jsdom

// The Hub's template carousel: the horizontal template rail under the Hub
// composer, in the slot the drop-to-edit zone used to occupy. Cards come
// from the bundled example catalogue (readable-studio.json manifests), each
// card is a poster (preview on top, title-only line below, description in
// the tooltip), the rail is collapsible through the shared accordion pair
// (stays mounted, toggles a class) with the collapsed state persisted across
// remounts, the old drop zone is gone, and dropping a file on the prompt
// still attaches it (that path is the reason the separate zone was
// redundant).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';

import { HomeHero } from '../../src/components/HomeHero';
import { __resetHtmlSurfaceProbeCacheForTests } from '../../src/components/plugins-home/cards/HtmlSurface';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';

const ko = getKo();
const en = getEn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  window.localStorage.clear();
});

const EXAMPLES_DIR = resolve(__dirname, '../../../../plugins/_official/examples');

function catalogueRecord(slug: string): InstalledPluginRecord {
  const manifest = JSON.parse(
    readFileSync(resolve(EXAMPLES_DIR, slug, 'readable-studio.json'), 'utf8'),
  ) as InstalledPluginRecord['manifest'];
  const id = `example-${slug}`;
  return {
    id,
    title: manifest.title ?? slug,
    version: manifest.version,
    sourceKind: 'bundled',
    source: EXAMPLES_DIR,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    manifest: { ...manifest, name: id },
    fsPath: resolve(EXAMPLES_DIR, slug),
    installedAt: 0,
    updatedAt: 0,
  };
}

const CATALOGUE = [
  'pricing-page',
  'hr-onboarding',
  'velar-luxury-real-estate',
  'gamified-app',
  'guizang-ppt',
].map(catalogueRecord);

function tabButton(id: string): HTMLButtonElement {
  return screen.getAllByTestId('hub-template-carousel-tab')
    .find((node) => node.getAttribute('data-tab-id') === id) as HTMLButtonElement;
}

function renderHub(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}, locale: 'ko' | 'en' = 'ko') {
  const onAddFiles = vi.fn();
  const onPickExamplePlugin = vi.fn();
  const utils = render(
    <I18nProvider initial={locale}>
      <HomeHero
        surface="hub"
        prompt=""
        onPromptChange={() => undefined}
        onSubmit={() => undefined}
        activePluginTitle={null}
        activeChipId={null}
        onClearActivePlugin={() => undefined}
        pluginOptions={CATALOGUE}
        pluginsLoading={false}
        pendingPluginId={null}
        pendingChipId={null}
        onPickPlugin={() => undefined}
        onPickExamplePlugin={onPickExamplePlugin}
        onPickChip={() => undefined}
        onAddFiles={onAddFiles}
        contextItemCount={0}
        error={null}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...utils, onAddFiles, onPickExamplePlugin };
}

describe('Hub template carousel', () => {
  it('renders catalogue templates as poster cards: preview plus a title-only line', () => {
    renderHub();
    const carousel = screen.getByTestId('hub-template-carousel');
    expect(carousel.getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText(ko['homeHero.templateCarouselTitle'])).not.toBeNull();

    // Default tab is the deck set; the website tab holds the prototype cards.
    expect(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id')))
      .toEqual(['example-guizang-ppt']);
    fireEvent.click(tabButton('prototype'));
    const cards = screen.getAllByTestId('hub-template-card');
    const ids = cards.map((card) => card.getAttribute('data-plugin-id'));
    expect(ids).toEqual(expect.arrayContaining(
      CATALOGUE.filter((record) => record.manifest.readable?.hubType === 'website').map((record) => record.id),
    ));

    const pricing = cards.find((card) => card.getAttribute('data-plugin-id') === 'example-pricing-page')!;
    const manifest = CATALOGUE[0]!.manifest;
    expect(pricing.querySelector('.home-hero__template-title')?.textContent).toBe(manifest.title_i18n?.ko);
    // Visible text is the title only; the description is not rendered as
    // text (it would wrap the narrow poster card) and survives in the tooltip.
    expect(pricing.querySelector('.home-hero__template-desc')).toBeNull();
    expect(pricing.textContent).toBe(manifest.title_i18n?.ko);
    expect(pricing.getAttribute('title')).toBe(`${manifest.title_i18n?.ko} · ${manifest.description_i18n?.ko}`);
    const thumb = pricing.querySelector('.home-hero__template-thumb')!;
    expect(thumb).not.toBeNull();
    // Preview above the title in DOM order (the card is a column).
    expect(thumb.compareDocumentPosition(pricing.querySelector('.home-hero__template-title')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each card is filed under its tab's chip so a pick binds the right
    // creation type.
    expect(pricing.getAttribute('data-chip-id')).toBe('prototype');
    fireEvent.click(tabButton('deck'));
    const deck = screen.getAllByTestId('hub-template-card')
      .find((card) => card.getAttribute('data-plugin-id') === 'example-guizang-ppt')!;
    expect(deck.getAttribute('data-chip-id')).toBe('deck');
  });

  it('stacks three vertical type tabs left of the rail, each showing that type\'s full set', () => {
    const { unmount } = renderHub();
    const tablist = screen.getByTestId('hub-template-carousel-tabs');
    expect(tablist.getAttribute('role')).toBe('tablist');
    expect(tablist.getAttribute('aria-orientation')).toBe('vertical');
    expect(tablist.getAttribute('aria-label')).toBe(ko['homeHero.templateTabsLabel']);
    const tabs = screen.getAllByTestId('hub-template-carousel-tab');
    expect(tabs.map((node) => node.getAttribute('data-tab-id'))).toEqual(['deck', 'report', 'prototype']);
    expect(tabs.map((node) => node.querySelector('.home-hero__templates-tab-label')?.textContent)).toEqual([
      ko['homeHero.templateTabDeck'],
      ko['homeHero.templateTabReport'],
      ko['homeHero.templateTabPrototype'],
    ]);
    // Each tab is a real button: an icon per type (the creation chip's
    // glyph), the label, and that type's template count (1 deck, 1 report,
    // 3 websites in this catalogue) with a spoken-form label.
    for (const node of tabs) {
      expect(node.querySelector('.home-hero__templates-tab-icon svg')).not.toBeNull();
    }
    expect(tabs.map((node) => node.querySelector('[data-testid="hub-template-carousel-tab-count"]')?.textContent))
      .toEqual(['1', '1', '3']);
    expect(tabButton('prototype').querySelector('[data-testid="hub-template-carousel-tab-count"]')?.getAttribute('aria-label'))
      .toBe(ko['homeHero.templateTabCount'].replace('{count}', '3'));
    // The column precedes the rail inside the collapsible body, so it collapses with it.
    const rail = screen.getByTestId('hub-template-carousel-rail');
    const body = screen.getByTestId('hub-template-carousel-body');
    expect(body.contains(tablist)).toBe(true);
    expect(tablist.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The rail sits in its arrow viewport; the tab column is that viewport's sibling.
    expect(tablist.parentElement).toBe(screen.getByTestId('hub-template-carousel-viewport').parentElement);
    // Tabs are buttons with aria-selected (never checkboxes); the rail is
    // labelled by the selected tab and the tab controls the rail.
    for (const node of tabs) expect(node.tagName).toBe('BUTTON');
    expect(tabButton('deck').getAttribute('aria-selected')).toBe('true');
    expect(tabButton('deck').classList.contains('is-selected')).toBe(true);
    expect(tabButton('report').getAttribute('aria-selected')).toBe('false');
    expect(rail.getAttribute('aria-labelledby')).toBe(tabButton('deck').id);
    expect(tabButton('deck').getAttribute('aria-controls')).toBe(rail.id);

    // Full, uncapped set per tab: 20 prototype records all show (the chip
    // view's showcase cap is 18), in the chip view's curated order.
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...CATALOGUE[0]!,
      id: `example-site-${index}`,
      title: `Site ${index}`,
      manifest: { ...CATALOGUE[0]!.manifest, name: `example-site-${index}` },
    }));
    unmount();
    renderHub({ pluginOptions: [...CATALOGUE, ...many] });
    fireEvent.click(tabButton('prototype'));
    const shown = screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id'));
    expect(shown).toHaveLength(23);
    expect(shown).toEqual(expect.arrayContaining(many.map((record) => record.id)));
    expect(new Set(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-chip-id'))))
      .toEqual(new Set(['prototype']));
    // The onboarding document is a report, not a website despite prototype mode.
    fireEvent.click(tabButton('report'));
    expect(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id')))
      .toEqual(['example-hr-onboarding']);
    expect(screen.getAllByTestId('hub-template-carousel-tab')).toHaveLength(3);
  });

  it('tabs are one Tab stop with a roving tabindex: ArrowUp/ArrowDown move and select', () => {
    renderHub();
    const tablist = screen.getByTestId('hub-template-carousel-tabs');
    expect(screen.getAllByTestId('hub-template-carousel-tab').filter((node) => node.tabIndex === 0))
      .toHaveLength(1);
    expect(tabButton('deck').tabIndex).toBe(0);
    tabButton('deck').focus();
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabButton('report'));
    expect(tabButton('report').getAttribute('aria-selected')).toBe('true');
    expect(tabButton('report').tabIndex).toBe(0);
    expect(tabButton('deck').tabIndex).toBe(-1);
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabButton('prototype'));
    // Clamped at the ends, never wraps.
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabButton('prototype'));
    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tabButton('report'));
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(document.activeElement).toBe(tabButton('deck'));
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(document.activeElement).toBe(tabButton('prototype'));
  });

  it('persists the selected tab next to the collapse preference and defaults to decks', () => {
    const first = renderHub();
    expect(window.localStorage.getItem('readable-studio:hub-template-carousel-tab')).toBeNull();
    fireEvent.click(tabButton('prototype'));
    expect(window.localStorage.getItem('readable-studio:hub-template-carousel-tab')).toBe('prototype');
    first.unmount();
    renderHub();
    expect(tabButton('prototype').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id')))
      .toContain('example-pricing-page');
    // Back to the default clears the key; garbage in storage falls back to decks.
    fireEvent.click(tabButton('deck'));
    expect(window.localStorage.getItem('readable-studio:hub-template-carousel-tab')).toBeNull();
    cleanup();
    window.localStorage.setItem('readable-studio:hub-template-carousel-tab', 'bogus');
    renderHub(undefined, 'en');
    expect(tabButton('deck').getAttribute('aria-selected')).toBe('true');
    expect(tabButton('deck').querySelector('.home-hero__templates-tab-label')?.textContent).toBe(en['homeHero.templateTabDeck']);
  });

  it('styles the tabs as a vertical segmented control: filled buttons with a solid selected pill', () => {
    // The owner's complaint: the column did not read as clickable. Every
    // tab is a pointer-cursor button on an engraved tray; hover changes the
    // fill, :active presses, and the selected tab is the solid accent pill
    // with contrast ink (not a tint). No border lines, existing tokens only.
    const css = readFileSync(resolve(__dirname, '../../src/styles/home/home-hero.css'), 'utf8');
    const rules = new Map<string, Record<string, string>>();
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('home-hero__templates-tab')) return;
      if (rule.parent?.type === 'atrule') return; // reduced-motion overrides are not the base look
      const decls: Record<string, string> = rules.get(rule.selector) ?? {};
      rule.walkDecls((decl) => { decls[decl.prop] = decl.value; });
      rules.set(rule.selector, decls);
    });
    const tray = rules.get('.home-hero__templates-tabs')!;
    expect(tray['flex-direction']).toBe('column');
    expect(tray.background).toBe('var(--hub-control-engraved)');
    const tab = rules.get('.home-hero__templates-tab')!;
    expect(tab.cursor).toBe('pointer');
    expect(tab.border).toBe('0');
    expect(tab['min-height']).toBe('40px');
    expect(tab['word-break']).toBe('keep-all');
    expect(rules.get('.home-hero__templates-tab:hover')?.background).toBe('var(--hub-control-surface-hover)');
    expect(rules.get('.home-hero__templates-tab:active')?.transform).toMatch(/scale/);
    expect(rules.get('.home-hero__templates-tab:focus-visible')?.outline).toBe('2px solid var(--hub-accent)');
    const selected = rules.get('.home-hero__templates-tab.is-selected')!;
    expect(selected.background).toBe('var(--hub-accent)');
    expect(selected.color).toBe('var(--hub-accent-fg)');
    expect(selected['font-weight']).toBe('650');
    for (const decls of rules.values()) {
      for (const [prop, value] of Object.entries(decls)) {
        if (prop === 'background' || prop === 'color' || prop === 'box-shadow') expect(value).not.toMatch(/#[0-9a-f]{3}|rgba?\(/i);
        if (prop.startsWith('border') && !prop.includes('radius')) expect(value).toBe('0');
      }
    }
  });

  describe('edge arrows', () => {
    // jsdom has no layout: drive scrollWidth / clientWidth / scrollLeft by
    // hand on the rail and fire `scroll` so the component re-reads them.
    function layoutRail(rail: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
      Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: scrollWidth });
      Object.defineProperty(rail, 'clientWidth', { configurable: true, value: clientWidth });
      let left = scrollLeft;
      Object.defineProperty(rail, 'scrollLeft', {
        configurable: true,
        get: () => left,
        set: (value: number) => { left = value; },
      });
      fireEvent.scroll(rail);
    }
    function arrows() {
      return {
        prev: screen.getByTestId('hub-template-carousel-prev') as HTMLButtonElement,
        next: screen.getByTestId('hub-template-carousel-next') as HTMLButtonElement,
        viewport: screen.getByTestId('hub-template-carousel-viewport'),
      };
    }

    it('both hide while the cards fit; left hides at the start, right at the end, both show midway', () => {
      renderHub();
      fireEvent.click(tabButton('prototype'));
      const rail = screen.getByTestId('hub-template-carousel-rail');
      const { prev, next, viewport } = arrows();
      expect(prev.getAttribute('aria-label')).toBe(ko['homeHero.templateRailPrev']);
      expect(next.getAttribute('aria-label')).toBe(ko['homeHero.templateRailNext']);
      // The arrows sit inside the viewport that wraps the rail, after the
      // cards in DOM order, so they overlay the rail edges.
      expect(viewport.contains(rail)).toBe(true);
      expect(viewport.contains(prev) && viewport.contains(next)).toBe(true);

      // No overflow (jsdom default 0/0): both hidden and out of the tab order.
      layoutRail(rail, { scrollWidth: 600, clientWidth: 600, scrollLeft: 0 });
      expect(prev.disabled && next.disabled).toBe(true);
      expect(prev.getAttribute('aria-hidden')).toBe('true');
      expect(next.tabIndex).toBe(-1);
      expect(viewport.classList.contains('is-at-start') && viewport.classList.contains('is-at-end')).toBe(true);

      // Overflowing, at the start: only the right arrow.
      layoutRail(rail, { scrollWidth: 1800, clientWidth: 600, scrollLeft: 0 });
      expect(prev.disabled).toBe(true);
      expect(next.disabled).toBe(false);
      expect(next.getAttribute('aria-hidden')).toBe('false');
      expect(next.tabIndex).toBe(0);
      expect(viewport.classList.contains('is-at-start')).toBe(true);
      expect(viewport.classList.contains('is-at-end')).toBe(false);

      // Midway: both.
      layoutRail(rail, { scrollWidth: 1800, clientWidth: 600, scrollLeft: 500 });
      expect(prev.disabled || next.disabled).toBe(false);
      expect(prev.tabIndex === 0 && next.tabIndex === 0).toBe(true);
      expect(viewport.classList.contains('is-at-start') || viewport.classList.contains('is-at-end')).toBe(false);

      // At the end (within the 1px tolerance): only the left arrow.
      layoutRail(rail, { scrollWidth: 1800, clientWidth: 600, scrollLeft: 1199.5 });
      expect(prev.disabled).toBe(false);
      expect(next.disabled).toBe(true);
      expect(viewport.classList.contains('is-at-end')).toBe(true);
    });

    it('a click pages the rail by one viewport minus a card width, smoothly unless motion is reduced', () => {
      renderHub();
      fireEvent.click(tabButton('prototype'));
      const rail = screen.getByTestId('hub-template-carousel-rail');
      const item = rail.querySelector<HTMLElement>('[data-testid="hub-template-item"]')!;
      item.getBoundingClientRect = () => ({ width: 140, height: 120, top: 0, left: 0, right: 140, bottom: 120, x: 0, y: 0, toJSON: () => ({}) });
      const scrollTo = vi.fn((options: ScrollToOptions) => {
        rail.scrollLeft = options.left ?? 0;
        fireEvent.scroll(rail);
      });
      rail.scrollTo = scrollTo as unknown as typeof rail.scrollTo;
      layoutRail(rail, { scrollWidth: 1800, clientWidth: 600, scrollLeft: 0 });
      const { prev, next } = arrows();

      fireEvent.click(next);
      expect(scrollTo).toHaveBeenCalledWith({ left: 460, behavior: 'smooth' });
      expect(rail.scrollLeft).toBe(460);
      expect(prev.disabled).toBe(false);
      fireEvent.click(prev);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: 'smooth' });
      expect(prev.disabled).toBe(true);

      // Reduced motion: same distance, instant.
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      try {
        fireEvent.click(next);
        expect(scrollTo).toHaveBeenLastCalledWith({ left: 460, behavior: 'auto' });
      } finally {
        window.matchMedia = matchMedia;
      }
    });
  });

  it('a card pick never enters an expanded state: the tab column and the set stay, only the check moves', () => {
    // Regression: picking a card used to switch the rail into a chip-scoped
    // mode (tab column gone, set replaced by the chip's presets) the owner
    // could not leave. The rail must look the same before and after a pick
    // (the host activates the chip and the plugin), and no sub-category
    // chip row may appear under the composer.
    const { onPickExamplePlugin, rerender } = renderHub();
    const before = screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id'));
    fireEvent.click(screen.getAllByTestId('hub-template-card')[0]!);
    expect(onPickExamplePlugin).toHaveBeenCalledTimes(1);
    rerender(
      <I18nProvider initial="ko">
        <HomeHero
          surface="hub"
          prompt=""
          onPromptChange={() => undefined}
          onSubmit={() => undefined}
          activePluginTitle={CATALOGUE[4]!.title}
          activePluginRecord={CATALOGUE[4]!}
          activeChipId="deck"
          onClearActivePlugin={() => undefined}
          pluginOptions={CATALOGUE}
          pluginsLoading={false}
          pendingPluginId={null}
          pendingChipId={null}
          onPickPlugin={() => undefined}
          onPickExamplePlugin={onPickExamplePlugin}
          onPickChip={() => undefined}
          onAddFiles={() => undefined}
          contextItemCount={0}
          error={null}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('hub-template-carousel-tabs')).not.toBeNull();
    expect(screen.getByTestId('hub-template-carousel-rail').getAttribute('aria-labelledby')).toBe(tabButton('deck').id);
    expect(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id'))).toEqual(before);
    const picked = screen.getAllByTestId('hub-template-card')
      .find((card) => card.getAttribute('data-plugin-id') === 'example-guizang-ppt')!;
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    expect(picked.classList.contains('is-active')).toBe(true);
    expect(screen.queryByTestId('home-hero-subtype-row')).toBeNull();
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    // The other tabs stay reachable (the way out of a mis-click).
    fireEvent.click(tabButton('report'));
    expect(screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id')))
      .toEqual(['example-hr-onboarding']);
  });

  it('a click on the already-selected card routes to the chip-remove path, not a re-pick', () => {
    const onClearTemplateChip = vi.fn();
    const { onPickExamplePlugin } = renderHub({
      activePluginTitle: CATALOGUE[4]!.title,
      activePluginRecord: CATALOGUE[4]!,
      activeChipId: 'deck',
      templateChip: { name: CATALOGUE[4]!.title },
      onClearTemplateChip,
    });
    const picked = screen.getAllByTestId('hub-template-card')
      .find((card) => card.getAttribute('data-plugin-id') === 'example-guizang-ppt')!;
    expect(picked.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(picked);
    expect(onClearTemplateChip).toHaveBeenCalledTimes(1);
    expect(onPickExamplePlugin).not.toHaveBeenCalled();
    // The favorite star on the same card never touches the selection.
    fireEvent.click(picked.parentElement!.querySelector('.home-hero__template-fav')!);
    expect(onClearTemplateChip).toHaveBeenCalledTimes(1);
    expect(onPickExamplePlugin).not.toHaveBeenCalled();
  });

  it('keeps the favorite star and the selection check on opposite corners of every card', () => {
    renderHub({ activeChipId: 'deck', activePluginRecord: CATALOGUE[4]!, activePluginTitle: CATALOGUE[4]!.title });
    const item = screen.getAllByTestId('hub-template-item')[0]!;
    const star = item.querySelector('[data-testid="hub-template-favorite"]')!;
    const check = item.querySelector('[data-testid="hub-template-check"]')!;
    expect(star.parentElement).toBe(item);
    expect(check.parentElement).toBe(item);
    expect(check.getAttribute('data-active')).toBe('true');
    expect(check.classList.contains('is-on')).toBe(true);
    // The check is a visual only; the card button carries the state.
    expect(check.getAttribute('aria-hidden')).toBe('true');
    expect(item.querySelector('.home-hero__plugin-preset-check')).toBeNull();
    const css = readFileSync(resolve(__dirname, '../../src/styles/home/home-hero.css'), 'utf8');
    const root = postcss.parse(css);
    const decl = (selector: string) => Object.fromEntries(
      (root.nodes.find((node): node is Rule => node.type === 'rule' && node.selector === selector)!.nodes)
        .flatMap((node) => (node.type === 'decl' ? [[node.prop, node.value]] : [])),
    );
    const fav = decl('.home-hero__template-fav');
    const badge = decl('.home-hero__template-check');
    expect([fav.top, fav.left, fav.right]).toEqual(['14px', '14px', undefined]);
    expect([badge.top, badge.right, badge.left]).toEqual(['14px', '14px', undefined]);
    expect([fav.width, fav.height]).toEqual([badge.width, badge.height]);
  });

  it('picking a card seeds the composer through the example-plugin handler', () => {
    const { onPickExamplePlugin } = renderHub();
    fireEvent.click(tabButton('report'));
    const card = screen.getAllByTestId('hub-template-card')
      .find((node) => node.getAttribute('data-plugin-id') === 'example-hr-onboarding')!;
    fireEvent.click(card);
    expect(onPickExamplePlugin).toHaveBeenCalledTimes(1);
    const [record, chipId, promptText] = onPickExamplePlugin.mock.calls[0]!;
    expect(record.id).toBe('example-hr-onboarding');
    expect(chipId).toBe('report');
    expect(promptText.length).toBeGreaterThan(0);
  });

  it('is one Tab stop: arrow keys move focus between cards', () => {
    renderHub();
    fireEvent.click(tabButton('prototype'));
    const cards = screen.getAllByTestId('hub-template-card');
    expect(cards.filter((card) => card.tabIndex === 0)).toHaveLength(1);
    cards[0]!.focus();
    fireEvent.keyDown(screen.getByTestId('hub-template-carousel-rail'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(screen.getByTestId('hub-template-carousel-rail'), { key: 'End' });
    expect(document.activeElement).toBe(cards[cards.length - 1]);
    fireEvent.keyDown(screen.getByTestId('hub-template-carousel-rail'), { key: 'Home' });
    expect(document.activeElement).toBe(cards[0]);
  });

  it('collapses on the toggle through the shared accordion pair and stays collapsed across a remount', () => {
    const first = renderHub();
    const toggle = screen.getByTestId('hub-template-carousel-toggle');
    const body = screen.getByTestId('hub-template-carousel-body');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(toggle.textContent).toBe(ko['homeHero.templateCarouselHide']);
    expect(body.classList.contains('accordion-collapsible')).toBe(true);
    expect(body.classList.contains('open')).toBe(true);
    expect(body.hasAttribute('inert')).toBe(false);
    expect(body.querySelector('.accordion-collapsible-inner > .home-hero__templates-deck > .home-hero__templates-viewport > .home-hero__templates-rail')).not.toBeNull();
    expect(body.querySelector('.accordion-collapsible-inner > .home-hero__templates-deck > .home-hero__templates-tabs')).not.toBeNull();
    fireEvent.click(toggle);
    // Collapse toggles the class and keeps the rail mounted so the exit
    // transition can play (an unmount would snap); the hidden cards leave
    // the tab order and the accessibility tree through `inert`.
    expect(screen.getByTestId('hub-template-carousel-body')).toBe(body);
    expect(body.classList.contains('open')).toBe(false);
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('hub-template-carousel-rail')).not.toBeNull();
    expect(screen.getAllByTestId('hub-template-card').length).toBeGreaterThan(0);
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe(ko['homeHero.templateCarouselShow']);
    first.unmount();

    // A fresh mount (next launch) reads the persisted opt-out.
    renderHub();
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('true');
    const remounted = screen.getByTestId('hub-template-carousel-body');
    expect(remounted.classList.contains('open')).toBe(false);
    expect(remounted.hasAttribute('inert')).toBe(true);
    // ...and the opt-out is reversible from the same control.
    fireEvent.click(screen.getByTestId('hub-template-carousel-toggle'));
    expect(remounted.classList.contains('open')).toBe(true);
    expect(remounted.hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('false');
    cleanup();
    renderHub(undefined, 'en');
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText(en['homeHero.templateCarouselTitle'])).not.toBeNull();
  });

  it('renders card thumbnails from the local example page, never from a remote host', async () => {
    // The daemon decorates records with a baked poster/clip that, when the
    // bake files are not on disk, points at a CDN. Offline / locked-down
    // machines cannot resolve that host, so the thumb must come from the
    // local sandboxed example page instead (daemon-served, same origin).
    const remote = 'https://repo-assets.readable-studio.ai/plugin-previews';
    const decorated = CATALOGUE.map((record) => ({
      ...record,
      manifest: {
        ...record.manifest,
        readable: {
          ...record.manifest.readable,
          thumbnail: { src: `/template-thumbnails/${record.id}.webp` },
          bakedPreview: {
            poster: `${remote}/${record.id}.poster.jpg`,
            video: `${remote}/${record.id}.mp4`,
            holdMs: 2500,
          },
        },
      },
    })) as InstalledPluginRecord[];
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      if (/^https?:/i.test(url)) throw new TypeError('getaddrinfo ENOTFOUND');
      return new Response('<!doctype html>', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    __resetHtmlSurfaceProbeCacheForTests();
    try {
      renderHub({ pluginOptions: decorated });
      fireEvent.click(tabButton('prototype'));
      const card = screen.getAllByTestId('hub-template-card')
        .find((node) => node.getAttribute('data-plugin-id') === 'example-pricing-page')!;
      const thumb = card.querySelector('.home-hero__template-thumb')!;
      const image = thumb.querySelector('img')!;
      expect(image.getAttribute('src')).toBe('/template-thumbnails/example-pricing-page.webp');
      // Frame fill comes from the stylesheet contract (tests/styles/hub-template-thumb-frame),
      // not an inline letterbox style.
      expect(image.className).toBe('home-hero__template-img');
      expect(image.getAttribute('style')).toBeNull();
      expect(thumb.querySelector('iframe')).toBeNull();
      fireEvent.error(image);
      const iframe = await screen.findByTitle(`${CATALOGUE[0]!.manifest.title_i18n?.ko} preview`);
      expect(thumb.contains(iframe)).toBe(true);
      expect(iframe.getAttribute('src')).toBe('/api/plugins/example-pricing-page/preview');
      expect(iframe.getAttribute('sandbox')).not.toBeNull();
      // No card paints a letter glyph and nothing was asked of a remote host.
      expect(document.querySelector('.plugins-home__media-fallback')).toBeNull();
      expect(document.querySelector('[data-testid="plugins-home-html-fallback"]')).toBeNull();
      expect(document.querySelector('.home-hero__template-thumb img[src^="http"]')).toBeNull();
      expect(requested.filter((url) => /^https?:/i.test(url))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      __resetHtmlSurfaceProbeCacheForTests();
    }
  });

  it('draws a designed static card for templates with neither a thumbnail nor a preview entry', async () => {
    // These report scenarios ship only a SKILL.md: their manifests declare a
    // non-HTML preview whose `./example.html` does not exist, so neither a
    // live iframe nor the letter glyph is an honest preview. hr-onboarding
    // does ship an example page, so without a thumbnail it keeps the live
    // fallback.
    const noPreview = ['dcf-valuation', 'last30days', 'x-research'].map(catalogueRecord);
    const onboardingRecord = catalogueRecord('hr-onboarding');
    const { thumbnail: _thumbnail, ...onboardingReadable } = onboardingRecord.manifest.readable as Record<string, unknown>;
    const onboardingNoThumb = {
      ...onboardingRecord,
      manifest: { ...onboardingRecord.manifest, readable: onboardingReadable },
    } as InstalledPluginRecord;
    for (const record of noPreview) {
      expect(record.manifest.readable?.hubType).toBe('report');
      expect(record.manifest.readable?.thumbnail).toBeUndefined();
      expect((record.manifest.readable?.preview as { type?: string }).type).not.toBe('html');
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('<!doctype html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    __resetHtmlSurfaceProbeCacheForTests();
    try {
      renderHub({ pluginOptions: [...CATALOGUE.filter((record) => record.id !== 'example-hr-onboarding'), onboardingNoThumb, ...noPreview] });
      fireEvent.click(tabButton('report'));
      const cards = screen.getAllByTestId('hub-template-card');
      expect(cards.map((card) => card.getAttribute('data-plugin-id'))).toEqual(
        expect.arrayContaining(['example-hr-onboarding', ...noPreview.map((record) => record.id)]),
      );
      for (const record of noPreview) {
        const card = cards.find((node) => node.getAttribute('data-plugin-id') === record.id)!;
        const thumb = card.querySelector('.home-hero__template-thumb')!;
        const placeholder = thumb.querySelector('[data-testid="hub-template-placeholder"]')!;
        expect(placeholder).not.toBeNull();
        expect(placeholder.getAttribute('data-frame')).toBe('report');
        // Shaped like the output (type kicker + the template's own title as
        // the sheet heading); no iframe, no image, no gallery glyph.
        expect(placeholder.textContent).toBe(`${ko['homeHero.templateTabReport']}${record.manifest.title_i18n?.ko}`);
        expect(placeholder.querySelector('svg')).not.toBeNull();
        expect(thumb.querySelector('iframe')).toBeNull();
        expect(thumb.querySelector('img')).toBeNull();
        expect(thumb.querySelector('.plugins-home__text-surface')).toBeNull();
        // The visible title line under the thumb is unchanged.
        expect(card.querySelector('.home-hero__template-title')?.textContent).toBe(record.manifest.title_i18n?.ko);
      }
      const onboarding = cards.find((node) => node.getAttribute('data-plugin-id') === 'example-hr-onboarding')!;
      const iframe = await screen.findByTitle(`${onboarding.querySelector('.home-hero__template-title')?.textContent} preview`);
      expect(onboarding.contains(iframe)).toBe(true);
      expect(onboarding.querySelector('[data-testid="hub-template-placeholder"]')).toBeNull();
      // Only the live card probed its preview; the static cards asked the
      // daemon for nothing.
      const probed = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith('/api/plugins/'));
      expect(probed).toEqual(['/api/plugins/example-hr-onboarding/preview']);
    } finally {
      vi.unstubAllGlobals();
      __resetHtmlSurfaceProbeCacheForTests();
    }
  });

  it('shapes the designed card after the tab it is filed under: slide for decks, browser for websites', () => {
    const base = catalogueRecord('x-research');
    const retyped = (hubType: string, id: string): InstalledPluginRecord => ({
      ...base,
      id,
      manifest: { ...base.manifest, name: id, readable: { ...base.manifest.readable!, hubType } },
    } as InstalledPluginRecord);
    const deck = retyped('deck', 'example-blank-deck');
    const site = retyped('website', 'example-blank-site');
    renderHub({ pluginOptions: [deck, site] });
    expect(screen.getByTestId('hub-template-placeholder').getAttribute('data-frame')).toBe('deck');
    expect(screen.getByTestId('hub-template-placeholder').textContent).toContain(ko['homeHero.templateTabDeck']);
    fireEvent.click(tabButton('prototype'));
    expect(screen.getByTestId('hub-template-placeholder').getAttribute('data-frame')).toBe('website');
    expect(screen.getByTestId('hub-template-placeholder').textContent).toContain(ko['homeHero.templateTabPrototype']);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('styles the rail scrollbar as the product\'s slim thumb-only bar, not the native one', () => {
    // `scrollbar-width: thin` alone rendered Chromium's native Windows
    // scrollbar, arrow buttons included, and any standard `scrollbar-width` /
    // `scrollbar-color` makes Chromium ignore the ::-webkit pseudo-elements.
    // So the rail owns neither and styles the pseudo-elements with the
    // `.chat-log` thumb geometry and ink, buttons removed, existing tokens only.
    const css = readFileSync(resolve(__dirname, '../../src/styles/home/home-hero.css'), 'utf8');
    const rules = new Map<string, Record<string, string>>();
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('home-hero__templates-rail')) return;
      const decls: Record<string, string> = rules.get(rule.selector) ?? {};
      rule.walkDecls((decl) => { decls[decl.prop] = decl.value; });
      rules.set(rule.selector, decls);
    });
    const rail = rules.get('.home-hero__templates-rail')!;
    expect(rail['overflow-x']).toBe('auto');
    expect(rail['scrollbar-width']).toBeUndefined();
    expect(rail['scrollbar-color']).toBeUndefined();
    expect(rules.get('.home-hero__templates-rail::-webkit-scrollbar')?.height).toBe('8px');
    expect(rules.get('.home-hero__templates-rail::-webkit-scrollbar-button')?.display).toBe('none');
    expect(rules.get('.home-hero__templates-rail::-webkit-scrollbar-track')?.background).toBe('transparent');
    const thumb = rules.get('.home-hero__templates-rail::-webkit-scrollbar-thumb')!;
    expect(thumb.background).toBe('color-mix(in srgb, var(--text-muted) 18%, transparent)');
    expect(thumb.background).not.toMatch(/#|rgba?\(/);
    expect(thumb['background-clip']).toBe('padding-box');
    expect(thumb['border-radius']).toBe('var(--radius)');
    expect(rules.get('.home-hero__templates-rail:hover::-webkit-scrollbar-thumb')?.background)
      .toBe('color-mix(in srgb, var(--text-muted) 28%, transparent)');
    // The same shape the transcript ships, so the two never drift.
    const chat = readFileSync(resolve(__dirname, '../../src/styles/chat.css'), 'utf8');
    let chatThumb = '';
    postcss.parse(chat).walkRules('.chat-log::-webkit-scrollbar-thumb', (rule: Rule) => {
      rule.walkDecls('background', (decl) => { chatThumb = decl.value; });
    });
    expect(thumb.background).toBe(chatThumb);
  });

  it('no longer renders the separate drop-to-edit zone', () => {
    renderHub();
    expect(screen.queryByTestId('hub-drop-to-edit')).toBeNull();
    expect(document.querySelector('[data-state="drag-over"]')).toBeNull();
  });

  it('still attaches a file dropped on the prompt box', () => {
    const { onAddFiles } = renderHub();
    const composer = screen.getByTestId('hub-composer');
    const file = new File(['brief'], 'brief.md', { type: 'text/markdown' });
    fireEvent.dragOver(composer, { dataTransfer: { files: [], types: ['Files'] } });
    expect(composer.classList.contains('is-drag-active')).toBe(true);
    fireEvent.drop(composer, { dataTransfer: { files: [file], types: ['Files'] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0]![0]).toEqual([file]);
    expect(composer.classList.contains('is-drag-active')).toBe(false);
  });
});
