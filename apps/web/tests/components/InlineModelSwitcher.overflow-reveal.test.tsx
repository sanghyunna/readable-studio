// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({ fetchProviderModels: vi.fn() }));

const SHORT_LABEL = 'GPT-5.6-Sol';
const MEDIUM_LABEL = 'GPT-5.6-Terra';
const LONG_LABEL = 'GPT-5.3-Codex-Spark-Extended-Preview';
const agent: AgentInfo = {
  id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '0.133.0',
  models: [
    { id: 'sol', label: SHORT_LABEL },
    { id: 'terra', label: MEDIUM_LABEL },
    { id: 'spark', label: LONG_LABEL },
  ],
  reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
};
const config: AppConfig = {
  mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', apiVersion: '',
  baseUrl: 'https://api.anthropic.com', model: 'sol',
  apiProviderBaseUrl: 'https://api.anthropic.com', apiProtocolConfigs: {},
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: { codex: { model: 'sol' } }, agentCliEnv: {},
};

// These are the sizing/option sheets in app/layout.tsx import order. The
// imported-cascade test separately covers the entire stylesheet graph.
const readStyle = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = [
  'tokens.css', 'base.css', 'primitives.css', 'chat.css',
  'home/entry-layout.css', 'home/home-hero.css',
].map((path) => readStyle(`../../src/styles/${path}`)).join('\n');
type Motion = 'reduce' | 'no-preference';
const styles = (el: Element) => window.getComputedStyle(el);
const px = (value: string) => Number.parseFloat(value) || 0;
function child(el: Element, selector: string): HTMLElement {
  const result = el.querySelector<HTMLElement>(selector);
  if (!result) throw new Error(`Missing ${selector}`);
  return result;
}
function labelOf(modelId: string): HTMLElement {
  return child(screen.getByTestId(`inline-model-switcher-model-option-${modelId}`),
    '.inline-switcher__model-option-label');
}
function textOf(label: HTMLElement): HTMLElement {
  return child(label, '.inline-switcher__model-option-label-text');
}

const restorers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const restore of restorers.splice(0).reverse()) restore();
  vi.unstubAllGlobals();
});

function installStyles(motion: Motion) {
  const root = postcss.parse(css);
  root.walkAtRules('media', (rule) => {
    if (rule.params === `(prefers-reduced-motion: ${motion})`) rule.replaceWith(rule.nodes!);
    else rule.remove();
  });
  root.walkAtRules('container', (rule) => { rule.remove(); });
  root.walkAtRules('keyframes', (rule) => { rule.remove(); });
  root.walkRules((rule) => {
    // Retain real declarations/cascade, without unrelated application styles
    // making every jsdom geometry read needlessly expensive.
    if (!/inline-switcher|:root|^\*$|^button\b/.test(rule.selector)) rule.remove();
    else rule.selector = rule.selector.replace(/:hover\b/g, '[data-test-hover]');
  });
  // jsdom drops a border shorthand containing var() instead of substituting
  // its color token, losing the 1px edges. Resolve only that CSSOM limitation.
  let borderColor = '';
  root.walkRules(':root', (rule) => {
    rule.walkDecls('--border', (decl) => { borderColor = decl.value; });
  });
  root.walkDecls('border', (decl) => {
    decl.value = decl.value.replace(/var\(--border\)/g, borderColor);
  });
  const style = document.createElement('style');
  style.textContent = root.toString();
  document.head.append(style);
  restorers.push(() => style.remove());
}

/**
 * jsdom has no layout engine. Model the actual one-column grid + flex row using
 * the mounted elements' computed sizing, not a hard-coded 139px label box.
 * The reported browser case has 501px intrinsic text inside a 174px list.
 * An implicit auto grid track + an auto-minimum button must reproduce the
 * broken 538px row / 501px label, rather than magically giving it a clip box.
 * Only the text has intrinsic metrics; wrapper scrollWidth also changes after
 * translation, so measuring that wrapper cannot pass the resize regression.
 */
