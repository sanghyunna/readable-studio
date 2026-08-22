import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n';
import { AnalyticsProvider } from '../src/analytics/provider';
import { THEME_SCHEME_BY_ID } from '../src/state/themes';
import '../src/index.css';
import '../src/styles/home/index.css';
import '../src/styles/fonts.css';

export const metadata: Metadata = {
  applicationName: 'Readable Studio',
  title: {
    default: 'Readable Studio',
    template: '%s · Readable Studio',
  },
  description: 'Turn source text into polished, directly editable standalone HTML documents.',
  icons: {
    icon: [
      { url: '/app-icon.svg', type: 'image/svg+xml' },
      { url: '/app-icon.png', type: 'image/png' },
    ],
    apple: '/app-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#F4EFE6',
};

/**
 * Inline script that runs before React hydrates to apply the saved theme
 * preference without a flash of unstyled content. It reads the same
 * localStorage key used by `state/config.ts` and sets `data-theme` on
 * `<html>` immediately — before any CSS or React paint.
 * Keep the accent variable mix ratios in sync with `accentVars()` in
 * `src/state/appearance.ts`.
 */
const themeInitScript = `(function(){try{var schemes=${JSON.stringify(THEME_SCHEME_BY_ID)};var root=document.documentElement;if(root.getAttribute('data-readable-composition')==='hosted'){root.setAttribute('data-theme','system');root.setAttribute('data-theme-scheme',schemes.system);return}var c=JSON.parse(localStorage.getItem('readable-studio:config')||'{}');var t=typeof c.theme==='string'?c.theme:'system';var scheme=schemes[t];if(scheme){root.setAttribute('data-theme',t);root.setAttribute('data-theme-scheme',scheme)}var a=typeof c.accentColor==='string'&&/^#[0-9a-fA-F]{6}$/.test(c.accentColor.trim())?c.accentColor.trim().toLowerCase():'#c96442';var m=c.accentColorMode;var custom=m==='custom'||(m!=='theme'&&a!=='#c96442');if(custom){var s=root.style;s.setProperty('--accent',a);s.setProperty('--accent-strong','color-mix(in srgb, '+a+' 86%, var(--text-strong))');s.setProperty('--accent-soft','color-mix(in srgb, '+a+' 22%, var(--bg-panel))');s.setProperty('--accent-tint','color-mix(in srgb, '+a+' 12%, var(--bg-panel))');s.setProperty('--accent-hover','color-mix(in srgb, '+a+' 90%, var(--text-strong))')}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const composition = process.env.READABLE_WEB_COMPOSITION === 'hosted' ? 'hosted' : undefined;
  const content = <AnalyticsProvider>{children}</AnalyticsProvider>;
  return (
    <html lang='en' data-readable-composition={composition} suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: intentional theme-init inline script to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning>
        {composition === 'hosted' ? content : <I18nProvider>{content}</I18nProvider>}
      </body>
    </html>
  );
}
