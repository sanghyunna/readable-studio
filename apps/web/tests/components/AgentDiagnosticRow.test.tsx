// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDiagnosticRow } from '../../src/components/AgentDiagnosticRow';
import type { AgentDiagnostic } from '../../src/types';
import { getEn } from '../../src/i18n/locales/en';
import { getKo } from '../../src/i18n/locales/ko';
import { I18nProvider } from '../../src/i18n';
const en = getEn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const notOnPath: AgentDiagnostic = {
  reason: 'not-on-path',
  severity: 'error',
  message: 'Gemini (`gemini`) was not found on your PATH.',
  searchedDirs: ['/usr/bin', '/opt/homebrew/bin'],
  fixActions: [{ kind: 'openInstall' }, { kind: 'rescan' }],
};

const databricksNoModels: AgentDiagnostic = {
  reason: 'auth-unknown',
  severity: 'warning',
  message: 'No Databricks models are configured in Readable Studio.',
  fixActions: [{ kind: 'openDocs' }, { kind: 'rescan' }],
};

const databricksPackageDamaged: AgentDiagnostic = {
  reason: 'not-executable',
  severity: 'error',
  message: 'The bundled Databricks CLI is missing or unusable.',
  fixActions: [{ kind: 'rescan' }],
};

describe('AgentDiagnosticRow', () => {
  const reasons: AgentDiagnostic['reason'][] = [
    'not-on-path', 'not-executable', 'shim-broken', 'configured-bin-invalid',
    'auth-missing', 'auth-unknown', 'discovery-failed', 'probe-timeout',
  ];
  it.each(reasons)('renders Korean shipped copy for %s, with raw diagnostics only in the tooltip', (reason) => {
    const diagnostic: AgentDiagnostic = {
      reason, severity: 'error',
      message: 'Live model discovery failed. Check the CLI configuration and connection, then rescan.',
      detail: 'stderr: connection refused',
    };
    render(<I18nProvider initial="ko"><AgentDiagnosticRow diagnostic={diagnostic} /></I18nProvider>);
    const group = screen.getByRole('group');
    const copy = getKo()[`settings.agentDiagnostic.${reason}`];
    expect(group.textContent).toBe(copy);
    expect(group.textContent).not.toContain(diagnostic.message);
    expect(screen.getByText(copy).getAttribute('title')).toContain(diagnostic.detail);
    if (reason === 'discovery-failed') {
      expect(screen.getByText(copy).getAttribute('title')).not.toContain(diagnostic.message);
    }
  });

  it('renders Korean Databricks setup guidance', () => {
    render(<I18nProvider initial="ko"><AgentDiagnosticRow agentId="databricks" diagnostic={databricksNoModels} /></I18nProvider>);
    expect(screen.getByRole('group').textContent).toBe(getKo()['settings.agentDiagnostic.databricks-no-models']);
    expect(screen.getByRole('group').textContent).not.toContain(databricksNoModels.message);
  });
  it('renders localized copy and tags the reason', () => {
    render(<AgentDiagnosticRow diagnostic={notOnPath} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('data-reason')).toBe('not-on-path');
    expect(screen.getByText(en['settings.agentDiagnostic.not-on-path'])).toBeTruthy();
  });

  it('exposes searched dirs via the message tooltip', () => {
    render(<AgentDiagnosticRow diagnostic={notOnPath} />);
    const title = screen.getByText(en['settings.agentDiagnostic.not-on-path']).getAttribute('title') ?? '';
    expect(title).toContain('/usr/bin');
    expect(title).toContain('/opt/homebrew/bin');
  });

  it('only renders buttons for intents that have a wired handler', () => {
    const onRescan = vi.fn();
    // openInstall is in the diagnostic but no onOpenInstall handler is given,
    // so only Rescan should render. Actions are icon-only buttons whose
    // accessible name comes from the (tooltip) aria-label.
    render(<AgentDiagnosticRow diagnostic={notOnPath} handlers={{ onRescan }} />);
    expect(
      screen.queryByRole('button', { name: en['settings.agentInstall.install'] }),
    ).toBeNull();
    const rescan = screen.getByRole('button', { name: en['settings.rescan'] });
    fireEvent.click(rescan);
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it('suppresses the generic Install CTA for every Databricks state', () => {
    const onOpenInstall = vi.fn();
    const onRescan = vi.fn();
    render(
      <AgentDiagnosticRow
        agentId="databricks"
        diagnostic={{
          ...databricksPackageDamaged,
          fixActions: [{ kind: 'openInstall' }, { kind: 'rescan' }],
        }}
        handlers={{ onOpenInstall, onRescan }}
      />,
    );
    expect(
      screen.queryByRole('button', { name: en['settings.agentInstall.install'] }),
    ).toBeNull();
    // Rescan is still wired and should still work.
    fireEvent.click(screen.getByRole('button', { name: en['settings.rescan'] }));
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(onOpenInstall).not.toHaveBeenCalled();
  });

  it('maps zero configured Databricks models to Settings > Databricks guidance', () => {
    const onOpenDatabricksSettings = vi.fn();
    render(
      <AgentDiagnosticRow
        agentId="databricks"
        diagnostic={databricksNoModels}
        handlers={{ onOpenDatabricksSettings }}
      />,
    );
    expect(screen.getByText(en['settings.agentDiagnostic.databricks-no-models'])).toBeTruthy();
    const btn = screen.getByRole('button', { name: en['settings.databricksModels'] });
    fireEvent.click(btn);
    expect(onOpenDatabricksSettings).toHaveBeenCalledTimes(1);
  });

  it('preserves the Databricks probe diagnostic while offering package repair as an optional action', () => {
    const onReDownloadPortablePackage = vi.fn();
    render(
      <AgentDiagnosticRow
        agentId="databricks"
        diagnostic={databricksPackageDamaged}
        handlers={{ onReDownloadPortablePackage }}
      />,
    );
    expect(screen.getByText(en['settings.agentDiagnostic.not-executable'])).toBeTruthy();
    expect(screen.getByText(en['settings.agentDiagnostic.not-executable']).getAttribute('title')).toContain(databricksPackageDamaged.message);
    const btn = screen.getByRole('button', { name: en['common.exportZip'] });
    fireEvent.click(btn);
    expect(onReDownloadPortablePackage).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic Install CTA for non-Databricks agents', () => {
    const onOpenInstall = vi.fn();
    render(<AgentDiagnosticRow diagnostic={notOnPath} handlers={{ onOpenInstall }} />);
    const install = screen.getByRole('button', { name: en['settings.agentInstall.install'] });
    fireEvent.click(install);
    expect(onOpenInstall).toHaveBeenCalledTimes(1);
  });

});
