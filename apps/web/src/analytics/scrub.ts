// Legacy event scrubber retained for observability compatibility tests.
// Telemetry egress is disabled, but error-tracking still uses the path scrub
// helpers locally before dropping events at the no-op dispatch boundary.
//
// The masking rules here intentionally over-redact rather than rely on
// per-element `ph-no-capture` marks scattered across the codebase. A
// single function is easier to audit and harder to forget when a new
// sensitive surface ships.

export interface CaptureResult {
  event: string;
  properties?: Record<string, unknown>;
}

// Tags whose text content can carry user-typed values. Historical autocapture
// could include element text content, so keep the scrubber conservative.
const TEXT_BEARING_TAGS = new Set(['input', 'textarea']);

function scrubElementsChain(
  elements: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return elements.map((el) => {
    const tag = typeof el.tag_name === 'string' ? el.tag_name.toLowerCase() : '';
    const contentEditable =
      typeof el.attr__contenteditable === 'string' &&
      el.attr__contenteditable !== 'false';
    const isPasswordInput =
      tag === 'input' &&
      typeof el.attr__type === 'string' &&
      el.attr__type.toLowerCase() === 'password';
    const shouldScrub =
      TEXT_BEARING_TAGS.has(tag) || contentEditable || isPasswordInput;
    if (!shouldScrub) return el;
    const cleaned: Record<string, unknown> = { ...el };
    delete cleaned.$el_text;
    delete cleaned.attr__value;
    delete cleaned.attr__placeholder;
    delete cleaned.attr__aria_label;
    delete cleaned.text;
    return cleaned;
  });
}

// Drop query-string and fragment from URLs in pageview / pageleave / nav
// events. Pathnames are kept (they're typically `/projects/<uuid>`,
// non-sensitive) but any `?q=…` we accidentally introduce in the future
// won't leak.
function scrubUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// Rewrite absolute filesystem paths in exception stack traces. Packaged
// builds expose `file:///Applications/Readable Studio.app/Contents/Resources/…`
// which leaks both the install root and the user's home dir in homebrew /
// custom installs. Reduce to the repo-relative tail.
//
// Exported so error-tracking.ts can apply the same scrub before dropping
// compatibility events at the no-op dispatch boundary.
export function scrubFilePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // file:///abs/path/.../apps/web/src/foo.tsx → app://apps/web/src/foo.tsx
  // /Users/<user>/.../apps/web/src/foo.tsx    → app://apps/web/src/foo.tsx
  //
  // The prefix uses `[^()\n]*?` (non-greedy, no parens/newlines) so paths
  // that contain spaces — most notably the packaged macOS layout
  // `/Applications/Readable Studio.app/Contents/Resources/...` — get fully
  // rewritten instead of partially leaking the install directory. The
  // tail stops at whitespace or a closing paren so stack frames of shape
  // `at fn (file:///.../foo.tsx:1:2)` lose only the path portion.
  return value.replace(
    /(?:file:\/\/)?[^()\n]*?\/((?:apps|packages|tools)\/[^\s)]+)/g,
    'app://$1',
  );
}

// Exported so error-tracking.ts can apply the same scrub before dropping a
// directly-built `$exception` compatibility payload.
export function scrubExceptionList(
  list: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return list.map((entry) => {
    const next = { ...entry };
    const stack = next.stacktrace as
      | { frames?: Array<Record<string, unknown>> }
      | undefined;
    if (stack?.frames && Array.isArray(stack.frames)) {
      next.stacktrace = {
        ...stack,
        frames: stack.frames.map((frame) => ({
          ...frame,
          filename: scrubFilePath(frame.filename),
          abs_path: scrubFilePath(frame.abs_path),
        })),
      };
    }
    if (typeof next.mechanism === 'object' && next.mechanism !== null) {
      // Mechanism source URL can also be a file:// — same scrub.
      const mech = next.mechanism as Record<string, unknown>;
      if (typeof mech.source === 'string') {
        mech.source = scrubFilePath(mech.source);
      }
    }
    return next;
  });
}

// Some historical events do not need local compatibility processing.
const SUPPRESSED_EVENTS = new Set<string>([
  // Historical opt-in event; no longer emitted by this fork.
  '$opt_in',
]);

export function scrubBeforeSend(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return null;
  if (SUPPRESSED_EVENTS.has(cr.event)) return null;

  const props = (cr.properties ?? {}) as Record<string, unknown>;

  // Autocapture / rageclick / dead-click carry $elements (legacy) or
  // $elements_chain (newer). Both shapes get the same scrub.
  const elementBearing =
    cr.event === '$autocapture' ||
    cr.event === '$rageclick' ||
    cr.event === '$dead_click' ||
    cr.event === '$copy_autocapture';
  if (elementBearing) {
    const elements = props.$elements;
    if (Array.isArray(elements)) {
      props.$elements = scrubElementsChain(elements as Array<Record<string, unknown>>);
    }
  }

  // URL-bearing events.
  if (typeof props.$current_url === 'string') {
    props.$current_url = scrubUrl(props.$current_url);
  }
  if (typeof props.$pathname === 'string') {
    // Pathnames in this app are routing slugs (/projects/<uuid>) — keep
    // as-is. Query strings live on $current_url, not $pathname.
  }
  if (typeof props.$referrer === 'string') {
    props.$referrer = scrubUrl(props.$referrer);
  }

  // Exceptions: scrub file paths in stack frames.
  if (cr.event === '$exception') {
    const list = props.$exception_list;
    if (Array.isArray(list)) {
      props.$exception_list = scrubExceptionList(list as Array<Record<string, unknown>>);
    }
    if (typeof props.$exception_source === 'string') {
      props.$exception_source = scrubFilePath(props.$exception_source);
    }
  }

  return { ...cr, properties: props };
}
