// @vitest-environment jsdom
// PluginShareMenu — plugin actions affordance contract.
//
// Locks the popover behaviour users expect from a plugin-specific
// actions button on a detail modal: copy install command / plugin id /
// README badge land on the clipboard, and the popover surfaces source +
// homepage links when the manifest carries them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledPluginRecord } from '@readable-studio/contracts';

import {
  buildPluginShareUrl,
  PluginShareMenu,
} from '../../src/components/plugin-details/PluginShareMenu';
import { I18nProvider, type Locale } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
const en = getEn();
const ko = getKo();

interface MakeArgs {
  id: string;
  title?: string;
  source?: string;
  sourceKind?: InstalledPluginRecord['sourceKind'];
  marketplaceId?: string;
  marketplaceEntryName?: string;
  authorUrl?: string;
  homepage?: string;
}

function make(args: MakeArgs): InstalledPluginRecord {
  return {
    id: args.id,
    title: args.title ?? args.id,
    version: '0.1.0',
    sourceKind: args.sourceKind ?? 'bundled',
    source: args.source ?? `plugins/${args.id}`,
    sourceMarketplaceId: args.marketplaceId,
    sourceMarketplaceEntryName: args.marketplaceEntryName,
    trust: 'bundled',
    capabilitiesGranted: [],
    manifest: {
      name: args.id,
      version: '0.1.0',
      title: args.title ?? args.id,
      ...(args.authorUrl ? { author: { url: args.authorUrl } } : {}),
      ...(args.homepage ? { homepage: args.homepage } : {}),
      readable: { kind: 'scenario' },
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

describe('PluginShareMenu', () => {
  let container: HTMLDivElement;
  let root: Root;
  let writes: string[];
  let clipboardWrite: Promise<void>;
  let finishClipboardWrite: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writes = [];
    clipboardWrite = new Promise<void>((resolve) => {
      finishClipboardWrite = resolve;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn((value: string) => {
          writes.push(value);
          return clipboardWrite;
        }),
      },
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...window.location,
        origin: 'https://example.test',
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderMenu(record: InstalledPluginRecord, locale?: Locale) {
    await act(async () => {
      root.render(
        locale ? (
          <I18nProvider initial={locale}>
            <PluginShareMenu record={record} />
          </I18nProvider>
        ) : (
          <PluginShareMenu record={record} />
        ),
      );
    });
  }

  async function openPopover(expectedTriggerText = 'More') {
    const trigger = container.querySelector(
      '.plugin-share-trigger',
    ) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain(expectedTriggerText);
    await act(async () => {
      trigger.click();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
  }

  async function clickItem(label: string) {
    const items = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ) as HTMLButtonElement[];
    const match = items.find((b) => b.textContent?.includes(label));
    expect(match, `expected an item labelled "${label}"`).toBeTruthy();
    await act(async () => {
      match!.click();
      // Resolve the actual clipboard operation inside act so its callers'
      // continuations and the resulting feedback render finish before returning.
      finishClipboardWrite();
      await clipboardWrite;
    });
    expect(match!.textContent).toBe(en['preview.shareCopied']);
  }

  it('copies an install command for marketplace plugins using the registry entry name', async () => {
    await renderMenu(
      make({
        id: 'mp-plugin',
        sourceKind: 'github',
        source: 'github:readable-studio/plugins/mp-plugin',
        marketplaceId: 'official',
        marketplaceEntryName: 'readable-studio/mp-plugin',
      }),
    );
    await openPopover();
    await clickItem('Copy install command');
    expect(writes).toContain('readable plugin install readable-studio/mp-plugin');
  });

  it('copies the github source string for github-installed plugins', async () => {
    await renderMenu(
      make({
        id: 'gh-plugin',
        sourceKind: 'github',
        source: 'github:owner/repo@main/sub',
      }),
    );
    await openPopover();
    await clickItem('Copy install command');
    expect(writes).toContain('readable plugin install github:owner/repo@main/sub');
  });

  it('does not duplicate the template share link action', async () => {
    await renderMenu(make({ id: 'live-dashboard' }));
    await openPopover();
    const labels = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ).map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Copy share link'))).toBe(false);
  });

  it('copies the bare plugin id for paste-into-yaml workflows', async () => {
    await renderMenu(make({ id: 'agentic-ds' }));
    await openPopover();
    await clickItem('Copy plugin ID');
    expect(writes).toContain('agentic-ds');
  });

  it('copies a README badge that links back to the marketplace detail page', async () => {
    await renderMenu(make({
      id: 'badge-plugin',
      title: 'Badge Plugin',
      marketplaceId: 'official',
      marketplaceEntryName: 'readable-studio/badge-plugin',
    }));
    await openPopover();
    await clickItem('Copy README badge');
    expect(writes.some((value) => (
      value.includes('Badge Plugin') &&
      value.includes('https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20badge-plugin&type=code')
    ))).toBe(true);
  });

  it('does not expose public share artifacts for local-only plugins', async () => {
    const localOnly = make({
      id: 'local-plugin',
      sourceKind: 'local',
      source: '/tmp/local-plugin',
    });
    expect(buildPluginShareUrl(localOnly)).toBeNull();

    await renderMenu(localOnly);
    await openPopover();
    const labels = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ).map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Copy README badge'))).toBe(false);
  });

  it('does not expose public share artifacts for private marketplace plugins', async () => {
    const privateMarketplace = make({
      id: 'private-plugin',
      sourceKind: 'marketplace',
      source: 'private/private-plugin',
      marketplaceId: 'private',
      marketplaceEntryName: 'private/private-plugin',
    });
    expect(buildPluginShareUrl(privateMarketplace)).toBeNull();

    await renderMenu(privateMarketplace);
    await openPopover();
    const labels = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ).map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Copy README badge'))).toBe(false);
  });

  it('localizes the plugin action menu labels', async () => {
    await renderMenu(
      make({
        id: 'ko-plugin',
        sourceKind: 'github',
        source: 'github:owner/repo',
        marketplaceId: 'official',
        marketplaceEntryName: 'readable-studio/ko-plugin',
        homepage: 'https://example.test/plugin-home',
      }),
      'ko',
    );
    await openPopover(ko['homeHero.moreShortcuts']);
    const labels = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ).map((item) => item.textContent ?? '');
    expect(labels).toContain(ko['plugins.actions.copyInstallCommand']);
    expect(labels).toContain(ko['plugins.actions.copyPluginId']);
    expect(labels).toContain(ko['plugins.actions.copyReadmeBadge']);
    expect(labels).toContain(ko['plugins.actions.openSourceGithub']);
    expect(labels).toContain(ko['plugins.actions.openHomepage']);
    expect(labels).toContain(ko['plugins.actions.openMarketplace']);
    expect(labels.some((label) => label.includes('Copy install command'))).toBe(false);
  });
  it('points Open in marketplace at the public GitHub search for bundled plugins', async () => {
    await renderMenu(make({ id: 'plain' }));
    await openPopover();
    const items = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ) as HTMLButtonElement[];
    expect(items.some((b) => b.textContent?.includes('Open in marketplace'))).toBe(
      true,
    );
    const marketplaceLink = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a.plugin-share-item'),
    ).find((link) => link.textContent?.includes('Open in marketplace'));
    // Bundled plugins use the public repository search, never a fabricated
    // product-site URL or a local /marketplace path.
    expect(marketplaceLink?.getAttribute('href')).toBe(
      'https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20plain&type=code',
    );
  });

  it('builds a public GitHub search link for bundled plugins', () => {
    expect(buildPluginShareUrl(make({ id: 'simple-deck' }))).toBe(
      'https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20simple-deck&type=code',
    );
  });

  it('builds a public GitHub search link for community marketplace plugins', () => {
    // Community manifest names carry a `community-` prefix, but the landing
    // page routes are keyed on the folder name via routeId=`community/<folder>`.
    // buildPluginShareUrl must use sourceMarketplaceEntryName so pluginDetailSlug
    // takes the last segment and matches the generated page slug.
    expect(
      buildPluginShareUrl(
        make({
          id: 'community-registry-starter',
          sourceKind: 'marketplace',
          source: 'community/registry-starter',
          marketplaceId: 'community',
          marketplaceEntryName: 'community/registry-starter',
        }),
      ),
    ).toBe('https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20community%2Fregistry-starter&type=code');
  });

  it('copies a README badge for community marketplace plugins', async () => {
    await renderMenu(
      make({
        id: 'community-registry-starter',
        title: 'Community Registry Starter',
        sourceKind: 'marketplace',
        source: 'community/registry-starter',
        marketplaceId: 'community',
        marketplaceEntryName: 'community/registry-starter',
      }),
    );
    await openPopover();
    await clickItem('Copy README badge');
    expect(
      writes.some(
        (value) =>
          value.includes('Community Registry Starter') &&
          value.includes('https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20community%2Fregistry-starter&type=code'),
      ),
    ).toBe(true);
  });

  it('points Open in marketplace at the public page for community marketplace plugins', async () => {
    await renderMenu(
      make({
        id: 'community-registry-starter',
        sourceKind: 'marketplace',
        source: 'community/registry-starter',
        marketplaceId: 'community',
        marketplaceEntryName: 'community/registry-starter',
      }),
    );
    await openPopover();
    const marketplaceLink = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a.plugin-share-item'),
    ).find((link) => link.textContent?.includes('Open in marketplace'));
    expect(marketplaceLink?.getAttribute('href')).toBe(
      'https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20community%2Fregistry-starter&type=code',
    );
  });

  it('surfaces the GitHub source link when sourceKind is github', async () => {
    await renderMenu(
      make({
        id: 'gh-with-link',
        sourceKind: 'github',
        source: 'github:owner/repo',
      }),
    );
    await openPopover();
    const items = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ) as HTMLElement[];
    expect(items.some((b) => b.textContent?.includes('Open source on GitHub'))).toBe(
      true,
    );
    const sourceLink = container.querySelector<HTMLAnchorElement>(
      'a.plugin-share-item[href="https://github.com/owner/repo"]',
    );
    expect(sourceLink).toBeTruthy();
  });

  it('surfaces the homepage link when manifest.homepage is set', async () => {
    await renderMenu(
      make({
        id: 'with-homepage',
        sourceKind: 'local',
        homepage: 'https://example.test/plugin-home',
      }),
    );
    await openPopover();
    const items = Array.from(
      container.querySelectorAll('.plugin-share-item'),
    ) as HTMLElement[];
    expect(items.some((b) => b.textContent?.includes('Open homepage'))).toBe(
      true,
    );
    const homepageLink = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a.plugin-share-item'),
    ).find((link) => link.textContent?.includes('Open homepage'));
    expect(homepageLink).toBeTruthy();
    expect(homepageLink?.getAttribute('href')).toBe('https://example.test/plugin-home');
  });

  it('renders official bundled repo links as anchors', async () => {
    await renderMenu(
      make({
        id: 'official-plugin',
        sourceKind: 'bundled',
        source: 'plugins/_official/scenarios/official-plugin',
      }),
    );
    await openPopover();
    const repoLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        'a.plugin-share-item[href="https://github.com/sanghyunna/readable-studio"]',
      ),
    );
    expect(repoLinks.length).toBeGreaterThan(0);
    expect(
      repoLinks.some((link) => link.textContent?.includes('Open source on GitHub')),
    ).toBe(true);
  });
});
