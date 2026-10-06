// @vitest-environment jsdom

// Favorite star on each Hub template card: a real button with aria-pressed
// over the thumb's top-right corner. Pressing it toggles the favorite and
// never picks the template; favorites sort first within the active tab in
// starring order; the list is the daemon-owned `templateFavorites`, written
// with a partial PUT and announced through the app-config-changed event.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';

import { HomeHero } from '../../src/components/HomeHero';
import {
  sortHubTemplateItemsByFavorite,
  toggleTemplateFavorite,
} from '../../src/components/home-hero/templateCarousel';
import { I18nProvider } from '../../src/i18n';
import { getKo } from '../../src/i18n/locales/ko';
import { getEn } from '../../src/i18n/locales/en';

const ko = getKo();
const en = getEn();

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

type FetchCall = { url: string; init?: RequestInit };

// A fake daemon config endpoint: GET returns the stored list, PUT merges
// the partial body the way the real daemon does.
function stubDaemon(initialFavorites: string[]) {
  const state = { templateFavorites: [...initialFavorites] };
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === '/api/app-config' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { templateFavorites?: string[] };
      if (Array.isArray(body.templateFavorites)) state.templateFavorites = body.templateFavorites;
      return new Response(JSON.stringify({ config: state }), { status: 200 });
    }
    if (url === '/api/app-config') {
      return new Response(JSON.stringify({ config: { enabledAgentIds: [], ...state } }), { status: 200 });
    }
    return new Response('<!doctype html>', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, calls, fetchMock };
}

function nextConfigChange(): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      window.removeEventListener('readable-studio:app-config-changed', listener);
      reject(new Error('Config change was not announced'));
    }, 2000);
    window.addEventListener('readable-studio:app-config-changed', listener, { once: true });
  });
}

function tabButton(id: string): HTMLButtonElement {
  return screen.getAllByTestId('hub-template-carousel-tab')
    .find((node) => node.getAttribute('data-tab-id') === id) as HTMLButtonElement;
}

function cardIds(): string[] {
  return screen.getAllByTestId('hub-template-card').map((card) => card.getAttribute('data-plugin-id')!);
}

function starFor(id: string): HTMLButtonElement {
  return screen.getAllByTestId('hub-template-favorite')
    .find((node) => node.getAttribute('data-plugin-id') === id) as HTMLButtonElement;
}

