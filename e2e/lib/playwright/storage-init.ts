import type { BrowserContext, Page, WebError } from '@playwright/test';

const FAILURE_PREFIX = '[e2e-storage-seed]';
const observedTargets = new WeakSet<Page | BrowserContext>();

/**
 * App config belongs to the top-level HTTP(S) document, not its blank or
 * sandboxed previews. Keep the callback inside the same init script as the
 * guard: Playwright does not guarantee ordering between separate init scripts.
 * The suite navigates the top-level page to the app; frames never need seeding.
 */
export async function addStorageInitScript<Arg>(
  page: Page | BrowserContext,
  seed: (arg: Arg) => void,
  arg: Arg,
): Promise<void> {
  if (!observedTargets.has(page)) {
    // A browser pageerror alone does not fail a Playwright test. Surface only
    // our marked seeding failures as runner errors, without filtering any of
    // the page's errors or hiding them from existing observers.
    const onPageError = (error: Error) => {
      if (error.message.startsWith(FAILURE_PREFIX)) throw error;
    };
    if ('pages' in page) {
      const onWebError = (error: WebError) => onPageError(error.error());
      page.on('weberror', onWebError);
      page.once('close', () => page.off('weberror', onWebError));
    } else {
      page.on('pageerror', onPageError);
      page.once('close', () => page.off('pageerror', onPageError));
    }
    observedTargets.add(page);
  }

  await page.addInitScript({
    content: storageSeedScript(seed, arg),
  });
}

/** The same guarded expression for desktop inspect eval and Playwright. */
export function storageSeedScript<Arg, Result>(seed: (arg: Arg) => Result, arg: Arg): string {
  return `(${runStorageSeed.toString()})(${seed.toString()}, ${JSON.stringify(arg)}, ${JSON.stringify(FAILURE_PREFIX)})`;
}

/** One-shot mutations must not become init scripts that reset persisted state on reload. */
export async function evaluateStorageSeed<Arg, Result>(
  page: Page,
  seed: (arg: Arg) => Result,
  arg: Arg,
): Promise<Result | undefined> {
  // evaluate rejects directly, so no pageerror listener is needed here.
  return page.evaluate<Result | undefined>(storageSeedScript(seed, arg));
}

// Self-contained because Playwright evaluates its source in each new document.
function runStorageSeed<Arg, Result>(seed: (arg: Arg) => Result, arg: Arg, failurePrefix: string): Result | undefined {
  if (window !== window.top) return;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

  try {
    // Unlike location.origin, window.origin reflects an opaque sandbox origin.
    // An opaque top-level app is a harness failure, not an ignorable preview.
    if (window.origin !== window.location.origin || window.origin === 'null') {
      throw new Error('The app document does not have a same-origin storage context');
    }
    return seed(arg);
  } catch (error) {
    throw new Error(`${failurePrefix} ${window.location.origin}: ${String(error)}`, { cause: error });
  }
}
