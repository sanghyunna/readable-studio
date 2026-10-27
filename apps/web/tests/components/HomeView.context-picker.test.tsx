// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $createTextNode, $getRoot, $isElementNode, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import {
  DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
  type InstalledPluginRecord,
  type McpServerConfig,
  type SkillSummary,
} from '@readable-studio/contracts';
import { HomeView } from '../../src/components/HomeView';
import { getHomeHeroEditor, homeHeroPromptText, setHomeHeroPrompt } from '../helpers/home-hero-lexical';

// HomeHero's prompt input migrated from a <textarea>+highlight overlay to the
// same Lexical contenteditable the project composer uses. The `home-hero-input`
// hook is now a contenteditable <div> with no `.value`, so:
//   - driving text uses `setHomeHeroPrompt(...)` (a real `editor.update`) where
//     the old tests did `fireEvent.change(input, { target: { value } })`.
//   - reading text uses `homeHeroPromptText()` where they read `input.value`.
// Picking from the @-picker still inserts an atomic mention PILL whose literal
// text is `@<token>` without adding whitespace the user did not type.

// Settle the Lexical update listener's onChange/onTrigger React state updates
// (they flush a microtask after the discrete editor update) before asserting,
// mirroring the project composer's `typeAndSettle`.
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const SKILL: SkillSummary = {
  id: 'prototype-lab',
  name: 'Prototype Lab',
  description: 'Create a focused prototype.',
  triggers: ['prototype', 'flow'],
  mode: 'prototype',
  previewType: 'html',
  designSystemRequired: false,
  defaultFor: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Design a focused onboarding prototype.',
  aggregatesExamples: false,
};

const DECK_SKILL: SkillSummary = {
  ...SKILL,
  id: 'deck-lab',
  name: 'Deck Lab',
  description: 'Create a focused slide deck.',
  triggers: ['deck', 'slides'],
  mode: 'deck',
  examplePrompt: 'Design a focused investor deck.',
};

const WEB_PROTOTYPE_PLUGIN = makePlugin('example-web-prototype', 'Web Prototype');
const MCP_SERVER: McpServerConfig = {
  id: 'linear',
  label: 'Linear',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
};

