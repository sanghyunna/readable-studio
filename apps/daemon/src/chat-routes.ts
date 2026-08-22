import type { Express } from 'express';
import type { RouteDeps } from './server-context.js';
import {
  buildLegacyMaxTokensParam,
  buildMaxCompletionTokensParam,
  buildOpenAIChatTokenParam,
  isUnsupportedMaxTokensError,
} from './openai-chat-token-params.js';
import {
  AIHUBMIX_DEFAULT_BASE_URL,
  aihubmixHeaders,
  aihubmixAppCodeHeader,
  aihubmixOriginFromBase,
  classifyAIHubMixModel,
} from './aihubmix.js';
import { projectKindToTracking } from '@readable-studio/contracts/analytics';
import { proxyDispatcherRequestInit, validateBaseUrlResolved } from './connectionTest.js';
import { googleStreamGenerateContentUrl } from './google-models.js';
import { createRoleMarkerGuard } from './role-marker-guard.js';

// Allowlist for the `/feedback` route. Mirrors the
// ChatMessageFeedbackReasonCode union in packages/contracts/src/api/chat.ts.
// Kept inline (not imported as a runtime value, since the contract type is
// type-only) so a stale client can't poison Langfuse with unknown categories.
const FEEDBACK_REASON_ALLOWLIST: ReadonlySet<string> = new Set([
  'matched_request',
  'strong_visual',
  'useful_structure',
  'easy_to_continue',
  'followed_design_system',
  'missed_request',
  'weak_visual',
  'incomplete_output',
  'hard_to_use',
  'missed_design_system',
  'other',
]);

export interface RegisterChatRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'chat' | 'agents' | 'critique' | 'validation' | 'lifecycle' | 'paths' | 'telemetry'> {}

