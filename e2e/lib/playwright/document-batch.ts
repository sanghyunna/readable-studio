import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { fulfillAgentsRoute } from './mock-factory.ts';
import { addStorageInitScript } from './storage-init.ts';
import { T } from '../timeouts.ts';

export type Locale = 'en' | 'ko';

/** Compare shipped copy, not a second hardcoded English/Korean translation. */
export async function shippedCopy(locale: Locale) {
  const source = await readFile(new URL(`../../../apps/web/src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8');
  const file = ts.createSourceFile(`${locale}.ts`, source, ts.ScriptTarget.Latest, true);
  const values = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)
      && ts.isStringLiteral(node.initializer)) values.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return (key: string, vars: Record<string, string | number> = {}) => {
    const value = values.get(key);
    if (value === undefined) throw new Error(`Missing shipped ${locale} copy: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`Missing ${key} interpolation: ${name}`);
      return String(vars[name]);
    });
  };
}

export async function seedLocale(page: Page, locale: Locale) {
  await addStorageInitScript(page, (value) => {
    localStorage.setItem('readable-studio:locale', value);
    localStorage.setItem('readable-studio:locale-source', 'manual');
  }, locale);
}

/** An absent agent cannot silently resolve to the CLI's valid `default` model. */
export async function withholdModels(page: Page) {
  let withheld = true;
  await page.route('**/api/agents**', async (route) => {
    if (withheld) await fulfillAgentsRoute(route, []);
    else await route.fallback();
  });
  return async () => {
    withheld = false;
    const [response] = await Promise.all([
      page.waitForResponse((incoming) => new URL(incoming.url()).pathname === '/api/agents'
        && new URL(incoming.url()).searchParams.get('stream') === '1', { timeout: T.long }),
      // Product config refresh seam: hydrate discovery without remounting the
      // Hub, which would hide a lost in-memory attachment/draft regression.
      page.evaluate(() => window.dispatchEvent(new Event('readable-studio:app-config-changed'))),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
  };
}

export function observeWrites(page: Page) {
  const posts: Request[] = [];
  const missing: string[] = [];
  const incoming = (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) posts.push(request);
  };
  const outgoing = (response: Response) => {
    if (response.status() === 404 && /^\/api\/projects\//.test(new URL(response.url()).pathname)) missing.push(response.url());
  };
  page.on('request', incoming);
  page.on('response', outgoing);
  return {
    posts, missing,
    at: (path: string) => posts.filter((request) => new URL(request.url()).pathname === path),
    dispose() { page.off('request', incoming); page.off('response', outgoing); },
  };
}

export type CloseMethod = 'button' | 'middle' | 'shortcut';

/** Deliberately close in the SAME task as input, before React/iframe acks. */
export async function stageStyleAndClose(input: Locator, method: CloseMethod, tabName: string, closeLabel: string) {
  await input.evaluate((element, args) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Style control is not an input');
    const tab = document.querySelector<HTMLElement>(`[role="tab"][aria-label="${CSS.escape(args.tabName)}"]`);
    if (!tab) throw new Error('Active file tab is missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, '48');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    if (args.method === 'button') {
      const close = tab.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(args.closeLabel)}"]`);
      if (!close) throw new Error('Close control is missing');
      close.click();
    } else if (args.method === 'middle') {
      tab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    } else {
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    }
  }, { method, tabName, closeLabel });
}
