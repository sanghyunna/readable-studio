// @vitest-environment jsdom

// Hub template cards: picking a card no longer pastes the template brief into
// the composer. The brief is hidden behind a removable chip, the composer
// stays empty for the user's own words, and the sent prompt is still the
// brief followed by the user's text (so the agent receives the template).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPluginRecord } from '@readable-studio/contracts';

import { HomeView } from '../../src/components/HomeView';
import type { PluginLoopSubmit } from '../../src/components/PluginLoopHome';
import { I18nProvider } from '../../src/i18n';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';
import {
  composeTemplatePrompt,
  templatePromptBoundary,
  userTextFromTemplateMessage,
  visiblePromptForNaming,
} from '../../src/components/home-hero/templatePrompt';
import { homeHeroPromptText, setHomeHeroPrompt } from '../helpers/home-hero-lexical';

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

const DECK = catalogueRecord('guizang-ppt');
const DECK_B = catalogueRecord('deck-swiss-international');

const APPLY_RESULT = {
  query: '',
  contextItems: [],
  inputs: [],
  assets: [],
  mcpServers: [],
  trust: 'trusted',
  capabilitiesGranted: [],
  capabilitiesRequired: [],
  projectMetadata: {},
  appliedPlugin: {
    snapshotId: 'snap-deck',
    pluginId: DECK.id,
    pluginVersion: DECK.version,
    manifestSourceDigest: 'a'.repeat(64),
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

function renderHub() {
  writeHomeGuideStage('done');
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (typeof url === 'string' && url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: [DECK, DECK_B] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (typeof url === 'string' && url === `/api/plugins/${encodeURIComponent(DECK.id)}/apply`) {
      return new Response(JSON.stringify(APPLY_RESULT), {
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
        surface="hub"
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />
    </I18nProvider>,
  );
  return { onSubmit };
}

function deckCard(id: string = DECK.id): HTMLButtonElement {
  return screen.getAllByTestId('hub-template-card')
    .find((node) => node.getAttribute('data-plugin-id') === id) as HTMLButtonElement;
}

function expectCardSelected(card: HTMLButtonElement, selected: boolean) {
  expect(card.getAttribute('aria-pressed')).toBe(selected ? 'true' : 'false');
  expect(card.classList.contains('is-active')).toBe(selected);
  const check = card.parentElement!.querySelector('[data-testid="hub-template-check"]')!;
  expect(check.getAttribute('data-active')).toBe(selected ? 'true' : 'false');
  expect(check.classList.contains('is-on')).toBe(selected);
}

async function pickDeckCard() {
  await screen.findAllByTestId('hub-template-card');
  fireEvent.click(deckCard());
  return screen.findByTestId('home-hero-template-chip');
}

describe('Hub template chip', () => {
  it('shows a chip instead of the brief and sends brief + user text', async () => {
    const { onSubmit } = renderHub();
    const chip = await pickDeckCard();
    expect(chip.textContent).toContain(DECK.title);
    expect(homeHeroPromptText().trim()).toBe('');

    setHomeHeroPrompt('write me a slide deck to explain the transformer architecture');
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.prompt.endsWith('\n\nwrite me a slide deck to explain the transformer architecture')).toBe(true);
    expect(payload.prompt.length).toBeGreaterThan(
      'write me a slide deck to explain the transformer architecture'.length + 2,
    );
    expect(payload.templateRef).toEqual({
      id: DECK.id,
      name: DECK.title,
      boundary: payload.prompt.indexOf('write me a slide deck'),
    });
    expect(userTextFromTemplateMessage(payload.prompt, payload.templateRef)).toBe(
      'write me a slide deck to explain the transformer architecture',
    );
    expect(screen.queryByTestId('home-hero-template-chip')).toBeNull();
  });

  it('sends the chip alone when the user typed nothing', async () => {
    const { onSubmit } = renderHub();
    await pickDeckCard();
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.prompt.length).toBeGreaterThan(0);
    expect(payload.templateRef?.boundary).toBe(payload.prompt.length);
    expect(userTextFromTemplateMessage(payload.prompt, payload.templateRef)).toBe('');
  });

  it('removing the chip drops the hidden brief but keeps the user text', async () => {
    const { onSubmit } = renderHub();
    await pickDeckCard();
    setHomeHeroPrompt('explain the transformer architecture');
    fireEvent.click(screen.getByTestId('home-hero-template-chip-remove'));
    expect(screen.queryByTestId('home-hero-template-chip')).toBeNull();
    expect(homeHeroPromptText().trim()).toBe('explain the transformer architecture');

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      prompt: 'explain the transformer architecture',
      templateRef: null,
    });
  });

  it('clicking the selected card again deselects it: chip gone, card unpressed, typed text kept', async () => {
    const { onSubmit } = renderHub();
    await pickDeckCard();
    expectCardSelected(deckCard(), true);
    setHomeHeroPrompt('explain the transformer architecture');

    fireEvent.click(deckCard());
    await waitFor(() => expect(screen.queryByTestId('home-hero-template-chip')).toBeNull());
    expectCardSelected(deckCard(), false);
    expect(homeHeroPromptText().trim()).toBe('explain the transformer architecture');

    fireEvent.click(screen.getByTestId('home-hero-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      prompt: 'explain the transformer architecture',
      templateRef: null,
    });
  });

  it('clicking a different card switches the selection instead of clearing it', async () => {
    renderHub();
    await pickDeckCard();
    fireEvent.click(deckCard(DECK_B.id));
    // Swapping one bound template for another goes through the existing
    // replacement confirmation; confirming it completes the switch.
    fireEvent.click(document.querySelector('.home-hero-confirm__primary')!);
    await waitFor(() => expectCardSelected(deckCard(DECK_B.id), true));
    expectCardSelected(deckCard(), false);
    expect(screen.getByTestId('home-hero-template-chip').textContent).toContain(DECK_B.title);
  });

  it('removing the chip via its (x) also deselects the card', async () => {
    renderHub();
    await pickDeckCard();
    expectCardSelected(deckCard(), true);
    fireEvent.click(screen.getByTestId('home-hero-template-chip-remove'));
    await waitFor(() => expect(screen.queryByTestId('home-hero-template-chip')).toBeNull());
    expectCardSelected(deckCard(), false);
  });
});

describe('template prompt split helpers', () => {
  it.each(['이번 분기 실적을 한국어로 정리해 주세요.', ''])('names template submissions without the hidden brief (%s)', (typed) => {
    const brief = 'Hidden template instructions';
    const prompt = composeTemplatePrompt(brief, typed);
    const ref = { id: 'report', name: '보고서', boundary: templatePromptBoundary(brief, typed) };
    expect(visiblePromptForNaming(prompt, ref)).toBe(typed || ref.name);
  });

  it('preserves legacy naming and does not expose a brief with an invalid boundary', () => {
    expect(visiblePromptForNaming('Create a landing page', undefined)).toBe('Create a landing page');
    expect(visiblePromptForNaming('Hidden brief', { id: 'report', name: '보고서', boundary: 99 })).toBe('보고서');
  });
  it('composes brief + user text and locates the boundary', () => {
    const prompt = composeTemplatePrompt('BRIEF', '  hello  ');
    expect(prompt).toBe('BRIEF\n\nhello');
    expect(templatePromptBoundary('BRIEF', '  hello  ')).toBe(prompt.indexOf('hello'));
    expect(composeTemplatePrompt('BRIEF', '   ')).toBe('BRIEF');
    expect(templatePromptBoundary('BRIEF', '')).toBe(5);
  });

  it('leaves messages without a ref, or with a ref that does not fit, untouched', () => {
    expect(userTextFromTemplateMessage('old message', undefined)).toBeNull();
    expect(userTextFromTemplateMessage('old message', null)).toBeNull();
    expect(userTextFromTemplateMessage('short', { id: 'x', name: 'X', boundary: 99 })).toBeNull();
    expect(userTextFromTemplateMessage('short', { id: 'x', name: 'X', boundary: -1 })).toBeNull();
  });
});
