// Shared URL helpers for plugin detail, preview, and repository links.
// Readable Studio ships no product website, so default share links target the
// canonical GitHub repository. Self-hosted callers can still pass an origin
// that serves the existing `/plugins/<slug>/` detail route.

export const READABLE_STUDIO_REPOSITORY_URL =
  'https://github.com/sanghyunna/readable-studio';

// Slugify one path segment: lower-cased, non-url-safe runs collapsed to `-`,
// leading/trailing `-` trimmed. Must match the landing site byte-for-byte.
export function pluginSlugSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plugin'
  );
}

// Single-segment detail slug = slugified last `/`-segment of the id, e.g.
// `readable-studio/Hero Deck` -> `hero-deck`, `live-dashboard` -> `live-dashboard`.
// This is what the `/plugins/[slug]/` route uses.
export function pluginDetailSlug(id: string): string {
  const last = id.split('/').filter(Boolean).at(-1) ?? id;
  return pluginSlugSegment(last);
}

// Multi-segment slug preserving the namespace as a path separator, e.g.
// `readable-studio/Hero Deck` -> `readable-studio/hero-deck`. Used for the namespaced
// preview route and any list data attributes that want full provenance.
export function pluginSlug(id: string): string {
  return id
    .split('/')
    .map(pluginSlugSegment)
    .join('/');
}

// Site-relative single-segment detail-page path. Trailing slash matches the
// landing site's emitted route. e.g. `/plugins/hero-deck/`.
export function pluginDetailPath(id: string): string {
  return `/plugins/${pluginDetailSlug(id)}/`;
}

// Site-relative namespaced live-HTML preview path, e.g.
// `/plugins/previews/readable-studio/hero-deck/`.
export function pluginPreviewPath(id: string): string {
  return `/plugins/previews/${pluginSlug(id)}/`;
}

// Fully-qualified shareable URL for a plugin detail page. `origin` defaults to
// the public site; a self-hosted daemon may pass its own origin (read from env
// on the daemon side, never here). A trailing slash on `origin` is trimmed so
// we never emit `//plugins/...`.
export function pluginShareUrl(
  id: string,
  origin: string = READABLE_STUDIO_REPOSITORY_URL,
): string {
  const normalizedOrigin = origin.replace(/\/+$/, '');
  if (normalizedOrigin === READABLE_STUDIO_REPOSITORY_URL) {
    const query = encodeURIComponent(`path:plugins ${id}`);
    return `${READABLE_STUDIO_REPOSITORY_URL}/search?q=${query}&type=code`;
  }
  return `${normalizedOrigin}${pluginDetailPath(id)}`;
}
