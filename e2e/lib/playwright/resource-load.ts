import type { Page, Request, Response } from '@playwright/test';

/** Subscribe before navigation; inspect failures after the destination is interactive. */
export function observeResourceLoads(page: Page) {
  const failures: Array<{ url: string; error: string }> = [];
  const isModuleResource = (request: Request) =>
    request.resourceType() === 'script' || request.resourceType() === 'stylesheet';
  const onResponse = (response: Response) => {
    if (isModuleResource(response.request()) && response.status() >= 400) {
      failures.push({ url: response.url(), error: `HTTP ${response.status()}` });
    }
  };
  const onFailed = (request: Request) => {
    if (isModuleResource(request)) {
      failures.push({ url: request.url(), error: request.failure()?.errorText ?? 'requestfailed' });
    }
  };
  const onPageError = (error: Error) => {
    failures.push({ url: page.url(), error: error.message });
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('pageerror', onPageError);
  return {
    failures,
    dispose() {
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      page.off('pageerror', onPageError);
    },
  };
}
