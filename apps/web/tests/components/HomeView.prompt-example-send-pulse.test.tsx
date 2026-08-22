// @vitest-environment jsdom

// Static prompt-example cards must show the Send cue too.
//
// When a chip has no example plugins, HomeHero falls back to static
// prompt-example cards (`home-hero-prompt-example`) handled entirely
// inside the component. Seeding the composer through that path must
// trigger the same send-button attention sheen as the HomeView-routed
// plugin Use / preset flows.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomeView } from '../../src/components/HomeView';
import type { PluginLoopSubmit } from '../../src/components/PluginLoopHome';
import { createPluginUseHandoff } from '../../src/components/home-hero/plugin-authoring';
import { I18nProvider } from '../../src/i18n';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import { setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const WEB_PROTOTYPE_PLUGIN = {
  id: 'example-web-prototype',
  title: 'Web Prototype',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/web-prototype',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/web-prototype',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'example-web-prototype',
    title: 'Web Prototype',
    version: '0.1.0',
    description: 'General-purpose desktop web prototype.',
    readable: { kind: 'scenario', taskKind: 'new-generation' },
  },
};

const REQUIRED_INPUT_PLUGIN = {
  ...WEB_PROTOTYPE_PLUGIN,
  id: 'needs-input',
  title: 'Needs input',
  manifest: {
    ...WEB_PROTOTYPE_PLUGIN.manifest,
    name: 'needs-input',
    title: 'Needs input',
    readable: {
      ...WEB_PROTOTYPE_PLUGIN.manifest.readable,
      useCase: { query: 'Create {{topic}}' },
      inputs: [{ name: 'topic', type: 'string', required: true, label: 'Topic' }],
    },
  },
};

const REQUIRED_INPUT_APPLY_RESULT = {
  query: 'Create {{topic}}',
  contextItems: [],
  inputs: REQUIRED_INPUT_PLUGIN.manifest.readable.inputs,
  assets: [],
  mcpServers: [],
  trust: 'trusted',
  capabilitiesGranted: [],
  capabilitiesRequired: [],
  projectMetadata: {},
  appliedPlugin: {
    snapshotId: 'snap-needs-input',
    pluginId: 'needs-input',
    pluginVersion: '0.1.0',
    manifestSourceDigest: 'b'.repeat(64),
    inputs: {},
    resolvedContext: { items: [] },
    capabilitiesGranted: [],
    capabilitiesRequired: [],
    assetsStaged: [],
    taskKind: 'new-generation',
    appliedAt: 0,
    mcpServers: [],
    status: 'fresh',
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.localStorage.clear();
});

describe('static prompt-example send pulse', () => {
  it('continues to an empty project without sending a prompt', async () => {
    writeHomeGuideStage('done');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const onSubmit = vi.fn(async (_payload: PluginLoopSubmit) => true);

    render(
      <I18nProvider initial="en">
        <HomeView
          projects={[]}
          onSubmit={onSubmit}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByTestId('home-hero-continue-without-prompt'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      prompt: '',
      attachments: [],
      autoSendFirstMessage: false,
    });
  });

  it('ignores typed prompt and preserves staged HTML while continuing once', async () => {
    writeHomeGuideStage('done');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const htmlFile = new File(['<h1>Preview</h1>'], 'index.html', { type: 'text/html' });
    let resolveSubmit: ((result: boolean) => void) | undefined;
    const pendingSubmit = new Promise<boolean>((resolve) => {
      resolveSubmit = resolve;
    });
    const onSubmit = vi.fn((_payload: PluginLoopSubmit) => pendingSubmit);

    render(
      <I18nProvider initial="en">
        <HomeView
          projects={[]}
          onSubmit={onSubmit}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
        />
      </I18nProvider>,
    );

    setHomeHeroPrompt('Do not send this prompt');
    fireEvent.change(screen.getByTestId('home-hero-file-input'), {
      target: { files: [htmlFile] },
    });
    const continueButton = await screen.findByTestId('home-hero-continue-without-prompt');
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      prompt: '',
      attachments: [htmlFile],
      autoSendFirstMessage: false,
    });
    resolveSubmit?.(true);
  });

  it('does not bind an incomplete active plugin to a blank project', async () => {
    writeHomeGuideStage('done');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [REQUIRED_INPUT_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/api/plugins/needs-input/apply')) {
        return new Response(JSON.stringify(REQUIRED_INPUT_APPLY_RESULT), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const onSubmit = vi.fn((_payload: PluginLoopSubmit) => true);

    render(
      <I18nProvider initial="en">
        <HomeView
          projects={[]}
          onSubmit={onSubmit}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
          promptHandoff={createPluginUseHandoff(1, 'needs-input')}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('home-hero-active-plugin')).toBeTruthy());
    fireEvent.click(await screen.findByTestId('home-hero-continue-without-prompt'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      prompt: '',
      autoSendFirstMessage: false,
    });
    expect(onSubmit.mock.calls[0]?.[0]?.pluginId).not.toBe('needs-input');
  });

  it('pulses the send button after clicking a fallback prompt-example card', async () => {
    // Keep the first-run guide quiet so the sheen we assert on is the
    // send button's, not the guide trail's.
    writeHomeGuideStage('done');
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    render(
      <I18nProvider initial="en">
        <HomeView
          projects={[]}
          onSubmit={() => undefined}
          onOpenProject={() => undefined}
          onViewAllProjects={() => undefined}
        />
      </I18nProvider>,
    );

    // The chip's default plugin exists (so the chip binds) but no plugin
    // matches the example filter → fallback static prompt-example cards.
    fireEvent.click(await screen.findByTestId('home-hero-rail-prototype'));
    const exampleCards = await screen.findAllByTestId('home-hero-prompt-example');
    const firstExample = exampleCards[0];
    if (!firstExample) throw new Error('expected at least one prompt-example card');

    const submit = screen.getByTestId('home-hero-submit');
    expect(submit.className).not.toContain('home-hero__attention-sheen');

    fireEvent.click(firstExample);
    await waitFor(() => {
      expect(submit.className).toContain('home-hero__attention-sheen');
    });
  });
});
