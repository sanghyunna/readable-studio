// Diagnostic PATH alternatives do not affect an authoritative selection. Cache
// only those scans; ordinary fallback discovery always sees new installations.
const PATH_DIAGNOSTIC_TTL_MS = 5000;
const alternatives = new Map<string, { readonly path: string | null; readonly expiresAt: number }>();

export function executableEnvironmentKey(): string {
  return JSON.stringify([
    process.platform, process.env.PATH, process.env.Path, process.env.PATHEXT,
    process.env.HOME, process.env.USERPROFILE, process.env.READABLE_AGENT_HOME,
    process.env.READABLE_DATA_DIR, process.env.READABLE_RESOURCE_ROOT,
    process.env.READABLE_SANDBOX_MODE, process.env.NPM_CONFIG_PREFIX,
    process.env.npm_config_prefix, process.env.VP_HOME,
  ]);
}

export function cachedExecutableAlternative(key: string, resolve: () => string | null): string | null {
  const now = Date.now();
  const cached = alternatives.get(key);
  if (cached && cached.expiresAt > now) return cached.path;
  for (const [entryKey, entry] of alternatives) {
    if (entry.expiresAt <= now) alternatives.delete(entryKey);
  }
  const resolved = resolve();
  alternatives.set(key, { path: resolved, expiresAt: now + PATH_DIAGNOSTIC_TTL_MS });
  return resolved;
}