function installGeometry() {
  const intrinsicOverrides = new WeakMap<HTMLElement, number>();
  const intrinsic = (el: HTMLElement) => intrinsicOverrides.get(el)
    ?? (el.textContent === LONG_LABEL ? 501 : (el.textContent ?? '').length * 7);
  function geometry(label: HTMLElement) {
    const option = label.parentElement!;
    const list = option.parentElement!;
    const panel = list.parentElement!;
    const panelStyle = styles(panel);
    const panelWidth = px(panelStyle.width.replace(/var\((--[\w-]+)\)/g,
      (_, token: string) => styles(document.documentElement).getPropertyValue(token)));
    const listWidth = panelWidth - px(panelStyle.paddingLeft) - px(panelStyle.paddingRight)
      - px(panelStyle.borderLeftWidth) - px(panelStyle.borderRightWidth);
    const optionStyle = styles(option);
    const labelStyle = styles(label);
    const check = styles(child(option, '.inline-switcher__model-option-check'));
    const reserved = px(optionStyle.paddingLeft) + px(optionStyle.paddingRight)
      + px(optionStyle.borderLeftWidth) + px(optionStyle.borderRightWidth)
      + (px(optionStyle.columnGap) || px(optionStyle.gap)) + px(check.flexBasis);
    const textWidth = intrinsic(textOf(label));
    const automaticMinimum = optionStyle.minWidth !== '0px'
      && styles(list).gridTemplateColumns !== 'minmax(0, 1fr)';
    const rowWidth = Math.max(listWidth, automaticMinimum ? textWidth + reserved : 0);
    const viewportWidth = labelStyle.minWidth === '0px'
      ? Math.max(0, rowWidth - reserved) : Math.max(textWidth, rowWidth - reserved);
    return { listWidth, rowWidth, viewportWidth, textWidth };
  }
  const proto = window.HTMLElement.prototype;
  for (const property of ['clientWidth', 'scrollWidth'] as const) {
    const original = Object.getOwnPropertyDescriptor(proto, property);
    Object.defineProperty(proto, property, {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('inline-switcher__model-option-label-text')) return intrinsic(this);
        if (this.classList.contains('inline-switcher__model-option-label')) {
          const { viewportWidth, textWidth } = geometry(this);
          if (property === 'clientWidth') return viewportWidth;
          const engaged = styles(textOf(this)).transform.startsWith('translateX');
          return engaged ? viewportWidth : Math.max(viewportWidth, textWidth);
        }
        if (this.classList.contains('inline-switcher__model-list')) {
          const rows = [...this.querySelectorAll<HTMLElement>('.inline-switcher__model-option-label')]
            .map(geometry);
          return property === 'clientWidth' ? rows[0]!.listWidth
            : Math.max(...rows.map((row) => row.rowWidth));
        }
        return 0;
      },
    });
    restorers.push(() => {
      if (original) Object.defineProperty(proto, property, original);
      else Reflect.deleteProperty(proto, property);
    });
  }
  return { geometry, intrinsicOverrides };
}

function installResizeObserver() {
  const subscriptions = new Map<ResizeObserverCallback, Set<Element>>();
  class Observer {
    constructor(private callback: ResizeObserverCallback) {
      subscriptions.set(callback, new Set());
    }
    observe(el: Element) { subscriptions.get(this.callback)!.add(el); }
    disconnect() { subscriptions.delete(this.callback); }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  return {
    subscriptions,
    resize(el: Element) {
      const listeners = [...subscriptions].filter(([, targets]) => targets.has(el));
      expect(listeners.length).toBeGreaterThan(0);
      act(() => {
        for (const [callback] of listeners) callback([], {} as ResizeObserver);
      });
    },
  };
}

function openModelList(motion: Motion = 'reduce', home = false, variant: 'model' | 'reasoning' = 'model') {
  installStyles(motion);
  const geometry = installGeometry();
  const observer = installResizeObserver();
  const onAgentModelChange = vi.fn();
  const view = render(
    <div className={home ? 'home-hero__execution-switcher' : 'composer-execution-switcher'}>
      <InlineModelSwitcher
        config={config} agents={[agent]} daemonLive variant={variant}
        onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={onAgentModelChange}
        onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()}
      />
    </div>,
  );
  fireEvent.click(screen.getByTestId(`inline-model-switcher-${variant}-trigger`));
  return { ...view, ...geometry, ...observer, onAgentModelChange };
}

