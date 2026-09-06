import type { Page, TestInfo } from '@playwright/test';

export type ReachabilityPhase = 'immediate' | 'settled' | 'observed-transition';

export interface ReachabilityFailure {
  readonly control: string;
  readonly reason: string;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly centre: { readonly x: number; readonly y: number } | null;
  readonly coveringElement: string | null;
  readonly coveringStyle: string | null;
  readonly clippingAncestors: readonly string[];
}

interface ReachabilityReport {
  readonly audited: number;
  readonly skippedOffscreen: number;
  readonly failures: readonly ReachabilityFailure[];
}

interface SentinelSnapshot {
  readonly reason: string;
  readonly report: ReachabilityReport;
}

declare global {
  interface Window {
    __readableReachability?: {
      audit: () => ReachabilityReport;
      clear: () => void;
      snapshots: SentinelSnapshot[];
    };
  }
}

/**
 * Install before navigation. The browser samples every mutation frame and every
 * frame in which a CSS/Web Animation is running. This preserves failures from
 * short collapse/exit windows that are gone by the time Playwright settles.
 */
export async function installReachabilitySentinel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const interactiveSelector = [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="slider"]',
      '[role="treeitem"]',
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable]:not([contenteditable="false"])',
    ].join(',');

    const describe = (element: Element | null): string | null => {
      if (!element) return null;
      const html = element as HTMLElement;
      const id = html.id ? `#${CSS.escape(html.id)}` : '';
      const testId = html.dataset.testid ? `[data-testid="${html.dataset.testid}"]` : '';
      const role = html.getAttribute('role') ? `[role="${html.getAttribute('role')}"]` : '';
      const classes = [...html.classList].slice(0, 3).map((name) => `.${CSS.escape(name)}`).join('');
      return `${html.tagName.toLowerCase()}${id}${testId}${role}${classes}`;
    };

    const controlName = (element: Element): string => {
      const labelledBy = element.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ')
        : '';
      const text = [
        element.getAttribute('aria-label'),
        labelledText,
        element.getAttribute('alt'),
        element.getAttribute('title'),
        element.getAttribute('name'),
        element.textContent?.trim(),
      ].find((value) => value != null && value.length > 0) ?? '';
      const compact = text.replace(/\s+/g, ' ').trim().slice(0, 100);
      return compact ? `${describe(element)} "${compact}"` : describe(element) ?? '<unknown control>';
    };

    const excludedBySemantics = (element: Element): boolean => {
      const disabled = element.matches(':disabled, [disabled], [aria-disabled="true"]');
      // Disabled controls are ordinarily intentional. An unanswered surface
      // explicitly requiring interaction is different: disabling every route
      // through it is a user deadlock and must be reported by this guard.
      if (disabled && !element.closest('[data-reachability-required="true"]')) return true;
      if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return true;
      const details = element.closest('details:not([open])');
      if (details) {
        const summary = [...details.children].find((child) => child.tagName === 'SUMMARY');
        if (!summary?.contains(element)) return true;
      }
      return false;
    };

    const intersect = (
      rect: { left: number; top: number; right: number; bottom: number },
      clip: { left: number; top: number; right: number; bottom: number },
      clipX = true,
      clipY = true,
    ) => ({
      left: clipX ? Math.max(rect.left, clip.left) : rect.left,
      top: clipY ? Math.max(rect.top, clip.top) : rect.top,
      right: clipX ? Math.min(rect.right, clip.right) : rect.right,
      bottom: clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom,
    });

    const audit = (): ReachabilityReport => {
      const failures: ReachabilityFailure[] = [];
      let audited = 0;
      let skippedOffscreen = 0;
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };

      const activeBlockingSurface = [...document.querySelectorAll(
        '[role="dialog"][aria-modal="true"], [role="menu"]',
      )].filter((element) => {
        const surfaceStyle = getComputedStyle(element);
        return surfaceStyle.display !== 'none'
          && surfaceStyle.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      }).at(-1) ?? null;

      for (const candidate of document.querySelectorAll(interactiveSelector)) {
        // Modal dialogs and open menus intentionally arbitrate pointer input in
        // front of the surface beneath them. Audit the active overlay rather
        // than calling covered background controls unreachable.
        if (activeBlockingSurface
          && candidate !== activeBlockingSurface
          && !activeBlockingSurface.contains(candidate)) continue;
        if (excludedBySemantics(candidate)) continue;
        const style = getComputedStyle(candidate);
        if (style.display === 'none' || style.pointerEvents === 'none') continue;

        const rawRects = [...candidate.getClientRects()].map((rect) => ({
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        }));
        const hasViewportPosition = rawRects.some((rect) =>
          rect.right >= 0 && rect.left <= innerWidth && rect.bottom >= 0 && rect.top <= innerHeight,
        );
        if (!hasViewportPosition) {
          skippedOffscreen += 1;
          continue;
        }
        audited += 1;

        const clippingAncestors: string[] = [];
        let painted = rawRects.map((rect) => intersect(rect, viewport));
        let clippedOnlyByScrollableOverflow = false;
        let effectiveOpacity = Number(style.opacity);
        for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          effectiveOpacity *= Number(ancestorStyle.opacity);
          const clipsX = /^(hidden|clip|auto|scroll)$/.test(ancestorStyle.overflowX);
          const clipsY = /^(hidden|clip|auto|scroll)$/.test(ancestorStyle.overflowY);
          if (!clipsX && !clipsY) continue;
          const box = ancestor.getBoundingClientRect();
          const paddingBox = {
            left: box.left + ancestor.clientLeft,
            top: box.top + ancestor.clientTop,
            right: box.left + ancestor.clientLeft + ancestor.clientWidth,
            bottom: box.top + ancestor.clientTop + ancestor.clientHeight,
          };
          clippingAncestors.push(
            `${describe(ancestor)} overflow=${ancestorStyle.overflowX}/${ancestorStyle.overflowY} ` +
              `paddingBox=${paddingBox.left},${paddingBox.top},${paddingBox.right},${paddingBox.bottom}`,
          );
          const hadPaintedArea = painted.some((rect) => rect.right > rect.left && rect.bottom > rect.top);
          painted = painted.map((rect) => intersect(rect, paddingBox, clipsX, clipsY));
          const hasPaintedArea = painted.some((rect) => rect.right > rect.left && rect.bottom > rect.top);
          if (hadPaintedArea && !hasPaintedArea && (
            (clipsX && /^(auto|scroll)$/.test(ancestorStyle.overflowX)) ||
            (clipsY && /^(auto|scroll)$/.test(ancestorStyle.overflowY))
          )) {
            clippedOnlyByScrollableOverflow = true;
          }
        }
        const positive = painted.filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
        const largest = positive.sort((a, b) =>
          (b.right - b.left) * (b.bottom - b.top) - (a.right - a.left) * (a.bottom - a.top),
        )[0];
        const rect = largest ? {
          x: largest.left,
          y: largest.top,
          width: largest.right - largest.left,
          height: largest.bottom - largest.top,
        } : null;

        if (!rect && clippedOnlyByScrollableOverflow) {
          audited -= 1;
          skippedOffscreen += 1;
          continue;
        }
        if (!rect) {
          failures.push({
            control: controlName(candidate),
            reason: rawRects.length === 0 ? 'has no painted client rectangle (zero-sized grid/flex track or unpainted control)' : 'is fully clipped by the viewport or an overflow ancestor',
            rect: null,
            centre: null,
            coveringElement: null,
            coveringStyle: null,
            clippingAncestors,
          });
          continue;
        }
        const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        if (candidate.matches(':disabled, [disabled], [aria-disabled="true"]')) {
          failures.push({
            control: controlName(candidate),
            reason: 'is disabled inside a surface that requires user interaction',
            rect,
            centre,
            coveringElement: null,
            coveringStyle: null,
            clippingAncestors,
          });
          continue;
        }
        const directHit = document.elementFromPoint(centre.x, centre.y);
        const stack = document.elementsFromPoint(centre.x, centre.y);
        const hit = directHit && getComputedStyle(directHit).pointerEvents !== 'none'
          ? directHit
          : stack.find((entry) => getComputedStyle(entry).pointerEvents !== 'none') ?? null;
        const associatedLabel = hit instanceof HTMLLabelElement
          && (hit.control === candidate || hit.contains(candidate));
        const reachable = hit !== null && (hit === candidate || candidate.contains(hit) || associatedLabel);

        if (effectiveOpacity === 0 && reachable) {
          failures.push({
            control: controlName(candidate),
            reason: 'is semantically interactive with effective opacity 0 and retains a hit area',
            rect,
            centre,
            coveringElement: null,
            coveringStyle: null,
            clippingAncestors,
          });
          continue;
        }
        if (reachable) continue;

        const hitStyle = hit ? getComputedStyle(hit) : null;
        failures.push({
          control: controlName(candidate),
          reason: style.pointerEvents === 'none'
            ? 'has pointer-events:none at its painted centre'
            : 'centre hit test resolves outside the control',
          rect,
          centre,
          coveringElement: describe(hit),
          coveringStyle: hitStyle
            ? `position=${hitStyle.position}; z-index=${hitStyle.zIndex}; overflow=${hitStyle.overflowX}/${hitStyle.overflowY}; pointer-events=${hitStyle.pointerEvents}`
            : null,
          clippingAncestors,
        });
      }
      return { audited, skippedOffscreen, failures };
    };

    const snapshots: SentinelSnapshot[] = [];
    let scheduled = false;
    let monitoringAnimations = false;
    const record = (reason: string) => {
      const report = audit();
      if (report.failures.length > 0) {
        snapshots.push({ reason, report });
        if (snapshots.length > 40) snapshots.shift();
      }
    };
    const schedule = (reason: string) => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        record(reason);
      });
    };
    const monitorAnimations = () => {
      if (monitoringAnimations) return;
      monitoringAnimations = true;
      const frame = () => {
        record('animation-frame');
        if (document.getAnimations().some((animation) => animation.playState === 'running')) {
          requestAnimationFrame(frame);
        } else {
          monitoringAnimations = false;
        }
      };
      requestAnimationFrame(frame);
    };

    new MutationObserver(() => schedule('mutation-frame')).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    addEventListener('transitionrun', monitorAnimations, true);
    addEventListener('animationstart', monitorAnimations, true);
    window.__readableReachability = {
      audit,
      clear: () => { snapshots.length = 0; },
      snapshots,
    };
    schedule('bootstrap');
  });
}

