// Legacy event metadata shape retained for web/daemon compatibility. Runtime
// telemetry dispatch is disabled in this fork.
export const EVENT_SCHEMA_VERSION = 2;

export type AnalyticsClientType = 'web' | 'desktop';

export interface AnalyticsPublicParams {
  event_id: string;
  request_id?: string;
  event_schema_version: number;
  env: string;
  ui_version: string;
  session_id: string;
  // v2 rename: was `anonymous_id` in schema v1. Compatibility clients now use
  // a fixed disabled marker instead of a telemetry identity.
  device_id: string;
  user_id?: string;
  client_type: AnalyticsClientType;
  app_version: string;
  locale: string;
}

// Legacy configure-state triplet retained for callers that still compute it.
// The no-op analytics client stores it locally only.
export type TrackingConfigureType =
  | 'local_cli'
  | 'byok'
  | 'both'
  // AMR sign-in is the user's only configured generation path: no local
  // CLI detected and no BYOK key saved. Counts toward the "configured"
  // funnel stage alongside local_cli/byok/both.
  | 'amr'
  | 'none'
  | 'unknown';

export type TrackingConfigureAvailability =
  | 'available'
  | 'unavailable'
  | 'unknown';

export interface AnalyticsConfigureGlobals {
  has_available_configure_cli: boolean;
  configure_type: TrackingConfigureType;
  configure_availability: TrackingConfigureAvailability;
}

// Legacy header names used by the web/daemon compatibility layer. The current
// runtime does not use them to emit telemetry.
export const ANALYTICS_HEADER_DEVICE_ID = 'x-readable-studio-analytics-device-id';
export const ANALYTICS_HEADER_SESSION_ID = 'x-readable-studio-analytics-session-id';
export const ANALYTICS_HEADER_CLIENT_TYPE = 'x-readable-studio-analytics-client-type';
export const ANALYTICS_HEADER_LOCALE = 'x-readable-studio-analytics-locale';
export const ANALYTICS_HEADER_REQUEST_ID = 'x-readable-studio-analytics-request-id';

// Compatibility response for /api/analytics/config. This fork always serves
// disabled config with null sink credentials.
export interface AnalyticsConfigResponse {
  enabled: boolean;
  env: string;
  key: string | null;
  host: string | null;
  installationId?: string | null;
}
