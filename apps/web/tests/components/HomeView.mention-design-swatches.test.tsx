// @vitest-environment jsdom

// The Hub 컨텍스트 picker listed design systems ("Anthropic", "Airtable", …) as
// bare text, so the user could not tell what any style looked like. Each
// design-system row now carries its system's REAL palette — the same
// `DesignSystemSummary.swatches` the daemon derives from the system's own
// tokens — as a small preview beside the name.
//
// Two behaviours are pinned here because both are load-bearing:
//   1. a design-system plugin whose system HAS a palette renders that
//      system's actual colors (not a synthetic hue, not a neighbour's), and
//   2. a design-system plugin whose system has NO usable palette falls back
//      to the name-only row — never an empty or black cluster.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary } from '@readable-studio/contracts';
import { HomeView } from '../../src/components/HomeView';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const AIRTABLE_PALETTE = ['#181d26', '#e0e2e6', '#1b61c9'];
// jsdom normalizes an inline hex background to `rgb()`. Derive the expectation
// from the fixture palette rather than hand-writing the channels, so the
// assertion still tracks the input if the fixture ever changes.
const AIRTABLE_PALETTE_RGB = AIRTABLE_PALETTE.map((hex) => {
  const [r, g, bl] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${bl})`;
});

// `readable.context.designSystem.ref` is the join key between a design-system
// plugin and its catalogue entry; `mode: 'design-system'` plus the bundled
// trust fields are what keep the record in the composer's plugin list.
function designSystemPlugin(id: string, title: string, ref: string) {
  return {
    id,
    title,
    version: '0.1.0',
    trust: 'bundled',
    sourceKind: 'bundled',
    source: `/tmp/${id}`,
    fsPath: `/tmp/${id}`,
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '0.1.0',
      description: `${title} design system.`,
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        mode: 'design-system',
        useCase: { query: `Generate a landing page using the ${title} design system.` },
        context: { designSystem: { ref, primary: true } },
      },
    },
  };
}

function designSystem(id: string, title: string, swatches?: string[]): DesignSystemSummary {
  return {
    id,
    title,
    category: 'Design & Creative',
    summary: `${title} bundled system.`,
    source: 'built-in',
    status: 'published',
    isEditable: false,
    ...(swatches ? { swatches } : {}),
  };
}

function stubContextFetch(plugins: unknown[]) {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/mcp/servers') {
      return new Response(JSON.stringify({ servers: [], templates: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Hub context picker design-system swatches', () => {
  it('renders a design system\'s own palette beside its name', async () => {
    stubContextFetch([designSystemPlugin('design-system-airtable', 'Airtable', 'airtable')]);

    render(
      <HomeView
        surface="hub"
        projects={[]}
        designSystems={[designSystem('airtable', 'Airtable', AIRTABLE_PALETTE)]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('@Airtable');

    const cluster = await screen.findByTestId(
      'home-hero-option-swatches-plugin-design-system-airtable',
    );

    // The fills must be Airtable's documented colors, in order. Deriving the
    // expectation from the fixture input (not from the rendered output) is
    // what makes this fail if the row ever falls back to a synthetic palette
    // or picks up a neighbouring system's colors.
    const fills = Array.from(cluster.children).map(
      (child) => (child as HTMLElement).style.background,
    );
    expect(fills).toEqual(AIRTABLE_PALETTE_RGB);

    // The name still carries the identity: the cluster is supplementary and
    // stays out of the accessibility tree rather than announcing hex codes.
    expect(cluster.getAttribute('aria-hidden')).toBe('true');
    const picker = screen.getByTestId('home-hero-plugin-picker');
    expect(within(picker).getByText('Airtable')).toBeTruthy();
  });

  it('falls back to the name-only row when a design system ships no usable palette', async () => {
    stubContextFetch([designSystemPlugin('design-system-blankly', 'Blankly', 'blankly')]);

    render(
      <HomeView
        surface="hub"
        projects={[]}
        designSystems={[designSystem('blankly', 'Blankly')]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('@Blankly');

    const picker = await screen.findByTestId('home-hero-plugin-picker');
    // The row itself must still be pickable — only the palette preview is gone.
    await waitFor(() => expect(within(picker).getByText('Blankly')).toBeTruthy());
    expect(
      screen.queryByTestId('home-hero-option-swatches-plugin-design-system-blankly'),
    ).toBeNull();
  });
});
