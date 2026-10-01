// @vitest-environment jsdom

// The Hub's template carousel: the horizontal template rail under the Hub
// composer, in the slot the drop-to-edit zone used to occupy. Cards come
// from the bundled example catalogue (readable-studio.json manifests), the
// rail is collapsible with the collapsed state persisted across remounts,
// the old drop zone is gone, and dropping a file on the prompt still
// attaches it (that path is the reason the separate zone was redundant).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  it('renders catalogue templates as row cards with localized title and description', () => {
    renderHub();
    const carousel = screen.getByTestId('hub-template-carousel');
    expect(carousel.getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText(ko['homeHero.templateCarouselTitle'])).not.toBeNull();

    const cards = screen.getAllByTestId('hub-template-card');
    const ids = cards.map((card) => card.getAttribute('data-plugin-id'));
    expect(ids).toEqual(expect.arrayContaining(CATALOGUE.map((record) => record.id)));

    const pricing = cards.find((card) => card.getAttribute('data-plugin-id') === 'example-pricing-page')!;
    const manifest = CATALOGUE[0]!.manifest;
    expect(pricing.querySelector('.home-hero__template-title')?.textContent).toBe(manifest.title_i18n?.ko);
    expect(pricing.querySelector('.home-hero__template-desc')?.textContent).toBe(manifest.description_i18n?.ko);
    expect(pricing.querySelector('.home-hero__template-thumb')).not.toBeNull();
    // Mixed rail: a deck template rides next to the prototype ones, filed
    // under its own chip so a pick binds the right creation type.
    const deck = cards.find((card) => card.getAttribute('data-plugin-id') === 'example-guizang-ppt')!;
    expect(deck.getAttribute('data-chip-id')).toBe('deck');
    expect(pricing.getAttribute('data-chip-id')).toBe('prototype');
  });

  it('picking a card seeds the composer through the example-plugin handler', () => {
    const { onPickExamplePlugin } = renderHub();
    const card = screen.getAllByTestId('hub-template-card')
      .find((node) => node.getAttribute('data-plugin-id') === 'example-hr-onboarding')!;
    fireEvent.click(card);
    expect(onPickExamplePlugin).toHaveBeenCalledTimes(1);
    const [record, chipId, promptText] = onPickExamplePlugin.mock.calls[0]!;
    expect(record.id).toBe('example-hr-onboarding');
    expect(chipId).toBe('prototype');
    expect(promptText.length).toBeGreaterThan(0);
  });

  it('is one Tab stop: arrow keys move focus between cards', () => {
    renderHub();
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

  it('collapses on the toggle and stays collapsed across a remount', () => {
    const first = renderHub();
    const toggle = screen.getByTestId('hub-template-carousel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe(ko['homeHero.templateCarouselHide']);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('hub-template-carousel-rail')).toBeNull();
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe(ko['homeHero.templateCarouselShow']);
    first.unmount();

    // A fresh mount (next launch) reads the persisted opt-out.
    renderHub();
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByTestId('hub-template-card')).toBeNull();
    // ...and the opt-out is reversible from the same control.
    fireEvent.click(screen.getByTestId('hub-template-carousel-toggle'));
    expect(screen.getAllByTestId('hub-template-card').length).toBeGreaterThan(0);
    cleanup();
    renderHub(undefined, 'en');
    expect(screen.getByTestId('hub-template-carousel').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText(en['homeHero.templateCarouselTitle'])).not.toBeNull();
  });

  it('follows the active creation type instead of the mixed rail', () => {
    renderHub({ activeChipId: 'deck' });
    const cards = screen.getAllByTestId('hub-template-card');
    expect(cards.map((card) => card.getAttribute('data-plugin-id'))).toEqual(['example-guizang-ppt']);
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
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
      const card = screen.getAllByTestId('hub-template-card')
        .find((node) => node.getAttribute('data-plugin-id') === 'example-pricing-page')!;
      const thumb = card.querySelector('.home-hero__template-thumb')!;
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
