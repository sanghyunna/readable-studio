import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LOG_BYTES = 256 * 1024;
const MAX_WORK_DIRS = 256;

interface KimiProviderFailure {
  code: 'RATE_LIMITED' | 'AGENT_AUTH_REQUIRED' | 'AGENT_EXECUTION_FAILED';
  message: string;
  retryable: false;
  details: { source: 'kimi_session_log'; statusCode: number; action?: 'login'; reset?: string };
}

// Only project safe provider phrases, never arbitrary log text: upstream
// messages may embed credentials, account names, request IDs or signed URLs.
function providerSummary(message: string): string {
  const phrases = [
    'bad gateway', 'service unavailable', 'internal server error', 'gateway timeout',
    'model not found', 'unknown model', 'invalid model', 'invalid request',
    'permission denied', 'access denied', 'forbidden', 'not found',
    'context length exceeded', 'too many requests', 'request timeout',
  ];
  return phrases.find((phrase) => message.toLowerCase().includes(phrase)) ?? 'provider request failed';
}

function describeFailure(statusCode: number, message: string): KimiProviderFailure {
  const details: KimiProviderFailure['details'] = { source: 'kimi_session_log', statusCode };
  if (statusCode === 401 || /unauthorized|authentication failed|invalid (?:api key|token)|expired (?:token|session)/i.test(message)) {
    return { code: 'AGENT_AUTH_REQUIRED', message: `Kimi login failed (HTTP ${statusCode}). Log in to Kimi again and retry.`, retryable: false, details: { ...details, action: 'login' } };
  }
  if (statusCode === 429 || /(?:usage|weekly|quota|rate)[ -]limit|quota.{0,20}(?:exceeded|reached)/i.test(message)) {
    // Reset descriptions are allowlisted too; do not copy a provider's whole
    // sentence, which may contain account identifiers or subscription links.
    const reset = /reset when the current 7-day window ends/i.test(message)
      ? 'current 7-day window ends'
      : message.match(/resets?(?: at| on| in)?\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}| UTC)?)|\d+\s+(?:seconds?|minutes?|hours?|days?))/i)?.[1];
    if (reset) details.reset = reset;
    const resetMessage = reset === 'current 7-day window ends'
      ? ' It resets when the current 7-day window ends.'
      : reset ? ` Reset: ${reset}.` : '';
    return { code: 'RATE_LIMITED', message: `The Kimi account usage limit is reached (HTTP ${statusCode}).${resetMessage} Retry after the limit resets.`, retryable: false, details };
  }
  return { code: 'AGENT_EXECUTION_FAILED', message: `Kimi provider error (HTTP ${statusCode}): ${providerSummary(message)}.`, retryable: false, details };
}

function parseFailure(log: string): KimiProviderFailure | null {
  const lines = log.split(/\r?\n/);
  for (const line of lines.reverse()) {
    // Kimi 0.27 records both the failed request and the final ACP failure.
    // The final error is a JSON object inside a JSON-escaped log field.
    if (line.includes('acp: turn ended with failed reason')) {
      const field = line.match(/\berror=("(?:\\.|[^"\\])*")/);
      if (!field) continue;
      try {
        const error = JSON.parse(JSON.parse(field[1]!)) as { code?: unknown; message?: unknown; details?: { statusCode?: unknown } };
        if (error.code !== 'provider.api_error' || typeof error.message !== 'string') continue;
        const status = Number(error.details?.statusCode ?? error.message.match(/^(\d{3})\b/)?.[1]);
        if (Number.isInteger(status) && status >= 400 && status <= 599) return describeFailure(status, error.message);
      } catch {
        // Optional external diagnostic data may be incomplete or malformed.
      }
    } else if (line.includes('llm request failed')) {
      const status = Number(line.match(/\bstatusCode=(\d{3})\b/)?.[1]);
      const field = line.match(/\berrorMessage=("(?:\\.|[^"\\])*")/);
      if (!field || status < 400 || status > 599 || !Number.isInteger(status)) continue;
      try { return describeFailure(status, JSON.parse(field[1]!) as string); } catch {
        // A partial log line is not evidence of a provider failure.
      }
    }
  }
  return null;
}

/** Read only the exact ACP session's diagnostic log, never the global log. */
export function readKimiSessionFailure(sessionId: string | null, env: NodeJS.ProcessEnv = process.env): KimiProviderFailure | null {
  if (!sessionId || !/^session_[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(sessionId)) return null;
  const home = process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  const sessionsRoot = path.join(home || os.homedir(), '.kimi-code', 'sessions');
  let directories: fs.Dir | undefined;
  try {
    directories = fs.opendirSync(sessionsRoot);
    for (let count = 0; count < MAX_WORK_DIRS; count++) {
      const entry = directories.readSync();
      if (!entry) break;
      if (!entry.isDirectory() || !entry.name.startsWith('wd_')) continue;
      const logPath = path.join(sessionsRoot, entry.name, sessionId, 'logs', 'kimi-code.log');
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(logPath, 'r');
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) continue;
        const length = Math.min(stat.size, MAX_LOG_BYTES);
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(descriptor, buffer, 0, length, Math.max(0, stat.size - length));
        return parseFailure(buffer.toString('utf8', 0, read));
      } catch {
        // Logs are optional and can disappear during Kimi's session cleanup.
        // Their absence must retain the original empty-turn error.
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
  } catch {
    // Kimi may not have created its data directory, or it may be inaccessible.
  } finally {
    directories?.closeSync();
  }
  return null;
}