function makePlugin(
  id: string,
  title: string,
  visualCharacteristics = ['dark and light sections alternate with a fullscreen hero'],
): InstalledPluginRecord {
  return {
    id,
    title,
    version: '1.0.0',
    sourceKind: 'bundled',
    source: `/tmp/${id}`,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '1.0.0',
      description: `${title} fixture`,
      tags: ['fixture'],
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        visualReference: {
          characteristics: visualCharacteristics,
        },
        useCase: {
          query: `Hydrated query from ${title}`,
        },
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomeView context picker', () => {
  it('stages pasted files on Home and submits them as first-turn context', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();
    const file = new File(['brief'], 'brief.pdf', { type: 'application/pdf' });

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    fireEvent.click(screen.getByTestId('home-hero-plus-trigger'));
    expect(screen.getByTestId('composer-plus-attach')).toBeTruthy();
    // Lexical's PastePlugin reads `clipboardData.files` (the old textarea path
    // read `clipboardData.items[].getAsFile()`); the staged-file outcome is
    // identical, only the clipboard shape the handler inspects changed.
    fireEvent.paste(input, {
      clipboardData: {
        files: [file],
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '',
      pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
      attachments: [file],
    }));
  });

  it('adds multiple @ plugins as context without applying or hydrating their query', async () => {
    const plugins = [
      makePlugin('example-acreage-farming', 'Acreage — Precision Farming'),
      makePlugin('deck-plugin', 'Deck Plugin', ['animated statistics grid with a masked logo marquee']),
    ];
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('Build @acreage');
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: /acreage/i }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));

    // Picking inserts an atomic plugin mention pill (`@Chart Plugin`) and stages
    // the plugin as context in HomeView state. The
    // inline pill is now the only on-screen representation of the staged context
    // (the duplicate top context-badge row was removed), so the submit payload
    // below is the authoritative check that the plugin was staged.
    await waitFor(() => {
      expect(homeHeroPromptText().trim()).toBe('Build @Acreage — Precision Farming');
    });

    // Continue typing after the first confirmed pill. Replacing the whole tree
    // with plain text would correctly discard that confirmed selection.
    act(() => getHomeHeroEditor().update(() => {
      const paragraph = $getRoot().getLastChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const text = $createTextNode(' @deck');
      paragraph.append(text);
      text.selectEnd();
    }, { discrete: true }));
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: /deck plugin/i }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));

    await waitFor(() => {
      expect(homeHeroPromptText().trim()).toBe('Build @Acreage — Precision Farming @Deck Plugin');
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply'))).toBe(false);
    expect(homeHeroPromptText()).not.toContain('Hydrated query');

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Build',
      pluginInputs: { prompt: 'Build' },
      pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
      visualReferences: [
        { characteristics: ['dark and light sections alternate with a fullscreen hero'] },
        { characteristics: ['animated statistics grid with a masked logo marquee'] },
      ],
    }));
    const payload = onSubmit.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty('contextPlugins');
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('fullscreen hero');
    expect(serialized).toContain('statistics grid');
    expect(serialized).not.toMatch(/Acreage|precision.farming|agriculture|agritech|acre|crop|field|soil|yield/i);
    expect(serialized).not.toContain('example-acreage-farming');
  });

  it.each(['plugin', 'skill', 'mcp'] as const)('reconciles confirmed %s context through Undo and Redo', async (kind) => {
    const plugin = makePlugin('sample-plugin', 'Sample Plugin');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return new Response(JSON.stringify({ plugins: [plugin] }));
      if (url === '/api/mcp/servers') return new Response(JSON.stringify({ servers: [MCP_SERVER], templates: [] }));
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const onSubmit = vi.fn(() => false);
    render(<HomeView projects={[]} skills={[SKILL]} onSubmit={onSubmit} onOpenProject={vi.fn()} onViewAllProjects={vi.fn()} />);
    await screen.findByTestId('home-hero-input');
    const name = kind === 'plugin' ? 'Sample Plugin' : kind === 'skill' ? 'Prototype Lab' : 'Linear';
    setHomeHeroPrompt(`Use @${name}`);
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));
    await settle();
    expect(screen.getByTestId('home-hero-input').querySelector(`[data-mention-kind="${kind}"]`)).toBeTruthy();

    act(() => { getHomeHeroEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await settle();
    expect(screen.getByTestId('home-hero-input').querySelector(`[data-mention-kind="${kind}"]`)).toBeNull();
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await settle();
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: `Use @${name}`, skillId: null, visualReferences: [], contextMcpServers: [],
    }));

    act(() => { getHomeHeroEditor().dispatchCommand(REDO_COMMAND, undefined); });
    await settle();
    expect(screen.getByTestId('home-hero-input').querySelector(`[data-mention-kind="${kind}"]`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await settle();
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      skillId: kind === 'skill' ? SKILL.id : null,
      visualReferences: kind === 'plugin' ? [{ characteristics: ['dark and light sections alternate with a fullscreen hero'] }] : [],
      contextMcpServers: kind === 'mcp' ? [expect.objectContaining({ id: MCP_SERVER.id })] : [],
    }));
  });

  it.each(['skill', 'template'] as const)('keeps a newly selected %s before an older skill as the single default after typing', async (kind) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return Response.json({ plugins: [] });
      if (url === '/api/mcp/servers') return Response.json({ servers: [], templates: [] });
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const onSubmit = vi.fn(() => false);
    render(<HomeView projects={[]} skills={[SKILL, DECK_SKILL]}
      designTemplates={kind === 'template' ? [DECK_SKILL] : []}
      onSubmit={onSubmit} onOpenProject={vi.fn()} onViewAllProjects={vi.fn()} />);
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('Make this with @Prototype Lab');
    await settle();
    fireEvent.click(await screen.findByTestId('mention-preview-use'));
    await settle();

    act(() => getHomeHeroEditor().update(() => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const query = $createTextNode('@Deck Lab ');
      paragraph.getFirstChild()!.insertBefore(query);
      query.select('@Deck Lab'.length, '@Deck Lab'.length);
    }, { discrete: true }));
    await settle();
    fireEvent.click(await screen.findByTestId('mention-preview-use'));
    await settle();
    expect(screen.getByTestId('home-hero-active-skill').textContent).toContain('Deck Lab');

    act(() => { getHomeHeroEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await settle();
    expect(screen.getByTestId('home-hero-active-skill').textContent).toContain('Prototype Lab');
    expect(screen.getByTestId('home-hero-input').querySelectorAll('[data-mention-kind="skill"]')).toHaveLength(1);
    act(() => { getHomeHeroEditor().dispatchCommand(REDO_COMMAND, undefined); });
    await settle();
    expect(screen.getByTestId('home-hero-active-skill').textContent).toContain('Deck Lab');
    expect(screen.getByTestId('home-hero-input').querySelectorAll('[data-mention-kind="skill"]')).toHaveLength(1);

    act(() => getHomeHeroEditor().update(() => {
      const paragraph = $getRoot().getLastChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const text = $createTextNode('continue');
      paragraph.append(text);
      text.selectEnd();
    }, { discrete: true }));
    await settle();
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await settle();
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: DECK_SKILL.id }));
    expect(screen.getByTestId('home-hero-input').querySelectorAll('[data-mention-kind="skill"]')).toHaveLength(1);
    expect(homeHeroPromptText()).not.toContain('@Prototype Lab');
  });

  it('removes the confirmed skill atom with the header clear action so typing cannot restore it', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return Response.json({ plugins: [] });
      if (url === '/api/mcp/servers') return Response.json({ servers: [], templates: [] });
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    const onSubmit = vi.fn(() => false);
    render(<HomeView projects={[]} skills={[SKILL]} onSubmit={onSubmit} onOpenProject={vi.fn()} onViewAllProjects={vi.fn()} />);
    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('Use @Prototype Lab');
    await settle();
    fireEvent.click(await screen.findByTestId('mention-preview-use'));
    await settle();
    fireEvent.click(within(screen.getByTestId('home-hero-active-skill')).getByRole('button'));
    await settle();
    expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    act(() => { getHomeHeroEditor().dispatchCommand(UNDO_COMMAND, undefined); });
    await settle();
    expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
    expect(screen.getByTestId('home-hero-input').querySelector('[data-mention-kind="skill"]')).toBeTruthy();
    act(() => { getHomeHeroEditor().dispatchCommand(REDO_COMMAND, undefined); });
    await settle();
    expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    expect(screen.getByTestId('home-hero-input').querySelector('[data-mention-kind="skill"]')).toBeNull();
    act(() => getHomeHeroEditor().update(() => {
      const paragraph = $getRoot().getLastChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const text = $createTextNode('continue');
      paragraph.append(text);
      text.selectEnd();
    }, { discrete: true }));
    await settle();
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await settle();
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: null }));
    expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    expect(screen.getByTestId('home-hero-input').querySelector('[data-mention-kind="skill"]')).toBeNull();
  });

  it('does not confirm an unfinished skill search when removing a mentioned file', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/plugins') return Response.json({ plugins: [] });
      if (url === '/api/mcp/servers') return Response.json({ servers: [], templates: [] });
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
    render(<HomeView projects={[]} skills={[SKILL]} onSubmit={vi.fn()} onOpenProject={vi.fn()} onViewAllProjects={vi.fn()} />);
    const input = await screen.findByTestId('home-hero-input');
    const file = new File(['# Brief'], 'brief.md', { type: 'text/markdown' });
    fireEvent.paste(input, { clipboardData: { files: [file], items: [{ kind: 'file', getAsFile: () => file }] } });
    await settle();
    setHomeHeroPrompt('Use @brief.md');
    await settle();
    fireEvent.click(await screen.findByTestId('mention-preview-use'));
    await settle();
    act(() => getHomeHeroEditor().update(() => {
      const paragraph = $getRoot().getLastChild();
      if (!$isElementNode(paragraph)) throw new Error('Missing composer paragraph');
      const text = $createTextNode(' @Prototype Lab');
      paragraph.append(text);
      text.selectEnd();
    }, { discrete: true }));
    await settle();
    expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove brief.md'));
    await settle();
    expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    expect(input.querySelector('[data-mention-kind="skill"]')).toBeNull();
    expect(homeHeroPromptText()).toContain('@Prototype Lab');
  });

  it('binds a selected home skill to the created project payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('@proto');
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: /prototype lab/i }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));

    await waitFor(() => {
      expect(homeHeroPromptText().trim()).toBe('@Prototype Lab');
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '@Prototype Lab',
      pluginId: null,
      skillId: SKILL.id,
      projectKind: 'prototype',
    }));
  });

  it('clears an active type chip when the user picks a skill (#2972)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[DECK_SKILL, SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByTestId('home-hero-rail-prototype'));
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-type-chip').textContent).toContain('Prototype');
    });

    screen.getByTestId('home-hero-input');
    setHomeHeroPrompt('@deck');
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: /deck lab/i }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
      expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: null,
      skillId: DECK_SKILL.id,
      projectKind: 'deck',
    }));
    expect(onSubmit.mock.calls[0]?.[0]?.pluginId).not.toBe('example-web-prototype');
  });

  it('clears an active skill when the user picks a type chip (#2972)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply')) {
        return new Response(JSON.stringify({
          appliedPlugin: {
            snapshotId: 'snap-web-prototype',
            pluginId: 'example-web-prototype',
            pluginVersion: '1.0.0',
            inputs: {},
          },
          contextItems: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await screen.findByTestId('home-hero-input');
    setHomeHeroPrompt('@proto');
    await settle();
    fireEvent.click(await screen.findByRole('option', { name: /prototype lab/i }));
    fireEvent.click(screen.getByTestId('mention-preview-use'));
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
    });

    fireEvent.click(await screen.findByTestId('home-hero-rail-prototype'));
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-type-chip').textContent).toContain('Prototype');
      expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    });

    setHomeHeroPrompt('Build a pricing-page prototype.');
    await settle();
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      skillId: null,
      projectKind: 'prototype',
    })));
  });

});
