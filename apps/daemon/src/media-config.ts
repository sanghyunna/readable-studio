// Per-provider credentials for the media dispatcher.
//
// Media settings APIs push API keys here; the daemon persists them to
// .readable-studio/media-config.json
// and reads them at generation time. Environment variables override the
// stored values so power users can keep keys out of the workspace
// folder altogether (`READABLE_OPENAI_API_KEY=… node daemon/cli.js`).
//
// Storage location (precedence high → low):
//   1. READABLE_MEDIA_CONFIG_DIR=DIR   → <DIR>/media-config.json
//   2. READABLE_DATA_DIR=DIR           → <DIR>/media-config.json
//   3. (default)                 → <projectRoot>/.readable-studio/media-config.json
// The default is unchanged for workspace-local installs. (1) lets a
// supervisor relocate just the credentials file. (2) means installs
// that already set READABLE_DATA_DIR for the rest of the daemon's runtime
// state (Nix-store / immutable-image installs, the packaged daemon at
// apps/packaged/src/sidecars.ts:createPackagedDaemonManagedPathEnv,
// the Home Manager / NixOS modules) get media-config there too without
// any extra plumbing. Both env values are resolved with the same
// semantics as READABLE_DATA_DIR in server.ts:resolveDataDir(): the shared
// expandHomePrefix() helper handles `~`, `$HOME`, and `${HOME}` (with
// either `/` or `\` separator), then relative paths anchor to
// <projectRoot> (NOT process.cwd, which is unrelated to the workspace
// when systemd or launchd starts the daemon).
//
// Migration note: a workspace install that sets a custom READABLE_DATA_DIR
// AND has a pre-existing `<projectRoot>/.readable-studio/media-config.json` will
// start reading from `<READABLE_DATA_DIR>/media-config.json` instead. Move
// the file once or set READABLE_MEDIA_CONFIG_DIR=<projectRoot>/.readable-studio to keep
// the old location.
//
// The file is intentionally simple JSON — no encryption, no schema
// versioning yet. The daemon listens on 127.0.0.1 only and the workspace
// is already trusted, so adding a vault here would mostly be theatre.
// We DO mask keys when reading via the GET endpoint so the UI doesn't
// echo secrets back into the DOM.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandHomePrefix } from './home-expansion.js';
import { resolveXAIBearer } from './xai-credentials.js';
import { isSandboxModeEnabled } from './sandbox-mode.js';

type ProviderEntry = { apiKey?: string; baseUrl?: string; model?: string };
type ProviderMap = Record<string, ProviderEntry>;
type JsonRecord = Record<string, unknown>;
type OAuthCredential = { apiKey: string; source: string };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object';
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
}

