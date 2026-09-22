// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDiagnosticRow } from '../../src/components/AgentDiagnosticRow';
import type { AgentDiagnostic } from '../../src/types';
import { getEn } from '../../src/i18n/locales/en';
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
  it('renders the daemon message and tags the reason', () => {
    render(<AgentDiagnosticRow diagnostic={notOnPath} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('data-reason')).toBe('not-on-path');
    expect(screen.getByText(notOnPath.message)).toBeTruthy();
  });

  it('exposes searched dirs via the message tooltip', () => {
    render(<AgentDiagnosticRow diagnostic={notOnPath} />);
    const title = screen.getByText(notOnPath.message).getAttribute('title') ?? '';
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
    expect(screen.getByText(/Settings > Databricks/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: en['settings.databricksModels'] });
    fireEvent.click(btn);
    expect(onOpenDatabricksSettings).toHaveBeenCalledTimes(1);
  });

  it('maps Databricks package corruption to a re-download portable ZIP action', () => {
    const onReDownloadPortablePackage = vi.fn();
    render(
      <AgentDiagnosticRow
        agentId="databricks"
        diagnostic={databricksPackageDamaged}
        handlers={{ onReDownloadPortablePackage }}
      />,
    );
    expect(screen.getByText(/Re-download.*portable package ZIP/)).toBeTruthy();
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