export function registerChatRoutes(app: Express, ctx: RegisterChatRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, createSseResponse } = ctx.http;
  const { testProviderConnection, testAgentConnection, getAgentDef, isKnownModel, sanitizeCustomModel, listProviderModels } = ctx.agents;
  const {
    handleCritiqueArtifact,
    handleCritiqueInterrupt,
    critiqueArtifactsRoot,
    critiqueResponseCapBytes,
    critiqueRunRegistry,
  } = ctx.critique;
  const rejectProxyPluginContext = (body: Record<string, unknown>, res: any) => {
    if (
      (typeof body.pluginId === 'string' && body.pluginId.trim().length > 0) ||
      (
        typeof body.appliedPluginSnapshotId === 'string' &&
        body.appliedPluginSnapshotId.trim().length > 0
      )
    ) {
      sendApiError(
        res,
        409,
        'PLUGIN_REQUIRES_DAEMON',
        'Plugin runs must go through POST /api/runs so the daemon can resolve and pin the applied plugin snapshot.',
      );
      return true;
    }
    return false;
  };

  // The canonical POST /api/runs handler lives in `server.ts` — it ran
  // first in Express's registration order long before this file existed,
  // so any handler we wired here was shadowed and never executed. Plugin
  // snapshot resolution, clientType inference, and the daemon-side
  // run_created/finished analytics all live in `server.ts` now.
  // POST /api/chat is likewise owned by `server.ts`; keep the chat run
  // launch path single-sourced so validation changes land on the live route.

  app.get('/api/runs', (req, res) => {
    const { projectId, conversationId, status } = req.query;
    const runs = design.runs.list({ projectId, conversationId, status });
    /** @type {import('@readable-studio/contracts').ChatRunListResponse} */
    const body = { runs: runs.map(design.runs.statusBody) };
    res.json(body);
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    res.json(design.runs.statusBody(run));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.stream(run, req, res);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.cancel(run);
    /** @type {import('@readable-studio/contracts').ChatRunCancelResponse} */
    const body = { ok: true };
    res.json(body);
  });

  // Receives the user's thumbs-up/down (+ reason codes) for an assistant
  // turn and forwards it to Langfuse as a `score-create`. Web persists the
  // feedback itself via PUT /messages/:id; this endpoint exists only as a
  // telemetry side channel — the daemon is the single network egress for
  // Langfuse and gates on `telemetry.metrics + telemetry.content` consent.
  //
  // The consent + sink decision is fast (awaits a small file read, no
  // network); we await it so the response status honestly reflects whether
  // the score was enqueued, skipped for consent, or skipped because no
  // Langfuse sink is configured. The actual Langfuse network call happens
  // as a detached promise inside the bridge.
  app.post('/api/runs/:id/feedback', async (req, res) => {
    const runId = req.params.id;
    const body = (req.body ?? {}) as Partial<{
      projectId: string;
      conversationId: string;
      assistantMessageId: string;
      rating: 'positive' | 'negative';
      reasonCodes: string[];
      hasCustomReason: boolean;
      customReason: string;
    }>;
    if (!runId) {
      return sendApiError(res, 400, 'INVALID_RUN_ID', 'runId missing');
    }
    if (body.rating !== 'positive' && body.rating !== 'negative') {
      return sendApiError(res, 400, 'INVALID_RATING', 'rating must be positive or negative');
    }
    // Drop anything outside the contract-side reason allowlist and
    // deduplicate; otherwise a malformed or replayed client payload could
    // create unknown Langfuse categories or duplicate score ids in the
    // same batch.
    const reasonCodes = Array.isArray(body.reasonCodes)
      ? Array.from(
          new Set(
            body.reasonCodes.filter(
              (c): c is string =>
                typeof c === 'string' && FEEDBACK_REASON_ALLOWLIST.has(c),
            ),
          ),
        )
      : [];
    const customReason = typeof body.customReason === 'string' ? body.customReason : '';
    const reportFeedback = ctx.telemetry?.reportFeedback;
    if (!reportFeedback) {
      res.status(202).json({ status: 'skipped_no_sink' });
      return;
    }
    // Build score metadata bag that lands in the Langfuse score body.
    // Mirrors the PostHog event so analysts can cross-reference.
    const scoreMetadata: Record<string, unknown> = {
      projectId: body.projectId,
      conversationId: body.conversationId,
      assistantMessageId: body.assistantMessageId,
      hasCustomReason: body.hasCustomReason === true,
      customReason,
    };
    const outcome = await reportFeedback({
      runId,
      rating: body.rating,
      reasonCodes,
      hasCustomReason: body.hasCustomReason === true,
      customReason,
      scoreMetadata,
    });
    res.status(202).json(outcome);
  });

  // ---- Connection tests (single-shot JSON; no SSE) ------------------------
  // Settings dialog uses these to verify a config works without sending a
  // real chat. Always return HTTP 200 with `ok: false` on upstream-caused
  // failures so the web layer can render a categorized inline status without
  // unwrapping nested error envelopes; real 4xx/5xx here mean a malformed
  // request or daemon bug.
  app.post('/api/provider/models', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    const protocol = body.protocol;
    if (
      typeof protocol !== 'string' ||
      !['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'].includes(protocol)
    ) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'protocol must be one of anthropic|openai|azure|google|ollama|senseaudio|aihubmix',
      );
    }
    // AIHubMix's catalogue (GET /api/v1/models?type=llm) is public, so its
    // model list loads without a key. Every other protocol needs the key to
    // hit its /v1/models endpoint.
    const apiKeyRequired = protocol !== 'aihubmix';
    if (
      typeof body.baseUrl !== 'string' ||
      typeof body.apiKey !== 'string' ||
      !body.baseUrl.trim() ||
      (apiKeyRequired && !body.apiKey.trim())
    ) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        apiKeyRequired ? 'baseUrl and apiKey are required' : 'baseUrl is required',
      );
    }
    try {
      const proxyDispatcher = proxyDispatcherRequestInit();
      try {
        const result = await listProviderModels({
          protocol,
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          apiVersion:
            typeof body.apiVersion === 'string' ? body.apiVersion : undefined,
          signal: controller.signal,
          requestInit: proxyDispatcher.requestInit,
        });
        return res.json(result);
      } finally {
        await proxyDispatcher.close();
      }
    } catch (err: any) {
      console.warn(
        `[provider:models] uncaught: ${err instanceof Error ? err.message : String(err)}`,
      );
      return sendApiError(res, 500, 'INTERNAL', 'Provider model discovery failed');
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

  app.post('/api/test/connection', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    try {
      if (body.mode === 'provider') {
        const protocol = body.protocol;
        if (
          typeof protocol !== 'string' ||
          !['anthropic', 'openai', 'azure', 'google', 'ollama', 'senseaudio', 'aihubmix'].includes(protocol)
        ) {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'protocol must be one of anthropic|openai|azure|google|ollama|senseaudio|aihubmix',
          );
        }
        if (
          typeof body.baseUrl !== 'string' ||
          typeof body.apiKey !== 'string' ||
          typeof body.model !== 'string' ||
          !body.baseUrl.trim() ||
          !body.apiKey.trim() ||
          !body.model.trim()
        ) {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'baseUrl, apiKey, and model are required',
          );
        }
        try {
          const result = await testProviderConnection({
            protocol,
            baseUrl: body.baseUrl,
            apiKey: body.apiKey,
            model: body.model,
            apiVersion:
              typeof body.apiVersion === 'string' ? body.apiVersion : undefined,
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:provider] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Connection test failed');
        }
      }

      if (body.mode === 'agent') {
        if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'agentId is required');
        }
        try {
          const def = getAgentDef(body.agentId);
          const testStart = Date.now();
          const safeModel =
            def && typeof body.model === 'string'
              ? isKnownModel(def, body.model)
                ? body.model
                : sanitizeCustomModel(body.model)
              : undefined;
          if (def && typeof body.model === 'string' && body.model.trim() && !safeModel) {
            return res.json({
              ok: false,
              kind: 'invalid_model_id',
              latencyMs: Date.now() - testStart,
              model: body.model.trim(),
              agentName: def.name,
              detail: 'Invalid custom model id. Use a model id that starts with a letter or number and contains no spaces.',
            });
          }
          const safeReasoning =
            def &&
            typeof body.reasoning === 'string' &&
            Array.isArray(def.reasoningOptions)
              ? (def.reasoningOptions.find((r: any) => r.id === body.reasoning)?.id ?? undefined)
              : undefined;
          const result = await testAgentConnection({
            agentId: body.agentId,
            model: safeModel ?? undefined,
            reasoning: safeReasoning,
            agentCliEnv:
              body.agentCliEnv && typeof body.agentCliEnv === 'object'
                ? body.agentCliEnv
                : undefined,
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:agent] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Agent test failed');
        }
      }

      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'mode must be one of provider|agent',
      );
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

  // ---- Critique Theater endpoints (Phase 6) --------------------------------

  // POST /api/projects/:projectId/critique/:runId/interrupt
  // Cascades an AbortController to the in-flight orchestrator for the given run.
  app.post(
    '/api/projects/:projectId/critique/:runId/interrupt',
    handleCritiqueInterrupt(db, critiqueRunRegistry),
  );

  // GET /api/projects/:projectId/critique/:runId/artifact
  // Streams the SHIP <ARTIFACT> body the orchestrator persisted, with
  // mime derived from the file extension on disk. Cross-project leak
  // guard mirrors the interrupt route. The web layer fetches this as
  // the logical artifact handle so it never sees daemon paths.
  //
  // Response cap is threaded from cfg.parserMaxBlockBytes so a row that
  // the orchestrator + writer accepted is always retrievable.
  app.get(
    '/api/projects/:projectId/critique/:runId/artifact',
    handleCritiqueArtifact(db, {
      artifactsRoot: critiqueArtifactsRoot,
      responseCapBytes: critiqueResponseCapBytes,
    }),
  );

  // ---- API Proxy (SSE) for API-compatible endpoints ------------------------
  // Browser → daemon → external API. Avoids CORS issues with third-party
  // providers. This keeps BYOK setup zero-config for local users at the cost of
  // one local streaming hop through the daemon.

  const redactAuthTokens = (text: string) =>
    text.replace(/Bearer [A-Za-z0-9_\-.+/=]+/g, 'Bearer [REDACTED]');

  // DNS-aware wrapper. The sync `validateBaseUrl` only inspects the literal
  // hostname string, so a public DNS name pointing at an internal address
  // (`internal.example.com → 10.0.0.5`) still passes. We delegate to
  // `validateBaseUrlResolved` here so every proxy/stream handler runs the
  // same resolved-IP check before issuing the upstream request.
  const validateExternalApiBaseUrl = (baseUrl: string) => {
    return validateBaseUrlResolved(baseUrl);
  };

  const proxyErrorCode = (status: number) => {
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'UPSTREAM_UNAVAILABLE';
  };

  const sendProxyError = (sse: any, message: string, init: any = {}) => {
    sse.send('error', {
      message,
      error: {
        code: init.code || 'UPSTREAM_UNAVAILABLE',
        message,
        ...(init.details === undefined ? {} : { details: init.details }),
        ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
      },
    });
  };

  const appendVersionedApiPath = (baseUrl: string, path: string) => {
    const url = new URL(baseUrl);
    // `URL.pathname` setter normalizes an empty string back to "/", so
    // we work in a local string to detect the no-path and no-version
    // cases.
    const trimmed = url.pathname.replace(/\/+$/, '');
    // Auto-inject `/v1` whenever the supplied path doesn't already
    // contain a `/vN` segment. This handles all four preset shapes:
    //   bare host                            → /v1/<route>            (api.openai.com, api.anthropic.com)
    //   ends in /vN                          → no inject              (api.openai.com/v1, /v1)
    //   /vN sub-path                         → no inject              (api.deepinfra.com/v1/openai, openrouter.ai/api/v1)
    //   non-versioned compat sub-path        → /v1/<route>            (api.deepseek.com/anthropic, api.minimaxi.com/anthropic)
    // Previously the check was end-of-path only, which broke the
    // /v1/openai sub-path case. A naive "non-empty path → respect"
    // would break the /anthropic sub-path case. Matching `/vN` as a
    // segment anywhere in the path threads both correctly.
    url.pathname = /\/v\d+(\/|$)/.test(trimmed)
      ? `${trimmed}${path}`
      : `${trimmed}/v1${path}`;
    return url.toString();
  };

  const collectSseFrame = (frame: string) => {
    const lines = frame.replace(/\r/g, '').split('\n');
    const dataLines = [];
    let event = 'message';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.push(value);
    }
    const payload = dataLines.join('\n');
    if (!payload) return { event, payload: '', data: null };
    if (payload === '[DONE]') return { event, payload, data: null };
    try {
      return { event, payload, data: JSON.parse(payload) };
    } catch {
      return { event, payload, data: null };
    }
  };

  const streamUpstreamSse = async (response: any, onFrame: any) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (await onFrame(collectSseFrame(frame))) {
          // Fire-and-forget cancel: awaiting hangs on some response-stream
          // implementations (notably Response built from Uint8Array body,
          // exposed by tests/proxy-routes.test.ts ollama case where the
          // mock body's tee'd cancel() never resolves). The cancel signal
          // is a hint; we're already returning from the function, so we
          // don't gain anything by blocking on it.
          void reader.cancel().catch(() => {});
          return;
        }
      }
    }

    const tail = buffer.trim();
    if (tail) await onFrame(collectSseFrame(tail));
  };

  const streamUpstreamNdjson = async (response: any, onFrame: any) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const data = JSON.parse(line);
          if (await onFrame({ data })) {
            // See note in streamUpstreamSse — fire-and-forget cancel.
            void reader.cancel().catch(() => {});
            return;
          }
        } catch {
          // Ignore malformed provider keepalive lines.
        }
      }
    }

    const tail = buffer.trim();
    if (tail) {
      try {
        const data = JSON.parse(tail);
        await onFrame({ data });
      } catch {
        // Ignore malformed provider tail data.
      }
    }
  };

  const extractOpenAIText = (data: any) => {
    const choices = data?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const first = choices[0];
    if (typeof first?.delta?.content === 'string') return first.delta.content;
    if (typeof first?.text === 'string') return first.text;
    return '';
  };

  const extractStreamErrorMessage = (data: any) => {
    const err = data?.error;
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err?.message === 'string') return err.message;
    try {
      return JSON.stringify(err);
    } catch {
      return 'unspecified provider error';
    }
  };

  const extractGeminiText = (data: any) => {
    const candidates = data?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((part) => part?.text).filter((text) => typeof text === 'string').join('');
  };

  const benignGeminiFinishReasons = new Set(['', 'STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);
  const extractGeminiBlockMessage = (data: any) => {
    const feedback = data?.promptFeedback;
    if (typeof feedback?.blockReason === 'string' && feedback.blockReason) {
      const tail = typeof feedback.blockReasonMessage === 'string' && feedback.blockReasonMessage
        ? ` — ${feedback.blockReasonMessage}`
        : '';
      return `Gemini blocked the prompt (${feedback.blockReason})${tail}.`;
    }
    const candidates = data?.candidates;
    if (!Array.isArray(candidates)) return '';
    for (const candidate of candidates) {
      const reason = candidate?.finishReason;
      if (typeof reason !== 'string' || benignGeminiFinishReasons.has(reason)) continue;
      const tail = typeof candidate?.finishMessage === 'string' && candidate.finishMessage
        ? ` — ${candidate.finishMessage}`
        : '';
      return `Gemini stopped the response (${reason})${tail}.`;
    }
    return '';
  };

  // Per-request role-marker guard for BYOK proxy streams (#3247).
  function createDeltaGuard(sse: any) {
    const guard = createRoleMarkerGuard('proxy');
    return {
      sendDelta(text: string) {
        if (guard.contaminated || !text) return;
        const safe = guard.feedText(text);
        if (safe.length > 0) {
          sse.send('delta', { delta: safe });
        }
        if (guard.contaminated) {
          const warn = guard.warningEvent();
          const markerText = warn?.marker ?? '## user';
          sse.send('delta', {
            delta: `\n\n---\n⚠️ **Security warning:** The model attempted to emit a fabricated role marker (\`${markerText}\`). Response was truncated to prevent unauthorized instruction injection. See issue #3247.\n`,
          });
        }
      },
      get contaminated() { 
        return guard.contaminated; 
      },
    };
  }

  // ---- Reusable base-chat streamers (text only — no tool loop) -------------
  // Both the native /api/proxy/{anthropic,google}/stream routes AND the
  // AIHubMix model-routed proxy call these. Only the resolved url + headers
  // differ (AIHubMix adds the APP-Code header and a different origin), so the
  // wire/SSE handling lives here once.

  const buildAnthropicChatPayload = (
    model: string,
    systemPrompt: unknown,
    messages: unknown,
    maxTokens: unknown,
  ) => {
    const payload: any = {
      model,
      max_tokens:
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      messages: Array.isArray(messages) ? messages : [],
      stream: true,
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.system = systemPrompt;
    }
    return payload;
  };

  const runAnthropicChatStream = async (
    res: any,
    opts: { url: string; headers: Record<string, string>; payload: any; logTag: string },
  ) => {
    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      sse.send('start', { model: opts.payload?.model });
      const response = await fetch(opts.url, {
        ...proxyDispatcher.requestInit,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[${opts.logTag}] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ event, data }: any) => {
        if (!data) return false;
        if (event === 'error' || data.type === 'error') {
          const message = data.error?.message || data.message || 'Anthropic upstream error';
          sendProxyError(sse, message, { details: data });
          ended = true;
          return true;
        }
        if (event === 'content_block_delta' && typeof data.delta?.text === 'string') {
          guard.sendDelta(data.delta.text);
          if (guard.contaminated) {
            sse.send('end', {});
            ended = true;
            return true;
          }
        }
        if (event === 'message_stop') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[${opts.logTag}] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  };

  const buildGeminiChatPayload = (
    systemPrompt: unknown,
    messages: unknown,
    maxTokens: unknown,
  ) => {
    const contents = (Array.isArray(messages) ? messages : []).map((message: any) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));
    const payload: any = {
      contents,
      generationConfig: {
        maxOutputTokens:
          typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      },
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    return payload;
  };

  const runGeminiChatStream = async (
    res: any,
    opts: { url: string; headers: Record<string, string>; payload: any; model: string; logTag: string },
  ) => {
    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      sse.send('start', { model: opts.model });
      const response = await fetch(opts.url, {
        ...proxyDispatcher.requestInit,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify(opts.payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[${opts.logTag}] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ data }: any) => {
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Gemini error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractGeminiText(data);
        if (delta) {
          guard.sendDelta(delta);
          if (guard.contaminated) {
            sse.send('end', {});
            ended = true;
            return true;
          }
        }
        const blockMessage = extractGeminiBlockMessage(data);
        if (blockMessage) {
          sendProxyError(sse, blockMessage, { details: data });
          ended = true;
          return true;
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[${opts.logTag}] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  };

  app.post('/api/proxy/anthropic/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = await validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = appendVersionedApiPath(baseUrl, '/messages');
    console.log(
      `[proxy:anthropic] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    return runAnthropicChatStream(res, {
      url,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload: buildAnthropicChatPayload(model, systemPrompt, messages, maxTokens),
      logTag: 'proxy:anthropic',
    });
  });

  app.post('/api/proxy/openai/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = await validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = appendVersionedApiPath(baseUrl, '/chat/completions');
    console.log(
      `[proxy:openai] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const payload: any = {
      model,
      messages: payloadMessages,
      ...buildOpenAIChatTokenParam(
        model,
        typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      ),
      stream: true,
    };

    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      sse.send('start', { model });
      const response = await fetch(url, {
        ...proxyDispatcher.requestInit,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(validated.parsed!.hostname === 'openrouter.ai' ? {
            'HTTP-Referer': 'https://github.com/sanghyunna/readable-studio',
            'X-Title': 'Readable Studio',
          } : {}),
        },
        body: JSON.stringify(payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `[proxy:openai] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
        );
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ payload, data }: any) => {
        if (payload === '[DONE]') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Provider error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractOpenAIText(data);
        if (delta) { 
          guard.sendDelta(delta); 
          if (guard.contaminated) { 
            sse.send('end', {}); 
            ended = true; 
            return true; 
          } 
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[proxy:openai] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  });

  app.post('/api/proxy/azure/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens, apiVersion } =
      proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'baseUrl, apiKey, and model are required',
      );
    }

    const validated = await validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = new URL(baseUrl);
    const basePath = url.pathname.replace(/\/+$/, '');
    const usesVersionedOpenAIPath = /\/openai\/v\d+(?:$|\/)/.test(basePath);
    const version =
      typeof apiVersion === 'string' && apiVersion.trim()
        ? apiVersion.trim()
        : usesVersionedOpenAIPath
          ? ''
          : '2024-10-21';
    url.pathname = usesVersionedOpenAIPath
      ? `${basePath}/chat/completions`
      : `${basePath}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
    if (usesVersionedOpenAIPath && !version) {
      url.searchParams.delete('api-version');
    }
    if (version) {
      url.searchParams.set('api-version', version);
    }
    console.log(
      `[proxy:azure] ${req.method} ${validated.parsed!.hostname} deployment=${model} api-version=${version || 'omitted'}`,
    );

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const effectiveMaxTokens =
      typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192;
    const payload = {
      ...(usesVersionedOpenAIPath ? { model } : {}),
      messages: payloadMessages,
      ...buildLegacyMaxTokensParam(effectiveMaxTokens),
      stream: true,
    };
    const retryPayload = {
      ...(usesVersionedOpenAIPath ? { model } : {}),
      messages: payloadMessages,
      ...buildMaxCompletionTokensParam(effectiveMaxTokens),
      stream: true,
    };

    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      sse.send('start', { model });
      const requestInit = {
        ...proxyDispatcher.requestInit,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        redirect: 'error' as const,
      };
      let response = await fetch(url, {
        ...requestInit,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errorText = await response.text();
        if (
          response.status === 400 &&
          isUnsupportedMaxTokensError(errorText)
        ) {
          console.warn(
            `[proxy:azure] retrying request with max_completion_tokens deployment=${model}`,
          );
          response = await fetch(url, {
            ...requestInit,
            body: JSON.stringify(retryPayload),
          });
          if (response.ok) {
            errorText = '';
          } else {
            errorText = await response.text();
          }
        }
        if (!response.ok) {
          console.error(
            `[proxy:azure] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
          );
          sendProxyError(sse, `Upstream error: ${response.status}`, {
            code: proxyErrorCode(response.status),
            details: errorText,
            retryable: response.status === 429 || response.status >= 500,
          });
          return sse.end();
        }
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamSse(response, ({ payload: ssePayload, data }: any) => {
        if (ssePayload === '[DONE]') {
          sse.send('end', {});
          ended = true;
          return true;
        }
        if (!data) return false;
        const streamError = extractStreamErrorMessage(data);
        if (streamError) {
          sendProxyError(sse, `Azure error: ${streamError}`, { details: data });
          ended = true;
          return true;
        }
        const delta = extractOpenAIText(data);
        if (delta) { guard.sendDelta(delta); 
          if (guard.contaminated) { 
            sse.send('end', {}); 
            ended = true; 
            return true; 
          } 
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[proxy:azure] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  });

  app.post('/api/proxy/google/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!apiKey || !model) {
      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'apiKey and model are required',
      );
    }

    const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
    const validated = await validateExternalApiBaseUrl(effectiveBaseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const url = googleStreamGenerateContentUrl(effectiveBaseUrl, model);
    console.log(
      `[proxy:google] ${req.method} ${validated.parsed!.hostname} model=${model}`,
    );

    return runGeminiChatStream(res, {
      url,
      headers: { 'x-goog-api-key': apiKey },
      payload: buildGeminiChatPayload(systemPrompt, messages, maxTokens),
      model,
      logTag: 'proxy:google',
    });
  });

  app.post('/api/proxy/ollama/stream', async (req, res) => {
    const proxyBody = req.body || {};
    if (rejectProxyPluginContext(proxyBody, res)) return;
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!apiKey || !model) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'apiKey and model are required');
    }

    const effectiveBaseUrl = baseUrl || 'https://ollama.com';
    const validated = await validateExternalApiBaseUrl(effectiveBaseUrl);
    if (validated.error) {
      return sendApiError(
        res,
        validated.forbidden ? 403 : 400,
        validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
        validated.error,
      );
    }

    const clean = effectiveBaseUrl.replace(/\/+$/, '').replace(/\/api\/?$/, '');
    const url = `${clean}/api/chat`;
    console.log(`[proxy:ollama] ${req.method} ${validated.parsed!.hostname} model=${model}`);

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const payload: any = { model, messages: payloadMessages, stream: true };
    if (typeof maxTokens === 'number' && maxTokens > 0) {
      payload.options = { num_predict: maxTokens };
    }

    const sse = createSseResponse(res);
    let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
    try {
      proxyDispatcher = proxyDispatcherRequestInit();
      sse.send('start', { model });
      const response = await fetch(url, {
        ...proxyDispatcher.requestInit,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        redirect: 'error',
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[proxy:ollama] upstream error: ${response.status} ${redactAuthTokens(errorText)}`);
        sendProxyError(sse, `Upstream error: ${response.status}`, {
          code: proxyErrorCode(response.status),
          details: errorText,
          retryable: response.status === 429 || response.status >= 500,
        });
        return sse.end();
      }

      let ended = false;
      const guard = createDeltaGuard(sse);
      await streamUpstreamNdjson(response, ({ data }: any) => {
        if (!data) return false;
        if (data.done) {
          sse.send('end', {});
          ended = true;
          return true;
        }
        const content = data.message?.content;
        if (typeof content === 'string' && content) { 
          guard.sendDelta(content); 
          if (guard.contaminated) { 
            sse.send('end', {}); 
            ended = true; 
            return true; 
          } 
        }
        return false;
      });
      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[proxy:ollama] internal error: ${err.message}`);
      sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
      sse.end();
    } finally {
      await proxyDispatcher?.close();
    }
  });

  interface ByokChatProxyOptions {
    logTag: string;
    defaultBaseUrl: string;
    buildHeaders: (apiKey: string) => Record<string, string>;
    routeByModel?: boolean;
  }

  const registerByokChatProxy = (routePath: string, opts: ByokChatProxyOptions) => {
    app.post(routePath, async (req, res) => {
      const proxyBody = req.body || {};
      if (rejectProxyPluginContext(proxyBody, res)) return;
      const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
      if (!apiKey || !model) {
        return sendApiError(
          res,
          400,
          'BAD_REQUEST',
          'apiKey and model are required',
        );
      }

      const effectiveBaseUrl = baseUrl || opts.defaultBaseUrl;
      const validated = await validateExternalApiBaseUrl(effectiveBaseUrl);
      if (validated.error) {
        return sendApiError(
          res,
          validated.forbidden ? 403 : 400,
          validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST',
          validated.error,
        );
      }

      if (opts.routeByModel) {
        const family = classifyAIHubMixModel(model);
        const origin = aihubmixOriginFromBase(effectiveBaseUrl);
        if (family === 'anthropic') {
          const anthropicUrl = appendVersionedApiPath(origin, '/messages');
          const anthropicHeaders = {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            ...aihubmixAppCodeHeader(),
          };
          console.log(
            `[${opts.logTag}] ${req.method} anthropic ${anthropicUrl} model=${model}`,
          );
          return runAnthropicChatStream(res, {
            url: anthropicUrl,
            headers: anthropicHeaders,
            payload: buildAnthropicChatPayload(model, systemPrompt, messages, maxTokens),
            logTag: opts.logTag,
          });
        }
        if (family === 'gemini') {
          const geminiUrl = googleStreamGenerateContentUrl(`${origin}/gemini`, model);
          const geminiHeaders = { 'x-goog-api-key': apiKey, ...aihubmixAppCodeHeader() };
          console.log(
            `[${opts.logTag}] ${req.method} gemini ${geminiUrl} model=${model}`,
          );
          return runGeminiChatStream(res, {
            url: geminiUrl,
            headers: geminiHeaders,
            payload: buildGeminiChatPayload(systemPrompt, messages, maxTokens),
            model,
            logTag: opts.logTag,
          });
        }
      }

      const url = appendVersionedApiPath(effectiveBaseUrl, '/chat/completions');
      console.log(
        `[${opts.logTag}] ${req.method} openai ${url} model=${model}`,
      );

      const payloadMessages = Array.isArray(messages) ? [...messages] : [];
      if (typeof systemPrompt === 'string' && systemPrompt) {
        payloadMessages.unshift({ role: 'system', content: systemPrompt });
      }

      const payload: any = {
        model,
        messages: payloadMessages,
        max_tokens:
          typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
        stream: true,
      };

      const sse = createSseResponse(res);
      let proxyDispatcher: ReturnType<typeof proxyDispatcherRequestInit> | null = null;
      try {
        proxyDispatcher = proxyDispatcherRequestInit();
        sse.send('start', { model });
        const response = await fetch(url, {
          ...proxyDispatcher.requestInit,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...opts.buildHeaders(apiKey),
          },
          body: JSON.stringify(payload),
          redirect: 'error',
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `[${opts.logTag}] upstream error: ${response.status} ${redactAuthTokens(errorText)}`,
          );
          sendProxyError(sse, `Upstream error: ${response.status}`, {
            code: proxyErrorCode(response.status),
            details: errorText,
            retryable: response.status === 429 || response.status >= 500,
          });
          return sse.end();
        }

        let ended = false;
        const guard = createDeltaGuard(sse);
        await streamUpstreamSse(response, ({ payload: ssePayload, data }: any) => {
          if (ssePayload === '[DONE]') {
            sse.send('end', {});
            ended = true;
            return true;
          }
          if (!data) return false;
          const streamError = extractStreamErrorMessage(data);
          if (streamError) {
            sendProxyError(sse, `Provider error: ${streamError}`, { details: data });
            ended = true;
            return true;
          }
          const delta = extractOpenAIText(data);
          if (delta) {
            guard.sendDelta(delta);
            if (guard.contaminated) {
              sse.send('end', {});
              ended = true;
              return true;
            }
          }
          return false;
        });
        if (!ended) sse.send('end', {});
        sse.end();
      } catch (err: any) {
        console.error(`[${opts.logTag}] internal error: ${err.message}`);
        sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
        sse.end();
      } finally {
        await proxyDispatcher?.close();
      }
    });
  };

  // SenseAudio chat completions: OpenAI-compatible chat wire, Bearer auth.
  registerByokChatProxy('/api/proxy/senseaudio/stream', {
    logTag: 'proxy:senseaudio',
    defaultBaseUrl: 'https://api.senseaudio.cn',
    buildHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
  });

  // AIHubMix chat completions: OpenAI-compatible by default, with native model routing.
  registerByokChatProxy('/api/proxy/aihubmix/stream', {
    logTag: 'proxy:aihubmix',
    defaultBaseUrl: AIHUBMIX_DEFAULT_BASE_URL,
    buildHeaders: (apiKey) => aihubmixHeaders(apiKey),
    routeByModel: true,
  });

}