const ENV_KEYS: Record<string, string[]> = {
  // OPENAI_API_KEY is the canonical env for the standard OpenAI API.
  // AZURE_API_KEY / AZURE_OPENAI_API_KEY are the canonical envs Azure
  // OpenAI examples use — we share the openai provider slot so a user
  // who pastes an Azure deployment URL into the OpenAI Base URL field
  // gets the credential picked up automatically.
  openai: [
    'READABLE_OPENAI_API_KEY',
    'OPENAI_API_KEY',
    'AZURE_API_KEY',
    'AZURE_OPENAI_API_KEY',
  ],
  volcengine: ['READABLE_VOLCENGINE_API_KEY', 'ARK_API_KEY', 'VOLCENGINE_API_KEY'],
  // READABLE_GROK_API_KEY first (the project-reserved override, same shape as
  // every other provider above), then XAI_API_KEY as the canonical
  // upstream env per docs.x.ai quickstart — so users who already export
  // it for the official SDK don't have to re-paste into Settings.
  grok: ['READABLE_GROK_API_KEY', 'XAI_API_KEY'],
  nanobanana: ['READABLE_NANOBANANA_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  imagerouter: ['READABLE_IMAGEROUTER_API_KEY', 'IMAGEROUTER_API_KEY'],
  openrouter: ['READABLE_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  'custom-image': ['READABLE_CUSTOM_IMAGE_API_KEY', 'CUSTOM_IMAGE_API_KEY'],
  bfl: ['READABLE_BFL_API_KEY', 'BFL_API_KEY'],
  fal: ['READABLE_FAL_KEY', 'FAL_KEY'],
  replicate: ['READABLE_REPLICATE_API_TOKEN', 'REPLICATE_API_TOKEN'],
  google: ['READABLE_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  kling: ['READABLE_KLING_API_KEY', 'KLING_API_KEY'],
  midjourney: ['READABLE_MIDJOURNEY_API_KEY'],
  minimax: ['READABLE_MINIMAX_API_KEY', 'MINIMAX_API_KEY'],
  suno: ['READABLE_SUNO_API_KEY'],
  udio: ['READABLE_UDIO_API_KEY'],
  elevenlabs: ['READABLE_ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEY'],
  fishaudio: ['READABLE_FISHAUDIO_API_KEY', 'FISH_AUDIO_API_KEY'],
  senseaudio: ['READABLE_SENSEAUDIO_API_KEY', 'SENSEAUDIO_API_KEY'],
  aihubmix: ['READABLE_AIHUBMIX_API_KEY', 'AIHUBMIX_API_KEY'],
  tavily: ['READABLE_TAVILY_API_KEY', 'TAVILY_API_KEY'],
  leonardo: ['READABLE_LEONARDO_API_KEY', 'LEONARDO_API_KEY'],
};

// Resolve an `READABLE_*_DIR` env override using the same semantics as
// `resolveDataDir()` in server.ts: expandHomePrefix() handles the `~`,
// `$HOME`, and `${HOME}` shorthands (with either `/` or `\` separator),
// then relative paths anchor to <projectRoot>, not process.cwd, since
// the daemon is often launched from a directory that has nothing to do
// with the workspace, e.g. systemd's `/`. The writability check that
// resolveDataDir does on startup is intentionally NOT replicated here:
// configFile() is on the read path and a missing/unwritable directory
// is a normal "no config yet" condition handled by readStored(); the
// write path's mkdir(recursive) creates the directory on first use.
function resolveOverrideDir(raw: string, projectRoot: string): string {
  // Share expandHomePrefix with resolveDataDir (server.ts) so READABLE_DATA_DIR
  // and READABLE_MEDIA_CONFIG_DIR cannot split state under a $HOME-style value.
  // A launcher passing READABLE_DATA_DIR=$HOME/.readable-studio without a shell to
  // expand it would otherwise route SQLite/projects/artifacts to the
  // expanded path while media-config.json stayed under
  // <projectRoot>/$HOME/.readable-studio, leaving stored credentials
  // unreachable on the next read.
  const expanded = expandHomePrefix(raw);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(projectRoot, expanded);
}

function envOverrideDir(envName: string, projectRoot: string): string | null {
  const raw = process.env[envName];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? resolveOverrideDir(trimmed, projectRoot) : null;
}

/**
 * Resolve the directory media-config.json (and credentials living next to
 * it, like xai-tokens.json) actually live in. Precedence: explicit
 * media-config override > general data dir > default.
 */
export function mediaConfigDir(projectRoot: string): string {
  return (
    envOverrideDir('READABLE_MEDIA_CONFIG_DIR', projectRoot)
    ?? envOverrideDir('READABLE_DATA_DIR', projectRoot)
    ?? path.join(projectRoot, '.readable-studio')
  );
}

function configFile(projectRoot: string): string {
  return path.join(mediaConfigDir(projectRoot), 'media-config.json');
}

async function readStoredFile(projectRoot: string): Promise<JsonRecord> {
  try {
    const raw = await readFile(configFile(projectRoot), 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return {};
    throw err;
  }
}

async function readStored(projectRoot: string): Promise<ProviderMap> {
  const parsed = await readStoredFile(projectRoot);
  return isRecord(parsed.providers) ? (parsed.providers as ProviderMap) : {};
}

function readEnvKey(providerId: string): string | null {
  const keys = ENV_KEYS[providerId];
  if (!keys) return null;
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function readNestedString(obj: unknown, keys: string[]): string {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!isRecord(cur)) return '';
    cur = cur[key];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : '';
}

async function readJsonIfPresent(file: string): Promise<JsonRecord | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    // Auth files are best-effort fallbacks. A malformed local auth cache
    // should not break the Settings page or hide stored provider config.
    return null;
  }
}

function apiKeyFromCodexAuth(data: unknown): string {
  return readNestedString(data, ['OPENAI_API_KEY']);
}

async function resolveOpenAIAuthFileCredential(): Promise<OAuthCredential | null> {
  if (isSandboxModeEnabled(process.env)) return null;
  const home = os.homedir();
  const codexAuth = await readJsonIfPresent(
    path.join(home, '.codex', 'auth.json'),
  );
  const apiKey = apiKeyFromCodexAuth(codexAuth);
  if (apiKey) {
    return { apiKey, source: 'codex-auth' };
  }

  return null;
}

async function resolveXAIOAuthCredential(
  projectRoot: string,
): Promise<OAuthCredential | null> {
  // 1. Readable Studio-native xAI OAuth tokens (written by the daemon's own
  //    xai-oauth.ts client when the user authorizes inside Readable Studio).
  const odBearer = await resolveXAIBearer(mediaConfigDir(projectRoot)).catch(
    () => null,
  );
  if (odBearer) {
    return {
      apiKey: odBearer.accessToken,
      source: `oauth-xai-${odBearer.source}`,
    };
  }

  if (isSandboxModeEnabled(process.env)) return null;

  // 2. Borrow the xAI OAuth token Hermes wrote to ~/.hermes/auth.json
  //    when the user ran `hermes auth add xai-oauth`. A user who has already authorized
  //    Hermes doesn't have to run a second OAuth dance inside Readable Studio.
  //    (No proactive refresh here — Hermes itself maintains the token,
  //    and we only borrow what is currently fresh.)
  const home = os.homedir();
  const hermesAuth = await readJsonIfPresent(
    path.join(home, '.hermes', 'auth.json'),
  );
  const hermesXaiToken = readNestedString(hermesAuth, [
    'providers',
    'xai-oauth',
    'tokens',
    'access_token',
  ]);
  if (hermesXaiToken) {
    return { apiKey: hermesXaiToken, source: 'oauth-hermes-xai' };
  }

  return null;
}

/**
 * Resolve credentials for a provider. Env vars win, then stored config,
 * then provider-specific external credential stores. OpenAI only trusts
 * explicit API keys from Codex auth files; Codex/Hermes OAuth tokens are
 * not valid proof that the Images API can be called.
 * Returns { apiKey, baseUrl } where either may be empty string.
 */
export async function resolveProviderConfig(projectRoot: string, providerId: string): Promise<ProviderEntry> {
  const stored = await readStored(projectRoot);
  const entry = stored[providerId] || {};
  const envKey = readEnvKey(providerId);
  const needsExternalCredential = !envKey && !entry.apiKey;
  const externalCredential = needsExternalCredential
    ? providerId === 'openai'
      ? await resolveOpenAIAuthFileCredential()
      : providerId === 'grok'
        ? await resolveXAIOAuthCredential(projectRoot)
        : null
    : null;
  return {
    apiKey: envKey || entry.apiKey || externalCredential?.apiKey || '',
    baseUrl: entry.baseUrl || '',
    ...(typeof entry.model === 'string' && entry.model.trim()
      ? { model: entry.model.trim() }
      : {}),
  };
}

