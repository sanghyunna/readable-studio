import type {
  AmrEntryAttribution,
  TrackingAmrEntrySource,
  TrackingPageName,
} from '@readable-studio/contracts/analytics';
import { trackAmrEntryClick } from './events';

type Track = (
  event: string,
  properties: Record<string, unknown>,
  options?: { requestId?: string; insertId?: string },
) => void;

interface RecordAmrEntryOptions {
  reuseExistingFrom?: readonly TrackingAmrEntrySource[];
}

const AMR_ATTRIBUTION_STORAGE_KEY = 'readable-studio:amr-entry-attribution:v1';
const AMR_ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ENTRY_PAGE_BY_SOURCE: Record<TrackingAmrEntrySource, TrackingPageName> = {
  onboarding_amr_card: 'onboarding',
  onboarding_amr_sign_in_continue: 'onboarding',
  inline_model_switcher_amr_row: 'chat_panel',
  settings_amr_agent_card: 'settings',
  settings_amr_authorize: 'settings',
  chat_error_authorize_retry: 'chat_panel',
  chat_error_recharge: 'chat_panel',
  chat_error_switch_retry_card: 'chat_panel',
  generation_preview_authorize_retry: 'file_manager',
  generation_preview_recharge: 'file_manager',
  generation_preview_switch_retry_card: 'file_manager',
};

export type { AmrEntryAttribution, TrackingAmrEntrySource };

// Where an amr_entry source surfaces in the product. amr-auth.ts reuses
// this to stamp `page_name` on amr_auth_result from the attribution alone.
export function amrEntryPageForSource(
  source: TrackingAmrEntrySource,
): TrackingPageName {
  return ENTRY_PAGE_BY_SOURCE[source];
}

export function recordAmrEntry(
  track: Track,
  sourceDetail: TrackingAmrEntrySource,
  now: Date = new Date(),
  options: RecordAmrEntryOptions = {},
): AmrEntryAttribution {
  const existing = readReusableAmrAttribution(now, options.reuseExistingFrom);
  if (existing) return existing;

  const attribution: AmrEntryAttribution = {
    entryId: `readable-amr-${randomId()}`,
    sourceProduct: 'readable_studio',
    sourceDetail,
    occurredAt: now.toISOString(),
  };
  writeAmrAttribution(attribution);
  trackAmrEntryClick(track, {
    page_name: ENTRY_PAGE_BY_SOURCE[sourceDetail],
    area: 'amr_entry',
    element: sourceDetail,
    action: 'click_amr_entry',
    entry_id: attribution.entryId,
    source_product: attribution.sourceProduct,
    source_detail: attribution.sourceDetail,
    entry_occurred_at: attribution.occurredAt,
  });
  void mirrorAmrEntryToAmrAnalytics(attribution);
  return attribution;
}

export function readAmrAttribution(now: Date = new Date()): AmrEntryAttribution | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AMR_ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AmrEntryAttribution>;
    if (!isValidAmrAttribution(parsed)) return null;
    if (now.getTime() - Date.parse(parsed.occurredAt) > AMR_ATTRIBUTION_TTL_MS) {
      window.localStorage.removeItem(AMR_ATTRIBUTION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function attributedAmrUrl(baseUrl: string, attribution: AmrEntryAttribution): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('readable_origin', attribution.sourceProduct);
    url.searchParams.set('readable_entry_id', attribution.entryId);
    url.searchParams.set('readable_entry_source', attribution.sourceDetail);
    url.searchParams.set('readable_entry_at', attribution.occurredAt);
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}${new URLSearchParams({
      readable_origin: attribution.sourceProduct,
      readable_entry_id: attribution.entryId,
      readable_entry_source: attribution.sourceDetail,
      readable_entry_at: attribution.occurredAt,
    }).toString()}`;
  }
}

function writeAmrAttribution(attribution: AmrEntryAttribution): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AMR_ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
  } catch {
    // Analytics persistence must never block the primary action.
  }
}

function readReusableAmrAttribution(
  now: Date,
  reuseExistingFrom: readonly TrackingAmrEntrySource[] | undefined,
): AmrEntryAttribution | null {
  if (!reuseExistingFrom || reuseExistingFrom.length === 0) return null;
  const existing = readAmrAttribution(now);
  if (!existing) return null;
  return reuseExistingFrom.includes(existing.sourceDetail) ? existing : null;
}

// Mirroring AMR attribution to the hosted vela analytics endpoint has been
// removed: this fork does not phone home AMR entry attribution to the cloud.
// Kept as a no-op (rather than deleted) so `recordAmrEntry` and any other
// caller keep compiling without a conditional call site.
async function mirrorAmrEntryToAmrAnalytics(
  _attribution: AmrEntryAttribution,
): Promise<void> {
  return;
}

function isValidAmrAttribution(value: Partial<AmrEntryAttribution>): value is AmrEntryAttribution {
  return value.sourceProduct === 'readable_studio'
    && typeof value.entryId === 'string'
    && value.entryId.length > 0
    && typeof value.sourceDetail === 'string'
    && value.sourceDetail in ENTRY_PAGE_BY_SOURCE
    && typeof value.occurredAt === 'string'
    && Number.isFinite(Date.parse(value.occurredAt));
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
