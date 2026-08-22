// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attributedAmrUrl,
  readAmrAttribution,
  recordAmrEntry,
} from '../../src/analytics/amr-attribution';

describe('AMR attribution helper', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts every AMR entry source defined for Readable Studio entry points', () => {
    const track = vi.fn();
    const sources = [
      'onboarding_amr_card',
      'onboarding_amr_sign_in_continue',
      'inline_model_switcher_amr_row',
      'settings_amr_agent_card',
      'settings_amr_authorize',
      'chat_error_authorize_retry',
      'chat_error_recharge',
      'chat_error_switch_retry_card',
      'generation_preview_authorize_retry',
      'generation_preview_recharge',
      'generation_preview_switch_retry_card',
    ] as const;

    for (const [index, source] of sources.entries()) {
      recordAmrEntry(
        track,
        source,
        new Date(`2026-06-03T12:00:${index.toString().padStart(2, '0')}.000Z`),
      );
    }

    expect(track).toHaveBeenCalledTimes(sources.length);
    expect(track.mock.calls.map(([, props]) => props.element)).toEqual(sources);
  });

  it('records a last-touch AMR entry and emits the matching ui_click event', () => {
    const track = vi.fn();
    const now = new Date('2026-06-03T12:00:00.000Z');

    const attribution = recordAmrEntry(track, 'chat_error_recharge', now);

    expect(attribution).toMatchObject({
      sourceProduct: 'readable_studio',
      sourceDetail: 'chat_error_recharge',
      occurredAt: '2026-06-03T12:00:00.000Z',
    });
    expect(attribution.entryId).toMatch(/^readable-amr-/u);
    expect(readAmrAttribution(now)).toEqual(attribution);
    expect(track).toHaveBeenCalledWith(
      'ui_click',
      expect.objectContaining({
        page_name: 'chat_panel',
        area: 'amr_entry',
        element: 'chat_error_recharge',
        action: 'click_amr_entry',
        entry_id: attribution.entryId,
        source_product: 'readable_studio',
        source_detail: 'chat_error_recharge',
        entry_occurred_at: '2026-06-03T12:00:00.000Z',
      }),
      undefined,
    );
    // The AMR analytics mirror to the cloud was removed; recordAmrEntry still
    // fires the local ui_click event but never phones home.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses a previous entry id for follow-up actions in the same source path', () => {
    const track = vi.fn();
    const first = recordAmrEntry(
      track,
      'onboarding_amr_card',
      new Date('2026-06-03T12:00:00.000Z'),
    );

    const second = recordAmrEntry(
      track,
      'onboarding_amr_sign_in_continue',
      new Date('2026-06-03T12:00:05.000Z'),
      { reuseExistingFrom: ['onboarding_amr_card'] },
    );

    expect(second).toEqual(first);
    expect(track).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readAmrAttribution(new Date('2026-06-03T12:00:05.000Z'))).toEqual(
      first,
    );
  });

  it('expires stored attribution after seven days', () => {
    const track = vi.fn();
    const attribution = recordAmrEntry(
      track,
      'settings_amr_authorize',
      new Date('2026-06-03T12:00:00.000Z'),
    );

    expect(readAmrAttribution(new Date('2026-06-10T11:59:59.000Z'))).toEqual(
      attribution,
    );
    expect(readAmrAttribution(new Date('2026-06-10T12:00:01.000Z'))).toBeNull();
  });

  it('adds Readable Studio attribution params to AMR wallet URLs', () => {
    expect(
      attributedAmrUrl('https://vela.powerformer.net/wallet?tab=recharge', {
        entryId: 'readable-amr-entry-123',
        sourceProduct: 'readable_studio',
        sourceDetail: 'generation_preview_recharge',
        occurredAt: '2026-06-03T12:00:00.000Z',
      }),
    ).toBe(
      'https://vela.powerformer.net/wallet?tab=recharge&readable_origin=readable_studio&readable_entry_id=readable-amr-entry-123&readable_entry_source=generation_preview_recharge&readable_entry_at=2026-06-03T12%3A00%3A00.000Z',
    );
  });
});
