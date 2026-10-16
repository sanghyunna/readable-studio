// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateLaunchBanner, UpdateSection } from '../../src/components/UpdateSection';

const cases: Array<[string, () => Promise<unknown>]> = [
  // Failures may surface a localized error alert, but never an update download prompt.
  ['null body', async () => ({ ok: true, json: async () => null })],
  ['empty object', async () => ({ ok: true, json: async () => ({}) })],
  ['http 500', async () => ({ ok: false, json: async () => ({}) })],
  ['unparseable body', async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })],
  ['network error', async () => { throw new Error('offline'); }],
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('update UI with broken endpoints', () => {
  it.each(cases)('launch banner offers no update on %s', async (_name, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    await act(async () => { render(<UpdateLaunchBanner ready />); });
    expect(screen.queryByRole('button', { name: /download|restart/ })).toBeNull();
  });

  it.each(cases)('settings section renders on %s', async (_name, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    await act(async () => { render(<UpdateSection currentVersion="1.0.0" />); });
    expect(screen.getByRole('region')).toBeTruthy();
  });
});