function renderHub(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}, locale: 'ko' | 'en' = 'ko') {
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
        onAddFiles={() => undefined}
        contextItemCount={0}
        error={null}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { ...utils, onPickExamplePlugin };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('sortHubTemplateItemsByFavorite', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ record: { id }, chipId: 'deck' }));
  const ids = (list: typeof items) => list.map((item) => item.record.id);

  it('leads with favorites in starring order and keeps the rest in place', () => {
    expect(ids(sortHubTemplateItemsByFavorite(items, []))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(sortHubTemplateItemsByFavorite(items, ['c']))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(sortHubTemplateItemsByFavorite(items, ['d', 'b']))).toEqual(['d', 'b', 'a', 'c']);
    // Favorites from other tabs / uninstalled plugins are simply absent.
    expect(ids(sortHubTemplateItemsByFavorite(items, ['zzz', 'b']))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('toggle appends on star and removes on unstar', () => {
    expect(toggleTemplateFavorite([], 'a')).toEqual(['a']);
    expect(toggleTemplateFavorite(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleTemplateFavorite(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('Hub template favorites', () => {
  it('renders a star button with aria-pressed and a localized label on every card, not inside the pick button', async () => {
    stubDaemon([]);
    renderHub();
    fireEvent.click(tabButton('prototype'));
    const stars = screen.getAllByTestId('hub-template-favorite');
    expect(stars).toHaveLength(screen.getAllByTestId('hub-template-card').length);
    for (const star of stars) {
      expect(star.tagName).toBe('BUTTON');
      expect(star.getAttribute('type')).toBe('button');
      expect(star.getAttribute('aria-pressed')).toBe('false');
      expect(star.getAttribute('aria-label')).toBe(ko['homeHero.templateFavoriteAdd']);
      expect(star.classList.contains('is-on')).toBe(false);
      // Sibling of the pick button inside the list item, never nested in it.
      expect(star.closest('[data-testid="hub-template-card"]')).toBeNull();
      const item = star.closest('[data-testid="hub-template-item"]')!;
      expect(item.getAttribute('role')).toBe('listitem');
      expect(item.querySelector('[data-testid="hub-template-card"]')).not.toBeNull();
      expect(item.querySelector('[data-testid="hub-template-card"]')?.getAttribute('role')).toBeNull();
    }
    cleanup();
    renderHub(undefined, 'en');
    expect(screen.getAllByTestId('hub-template-favorite')[0]!.getAttribute('aria-label'))
      .toBe(en['homeHero.templateFavoriteAdd']);
  });

  it('pressing the star toggles the favorite, persists it, and does not pick the template', async () => {
    const daemon = stubDaemon([]);
    let hub!: ReturnType<typeof renderHub>;
    await act(async () => { hub = renderHub(); });
    const { onPickExamplePlugin } = hub;
    fireEvent.click(tabButton('prototype'));
    expect(daemon.calls.some((call) => call.url === '/api/app-config')).toBe(true);
    const before = cardIds();
    // Star the LAST card so the reorder is observable.
    const target = before[before.length - 1]!;
    expect(before.length).toBeGreaterThan(1);

    const changed = vi.fn();
    window.addEventListener('readable-studio:app-config-changed', changed);
    const starred = nextConfigChange();
    fireEvent.click(starFor(target));
    expect(onPickExamplePlugin).not.toHaveBeenCalled();
    const star = starFor(target);
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(star.classList.contains('is-on')).toBe(true);
    expect(star.getAttribute('aria-label')).toBe(ko['homeHero.templateFavoriteRemove']);
    // The favorite leads the rail; the rest keep their order.
    expect(cardIds()).toEqual([target, ...before.filter((id) => id !== target)]);

    // Persisted through the daemon config as a partial PUT, then announced.
    await act(async () => { await starred; });
    expect(daemon.state.templateFavorites).toEqual([target]);
    const put = daemon.calls.find((call) => call.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({ templateFavorites: [target] });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener('readable-studio:app-config-changed', changed);

    // Keyboard: Enter / Space on the star only toggles.
    fireEvent.keyDown(starFor(target), { key: 'Enter' });
    fireEvent.keyDown(starFor(target), { key: ' ' });
    expect(onPickExamplePlugin).not.toHaveBeenCalled();

    // Unstar restores the original order and writes the empty list.
    const unstarred = nextConfigChange();
    fireEvent.click(starFor(target));
    expect(starFor(target).getAttribute('aria-pressed')).toBe('false');
    expect(cardIds()).toEqual(before);
    await act(async () => { await unstarred; });
    expect(daemon.state.templateFavorites).toEqual([]);
    // Picking still works from the card itself.
    fireEvent.click(screen.getAllByTestId('hub-template-card')[0]!);
    expect(onPickExamplePlugin).toHaveBeenCalledTimes(1);
  });

  it('loads persisted favorites on mount and orders them by starring order within the tab', async () => {
    stubDaemon(['example-hr-onboarding', 'example-gamified-app', 'example-pricing-page', 'example-guizang-ppt']);
    await act(async () => { renderHub(); });
    fireEvent.click(tabButton('prototype'));
    expect(starFor('example-gamified-app').getAttribute('aria-pressed')).toBe('true');
    const ids = cardIds();
    expect(ids.slice(0, 2)).toEqual(['example-gamified-app', 'example-pricing-page']);
    expect(ids).toHaveLength(3);
    expect(starFor('example-velar-luxury-real-estate').getAttribute('aria-pressed')).toBe('false');
    // A favorited document cannot leak back into the website tab.
    fireEvent.click(tabButton('report'));
    expect(cardIds()).toEqual(['example-hr-onboarding']);
    expect(starFor('example-hr-onboarding').getAttribute('aria-pressed')).toBe('true');
    // The deck favorite stays in its own tab.
    fireEvent.click(tabButton('deck'));
    expect(cardIds()).toEqual(['example-guizang-ppt']);
    expect(starFor('example-guizang-ppt').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the optimistic state when the daemon rejects the write', async () => {
    const daemon = stubDaemon([]);
    daemon.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/app-config' && init?.method === 'PUT') return new Response('{}', { status: 500 });
      if (url === '/api/app-config') return new Response(JSON.stringify({ config: { enabledAgentIds: [], templateFavorites: [] } }), { status: 200 });
      return new Response('<!doctype html>', { status: 200 });
    });
    const changed = vi.fn();
    window.addEventListener('readable-studio:app-config-changed', changed);
    renderHub();
    await act(async () => {
      fireEvent.click(starFor('example-guizang-ppt'));
    });
    expect(starFor('example-guizang-ppt').getAttribute('aria-pressed')).toBe('true');
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener('readable-studio:app-config-changed', changed);
  });

  it('styles the star with tokens only: transparent OFF outline, warm filled ON, reduced-motion safe', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/home/home-hero.css'), 'utf8');
    const rules = new Map<string, Record<string, string>>();
    let reducedMotionCoversStar = false;
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes('home-hero__template-fav')) return;
      const parent = rule.parent;
      if (parent && parent.type === 'atrule' && String((parent as { params?: string }).params).includes('prefers-reduced-motion: reduce')) {
        reducedMotionCoversStar = true;
        return;
      }
      const decls: Record<string, string> = rules.get(rule.selector) ?? {};
      rule.walkDecls((decl) => { decls[decl.prop] = decl.value; });
      rules.set(rule.selector, decls);
    });
    const star = rules.get('.home-hero__template-fav')!;
    expect(star.position).toBe('absolute');
    expect(star.background).toBe('transparent');
    expect(star.border).toBe('0');
    expect(Number.parseInt(star.width ?? '', 10)).toBeGreaterThanOrEqual(24);
    expect(Number.parseInt(star.width ?? '', 10)).toBeLessThanOrEqual(28);
    expect(star.color).toContain('var(--text-muted)');
    expect(rules.get('.home-hero__template-fav svg')?.fill).toBe('transparent');
    expect(rules.get('.home-hero__template-fav svg')?.filter).toContain('drop-shadow');
    expect(rules.get('.home-hero__template-fav.is-on')?.color).toBe('var(--amber)');
    expect(rules.get('.home-hero__template-fav.is-on svg')?.fill).toBe('currentColor');
    for (const decls of rules.values()) {
      for (const [prop, value] of Object.entries(decls)) {
        if (['color', 'background', 'background-color', 'box-shadow', 'filter', 'fill'].includes(prop)) {
          expect(value, `${prop}: ${value}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
        }
      }
    }
    expect(reducedMotionCoversStar).toBe(true);
  });
});
