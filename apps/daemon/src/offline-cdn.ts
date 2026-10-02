export type OfflineCdnLibrary = { lib: 'fontawesome' | 'chartjs'; major: number; version: string; files: string[] };
export type OfflineCdnManifest = { libraries: OfflineCdnLibrary[] };
export type OfflineCdnResolution = Pick<OfflineCdnLibrary, 'lib' | 'major'> & { path: string };

export function isSafeOfflineCdnPath(path: string): boolean {
  return path.length > 0 && !path.includes('\\') && !path.includes('%') && !path.includes(':') && !path.includes('\0') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** Resolve only known free-library URLs to files actually shipped in the manifest. */
export function resolveOfflineCdnUrl(input: string, manifest: OfflineCdnManifest): OfflineCdnResolution | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  let lib: OfflineCdnLibrary['lib'];
  let version: string | undefined;
  let file: string;
  let match: RegExpMatchArray | null;
  const host = url.hostname.toLowerCase();
  if (host === 'cdnjs.cloudflare.com' && (match = pathname.match(/^\/ajax\/libs\/(font-awesome|Chart\.js)\/([^/]+)\/(.+)$/i))) {
    lib = match[1]!.toLowerCase() === 'font-awesome' ? 'fontawesome' : 'chartjs';
    version = match[2]; file = lib === 'chartjs' ? `dist/${match[3]}` : match[3]!;
  } else if (['cdn.jsdelivr.net', 'unpkg.com'].includes(host) && (match = pathname.match(/^\/(?:npm\/)?(@fortawesome\/fontawesome-free|font-awesome|chart\.js)(?:@([^/]+))?(?:\/(.*))?$/))) {
    lib = match[1] === 'chart.js' ? 'chartjs' : 'fontawesome'; version = match[2]; file = match[3] ?? '';
    if (!version && match[1] === 'font-awesome') version = '4';
  } else if (host === 'use.fontawesome.com' && (match = pathname.match(/^\/releases\/v([^/]+)\/(.+)$/))) {
    lib = 'fontawesome'; version = match[1]; file = match[2]!;
  } else if (['maxcdn.bootstrapcdn.com', 'stackpath.bootstrapcdn.com'].includes(host) && (match = pathname.match(/^\/font-awesome\/([^/]+)\/(.+)$/))) {
    lib = 'fontawesome'; version = match[1]; file = match[2]!;
  } else if (['kit.fontawesome.com', 'ka-f.fontawesome.com'].includes(host) && /^\/[a-zA-Z0-9_-]+\.js$/.test(pathname)) {
    // Proprietary kit configuration is unavailable offline: use latest bundled FA Free.
    lib = 'fontawesome'; file = 'js/all.min.js';
  } else return null;
  const major = version === undefined ? undefined : Number(version.match(/^v?(\d+)(?:\.|$)/)?.[1]);
  if (major !== undefined && !Number.isInteger(major)) return null;
  const library = manifest.libraries.filter(entry => entry.lib === lib && (major === undefined || entry.major === major)).sort((a, b) => b.major - a.major)[0];
  if (!library) return null;
  if (!file && lib === 'chartjs') file = library.major >= 4 ? 'dist/chart.umd.js' : library.major === 3 ? 'dist/chart.min.js' : 'dist/Chart.min.js';
  if (!isSafeOfflineCdnPath(file)) return null;
  const alternate = file.includes('.min.') ? file.replace(/\.min\.(css|js)$/, '.$1') : file.replace(/\.(css|js)$/, '.min.$1');
  const resolved = library.files.includes(file) ? file : library.files.includes(alternate) ? alternate : null;
  return resolved ? { lib, major: library.major, path: resolved } : null;
}
