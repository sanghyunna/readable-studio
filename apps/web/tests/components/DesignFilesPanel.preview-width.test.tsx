// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import { I18nProvider } from '../../src/i18n';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
import type { Dict, Locale } from '../../src/i18n/types';

const css = readFileSync(new NodeURL('../../src/styles/workspace/design-files.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((match) => match[1]!.split(',').map((part) => part.trim()).includes(selector))
    .map((match) => match[2])
    .join('\n');
}

afterEach(cleanup);

describe('DesignFilesPanel preview width (H4-01)', () => {
  it('protects the list minimum against the workspace cascade and lets the preview yield', () => {
    const split = declarations('.app .df-panel.df-panel:not(.no-preview)');
    expect(split).toMatch(/grid-template-columns:\s*minmax\(min\(100%, 360px\), 1fr\) minmax\(0, 280px\)/);
    expect(declarations('.df-panel')).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container\s*\(max-width:\s*600px\)[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
    expect(css).toMatch(/@container\s*\(max-width:\s*600px\)[\s\S]*?\.df-actions button > span\s*\{\s*display:\s*none/);
  });

  it('keeps Korean words intact and gives long preview names an emergency wrap', () => {
    expect(declarations('.df-row-sub')).toMatch(/word-break:\s*keep-all/);
    expect(declarations('.df-preview-name')).toMatch(/word-break:\s*keep-all/);
    expect(declarations('.df-preview-name')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('keeps selection compact and removes optional timestamps on narrow lists', () => {
    expect(declarations('.df-row .df-row-select')).toMatch(/white-space:\s*nowrap/);
    expect(declarations('.df-row .df-row-select')).toMatch(/padding:\s*4px 8px/);
    expect(css).toMatch(/@container\s*\(max-width:\s*470px\)[\s\S]*?\.df-row-time\s*\{\s*display:\s*none/);
  });
});

describe('DesignFilesPanel localized selection (H4-03)', () => {
  it.each<Locale>(['en', 'ko'])('uses the %s dictionary for visible and accessible selection labels', (locale) => {
    const dict = locale === 'ko' ? getKo() : getEn();
    render(
      <I18nProvider initial={locale}>
        <DesignFilesPanel
          projectId="preview-width"
          files={[{ name: 'marker.json', path: 'marker.json', type: 'file', kind: 'code', mime: 'application/json', size: 80, mtime: 1700000000 }]}
          onRefreshFiles={vi.fn()} onOpenFile={vi.fn()} onRenameFile={vi.fn()}
          onDeleteFile={vi.fn()} onDeleteFiles={vi.fn()} onUpload={vi.fn()}
          onUploadFiles={vi.fn()} onPaste={vi.fn()} onNewSketch={vi.fn()}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText('marker.json'));
    expect(screen.getByTestId('design-file-preview')).toBeTruthy();
    const action = screen.getByTestId('design-file-row-marker.json').querySelector('.df-row-select')!;
    expect(action.textContent).toBe(dict['designFiles.select' as keyof Dict]);
    expect(action.getAttribute('aria-label')).toBe(
      dict['designFiles.selectFile' as keyof Dict]?.replace('{name}', 'marker.json'),
    );
    fireEvent.click(action);
    expect(action.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(action);
    expect(action.getAttribute('aria-pressed')).toBe('false');
  });
});