export async function clearReachabilityHistory(page: Page): Promise<void> {
  await page.evaluate(() => window.__readableReachability?.clear());
}

export async function expectPageInteractivesReachable(
  page: Page,
  options: { readonly phase: ReachabilityPhase; readonly testInfo?: TestInfo },
): Promise<{ readonly audited: number; readonly skippedOffscreen: number }> {
  const result = await page.evaluate(async (phase) => {
    const sentinel = window.__readableReachability;
    if (!sentinel) throw new Error('Reachability sentinel was not installed before navigation');
    if (phase === 'settled') {
      const finiteAnimations = document.getAnimations().filter((animation) => {
        const endTime = animation.effect?.getComputedTiming().endTime;
        return typeof endTime === 'number' && Number.isFinite(endTime);
      });
      await Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined)));
    }
    if (phase === 'observed-transition') {
      const snapshots = sentinel.snapshots.splice(0);
      return { report: snapshots.at(-1)?.report ?? sentinel.audit(), snapshots };
    }
    const report = sentinel.audit();
    // A point-in-time assertion establishes a new baseline. Do not let entry
    // animations already accepted by a settled/immediate check leak into the
    // next observed transition (for example, modal entry snapshots being
    // misreported while checking its later exit).
    sentinel.clear();
    return { report, snapshots: [] as SentinelSnapshot[] };
  }, options.phase);

  const collectedFailures = options.phase === 'observed-transition'
    ? result.snapshots.flatMap((snapshot) => snapshot.report.failures.map((failure) => ({
        ...failure,
        reason: `[${snapshot.reason}] ${failure.reason}`,
      })))
    : result.report.failures;
  const failures = [...new Map(collectedFailures.map((failure) => [
    `${failure.control}|${failure.reason.replace(/^\[[^\]]+\] /, '')}|${failure.coveringElement}`,
    failure,
  ])).values()];

  if (failures.length > 0) {
    if (options.testInfo) {
      await options.testInfo.attach(`reachability-${options.phase}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    }
    const detail = failures.map((failure, index) => {
      const centre = failure.centre ? `(${failure.centre.x.toFixed(1)}, ${failure.centre.y.toFixed(1)})` : 'none';
      return `${index + 1}. ${failure.control}: ${failure.reason}; centre=${centre}; ` +
        `coveredBy=${failure.coveringElement ?? 'none'}; coverStyle=${failure.coveringStyle ?? 'n/a'}; ` +
        `clipping=${failure.clippingAncestors.join(' -> ') || 'none'}`;
    }).join('\n');
    throw new Error(
      `Interactive reachability audit failed (${failures.length} failure(s), ${result.report.audited} controls audited):\n${detail}`,
    );
  }
  return { audited: result.report.audited, skippedOffscreen: result.report.skippedOffscreen };
}
