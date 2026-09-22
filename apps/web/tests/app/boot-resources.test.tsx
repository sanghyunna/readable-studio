// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RootLayout, { metadata } from '../../app/layout';

describe('boot resources', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('preloads the CSS font with matching anonymous CORS when rendering the shell', () => {
    // Given the root shell.
    const layout = RootLayout({ children: null });
    // When its HTML is rendered.
    const document = new DOMParser().parseFromString(renderToStaticMarkup(layout), 'text/html');
    // Then the font has exactly one reusable preload.
    const links = document.querySelectorAll('link[rel="preload"][as="font"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/fonts/PretendardVariable.woff2');
    expect(links[0]?.getAttribute('type')).toBe('font/woff2');
    expect(links[0]?.getAttribute('crossorigin')).toBe('anonymous');
  });

  it('offers one SVG favicon when the browser selects a desktop icon', () => {
    // Given the app metadata.
    // When reading its desktop icon candidates.
    const icons = metadata.icons;
    // Then PNG is reserved for Apple touch icons, not a competing favicon.
    expect(icons).toEqual({
      icon: [{ url: '/app-icon.svg', type: 'image/svg+xml' }],
      apple: '/app-icon.png',
    });
  });

  it('allows reuse of the unchanged icon when a production shell mounts its hero', async () => {
    // Given the production server configuration.
    vi.stubEnv('READABLE_WEB_OUTPUT_MODE', 'server');
    vi.stubEnv('NODE_ENV', 'production');
    const { default: config } = await import('../../next.config');
    // When Next resolves response headers.
    const headers = await config.headers?.();
    // Then subsequent icon consumers can reuse the first response without revalidation.
    expect(headers).toContainEqual({
      source: '/app-icon.svg',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
    });
  });
});
