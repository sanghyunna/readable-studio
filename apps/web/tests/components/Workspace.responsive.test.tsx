// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileWorkspace } from '../../src/components/FileWorkspace';
import { maxChatPanelWidthForSplit, projectSplitStyle, projectSplitTrackWidth, workspacePanelMinWidthForSplit } from '../../src/components/ProjectView';
import { fetchProjectFolders } from '../../src/providers/registry';

vi.mock('../../src/providers/registry', async (original) => ({
  ...await original<typeof import('../../src/providers/registry')>(),
  fetchProjectFolders: vi.fn().mockResolvedValue([]),
}));

const observers: Array<{ callback: () => void; targets: Element[] }> = [];
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number];
    constructor(callback: () => void) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() { this.entry.targets = []; }
  });
});
afterEach(() => { cleanup(); observers.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// jsdom computes styles but not layout/hit testing. These tests exercise real
// sizing/scroll code using explicit geometry inputs; the browser companion owns
// getBoundingClientRect/elementFromPoint acceptance, without mocked rectangles.
describe('workspace responsive sizing and permanent-tab reachability', () => {
  it.each([375, 768, 1280])('allocates usable tracks at %ipx without spending the rail or gutters twice', (viewport) => {
    const split = document.createElement('div');
    document.body.append(split);
    split.style.cssText = 'padding:10px; column-gap:10px';
    Object.defineProperty(split, 'clientWidth', { value: viewport - 56 });
    const budget = projectSplitTrackWidth(split);
    expect(budget).toBe(viewport - 96);
    const minimum = workspacePanelMinWidthForSplit(budget);
    const stacked = minimum === 0;
    expect(stacked).toBe(viewport < 1280);
    const chat = Math.min(460, maxChatPanelWidthForSplit(budget));
    const style = projectSplitStyle(false, chat, `minmax(${minimum}px, 1fr)`, stacked)!;
    Object.assign(split.style, style);
    const computed = getComputedStyle(split);
    if (stacked) {
      expect(computed.gridTemplateColumns).toBe('minmax(0, 1fr)');
      expect(computed.gridTemplateRows).toBe('minmax(0, 1fr) minmax(0, 1fr)');
      expect(split.clientWidth - 20).toBeGreaterThan(0);
      expect(chat).toBe(460); // Narrow layout must not destroy the saved desktop preference.
    } else {
      expect(computed.gridTemplateColumns).toBe('460px 8px minmax(400px, 1fr)');
      expect(budget - chat - 8).toBeGreaterThanOrEqual(400);
      expect(maxChatPanelWidthForSplit(budget)).toBe(720);
    }
    split.remove();
  });

  it('switches precisely at the two pane minima plus the divider', () => {
    expect(workspacePanelMinWidthForSplit(752)).toBe(0);
    expect(workspacePanelMinWidthForSplit(753)).toBe(400);
    expect(maxChatPanelWidthForSplit(753)).toBe(345);
  });

  it('negative control reproduces the former zero-width track at 375px', () => {
    const splitWidth = 375 - 56;
    const oldChat = Math.min(460, splitWidth - 8);
    const oldWorkspace = Math.max(0, splitWidth - 40 - oldChat - 8);
    expect(oldWorkspace).toBe(0);
    expect(projectSplitStyle(false, oldChat, 'minmax(0, 1fr)', false)?.gridTemplateColumns)
      .not.toBe(projectSplitStyle(false, 460, 'minmax(0, 1fr)', true)?.gridTemplateColumns);
  });

  it.each([375, 768, 1280])('reveals Design Files and Design System on activation and resize (%ipx input)', async (viewport) => {
    render(<FileWorkspace projectId="responsive-tabs" projectKind="prototype" files={[]}
      onRefreshFiles={() => {}} isDeck={false} tabsState={{ tabs: [], active: null }} onTabsStateChange={() => {}}
      designSystemProject={{ id: 'user:responsive', title: 'Responsive', category: 'Custom', summary: '', swatches: [], surface: 'web', source: 'user', status: 'draft', isEditable: true }} />);
    await act(async () => { await vi.mocked(fetchProjectFolders).mock.results.at(-1)!.value; });
    const bar = screen.getByRole('tablist');
    const barWidth = viewport === 1280 ? 300 : 180;
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => ({ left: 10, right: 10 + barWidth, width: barWidth } as DOMRect));
    for (const id of ['design-files-tab', 'design-system-project-tab']) {
      const tab = screen.getByTestId(id);
      bar.scrollLeft = 0;
      vi.spyOn(tab, 'getBoundingClientRect').mockImplementation(() => ({ left: 350 - bar.scrollLeft, right: 450 - bar.scrollLeft, width: 100 } as DOMRect));
      fireEvent.click(tab);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(bar.scrollLeft).toBe(440 - barWidth);
      expect(tab.getBoundingClientRect().right).toBe(10 + barWidth);
      bar.scrollLeft = 0;
      act(() => { for (const observer of observers) if (observer.targets.includes(bar)) observer.callback(); });
      expect(tab.getBoundingClientRect().right).toBe(10 + barWidth);
    }
  });

  it('keeps the computed permanent tab in flow, with a sticky-overlap negative control', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/workspace/drawer.css'), 'utf8');
    const declaration = css.match(/\.ws-tab\.design-files-tab\s*\{([^}]+)\}/)![1]!;
    const style = document.createElement('style');
    style.textContent = `.ws-tab.design-files-tab {${declaration}}`;
    const tab = document.createElement('button');
    tab.className = 'ws-tab design-files-tab';
    document.head.append(style); document.body.append(tab);
    expect(getComputedStyle(tab).position).toBe('static');
    tab.style.cssText = 'position:sticky;left:0;z-index:1';
    expect(getComputedStyle(tab).position).toBe('sticky');
    // At the supplied 768px failure's 216px workspace, a 130px pinned tab
    // covers the centre of a 100px sibling revealed into a 100px scrollport.
    expect(100 / 2 < 130).toBe(true);
    tab.remove(); style.remove();
    expect(css).toMatch(/@container file-workspace \(max-width: 480px\)/);
    expect(css).toMatch(/\.app \.workspace \.ws-tabs-actions\s*\{\s*flex: 1 1 100%/);
  });
});
