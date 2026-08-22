// Wire shape for the legacy cross-process safety-event bridge. The endpoint is
// retained for compatibility, but the daemon handler is now a no-op.

export interface ObservabilityEventRequest {
  event: string;
  properties?: Record<string, unknown>;
}

export interface ObservabilityEventResponse {
  ok: true;
}