function resolvedTransform(label: HTMLElement): string {
  return (styles(textOf(label)).transform || 'none').replace(
    /var\(--inline-switcher-option-reveal, 0px\)/g,
    label.style.getPropertyValue('--inline-switcher-option-reveal'),
  );
}

describe('model option intrinsic sizing and reveal', () => {
  it('reproduces the intrinsic-width failure when the old auto sizing is restored', () => {
    const { geometry, resize } = openModelList();
    const label = labelOf('spark');
    const option = label.parentElement!;
    const list = screen.getByTestId('inline-model-switcher-model-list');
    list.style.gridTemplateColumns = 'none';
    option.style.minWidth = 'auto';
    label.style.width = 'auto';
    label.style.flex = '1 1 auto';
    textOf(label).style.width = 'auto';
    expect(geometry(label)).toEqual({ listWidth: 174, rowWidth: 538, viewportWidth: 501, textWidth: 501 });
    expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
    resize(label);
    expect(label.hasAttribute('data-overflowing')).toBe(false);
  });

  it.each([false, true])('contains 501px text within the 174px list (home=%s)', (home) => {
    const { geometry } = openModelList('reduce', home);
    const label = labelOf('spark');
    const list = screen.getByTestId('inline-model-switcher-model-list');
    expect(geometry(label)).toEqual({ listWidth: 174, rowWidth: 174, viewportWidth: 137, textWidth: 501 });
    expect(list.clientWidth).toBe(174);
    expect(list.scrollWidth).toBe(list.clientWidth);
    expect(styles(list).overflowX).toBe('clip');
    expect(styles(list).width).toBe('100%');
    expect(styles(list).minWidth).toBe('0px');
    expect(styles(label.parentElement!).width).toBe('100%');
    expect(styles(label.parentElement!).minWidth).toBe('0px');
    expect(styles(label).width).toBe('0px');
    expect(styles(label).flexBasis).toBe('0px');
    expect(styles(label).overflow).toBe('hidden');
    expect(styles(textOf(label)).width).toBe('max-content');
    expect(label.getAttribute('data-overflowing')).toBe('true');
    expect(label.style.getPropertyValue('--inline-switcher-option-reveal')).toBe('364px');
    expect(labelOf('sol').hasAttribute('data-overflowing')).toBe(false);
    expect(labelOf('terra').hasAttribute('data-overflowing')).toBe(false);
    expect(label.parentElement!.getAttribute('title')).toBe(LONG_LABEL);
    expect(label.parentElement!.getAttribute('aria-selected')).toBe('false');
    expect(labelOf('sol').parentElement!.getAttribute('aria-selected')).toBe('true');
    expect(textOf(label).textContent).toBe(LONG_LABEL);
  });

  it.each([
    ['reduce', 'hover'], ['reduce', 'focus'],
    ['no-preference', 'hover'], ['no-preference', 'focus'],
  ] as const)('%s / %s reaches the exact tail without moving fitting text', (motion, engagement) => {
    const { resize } = openModelList(motion);
    for (const id of ['spark', 'sol']) {
      const label = labelOf(id);
      const option = label.parentElement!;
      expect(resolvedTransform(label)).toBe('none');
      expect(styles(label).textOverflow).toBe('ellipsis');
      if (engagement === 'hover') option.setAttribute('data-test-hover', '');
      else {
        option.focus();
        expect(document.activeElement).toBe(option);
        // jsdom caches pre-focus computed styles until a DOM mutation. This
        // attribute matches no rule; :focus still resolves from actual focus.
        option.setAttribute('data-test-focus-cache', '');
      }
      expect(resolvedTransform(label)).toBe(id === 'spark' ? 'translateX(calc(-1 * 364px))' : 'none');
      expect(styles(label).textOverflow).toBe(id === 'spark' ? 'clip' : 'ellipsis');
      if (motion === 'reduce') expect(styles(textOf(label)).transition).toBe('none');
      else expect(styles(textOf(label)).transition).toContain('transform');
      if (id === 'spark') {
        expect(textOf(label).scrollWidth - 364).toBe(label.clientWidth);
        // At the tail the wrapper no longer has scrollable overflow. Measuring
        // it again must not clear the flag and snap the text back to the start.
        expect(label.scrollWidth).toBe(label.clientWidth);
        resize(label);
        expect(label.getAttribute('data-overflowing')).toBe('true');
        expect(resolvedTransform(label)).toBe('translateX(calc(-1 * 364px))');
      }
      option.blur();
      option.removeAttribute('data-test-hover');
      option.removeAttribute('data-test-focus-cache');
      expect(resolvedTransform(label)).toBe('none');
    }
  });

  it('remeasures viewport/font changes, includes 1px overflow, and disconnects on close', () => {
    const { resize, intrinsicOverrides, subscriptions, unmount } = openModelList();
    const label = labelOf('spark');
    const panel = screen.getByTestId('inline-model-switcher-model-popover');
    panel.style.width = '160px';
    resize(label);
    expect(label.clientWidth).toBe(105);
    expect(label.style.getPropertyValue('--inline-switcher-option-reveal')).toBe('396px');
    intrinsicOverrides.set(textOf(label), 106);
    resize(textOf(label));
    expect(label.style.getPropertyValue('--inline-switcher-option-reveal')).toBe('1px');
    intrinsicOverrides.set(textOf(label), 105);
    resize(textOf(label));
    expect(label.hasAttribute('data-overflowing')).toBe(false);
    expect(label.style.getPropertyValue('--inline-switcher-option-reveal')).toBe('');
    intrinsicOverrides.set(textOf(label), 70);
    resize(textOf(label));
    expect(label.hasAttribute('data-overflowing')).toBe(false);
    unmount();
    expect(subscriptions.size).toBe(0);
  });

  it('selects the overflowing option and closes the list', () => {
    const { onAgentModelChange } = openModelList();
    fireEvent.click(screen.getByTestId('inline-model-switcher-model-option-spark'));
    expect(onAgentModelChange).toHaveBeenCalledExactlyOnceWith('codex', { model: 'spark' });
    expect(screen.queryByTestId('inline-model-switcher-model-list')).toBeNull();
  });

  it('preserves native keyboard focus and selection semantics', () => {
    const { onAgentModelChange } = openModelList();
    const option = screen.getByTestId('inline-model-switcher-model-option-spark');
    expect(option.tagName).toBe('BUTTON');
    expect(option.getAttribute('role')).toBe('option');
    expect(option.tabIndex).toBe(0);
    option.focus();
    expect(document.activeElement).toBe(option);
    expect(resolvedTransform(labelOf('spark'))).toBe('translateX(calc(-1 * 364px))');
    // jsdom does not synthesize a native button click from Enter. Dispatch the
    // activation click explicitly; real keyboard activation is browser-owned.
    fireEvent.click(option, { detail: 0 });
    expect(onAgentModelChange).toHaveBeenCalledExactlyOnceWith('codex', { model: 'spark' });
  });

  it('keeps the effort panel at 144px and preserves reasoning selection', () => {
    const { onAgentModelChange, geometry } = openModelList('reduce', true, 'reasoning');
    const list = screen.getByTestId('inline-model-switcher-reasoning-list');
    const option = screen.getByTestId('inline-model-switcher-reasoning-option-high');
    const label = child(option, '.inline-switcher__model-option-label');
    expect(geometry(label).listWidth).toBe(126); // 144 minus padding/border.
    expect(list.scrollWidth).toBe(list.clientWidth);
    expect(label.hasAttribute('data-overflowing')).toBe(false);
    fireEvent.click(option);
    expect(onAgentModelChange).toHaveBeenCalledExactlyOnceWith('codex', { reasoning: 'high' });
    expect(screen.queryByTestId('inline-model-switcher-reasoning-list')).toBeNull();
  });
});
