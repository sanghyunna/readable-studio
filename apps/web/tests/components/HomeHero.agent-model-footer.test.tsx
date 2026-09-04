// @vitest-environment jsdom

/**
 * Footer contract for the Hub composer: agent icon -> model name -> send.
 *
 * The agent/model control itself is authored by InlineModelSwitcher and reaches
 * HomeHero as an opaque `executionSwitcher` node, so these tests pin the part
 * HomeHero actually owns: that the node is mounted in the right slot, in the
 * right order relative to Send, and carries the marker class the footer CSS
 * keys off. Presentation (chevron suppressed, model name as label) is asserted
 * against the stylesheet in tests/styles/home-hero-agent-model-control.test.ts.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomeHero } from '../../src/components/HomeHero';

afterEach(cleanup);

function renderHub(executionSwitcher?: React.ReactNode) {
  return render(
    <div className="home-view--hub">
      <HomeHero
        surface="hub"
        prompt=""
        onPromptChange={vi.fn()}
        onSubmit={vi.fn()}
        activePluginTitle={null}
        activeChipId={null}
        onClearActivePlugin={vi.fn()}
        pluginOptions={[]}
        pluginsLoading={false}
        pendingPluginId={null}
        pendingChipId={null}
        onPickPlugin={vi.fn()}
        onPickChip={vi.fn()}
        contextItemCount={0}
        error={null}
        selectedPluginContexts={[]}
        selectedMcpContexts={[]}
        mcpOptions={[]}
        designSystems={[]}
        {...(executionSwitcher ? { executionSwitcher } : {})}
      />
    </div>,
  );
}

describe('Hub composer footer: agent + model slot', () => {
  it('mounts the agent/model control and orders it before Send', async () => {
    renderHub(<button type="button" data-testid="stub-switcher">switcher</button>);

    await screen.findByTestId('home-hero-input');
    const slot = screen.getByTestId('home-hero-agent-model');
    const send = screen.getByTestId('home-hero-submit');

    // The switcher is really inside the slot, not merely present somewhere.
    expect(slot.querySelector('[data-testid="stub-switcher"]')).not.toBeNull();
    // Agent/model precedes Send in document order, so Send stays last.
    expect(slot.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    // Marker class the footer stylesheet keys off to drop the chevron and
    // promote the model name.
    expect(slot.className).toContain('home-hero__execution-switcher--agent-model');
  });

  it('omits the slot entirely when no switcher is supplied', async () => {
    renderHub();

    await screen.findByTestId('home-hero-input');
    expect(screen.queryByTestId('home-hero-agent-model')).toBeNull();
    // Send survives regardless.
    expect(screen.getByTestId('home-hero-submit')).toBeTruthy();
  });

  it('no longer renders the template control on the hub surface', async () => {
    renderHub();

    await screen.findByTestId('home-hero-input');
    expect(screen.queryByTestId('home-hero-template-control')).toBeNull();
    // Context control is untouched capability.
    expect(screen.getByTestId('home-hero-context-control')).toBeTruthy();
  });

  it('has no session-mode chip in the composer footer', async () => {
    renderHub(
      <>
        <button type="button" data-testid="stub-agent">agent</button>
        <button type="button" data-testid="stub-model">model</button>
      </>,
    );

    await screen.findByTestId('home-hero-input');
    // Mode is a creation-time choice now; it lives in the New Project flow.
    expect(screen.queryByTestId('session-mode-trigger')).toBeNull();
  });

  it('renders agent then model then send, as three distinct controls', async () => {
    renderHub(
      <>
        <button type="button" data-testid="stub-agent">agent</button>
        <button type="button" data-testid="stub-model">model</button>
      </>,
    );

    await screen.findByTestId('home-hero-input');
    const agent = screen.getByTestId('stub-agent');
    const model = screen.getByTestId('stub-model');
    const send = screen.getByTestId('home-hero-submit');

    // Three separate elements, none nested inside another.
    expect(agent).not.toBe(model);
    expect(agent.contains(model)).toBe(false);
    // Left-to-right: agent -> model -> send.
    expect(agent.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('omits the subtitle node entirely on the hub surface', async () => {
    const { container } = renderHub();

    await screen.findByTestId('home-hero-input');
    // Not merely emptied or visually collapsed - the element must be absent so
    // it leaves no orphaned box or margin behind the title.
    expect(container.querySelector('.home-hero__subtitle')).toBeNull();
    // The title survives as the hero's single line of copy.
    expect(container.querySelector('.home-hero__title')).not.toBeNull();
  });

  it('keeps the subtitle on the non-hub surface', async () => {
    const { container } = render(
      <HomeHero
        prompt=""
        onPromptChange={vi.fn()}
        onSubmit={vi.fn()}
        activePluginTitle={null}
        activeChipId={null}
        onClearActivePlugin={vi.fn()}
        pluginOptions={[]}
        pluginsLoading={false}
        pendingPluginId={null}
        pendingChipId={null}
        onPickPlugin={vi.fn()}
        onPickChip={vi.fn()}
        contextItemCount={0}
        error={null}
        selectedPluginContexts={[]}
        selectedMcpContexts={[]}
        mcpOptions={[]}
        designSystems={[]}
      />,
    );

    await screen.findByTestId('home-hero-input');
    const subtitle = container.querySelector('.home-hero__subtitle');
    expect(subtitle).not.toBeNull();
    expect(subtitle?.textContent?.trim()).not.toBe('');
  });
});
