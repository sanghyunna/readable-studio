import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Button, Input, Select, VisuallyHidden } from '@readable-studio/components';
import { APP_CHROME_FILE_ACTIONS_ID, APP_CHROME_FILE_ACTIONS_SELECTOR } from './AppChromeHeader';
import {
  buildSocialSharePayload,
  READABLE_GITHUB_REPO_URL,
  type SocialShareRequest,
  type SocialShareResponse,
} from '@readable-studio/contracts';
import {
  anonymizeArtifactId,
  artifactKindToTracking,
  type TrackingProjectKind,
} from '@readable-studio/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import { trackIframeLoad } from '../observability/iframe-error';
import {
  trackArtifactExportResult,
  trackArtifactHeaderClick,
  trackArtifactToolbarClick,
  trackCommentPopoverClick,
  trackDrawToolbarClick,
  trackPageView,
  trackPresentPopoverClick,
  trackShareOptionPopoverClick,
} from '../analytics/events';
import { MarkdownRenderer, artifactRendererRegistry } from '../artifacts/renderer-registry';
import { renderMarkdownToSafeHtml } from '../artifacts/markdown';
import { useT, useI18n } from '../i18n';
import type { Dict, Locale } from '../i18n/types';
import {
  checkDeploymentLink,
  CLOUDFLARE_PAGES_PROVIDER_ID,
  createSocialSharePayload,
  DEFAULT_DEPLOY_PROVIDER_ID,
  deployProjectFile,
  fetchCloudflarePagesZones,
  fetchDeployConfig,
  fetchProjectDeployments,
  fetchProjectFilePreview,
  fetchProjectFiles,
  fetchProjectFileText,
  uploadProjectFiles,
  projectFileUrl,
  projectRawUrl,
  updateDeployConfig,
  type WebDeployConfigResponse,
  type WebCloudflarePagesDeploySelection,
  type WebDeploymentInfo,
  type WebDeployProjectFileResponse,
  type WebDeployProviderId,
  type WebUpdateDeployConfigRequest,
  writeProjectTextFile,
  writeProjectTextFileDetailed,
} from '../providers/registry';
import type { ProjectFilePreview } from '../providers/registry';
import {
  downloadImageDataUrl,
  exportAsJsx,
  exportAsMd,
  exportAsPdf,
  exportProjectAsHtml,
  exportProjectAsPdf,
  exportProjectAsZip,
  copyImageDataUrlToClipboard,
  exportReactComponentAsHtml,
  exportReactComponentAsZip,
  captureHostIframeSnapshot,
  imageDataUrlToBlob,
  openSandboxedPreviewInNewTab,
  prepareImageExportTarget,
  requestPreviewSnapshot,
  type ImageExportFormat,
} from '../runtime/exports';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { buildReactComponentSrcdoc } from '../runtime/react-component';
import { shouldConsumeSlideNav } from '../runtime/slide-nav';
import { findHtmlEntriesReferencing } from '../runtime/jsx-module-refs';
import { buildLazySrcdocTransport, buildSrcdoc, canActivateSrcDocTransport } from '../runtime/srcdoc';
import {
  hasTweaksTemplate,
  hasUrlModeBridge,
  htmlNeedsFocusGuard,
  htmlNeedsSandboxShim,
  parseForceInline,
  shouldUrlLoadHtmlPreview,
} from './file-viewer-render-mode';
import { saveTemplate } from '../state/projects';
import type {
  ProjectFile,
} from '../types';
import { Icon } from './Icon';
import { RemixIcon } from './RemixIcon';
import { SocialShareGrid } from './SocialShareGrid';
import { Toast } from './Toast';
import { PreviewDrawOverlay, type DrawToolbarElement } from './PreviewDrawOverlay';
import {
  buildBoardCommentAttachments,
  commentSnapshotEqual,
  commentTargetDisplayName,
  commentVisibleOnDeckSlide,
  commentsToAttachments,
  isValidCommentOverlayPosition,
  liveCommentTargetMapsEqual,
  liveSnapshotForComment,
  overlayBoundsFromSnapshot,
  selectionKindLabel,
  targetFromSnapshot,
  type PreviewCommentSnapshot,
} from '../comments';
import { applyPodMemberRemoval } from '../lib/pod-members';
import { AnnotationHoverPopover, BoardComposerPopover } from './BoardComposerPopover';
import {
  READABLE_PREVIEW_KEEP_ALIVE,
  PooledIframe,
  previewIframeKeepAliveKey,
} from './IframeKeepAlivePool';
import type {
  ChatCommentAttachment,
  PreviewComment,
  PreviewCommentAttachment,
  PreviewCommentMember,
  PreviewCommentTarget,
} from '../types';
import { ManualEditPanel, applyManualEditStyleField, applyManualEditStyleFields, emptyManualEditDraft, normalizeManualEditStyles, type ManualEditDraft } from './ManualEditPanel';
import { ManualEditShapeToolbar } from './ManualEditShapeToolbar';
import { ManualEditResizeHandles } from './ManualEditResizeHandles';
import { ManualEditMoveFrame, type ManualEditMoveUpdate } from './ManualEditMoveFrame';
import { ManualEditSnapGuides } from './ManualEditSnapGuides';
import { RESIZE_HANDLE_DIRECTIONS, resizeCssCommitStyles, type ResizeHandleDirection } from '../edit-mode/resize-geometry';
import {
  buildManualEditMovementCandidates,
  createManualEditSnapLatch,
  resolveManualEditMovement,
  type ManualEditMovementResult,
  type ManualEditMovementSession,
  type ManualEditMovementSource,
} from '../edit-mode/movement-session';
import { ManualEditTypographyToolbar, type ManualEditRichFormatState } from './ManualEditTypographyToolbar';
import { ManualEditLeftInspector } from './ManualEditLeftInspector';
import {
  applyManualEditPatch,
  isManualEditFullHtmlDocument,
  planManualEditDuplicate,
  readManualEditAttributes,
  readManualEditFields,
  readManualEditOuterHtml,
  readManualEditStyles,
} from '../edit-mode/source-patches';
import { MANUAL_EDIT_STYLE_PROPS, type ManualEditActivationMessage, type ManualEditBeginTextEditMessage, type ManualEditBridgeMessage, type ManualEditDuplicatePlan, type ManualEditEndTextEditMessage, type ManualEditHistoryEntry, type ManualEditHoverAtMessage, type ManualEditPatch, type ManualEditRect, type ManualEditResizeConstraint, type ManualEditResizeRequest, type ManualEditStyles, type ManualEditTarget } from '../edit-mode/types';
import {
  isManualEditNudgeBlocked,
  isManualEditNudgeKey,
  isManualEditNudgeNetZero,
  manualEditMoveAnnouncementSegments,
  manualEditNudgeDelta,
  manualEditNudgeDeltaFromDirection,
  type ManualEditMoveAnnouncementSegment,
} from '../edit-mode/keyboard-move';
import { isRenderableSketchJson, SketchPreview } from './SketchPreview';

function resolveChromeActionsHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(APP_CHROME_FILE_ACTIONS_SELECTOR)
    ?? document.getElementById(APP_CHROME_FILE_ACTIONS_ID);
}

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;
type SlideState = { active: number; count: number };
type BoardTool = 'inspect' | 'pod';
type StrokePoint = { x: number; y: number };
type ManualEditResizeFeedback = {
  targetId: string;
  constraints: ManualEditResizeConstraint[];
  announce: boolean;
};
type ActiveManualEditMovement = {
  readonly session: ManualEditMovementSession;
  readonly label: string;
  latestResult: ManualEditMovementResult | null;
  duplicate: ActiveManualEditDuplicate | null;
};
type ActiveManualEditDuplicate = {
  transactionId: string;
  plan: ManualEditDuplicatePlan | null;
  status: 'preparing' | 'creating' | 'ready' | 'suspended' | 'failed';
  sequence: number;
  placementOffset: { x: number; y: number } | null;
  lastAckSequence: number;
  pendingUpdate: ManualEditMoveUpdate | null;
  pendingCommit: ManualEditMoveUpdate | null;
  pendingFinalCommit: ManualEditMoveUpdate | null;
  ackWaiters: Map<number, { resolve: (ok: boolean) => void; timeoutId: number }>;
  generation: number;
};
const EMPTY_MANUAL_EDIT_SNAP_GUIDES: ManualEditMovementResult['guides'] = { vertical: null, horizontal: null };
export type ManualEditPendingStyleSave = {
  id: string;
  styles: Partial<ManualEditStyles>;
  label: string;
  version: number;
};
type ManualEditPostSaveIntent =
  | { seq: number; kind: 'select'; target: ManualEditTarget }
  | { seq: number; kind: 'clear'; openPageStyles: boolean }
  | { seq: number; kind: 'exit' };
type ManualEditPendingDuplicateSelection = {
  id: string;
  ownerId: string;
  seq: number;
};
type KeyboardBurst = {
  targetId: string;
  revision: number;
  // Arrow keys physically held on the HOST side. Iframe-origin bursts leave this
  // empty and are committed by the bridge's readable-edit-nudge-commit message; host
  // bursts commit when this set empties on keyup.
  heldKeys: Set<string>;
  netDelta: { x: number; y: number };
  startBaseline: string;
  lastResult: ManualEditMovementResult | null;
};
// A completed burst result deferred behind an in-flight save, committed when the
// save drains.
type KeyboardBurstQueued = {
  result: ManualEditMovementResult;
  netDelta: { x: number; y: number };
  startBaseline: string;
};
type PreviewViewportId = 'desktop' | 'tablet' | 'mobile';
type PreviewCanvasSize = { width: number; height: number; scrollLeft?: number; scrollTop?: number };
type CommentPreviewCanvasOptions = {
  boardMode: boolean;
  sidePanelCollapsed: boolean;
  viewport?: PreviewViewportId;
};
type PreviewScaleOptions = {
  canvasPadding?: number;
};
type PreviewViewportPreset = {
  id: PreviewViewportId;
  width: number | null;
  height: number | null;
  labelKey: keyof Dict;
  titleKey: keyof Dict;
};

async function sha256Hex(value: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Secure hashing is unavailable in this browser.');
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const IMAGE_EXPORT_FORMAT_OPTIONS: Array<{
  value: ImageExportFormat;
  label: string;
  extension: string;
}> = [
  { value: 'png', label: 'PNG', extension: '.png' },
  { value: 'jpeg', label: 'JPEG', extension: '.jpg' },
  { value: 'webp', label: 'WebP', extension: '.webp' },
];
type DeployProviderOption = {
  id: WebDeployProviderId;
  labelKey: 'fileViewer.vercelProvider' | 'fileViewer.cloudflarePagesProvider';
  tokenLink: string;
  tokenLinkKey: 'fileViewer.vercelTokenGetLink' | 'fileViewer.cloudflareApiTokenGetLink';
  tokenPlaceholderKey:
    | 'fileViewer.vercelTokenPlaceholder'
    | 'fileViewer.cloudflareApiTokenPlaceholder';
  tokenReuseHintKey: 'fileViewer.vercelTokenReuseHint' | 'fileViewer.cloudflareApiTokenReuseHint';
  tokenRequiredKey: 'fileViewer.vercelTokenRequired' | 'fileViewer.cloudflareApiTokenRequired';
  tokenLabelKey:
    | 'fileViewer.vercelToken'
    | 'fileViewer.cloudflareApiToken';
  accountIdLabelKey?: 'fileViewer.cloudflareAccountId';
  accountIdHintKey?: 'fileViewer.cloudflareAccountIdHint';
};
type CloudflarePagesZoneOption = {
  id: string;
  name: string;
  status?: string;
  type?: string;
};
type DeployResultCard = {
  id: string;
  label: string;
  url: string;
  status: string;
  message?: string;
};
const MAX_BRIDGE_COORDINATE = 1_000_000;
const PREVIEW_VIEWPORT_PRESETS: PreviewViewportPreset[] = [
  {
    id: 'desktop',
    width: null,
    height: null,
    labelKey: 'fileViewer.viewportDesktop',
    titleKey: 'fileViewer.viewportDesktopTitle',
  },
  {
    id: 'tablet',
    width: 820,
    height: 1180,
    labelKey: 'fileViewer.viewportTablet',
    titleKey: 'fileViewer.viewportTabletTitle',
  },
  {
    id: 'mobile',
    width: 390,
    height: 844,
    labelKey: 'fileViewer.viewportMobile',
    titleKey: 'fileViewer.viewportMobileTitle',
  },
];

function previewViewportIcon(viewport: PreviewViewportId): string {
  if (viewport === 'tablet') return 'tablet-line';
  if (viewport === 'mobile') return 'smartphone-line';
  return 'computer-line';
}

const EXPORT_READY_NUDGE_STORAGE_PREFIX = 'readable-studio:export-ready-nudge:';
const COMMENT_SIDE_DOCK_WIDTH = 320;
const COMMENT_SIDE_DOCK_RAIL_WIDTH = 42;
const COMMENT_SIDE_DOCK_GAP = 12;
const COMMENT_SIDE_DOCK_PADDING = 8;
const COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING = 24;
const COMMENT_SIDE_DOCK_MIN_CANVAS_WIDTH = 280;
const COMMENT_SIDE_DOCK_STACKED_PANEL_HEIGHT = 220;
const COMMENT_SIDE_DOCK_STACKED_RAIL_HEIGHT = 48;
const COMMENT_SIDE_DOCK_STACKED_HEIGHT_DEDUCTION =
  (COMMENT_SIDE_DOCK_PADDING * 2) + COMMENT_SIDE_DOCK_GAP + COMMENT_SIDE_DOCK_STACKED_PANEL_HEIGHT;
const COMMENT_SIDE_DOCK_STACKED_COLLAPSED_HEIGHT_DEDUCTION =
  (COMMENT_SIDE_DOCK_PADDING * 2) + COMMENT_SIDE_DOCK_GAP + COMMENT_SIDE_DOCK_STACKED_RAIL_HEIGHT;

// The five basic style facets the inspect panel exposes. Kept narrow on
// purpose — open-slide's design tokens panel only edits global tokens, so
// the per-element delta is small + obvious + cheap to read back from
// getComputedStyle on the iframe side.
type InspectStyleSnapshot = {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontWeight?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  borderRadius?: string;
  textAlign?: string;
  fontFamily?: string;
  lineHeight?: string;
};

type InspectClickedDescendant = {
  label: string;
  text: string;
};

type InspectTarget = {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  style: InspectStyleSnapshot;
  clickedDescendant?: InspectClickedDescendant;
};

const MAX_CACHED_SLIDE_STATES = 64;
const htmlPreviewSlideState = new Map<string, SlideState>();
const MAX_CACHED_PREVIEW_VIEWPORTS = 128;
// Grace window before the inspect hover card is torn down. Long enough to absorb
// the async iframe mouseout (readable-studio:comment-leave) that fires when the pointer slides
// onto the card or hops back onto the element under it, short enough to read as
// an immediate dismiss when the pointer really leaves.
const HOVER_CARD_DISMISS_DELAY_MS = 80;
const htmlPreviewViewportState = new Map<string, PreviewViewportId>();
const MARKDOWN_CODE_BLOCK_ATTR = 'data-markdown-code-block';
const MARKDOWN_COPY_BLOCK_ATTR = 'data-copy-code-block';
const MARKDOWN_COPY_BUTTON_CLASS = 'markdown-code-copy';
const MARKDOWN_COPY_TOAST_CLASS = 'markdown-code-toast';

const DEPLOY_PROVIDER_OPTIONS: DeployProviderOption[] = [
  {
    id: DEFAULT_DEPLOY_PROVIDER_ID,
    labelKey: 'fileViewer.vercelProvider',
    tokenLink: 'https://vercel.com/account/settings/tokens',
    tokenLinkKey: 'fileViewer.vercelTokenGetLink',
    tokenPlaceholderKey: 'fileViewer.vercelTokenPlaceholder',
    tokenReuseHintKey: 'fileViewer.vercelTokenReuseHint',
    tokenRequiredKey: 'fileViewer.vercelTokenRequired',
    tokenLabelKey: 'fileViewer.vercelToken',
  },
  {
    id: CLOUDFLARE_PAGES_PROVIDER_ID,
    labelKey: 'fileViewer.cloudflarePagesProvider',
    tokenLink: 'https://dash.cloudflare.com/profile/api-tokens',
    tokenLinkKey: 'fileViewer.cloudflareApiTokenGetLink',
    tokenPlaceholderKey: 'fileViewer.cloudflareApiTokenPlaceholder',
    tokenReuseHintKey: 'fileViewer.cloudflareApiTokenReuseHint',
    tokenRequiredKey: 'fileViewer.cloudflareApiTokenRequired',
    tokenLabelKey: 'fileViewer.cloudflareApiToken',
    accountIdLabelKey: 'fileViewer.cloudflareAccountId',
    accountIdHintKey: 'fileViewer.cloudflareAccountIdHint',
  },
];

function mergeManualEditInspectorStyles(
  sourceStyles: ManualEditStyles,
  previewStyles: ManualEditStyles,
): ManualEditStyles {
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    const sourceValue = sourceStyles[key]?.trim();
    const previewValue = previewStyles[key]?.trim();
    const value = sourceValue || previewValue || '';
    acc[key] = manualEditInspectorStyleValue(key, value);
    return acc;
  }, {} as ManualEditStyles);
}

function manualEditInspectorStyleValue(key: keyof ManualEditStyles, value: string): string {
  if (!value) return '';
  if (key === 'color' || key === 'backgroundColor' || key === 'borderColor') {
    return normalizeManualEditInspectorColor(value);
  }
  return value;
}

function normalizeManualEditInspectorColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const r = trimmed[1]!, g = trimmed[2]!, b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgba = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return trimmed;
  if (rgba[4] !== undefined && Number(rgba[4]) === 0) return '';
  const toHex = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw))))
    .toString(16)
    .padStart(2, '0');
  return `#${toHex(rgba[1]!)}${toHex(rgba[2]!)}${toHex(rgba[3]!)}`;
}

function manualEditPersistedValueMatchesSavedSnapshot(
  key: keyof ManualEditStyles,
  persistedValue: string,
  savedValue: string,
): boolean {
  return canonicalManualEditStyleValue(key, persistedValue) === canonicalManualEditStyleValue(key, savedValue);
}

function canonicalManualEditStyleValue(key: keyof ManualEditStyles, value: string): string {
  const normalized = manualEditInspectorStyleValue(key, value).trim();
  if (!normalized) return '';
  return normalized.toLowerCase();
}

function getDeployProviderOption(providerId: WebDeployProviderId): DeployProviderOption {
  return DEPLOY_PROVIDER_OPTIONS.find((option) => option.id === providerId) ?? DEPLOY_PROVIDER_OPTIONS[0]!;
}

function normalizeCloudflareDomainPrefixInput(raw: string): string {
  return raw.trim().toLowerCase();
}

function isValidCloudflareDomainPrefixInput(raw: string): boolean {
  const prefix = normalizeCloudflareDomainPrefixInput(raw);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix);
}

function deployResultState(status?: string): 'ready' | 'delayed' | 'protected' | 'failed' {
  if (status === 'protected') return 'protected';
  if (status === 'failed' || status === 'conflict') return 'failed';
  if (status === 'link-delayed' || status === 'pending') return 'delayed';
  return 'ready';
}

function publicShareUrlForDeployment(deployment?: WebDeploymentInfo | null): string {
  if (!deployment) return '';
  const cloudflare = deployment.cloudflarePages;
  const customDomainUrl = cloudflare?.customDomain?.status === 'ready'
    ? cloudflare.customDomain.url?.trim()
    : '';
  if (customDomainUrl) return customDomainUrl;
  const pagesDevUrl = cloudflare?.pagesDev?.status === 'ready'
    ? cloudflare.pagesDev.url?.trim()
    : '';
  if (pagesDevUrl) return pagesDevUrl;
  return deployResultState(deployment.status) === 'ready'
    ? deployment.url?.trim() || ''
    : '';
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
      if (priorFocus?.isConnected) {
        try {
          priorFocus.focus({ preventScroll: true });
        } catch {
          priorFocus.focus();
        }
      }
    }
  }
}

function decorateMarkdownCodeBlocks(html: string): string {
  let blockIndex = 0;
  return html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/g, (_match, attrs: string, content: string) => {
    const blockId = String(blockIndex++);
    return `<div class="markdown-code-block" ${MARKDOWN_CODE_BLOCK_ATTR}="${blockId}"><pre${attrs}>${content}</pre></div>`;
  });
}

function setMarkdownCodeBlockCopiedState(block: HTMLElement, copied: boolean, t: TranslateFn) {
  const button = block.querySelector<HTMLButtonElement>(`.${MARKDOWN_COPY_BUTTON_CLASS}`);
  if (!button) return;
  const label = copied ? t('fileViewer.copied') : t('fileViewer.copy');
  button.textContent = label;
  button.setAttribute('aria-label', label);
  button.title = t('fileViewer.copyTitle');

  const existingToast = block.querySelector(`.${MARKDOWN_COPY_TOAST_CLASS}`);
  if (copied) {
    if (existingToast instanceof HTMLElement) {
      existingToast.textContent = t('fileViewer.copied');
      return;
    }
    const toast = document.createElement('span');
    toast.className = MARKDOWN_COPY_TOAST_CLASS;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = t('fileViewer.copied');
    button.insertAdjacentElement('afterend', toast);
    return;
  }

  existingToast?.remove();
}

function PreviewViewportControls({
  viewport,
  onViewport,
  t,
  tabIndex,
}: {
  viewport: PreviewViewportId;
  onViewport: (viewport: PreviewViewportId) => void;
  t: TranslateFn;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const activePreset =
    PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === viewport) ?? PREVIEW_VIEWPORT_PRESETS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="viewer-viewport-switcher" ref={menuRef}>
      <button
        type="button"
        className={`viewer-action viewer-viewport-trigger${open ? '' : ' readable-tooltip'}`}
        aria-label={t('fileViewer.viewportAria')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={t(activePreset.titleKey)}
        data-tooltip={open ? undefined : t(activePreset.titleKey)}
        data-tooltip-placement="bottom"
        tabIndex={tabIndex}
        onClick={() => setOpen((value) => !value)}
      >
        <RemixIcon
          name={previewViewportIcon(activePreset.id)}
          size={14}
          className="viewer-viewport-icon"
        />
        <span>{t(activePreset.labelKey)}</span>
        <RemixIcon name="arrow-down-s-line" size={14} />
      </button>
      {open ? (
        <div className="viewer-viewport-menu" id={listboxId} role="listbox" aria-label={t('fileViewer.viewportAria')}>
          {PREVIEW_VIEWPORT_PRESETS.map((preset) => {
            const selected = viewport === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`viewer-viewport-menu-item${selected ? ' active' : ''}`}
                role="option"
                aria-selected={selected}
                title={t(preset.titleKey)}
                onClick={() => {
                  onViewport(preset.id);
                  setOpen(false);
                }}
              >
                <span className="viewer-viewport-menu-label">
                  <RemixIcon name={previewViewportIcon(preset.id)} size={14} />
                  <span>{t(preset.labelKey)}</span>
                </span>
                {selected ? <Icon name="check" size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function previewViewportStyle(
  viewport: PreviewViewportId,
  previewScale = 1,
  canvasSize?: PreviewCanvasSize,
  options?: PreviewScaleOptions,
): CSSProperties & Record<string, string | number> {
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport) ?? PREVIEW_VIEWPORT_PRESETS[0]!;
  if (!preset.width) return {};
  const effectiveScale = effectivePreviewScale(viewport, previewScale, canvasSize, options);
  return {
    '--preview-viewport-width': `${preset.width}px`,
    '--preview-viewport-height': `${preset.height}px`,
    '--preview-scale': effectiveScale,
    '--preview-user-scale': previewScale,
  };
}

export function commentPreviewCanvasSize(
  canvasSize: PreviewCanvasSize | undefined,
  options: CommentPreviewCanvasOptions,
): PreviewCanvasSize | undefined {
  if (!canvasSize || !options.boardMode) return canvasSize;
  const dockPadding = options.viewport && options.viewport !== 'desktop'
    ? COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING
    : COMMENT_SIDE_DOCK_PADDING;
  const sideDockWidth = options.sidePanelCollapsed ? COMMENT_SIDE_DOCK_RAIL_WIDTH : COMMENT_SIDE_DOCK_WIDTH;
  const dockedWidth = canvasSize.width - (dockPadding * 2) - COMMENT_SIDE_DOCK_GAP - sideDockWidth;
  if (usesStackedCommentSideDock(canvasSize, options)) {
    const stackedHeightDeduction = options.sidePanelCollapsed
      ? COMMENT_SIDE_DOCK_STACKED_COLLAPSED_HEIGHT_DEDUCTION
      : COMMENT_SIDE_DOCK_STACKED_HEIGHT_DEDUCTION;
    return {
      width: Math.max(1, canvasSize.width - (COMMENT_SIDE_DOCK_PADDING * 2)),
      height: Math.max(1, canvasSize.height - stackedHeightDeduction),
    };
  }
  return {
    width: Math.max(1, dockedWidth),
    height: Math.max(1, canvasSize.height - (dockPadding * 2)),
  };
}

function usesStackedCommentSideDock(
  canvasSize: PreviewCanvasSize | undefined,
  options: CommentPreviewCanvasOptions,
) {
  if (!canvasSize || !options.boardMode) return false;
  const dockPadding = options.viewport && options.viewport !== 'desktop'
    ? COMMENT_SIDE_DOCK_NON_DESKTOP_PADDING
    : COMMENT_SIDE_DOCK_PADDING;
  const sideDockWidth = options.sidePanelCollapsed ? COMMENT_SIDE_DOCK_RAIL_WIDTH : COMMENT_SIDE_DOCK_WIDTH;
  const dockedWidth = canvasSize.width - (dockPadding * 2) - COMMENT_SIDE_DOCK_GAP - sideDockWidth;
  return dockedWidth < COMMENT_SIDE_DOCK_MIN_CANVAS_WIDTH;
}

export function effectivePreviewScale(
  viewport: PreviewViewportId,
  previewScale: number,
  canvasSize?: PreviewCanvasSize,
  options?: PreviewScaleOptions,
) {
  if (viewport === 'desktop') return previewScale;
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport);
  if (!preset?.width || !preset.height || !canvasSize?.width || !canvasSize.height) return previewScale;
  const canvasPadding = options?.canvasPadding ?? 48;
  const availableWidth = Math.max(1, canvasSize.width - canvasPadding);
  const availableHeight = Math.max(1, canvasSize.height - canvasPadding);
  const fitScale = Math.min(1, availableWidth / preset.width, availableHeight / preset.height);
  return Math.min(previewScale, fitScale);
}

type PreviewOverlayTransform = { scale: number; offsetX: number; offsetY: number };

export function previewOverlayTransform(
  viewport: PreviewViewportId,
  previewScale: number,
  canvasSize?: PreviewCanvasSize,
  options?: PreviewScaleOptions,
): PreviewOverlayTransform {
  const scale = effectivePreviewScale(viewport, previewScale, canvasSize, options);
  if (viewport === 'desktop') return { scale, offsetX: 0, offsetY: 0 };
  const preset = PREVIEW_VIEWPORT_PRESETS.find((item) => item.id === viewport);
  const pad = 24;
  if (!preset?.width || !preset.height) return { scale, offsetX: pad, offsetY: pad };
  const availableWidth = Math.max(1, (canvasSize?.width ?? preset.width * scale + pad * 2) - pad * 2);
  const scaledWidth = preset.width * scale;
  return {
    scale,
    offsetX: pad + Math.max(0, (availableWidth - scaledWidth) / 2),
    offsetY: pad,
  };
}

function previewScaleShellStyle(
  viewport: PreviewViewportId,
  previewScale: number,
): CSSProperties & Record<string, string | number> {
  if (viewport === 'desktop') {
    return {
      width: `${100 / previewScale}%`,
      height: `${100 / previewScale}%`,
      transform: `scale(${previewScale})`,
      transformOrigin: '0 0',
    };
  }
  return {
    width: 'var(--preview-viewport-width)',
    height: 'var(--preview-viewport-height)',
    transform: 'scale(var(--preview-scale, 1))',
    transformOrigin: '0 0',
  };
}

function deploymentTimestamp(deployment: WebDeploymentInfo): number {
  const maybeDeployedAt = (deployment as WebDeploymentInfo & { deployedAt?: number | string }).deployedAt;
  const candidates = [maybeDeployedAt, deployment.updatedAt, deployment.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function compareDeploymentsByNewest(a: WebDeploymentInfo, b: WebDeploymentInfo): number {
  return deploymentTimestamp(b) - deploymentTimestamp(a);
}

function shareUrlForDeployment(deployment: WebDeploymentInfo): string {
  const customDomain = deployment.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
    ? deployment.cloudflarePages?.customDomain
    : undefined;
  if (customDomain?.status === 'ready' && customDomain.url?.trim()) {
    return customDomain.url.trim();
  }
  return deployment.url?.trim() || '';
}

function resolveShareUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (typeof window === 'undefined') return trimmed;
  return new URL(trimmed, window.location.origin).toString();
}

function pickLatestShareDeployment(
  deploymentsByProvider: Partial<Record<WebDeployProviderId, WebDeploymentInfo>>,
): WebDeploymentInfo | null {
  return Object.values(deploymentsByProvider)
    .filter((deployment): deployment is WebDeploymentInfo =>
      Boolean(deployment && shareUrlForDeployment(deployment) && deployResultState(deployment.status) !== 'failed'))
    .sort(compareDeploymentsByNewest)[0] ?? null;
}

// Anchors the hover "edit params" affordance to the top-right corner of the
// hovered element, just inside its bounds so moving the cursor from the
// element onto the icon does not drop the hover.
export function manualEditHoverIconStyle(
  target: ManualEditTarget,
  previewScale: number,
  canvasSize: PreviewCanvasSize | undefined,
  offsetX = 0,
  offsetY = 0,
): CSSProperties {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  const iconSize = 26;
  const inset = 4;
  const canvasWidth = canvasSize?.width ?? 1200;
  const canvasHeight = canvasSize?.height ?? 800;
  const targetTop = offsetY + target.rect.y * scale;
  const targetRight = offsetX + (target.rect.x + target.rect.width) * scale;
  const left = Math.max(
    inset,
    Math.min(targetRight - iconSize - inset, canvasWidth - iconSize - inset),
  );
  const top = Math.max(
    inset,
    Math.min(targetTop + inset, canvasHeight - iconSize - inset),
  );
  return { left, top, width: iconSize, height: iconSize };
}

// The selected element's rect on the preview canvas, in host px, using the same
// iframe→canvas transform as manualEditHoverIconStyle. Feeds the resize-handle
// overlay: left/top anchor the overlay, width/height size it. Zero/negative or
// non-finite rects collapse to a 0-size rect at the anchor (never NaN), so the
// caller can still render a stable — if degenerate — handle cluster.
export function manualEditResizeOverlayRect(
  target: ManualEditTarget,
  previewScale: number,
  canvasSize: PreviewCanvasSize | undefined,
  offsetX = 0,
  offsetY = 0,
): { left: number; top: number; width: number; height: number } | null {
  const scale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1;
  const { x, y, width, height } = target.rect;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  return {
    left: offsetX + x * scale,
    top: offsetY + y * scale,
    width: Math.max(0, width) * scale,
    height: Math.max(0, height) * scale,
  };
}

function manualEditResizeRequest(
  direction: ResizeHandleDirection,
  size: { width: number; height: number },
  includeDetails = false,
): ManualEditResizeRequest {
  const axes: ManualEditResizeRequest['axes'] = [];
  if (direction.includes('e') || direction.includes('w')) axes.push('width');
  if (direction.includes('n') || direction.includes('s')) axes.push('height');
  return { axes, requested: size, ...(includeDetails ? { includeDetails: true } : {}) };
}

export function cancelManualEditPendingStyleSnapshot(
  pending: ManualEditPendingStyleSave | null,
  id: string,
  keys: Array<keyof ManualEditStyles>,
): ManualEditPendingStyleSave | null {
  if (!pending || pending.id !== id || keys.length === 0) return pending;
  const nextStyles = { ...pending.styles };
  for (const key of keys) delete nextStyles[key];
  if (Object.keys(nextStyles).length === 0) return null;
  return { ...pending, styles: nextStyles };
}

// flushManualEditStyleSave leaves the pending ref pointing at the styles
// object that was just saved until after the save resolves (so a failed save
// can retry it). That means an id match alone no longer proves a *newer*
// edit arrived while reconcileManualEditStyleSave's save was in flight — only
// a different `.styles` reference does. Styles keys returned here are ones a
// reconcile repair must skip, since the user has already moved past them.
export function manualEditSupersededStyleKeys(
  pending: ManualEditPendingStyleSave | null,
  id: string,
  savedStyles: Partial<ManualEditStyles>,
): Partial<ManualEditStyles> {
  if (pending?.id !== id || pending.styles === savedStyles) return {};
  return pending.styles;
}

function usePreviewCanvasSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<PreviewCanvasSize | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measureNow = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const next = {
        width: rect.width,
        height: rect.height,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      };
      setSize((prev) => (
        prev
        && prev.width === next.width
        && prev.height === next.height
        && prev.scrollLeft === next.scrollLeft
        && prev.scrollTop === next.scrollTop
      ) ? prev : next);
    };
    const measure = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(measureNow);
    };
    measureNow();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      observer?.disconnect();
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  return [ref, size] as const;
}

function ensureMarkdownCodeBlockControls(root: HTMLElement, t: TranslateFn) {
  for (const block of root.querySelectorAll<HTMLElement>(`[${MARKDOWN_CODE_BLOCK_ATTR}]`)) {
    let button = block.querySelector<HTMLButtonElement>(`.${MARKDOWN_COPY_BUTTON_CLASS}`);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = MARKDOWN_COPY_BUTTON_CLASS;
      const blockId = block.getAttribute(MARKDOWN_CODE_BLOCK_ATTR) ?? '';
      button.setAttribute(MARKDOWN_COPY_BLOCK_ATTR, blockId);
      block.prepend(button);
    }
    setMarkdownCodeBlockCopiedState(block, false, t);
  }
}

function setSlideStateCached(key: string, state: SlideState) {
  htmlPreviewSlideState.set(key, state);
  if (htmlPreviewSlideState.size > MAX_CACHED_SLIDE_STATES) {
    const oldest = htmlPreviewSlideState.keys().next().value;
    if (oldest != null) htmlPreviewSlideState.delete(oldest);
  }
}

function waitForIframeLoadOrTimeout(iframe: HTMLIFrameElement, timeout = 750): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      iframe.removeEventListener('load', finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, timeout);
    iframe.addEventListener('load', finish, { once: true });
  });
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function temporarilyExposeIframeForSnapshot(iframe: HTMLIFrameElement): () => void {
  const previousVisibility = iframe.style.visibility;
  const previousOpacity = iframe.style.opacity;
  const previousPointerEvents = iframe.style.pointerEvents;
  iframe.style.visibility = 'visible';
  iframe.style.opacity = '0.001';
  iframe.style.pointerEvents = 'none';
  return () => {
    iframe.style.visibility = previousVisibility;
    iframe.style.opacity = previousOpacity;
    iframe.style.pointerEvents = previousPointerEvents;
  };
}

async function requestPreviewSnapshotWithRetry(iframe: HTMLIFrameElement): Promise<Awaited<ReturnType<typeof requestPreviewSnapshot>>> {
  const timeouts = [1500, 3000, 6000];
  for (const timeout of timeouts) {
    const snapshot = await requestPreviewSnapshot(iframe, timeout);
    if (snapshot) return snapshot;
    await waitForAnimationFrame();
  }
  return null;
}

function previewViewportStateKey(projectId: string, file: Pick<ProjectFile, 'name' | 'path'>): string {
  return `${projectId}:${file.path || file.name}`;
}

function setPreviewViewportCached(key: string, viewport: PreviewViewportId) {
  htmlPreviewViewportState.set(key, viewport);
  if (htmlPreviewViewportState.size > MAX_CACHED_PREVIEW_VIEWPORTS) {
    const oldest = htmlPreviewViewportState.keys().next().value;
    if (oldest != null) htmlPreviewViewportState.delete(oldest);
  }
}

interface Props {
  projectId: string;
  projectKind: TrackingProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck?: boolean;
  onExportAsPptx?: ((fileName: string) => void) | undefined;
  streaming?: boolean;
  commentQueueOnSend?: boolean;
  commentSendDisabled?: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[]) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<boolean | void> | boolean | void;
  onFileSaved?: () => Promise<void> | void;
  // Open `openName` as a tab (focusing it) and close `closeName` in one
  // atomic tab-state update. The React module pointer uses this to jump to the
  // HTML entry that renders a module and drop the dead-end module tab.
  onOpenFileReplacing?: (openName: string, closeName: string) => void;
  commentPortalId?: string;
  onCommentModeChange?: (active: boolean) => void;
  manualEditPortalId?: string;
  onManualEditInspectorChange?: (active: boolean) => void;
  // Bumped nonce asking this viewer to open its Share/Export menu (chat-side
  // "Share" next-step action). Only HTML artifacts expose a Share menu.
  shareRequest?: { nonce: number } | null;
  // Bumped nonce asking this viewer to open its Download/Export menu (chat-side
  // "Download" next-step action).
  downloadRequest?: { nonce: number } | null;
  // Bumped nonce asking a deck preview to flip to `slideIndex` (a queued chat
  // send for this file just started processing).
  slideNavRequest?: { slideIndex: number; nonce: number } | null;
}

export function FileViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  onExportAsPptx,
  streaming,
  commentQueueOnSend = false,
  commentSendDisabled = false,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
  onOpenFileReplacing,
  commentPortalId,
  onCommentModeChange,
  manualEditPortalId,
  onManualEditInspectorChange,
  shareRequest,
  downloadRequest,
  slideNavRequest,
}: Props) {
  const rendererMatch = artifactRendererRegistry.resolve({
    file,
    isDeckHint: Boolean(isDeck),
  });

  // studio_view artifact — fire once per (project, file) pair so the
  // activation funnel can attribute "user opened the produced artifact"
  // even when the sub-viewer below is HtmlViewer / MarkdownViewer / etc.
  // artifact_id is anonymized to satisfy the CSV's no-filename rule.
  const analytics = useAnalytics();
  const studioViewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${projectId}::${file.name}`;
    if (studioViewKeyRef.current === key) return;
    studioViewKeyRef.current = key;
    trackPageView(analytics.track, {
      page_name: 'artifact',
    });
  }, [projectId, projectKind, file.name, file.kind, rendererMatch?.renderer.id, analytics.track]);

  if (rendererMatch?.renderer.id === 'html' || rendererMatch?.renderer.id === 'deck-html') {
    return (
      <HtmlViewer
        projectId={projectId}
        projectKind={projectKind}
        file={file}
        liveHtml={liveHtml}
        filesRefreshKey={filesRefreshKey}
        isDeck={rendererMatch.renderer.id === 'deck-html'}
        onExportAsPptx={onExportAsPptx}
        streaming={Boolean(streaming)}
        commentQueueOnSend={commentQueueOnSend}
        commentSendDisabled={commentSendDisabled}
        previewComments={previewComments}
        onSavePreviewComment={onSavePreviewComment}
        onRemovePreviewComment={onRemovePreviewComment}
        onSendBoardCommentAttachments={onSendBoardCommentAttachments}
        onFileSaved={onFileSaved}
        commentPortalId={commentPortalId}
        onCommentModeChange={onCommentModeChange}
        manualEditPortalId={manualEditPortalId}
        onManualEditInspectorChange={onManualEditInspectorChange}
        shareRequest={shareRequest}
        downloadRequest={downloadRequest}
        slideNavRequest={slideNavRequest}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'react-component') {
    return (
      <ReactComponentViewer
        projectId={projectId}
        file={file}
        onOpenFileReplacing={onOpenFileReplacing}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'markdown') {
    return <MarkdownViewer projectId={projectId} file={file} />;
  }
  if (rendererMatch?.renderer.id === 'svg') {
    return <SvgViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'image') {
    return <ImageViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'video') {
    return <VideoViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'audio') {
    return <AudioViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'sketch') {
    if (isRenderableSketchJson(file)) {
      return <SketchViewer projectId={projectId} file={file} />;
    }
    return <ImageViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'text' || file.kind === 'code') {
    return <TextViewer projectId={projectId} file={file} />;
  }
  if (
    file.kind === 'pdf' ||
    file.kind === 'document' ||
    file.kind === 'presentation' ||
    file.kind === 'spreadsheet'
  ) {
    return <DocumentPreviewViewer projectId={projectId} file={file} />;
  }
  return <BinaryViewer projectId={projectId} file={file} />;
}

function exportReadyNudgeKey(projectId: string, fileName: string): string {
  return `${EXPORT_READY_NUDGE_STORAGE_PREFIX}${projectId}:${fileName}`;
}

function hasSeenExportReadyNudge(projectId: string, fileName: string): boolean {
  try {
    return window.sessionStorage.getItem(exportReadyNudgeKey(projectId, fileName)) === '1';
  } catch {
    return false;
  }
}

function markExportReadyNudgeSeen(projectId: string, fileName: string) {
  try {
    window.sessionStorage.setItem(exportReadyNudgeKey(projectId, fileName), '1');
  } catch {
    // Ignore storage-denied contexts; the in-memory state still prevents loops.
  }
}

function FileActions({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  return (
    <div className="viewer-toolbar-actions">
      <a
        className="ghost-link"
        href={projectFileUrl(projectId, file.name)}
        download={file.name}
      >
        {t('fileViewer.download')}
      </a>
      <a
        className="ghost-link"
        href={projectFileUrl(projectId, file.name)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {t('fileViewer.open')}
      </a>
    </div>
  );
}

function formatCommentTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t('common.minutesAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('common.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('common.daysAgo', { n: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('common.weeksAgo', { n: weeks });
  return new Date(ts).toLocaleDateString();
}

function commentActivityAt(comment: PreviewComment): number {
  return Math.max(
    Number.isFinite(comment.updatedAt) ? comment.updatedAt : 0,
    Number.isFinite(comment.createdAt) ? comment.createdAt : 0,
  );
}

function commentCreatedAt(comment: PreviewComment): number {
  return Number.isFinite(comment.createdAt) ? comment.createdAt : commentActivityAt(comment);
}

function commentTargetIntersectsPreview(
  target: PreviewCommentSnapshot | null,
  scale: number,
  offset: { x: number; y: number },
  bounds?: PreviewCanvasSize,
): boolean {
  if (!target || !bounds?.width || !bounds.height) return true;
  const rect = overlayBoundsFromSnapshot(target, scale, offset);
  const margin = 8;
  return (
    rect.left + rect.width > margin &&
    rect.top + rect.height > margin &&
    rect.left < bounds.width - margin &&
    rect.top < bounds.height - margin
  );
}

function commentDisplayLabel(comment: PreviewComment, t: TranslateFn): string {
  if (comment.elementId.startsWith('pin-')) return t('chat.comments.pin');
  const label = String(comment.label || '').trim().toLowerCase();
  const htmlHint = String(comment.htmlHint || '').trim().toLowerCase();
  const elementId = String(comment.elementId || '').trim().toLowerCase();
  const source = `${label} ${htmlHint} ${elementId}`;
  if (/\b(?:img|picture|video|canvas|svg)\b/.test(source)) return t('chat.comments.targetImage');
  if (/\b(?:button|input|textarea|select|label)\b/.test(source)) return t('chat.comments.targetControl');
  if (/^<a\b/.test(htmlHint)) return t('chat.comments.targetLink');
  if (/\b(?:h1|h2|h3|h4|h5|h6|p|span|strong|em|small|li|dt|dd)\b/.test(source)) return t('chat.comments.targetText');
  if (/\b(?:section|main|header|footer|nav|article|aside)\b/.test(source)) return t('chat.comments.targetSection');
  if (label.endsWith('.html') || elementId.startsWith('file-comment-')) return t('chat.comments.targetPage');
  if (comment.text.trim()) return t('chat.comments.targetText');
  return t('chat.comments.targetArea');
}

export function CommentSidePanel({
  comments,
  projectId,
  selectedIds,
  activeCommentId,
  collapsed,
  onCollapsedChange,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onReorder,
  onReply,
  onSendSelected,
  onCreateComment,
  sending,
  queueOnSend = false,
  sendDisabled = false,
  renderCreateForm = true,
  t,
  composer,
}: {
  comments: PreviewComment[];
  projectId?: string;
  selectedIds: Set<string>;
  activeCommentId: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleSelect: (commentId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onReorder?: (orderedIds: string[]) => void;
  onReply: (comment: PreviewComment) => void;
  onSendSelected: () => void | Promise<void>;
  onCreateComment?: (note: string) => boolean | Promise<boolean>;
  sending: boolean;
  queueOnSend?: boolean;
  sendDisabled?: boolean;
  renderCreateForm?: boolean;
  t: TranslateFn;
  composer?: ReactNode;
}) {
  const [newCommentDraft, setNewCommentDraft] = useState('');
  const [dragState, setDragState] = useState<CommentSideDragState | null>(null);
  const sorted = comments;
  const visibleSelectedIds = new Set(comments.filter((comment) => selectedIds.has(comment.id)).map((comment) => comment.id));
  const selectedCount = visibleSelectedIds.size;
  const allSelected = comments.length > 0 && selectedCount === comments.length;
  const commentsLabel = t('chat.tabComments');
  const canCreateComment = Boolean(onCreateComment) && newCommentDraft.trim().length > 0 && !sending && !sendDisabled;
  const canReorder = Boolean(onReorder && sorted.length > 1);
  const collapsedRailRef = useRef<HTMLButtonElement | null>(null);
  const expandedToggleRef = useRef<HTMLButtonElement | null>(null);
  const pendingToggleFocusRef = useRef<'collapsed' | 'expanded' | null>(null);
  const panelId = useId();
  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>, comment: PreviewComment) => {
    if (!canReorder) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(COMMENT_SIDE_DRAG_MIME, comment.id);
    event.dataTransfer.setData('text/plain', comment.id);
    setDragState({ draggingId: comment.id, overId: comment.id, edge: null });
  };
  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    if (!canReorder) return;
    const draggingId = dragState?.draggingId || event.dataTransfer.getData(COMMENT_SIDE_DRAG_MIME);
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (draggingId === targetId) {
      if (dragState?.overId !== targetId || dragState.edge !== null) {
        setDragState({ draggingId, overId: targetId, edge: null });
      }
      return;
    }
    const edge = commentSideDropEdgeForEvent(event);
    if (
      dragState?.draggingId !== draggingId ||
      dragState.overId !== targetId ||
      dragState.edge !== edge
    ) {
      setDragState({ draggingId, overId: targetId, edge });
    }
  };
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>, targetId: string) => {
    if (!canReorder) return;
    event.preventDefault();
    const draggingId =
      dragState?.draggingId ||
      event.dataTransfer.getData(COMMENT_SIDE_DRAG_MIME) ||
      event.dataTransfer.getData('text/plain');
    if (!draggingId || draggingId === targetId) {
      setDragState(null);
      return;
    }
    const edge = dragState?.overId === targetId && dragState.edge
      ? dragState.edge
      : commentSideDropEdgeForEvent(event);
    const nextIds = reorderPreviewCommentIds(sorted, draggingId, targetId, edge);
    if (nextIds.join('\0') !== sorted.map((comment) => comment.id).join('\0')) {
      onReorder?.(nextIds);
    }
    setDragState(null);
  };
  const submitNewComment = async () => {
    if (!onCreateComment || !newCommentDraft.trim()) return;
    const saved = await onCreateComment(newCommentDraft.trim());
    if (saved) setNewCommentDraft('');
  };

  useEffect(() => {
    const target =
      pendingToggleFocusRef.current === 'collapsed'
        ? collapsedRailRef.current
        : pendingToggleFocusRef.current === 'expanded'
          ? expandedToggleRef.current
          : null;
    if (!target) return;
    pendingToggleFocusRef.current = null;
    target.focus();
  }, [collapsed]);

  const handleCollapsedChange = (
    nextCollapsed: boolean,
    nextFocusTarget: 'collapsed' | 'expanded',
  ) => {
    pendingToggleFocusRef.current = nextFocusTarget;
    onCollapsedChange(nextCollapsed);
  };

  if (collapsed) {
    return (
      <button
        ref={collapsedRailRef}
        type="button"
        className="comment-side-rail"
        data-testid="comment-side-collapsed-rail"
        aria-label={t('preview.showSidebar', { label: commentsLabel })}
        aria-expanded={false}
        title={t('preview.showSidebar', { label: commentsLabel })}
        onClick={() => handleCollapsedChange(false, 'expanded')}
      >
        <RemixIcon name="message-3-line" size={15} />
        <span>{commentsLabel}</span>
        {comments.length > 0 ? <strong>{comments.length}</strong> : null}
      </button>
    );
  }

  return (
    <aside id={panelId} className="comment-side-panel" data-testid="comment-side-panel" aria-label={commentsLabel}>
      <div className="comment-side-header">
        <div className="comment-side-title">
          <RemixIcon name="message-3-line" size={15} />
          <span>{commentsLabel}</span>
        </div>
        <div className="comment-side-header-actions">
          {comments.length > 0 ? (
            <button
              type="button"
              className="comment-side-select-all"
              disabled={allSelected}
              onClick={onSelectAll}
            >
              {t('chat.comments.selectAll')}
            </button>
          ) : null}
          <button
            ref={expandedToggleRef}
            type="button"
            className="comment-side-collapse"
            aria-label={t('preview.hideSidebar', { label: commentsLabel })}
            aria-controls={panelId}
            aria-expanded={true}
            title={t('preview.hideSidebar', { label: commentsLabel })}
            onClick={() => handleCollapsedChange(true, 'collapsed')}
          >
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </div>
      <div
        className="comment-side-list"
        onDragLeave={(event) => {
          const related = event.relatedTarget;
          if (related instanceof Node && event.currentTarget.contains(related)) return;
          setDragState(null);
        }}
      >
        {sorted.length === 0 ? (
          <div className="comment-side-empty">
            {t('chat.comments.emptySaved')}
          </div>
        ) : sorted.map((comment, index) => {
          const selected = visibleSelectedIds.has(comment.id);
          const active = comment.id === activeCommentId;
          const isDragging = dragState?.draggingId === comment.id;
          const dropClass = dragState?.overId === comment.id &&
            dragState.draggingId !== comment.id &&
            dragState.edge
            ? ` comment-side-item-drop-${dragState.edge}`
            : '';
          return (
            <div
              key={comment.id}
              className={`comment-side-item${selected ? ' selected' : ''}${active ? ' active' : ''}${isDragging ? ' dragging' : ''}${dropClass}`}
              data-testid="comment-side-item"
              data-comment-id={comment.id}
              aria-current={active ? 'true' : undefined}
              role="button"
              tabIndex={0}
              onDragOver={(event) => handleDragOver(event, comment.id)}
              onDrop={(event) => handleDrop(event, comment.id)}
              onClick={() => onReply(comment)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onReply(comment);
              }}
            >
              <div className="comment-side-item-head">
                <button
                  type="button"
                  className="comment-side-drag-handle"
                  title={t('chat.queuedReorder')}
                  aria-label={t('chat.queuedReorder')}
                  draggable={canReorder}
                  disabled={!canReorder}
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => handleDragStart(event, comment)}
                  onDragEnd={() => setDragState(null)}
                >
                  <Icon name="grip-vertical" size={13} />
                </button>
                <span className="comment-side-author">
                  <strong>{`${index + 1}. ${commentDisplayLabel(comment, t)}`}</strong>
                </span>
                <span className="comment-side-time">{formatCommentTime(commentActivityAt(comment), t)}</span>
                <button
                  type="button"
                  className={`comment-side-check${selected ? ' checked' : ''}`}
                  aria-label={selected ? t('chat.comments.deselect') : t('chat.comments.select')}
                  aria-pressed={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleSelect(comment.id);
                  }}
                >
                  {selected ? <Icon name="check" size={11} /> : null}
                </button>
              </div>
              <div className="comment-side-body">{comment.note}</div>
              {projectId && comment.attachments && comment.attachments.length > 0 ? (
                <div className="comment-side-attachments">
                  {comment.attachments.map((attachment) => {
                    const url = projectRawUrl(projectId, attachment.path);
                    return (
                      <a
                        key={attachment.path}
                        className="comment-side-attachment"
                        data-testid="comment-side-attachment"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={attachment.name}
                        title={attachment.name}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <img src={url} alt={attachment.name} />
                      </a>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {selectedCount > 0 ? (
        <div className="comment-side-selectbar" data-testid="comment-side-selectbar">
          <span className="comment-side-selectcount">{t('chat.comments.nSelected', { n: selectedCount })}</span>
          <Button variant="ghost" onClick={onClearSelection}>
            {t('chat.comments.clear')}
          </Button>
          <Button
            variant="primary"
            data-testid="comment-side-send-claude"
            disabled={sending || sendDisabled}
            onClick={() => void onSendSelected()}
          >
            {sending
              ? t('chat.comments.sending')
              : queueOnSend
                ? t('chat.annotationQueue')
                : t('chat.comments.sendToChat')}
          </Button>
        </div>
      ) : null}
      {composer ? <div className="comment-side-composer">{composer}</div> : null}
      {renderCreateForm && onCreateComment ? (
        <form
          className="comment-side-new-comment composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNewComment();
          }}
        >
          <div className="composer-shell comment-side-new-comment-shell">
            <div className="composer-input-wrap">
              <div className="composer-textarea-layer">
                <textarea
                  value={newCommentDraft}
                  placeholder={t('chat.comments.placeholder')}
                  aria-label={t('chat.comments.placeholder')}
                  onChange={(event) => setNewCommentDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      void submitNewComment();
                    }
                  }}
                />
              </div>
            </div>
            <div className="composer-row comment-side-new-comment-actions">
              <button
                type="button"
                className="icon-btn"
                title={t('chat.cliSettingsTitle')}
                aria-label={t('chat.cliSettingsAria')}
                disabled
              >
                <span className="composer-tools-at" aria-hidden>
                  @
                </span>
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t('chat.attachTitle')}
                aria-label={t('chat.attachAria')}
                disabled
              >
                <Icon name="attach" size={15} />
              </button>
              <span className="composer-spacer" />
              <button
                type="submit"
                className={`composer-send${sending ? ' is-sending' : ''}`}
                disabled={!canCreateComment}
              >
                <Icon name="send" size={13} />
                <span>{sending ? t('chat.comments.sending') : t('chat.send')}</span>
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </aside>
  );
}

const COMMENT_SIDE_DRAG_MIME = 'application/x-readable-studio-preview-comment';

type CommentSideDropEdge = 'before' | 'after';

interface CommentSideDragState {
  draggingId: string;
  overId: string | null;
  edge: CommentSideDropEdge | null;
}

function commentSideDropEdgeForEvent(event: ReactDragEvent<HTMLElement>): CommentSideDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function reorderPreviewCommentIds(
  comments: PreviewComment[],
  draggingId: string,
  targetId: string,
  edge: CommentSideDropEdge,
): string[] {
  const ids = comments.map((comment) => comment.id);
  const from = ids.indexOf(draggingId);
  if (from < 0) return ids;
  const [draggedId] = ids.splice(from, 1);
  const targetIndex = ids.indexOf(targetId);
  if (targetIndex < 0 || !draggedId) return comments.map((comment) => comment.id);
  ids.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, draggedId);
  return ids;
}

export function appendSavedPreviewCommentOrder(
  currentOrderIds: string[],
  visibleComments: Array<Pick<PreviewComment, 'id'>>,
  savedId: string,
): string[] {
  if (!savedId) return currentOrderIds;
  const visibleIds = visibleComments.map((comment) => comment.id);
  if (currentOrderIds.includes(savedId) || visibleIds.includes(savedId)) {
    return currentOrderIds;
  }
  const visibleIdSet = new Set(visibleIds);
  const kept = currentOrderIds.filter((id) => visibleIdSet.has(id));
  const missingVisibleIds = visibleIds.filter((id) => !kept.includes(id));
  const base = currentOrderIds.length > 0 ? [...kept, ...missingVisibleIds] : visibleIds;
  const next = [...base, savedId];
  return next.join('\0') === currentOrderIds.join('\0') ? currentOrderIds : next;
}

function CommentSideDock({
  comments,
  projectId,
  selectedIds,
  activeCommentId,
  collapsed,
  onCollapsedChange,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onReorder,
  onReply,
  onSendSelected,
  onCreateComment,
  sending,
  queueOnSend = false,
  sendDisabled = false,
  renderCreateForm = true,
  t,
  composer,
}: {
  comments: PreviewComment[];
  projectId?: string;
  selectedIds: Set<string>;
  activeCommentId: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onToggleSelect: (commentId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onReorder?: (orderedIds: string[]) => void;
  onReply: (comment: PreviewComment) => void;
  onSendSelected: () => void | Promise<void>;
  onCreateComment?: (note: string) => boolean | Promise<boolean>;
  sending: boolean;
  queueOnSend?: boolean;
  sendDisabled?: boolean;
  renderCreateForm?: boolean;
  t: TranslateFn;
  composer?: ReactNode;
}) {
  return (
    <div
      className={`comment-side-dock${collapsed ? ' collapsed' : ''}`}
      data-testid="comment-side-dock"
    >
      <CommentSidePanel
        comments={comments}
        projectId={projectId}
        selectedIds={selectedIds}
        activeCommentId={activeCommentId}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        onToggleSelect={onToggleSelect}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onReorder={onReorder}
        onReply={onReply}
        onSendSelected={onSendSelected}
        onCreateComment={onCreateComment}
        sending={sending}
        queueOnSend={queueOnSend}
        sendDisabled={sendDisabled}
        renderCreateForm={renderCreateForm}
        t={t}
        composer={composer}
      />
    </div>
  );
}

// Maps a CSS computed value (e.g. "rgb(40, 50, 60)" or "16px") to a form
// input value. Browsers return colors as rgb()/rgba(); HTML <input type=color>
// only accepts "#rrggbb". Lengths come back as "12px" or "0px"; we strip
// units for slider binding and re-append on emit.
//
// Note: <input type=color> has no alpha channel, so an rgba() with alpha < 1
// is collapsed to its opaque RGB equivalent here. Most agent-generated HTML
// uses opaque colors, so this is a known cosmetic limitation — a
// semi-transparent source value will display in the panel as fully opaque.
function rgbToHex(value: string | undefined): string {
  if (!value) return '#000000';
  const v = value.trim();
  if (v.startsWith('#') && (v.length === 7 || v.length === 4)) {
    if (v.length === 4) {
      return '#' + [1, 2, 3].map((i) => {
        const c = v.charAt(i);
        return c + c;
      }).join('');
    }
    return v;
  }
  const m = v.match(/rgba?\(\s*([0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
  if (!m) return '#000000';
  const toHex = (n: string) => {
    const x = Math.max(0, Math.min(255, Math.round(Number(n))));
    return x.toString(16).padStart(2, '0');
  };
  return '#' + toHex(m[1] ?? '0') + toHex(m[2] ?? '0') + toHex(m[3] ?? '0');
}

// Parse a CSS length to a number. Inspect's current sliders all clamp to a
// non-negative range (padding, font-size, border-radius), so we reject
// negatives at parse time too — otherwise a `-12px` source value would be
// silently floored to 0 by the slider clamp without the regex agreeing.
// If a future control needs negative values (e.g. margin), thread an
// explicit `allowNegative` flag rather than reintroducing `-?` here.
function pxToNumber(value: string | undefined): number {
  if (!value) return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function InspectPanel({
  target,
  onApply,
  onResetElement,
  onSaveToSource,
  onClose,
  saving,
  savedAt,
  error,
}: {
  target: InspectTarget;
  onApply: (prop: string, value: string) => void;
  onResetElement: (elementId: string) => void;
  onSaveToSource: () => void;
  onClose: () => void;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
}) {
  // Local "draft" mirror of the most recent value the user picked, so
  // sliders/colors keep responding even before the iframe echoes back the
  // computed result. Reset whenever the selected element changes.
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft({});
  }, [target.elementId]);

  const value = (prop: string, fallback: string): string =>
    draft[prop] ?? fallback;

  function setVal(prop: string, raw: string) {
    setDraft((d) => ({ ...d, [prop]: raw }));
    onApply(prop, raw);
  }

  // Padding is exposed as a single shared slider that emits the `padding`
  // shorthand; the browser fans the value out to all four sides internally.
  // When per-side control becomes useful, switch to emitting explicit
  // padding-top / padding-right / padding-bottom / padding-left props
  // (the bridge already allow-lists those long-hand names).
  const initialPadding = pxToNumber(target.style.paddingTop);
  const initialFontSize = pxToNumber(target.style.fontSize);
  const initialRadius = pxToNumber(target.style.borderRadius);

  // Color / length controls all read through `draft` first so the input
  // tracks the most recent user pick even before getComputedStyle catches
  // up. Without this the picker would snap back to the initial computed
  // snapshot on every change and feel non-editable.
  const colorHex = value('color', rgbToHex(target.style.color));
  const bgHex = value('background-color', rgbToHex(target.style.backgroundColor));
  const padding = value('padding', String(initialPadding));
  const fontSize = value('font-size', String(initialFontSize));
  const radius = value('border-radius', String(initialRadius));
  const textAlign = value('text-align', target.style.textAlign || 'left');
  const fontWeight = value('font-weight', target.style.fontWeight || '400');
  // Parse once: `pxToNumber(...) || initial...` would treat a legitimate
  // `0px` draft as missing and snap the slider back to the original
  // computed value, making it impossible to remove padding/radius from an
  // element whose initial value is nonzero. `pxToNumber` already returns
  // 0 for unparseable input, so its result is safe to consume directly
  // and zero is preserved.
  const paddingNum = pxToNumber(padding);
  const fontSizeNum = pxToNumber(fontSize);
  const radiusNum = pxToNumber(radius);

  const justSaved = savedAt && Date.now() - savedAt < 4000;

  return (
    <aside className="inspect-panel" data-testid="inspect-panel">
      <header className="inspect-panel-head">
        <div className="inspect-panel-title">
          <strong title={target.label || target.elementId}>{target.label || target.elementId}</strong>
          <code title={target.selector}>{target.elementId}</code>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="Close inspect">
          ×
        </Button>
      </header>

      {target.clickedDescendant ? (
        <div className="inspect-ancestor-notice" data-testid="inspect-ancestor-notice">
          <div className="inspect-ancestor-notice-icon" aria-hidden>
            i
          </div>
          <div className="inspect-ancestor-notice-text">
            You clicked <strong>{target.clickedDescendant.label}</strong>
            {target.clickedDescendant.text
              ? ` ("${target.clickedDescendant.text.slice(0, 40)}${target.clickedDescendant.text.length > 40 ? '...' : ''}")`
              : ''}
            , but it has no <code>data-readable-id</code> annotation. Editing{' '}
            <strong>{target.label || target.elementId}</strong> instead, the nearest annotated ancestor.
          </div>
        </div>
      ) : null}

      <section className="inspect-section">
        <div className="inspect-section-label">Colors</div>
        <div className="inspect-row">
          <label htmlFor="ip-color">Text</label>
          <Input
            id="ip-color"
            data-testid="inspect-color"
            type="color"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
          />
          <Input
            type="text"
            value={colorHex}
            onChange={(e) => setVal('color', e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-bg">Background</label>
          <Input
            id="ip-bg"
            data-testid="inspect-bg"
            type="color"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
          />
          <Input
            type="text"
            value={bgHex}
            onChange={(e) => setVal('background-color', e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Typography</div>
        <div className="inspect-row">
          <label htmlFor="ip-fs">Size</label>
          <input
            id="ip-fs"
            data-testid="inspect-font-size"
            type="range"
            min={8}
            max={160}
            step={1}
            value={clamp(fontSizeNum, 8, 160)}
            onChange={(e) => setVal('font-size', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(fontSizeNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-fw">Weight</label>
          <Select
            id="ip-fw"
            value={fontWeight}
            onChange={(e) => setVal('font-weight', e.target.value)}
          >
            {['100', '300', '400', '500', '600', '700', '800', '900'].map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </Select>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-ta">Align</label>
          <Select
            id="ip-ta"
            value={textAlign}
            onChange={(e) => setVal('text-align', e.target.value)}
          >
            {['left', 'center', 'right', 'justify'].map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
        </div>
      </section>

      <section className="inspect-section">
        <div className="inspect-section-label">Spacing &amp; Shape</div>
        <div className="inspect-row">
          <label htmlFor="ip-pad">Padding</label>
          <input
            id="ip-pad"
            data-testid="inspect-padding"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(paddingNum, 0, 120)}
            onChange={(e) => setVal('padding', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(paddingNum)}px</span>
        </div>
        <div className="inspect-row">
          <label htmlFor="ip-rad">Radius</label>
          <input
            id="ip-rad"
            data-testid="inspect-radius"
            type="range"
            min={0}
            max={120}
            step={1}
            value={clamp(radiusNum, 0, 120)}
            onChange={(e) => setVal('border-radius', `${e.target.value}px`)}
          />
          <span className="inspect-row-value">{Math.round(radiusNum)}px</span>
        </div>
      </section>

      <footer className="inspect-panel-footer">
        <Button
          variant="ghost"
          onClick={() => {
            setDraft({});
            onResetElement(target.elementId);
          }}
        >
          Reset element
        </Button>
        <Button
          variant="primary"
          data-testid="inspect-save"
          disabled={saving}
          onClick={onSaveToSource}
        >
          {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save to source'}
        </Button>
      </footer>
      {error ? <div className="inspect-panel-error">{error}</div> : null}
    </aside>
  );
}

// Inspect-mode override entry as held in the host's authoritative map and as
// it travels in readable-studio:inspect-overrides messages. The host's persisted map is
// owned and mutated only by host-driven onApply / reset actions plus the
// initial parse of the source's <style data-readable-inspect-overrides> block;
// inbound iframe messages are treated as preview acknowledgements, never as
// save input. Artifact code rendered with scripts enabled can call
// window.parent.postMessage with a forged payload — ev.source still points
// at iframe.contentWindow — so any field arriving from the iframe is
// untrusted. Even the structured `overrides` field could be tampered with
// to flip allow-listed properties on elements the user never edited, which
// is why we no longer ingest it on save.
type InspectOverridePayload = {
  selector?: unknown;
  props?: unknown;
};

// Authoritative host-side override map: elementId → { selector, props }.
// Mirrors the in-iframe shape so serializeInspectOverrides can consume it.
export type InspectOverrideEntry = {
  selector: string;
  props: Record<string, string>;
};
export type InspectOverrideMap = Record<string, InspectOverrideEntry>;

// Allow-list of CSS properties the host will persist on Save. Mirrors the
// in-iframe ALLOWED_PROPS list so the host doesn't accept properties that
// the bridge itself would reject.
const HOST_ALLOWED_INSPECT_PROPS = new Set([
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-family',
  'line-height',
  'text-align',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-radius',
]);

// Reject values that could break out of `prop: value` and into the
// surrounding <style> block — semicolons, braces, angle brackets, and
// newlines. Mirrors the bridge's UNSAFE_VALUE regex.
const HOST_UNSAFE_INSPECT_VALUE = /[;{}<>\n\r]/;

// Reject elementIds whose characters could break out of `[attr="..."]`
// inside a <style> block. Forbidden:
//   - `"` and `\` would close the attribute string or smuggle CSS
//     escapes the host didn't pre-process;
//   - `<` and `>` would close the surrounding <style> tag;
//   - C0/C1 controls (newline, etc.) end the CSS rule under string
//     tokenization — kept in as defense-in-depth against parser quirks.
// Everything else — including ASCII whitespace and leading digits — is
// allowed, so deck labels like `01 Cover` survive instead of being
// dropped on the way to the persisted overrides block.
const HOST_UNSAFE_INSPECT_ID = /["\\<>\u0000-\u001f\u007f]/;

// Build the inspect overrides CSS body the host will persist, from the
// structured `overrides` field of an readable-studio:inspect-overrides message. The host
// MUST NOT trust the sibling `css` string — it is attacker-controlled when
// artifact JS forges the message. The selector is re-derived from each
// elementId; only allow-listed properties with safe values survive.
//
// Exported so unit tests can exercise the validator with hostile payloads.
export function serializeInspectOverrides(overrides: unknown): string {
  if (!overrides || typeof overrides !== 'object') return '';
  const map = overrides as Record<string, unknown>;
  const lines: string[] = [];
  for (const elementId of Object.keys(map)) {
    if (!elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) continue;
    const entry = map[elementId] as InspectOverridePayload | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    const props = entry.props;
    if (!props || typeof props !== 'object') continue;
    // Trust only the *kind* of selector the bridge built, not the value
    // it carried. The bridge runs CSS.escape over the elementId, so a raw
    // equality check against `[data-screen-label="${elementId}"]` would
    // miss legitimate deck labels like `01 Cover` (whitespace, leading
    // digit) and silently downgrade them to `[data-readable-id="..."]`. The
    // elementId itself was sanitized above, so embedding it verbatim into
    // the re-derived selector is safe inside an attribute value string.
    const inboundSelector = typeof entry.selector === 'string' ? entry.selector : '';
    const attr = inboundSelector.startsWith('[data-screen-label="')
      ? 'data-screen-label'
      : 'data-readable-id';
    const safeSelector = `[${attr}="${elementId}"]`;
    const decls: string[] = [];
    for (const [rawName, rawValue] of Object.entries(props as Record<string, unknown>)) {
      if (typeof rawName !== 'string' || typeof rawValue !== 'string') continue;
      const name = rawName.toLowerCase();
      if (!HOST_ALLOWED_INSPECT_PROPS.has(name)) continue;
      const value = rawValue.trim();
      if (!value || HOST_UNSAFE_INSPECT_VALUE.test(value)) continue;
      decls.push(`${name}: ${value} !important`);
    }
    if (!decls.length) continue;
    lines.push(`${safeSelector} { ${decls.join('; ')} }`);
  }
  return lines.join('\n');
}

// Apply a single host-driven prop change to the authoritative override map.
// Returns a new map (or the same reference if no-op so React skips renders).
// Empty value clears the prop; clearing the last prop drops the elementId.
// Mirrors the iframe bridge's applyOverride sanitization so the host map and
// the live preview stay in lock-step under the same rules.
export function updateInspectOverride(
  map: InspectOverrideMap,
  elementId: string,
  selector: string,
  prop: string,
  value: string,
): InspectOverrideMap {
  if (!elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) return map;
  const propName = String(prop || '').toLowerCase();
  if (!HOST_ALLOWED_INSPECT_PROPS.has(propName)) return map;
  const trimmed = String(value ?? '').trim();
  if (trimmed && HOST_UNSAFE_INSPECT_VALUE.test(trimmed)) return map;
  const existing = map[elementId];
  const nextProps: Record<string, string> = { ...(existing?.props ?? {}) };
  if (!trimmed) {
    if (!(propName in nextProps)) return map;
    delete nextProps[propName];
  } else if (nextProps[propName] === trimmed && existing?.selector === selector) {
    return map;
  } else {
    nextProps[propName] = trimmed;
  }
  const nextMap: InspectOverrideMap = { ...map };
  if (Object.keys(nextProps).length === 0) {
    delete nextMap[elementId];
  } else {
    nextMap[elementId] = { selector: selector || existing?.selector || '', props: nextProps };
  }
  return nextMap;
}

// Parse any persisted <style data-readable-inspect-overrides> blocks in the
// artifact source into the host's authoritative override map. The host owns
// this map and only mutates it from onApply / reset actions plus this
// initial hydration step — inbound iframe readable-studio:inspect-overrides messages are
// not ingested. Without this step, opening a file that already carries an
// override block would leave the host map empty, so a Save-to-source after
// any subsequent edit could splice a CSS body that drops every previously
// saved rule for elements the user did not touch in this session.
//
// Mirrors the iframe bridge's hydrateOverridesFromDom: same allow-list,
// same value sanitizer, same selector kinds, so what the iframe applies and
// what the host persists stay in lock-step. Pure string transform; no DOM.
//
// HTML-aware: enumerates `<style data-readable-inspect-overrides>` elements via
// the same walker used by the splicer, so a `<style data-readable-inspect-overrides>`
// literal living inside a `<script>`, `<style>` (e.g. CSS comment), `<textarea>`,
// `<title>`, or HTML comment is not mistaken for a real override block. Without
// that exclusion, useEffect would seed the host map from forged/quoted text and
// a later Save-to-source would persist phantom CSS the user never created.
export function parseInspectOverridesFromSource(source: string): InspectOverrideMap {
  const map: InspectOverrideMap = {};
  if (!source) return map;
  for (const body of stripInspectOverridesAndIndex(source).bodies) {
    const ruleRe = /(\[data-(?:readable-id|screen-label)="([^"]*)"\])\s*\{\s*([^}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(body)) !== null) {
      const selector = ruleMatch[1] ?? '';
      const elementId = ruleMatch[2] ?? '';
      const declBody = ruleMatch[3] ?? '';
      if (!selector || !elementId || HOST_UNSAFE_INSPECT_ID.test(elementId)) continue;
      const props: Record<string, string> = {};
      for (const raw of declBody.split(';')) {
        if (!raw) continue;
        const colon = raw.indexOf(':');
        if (colon <= 0) continue;
        const name = raw.slice(0, colon).trim().toLowerCase();
        if (!HOST_ALLOWED_INSPECT_PROPS.has(name)) continue;
        const value = raw.slice(colon + 1).replace(/!important/gi, '').trim();
        if (!value || HOST_UNSAFE_INSPECT_VALUE.test(value)) continue;
        props[name] = value;
      }
      if (Object.keys(props).length) {
        map[elementId] = { selector, props };
      }
    }
  }
  return map;
}

// HTML5 raw-text and escapable-raw-text elements: the parser does not
// interpret markup inside their contents, so a literal `</head>` or
// `<style data-readable-inspect-overrides>` written as text inside one of them
// must NOT be treated as a real tag. Without this exclusion, a regex-only
// splicer can match `</head>` inside an inline <script> string literal or
// a CSS comment and inject the override block into the middle of
// JavaScript/CSS instead of the actual document head, corrupting the
// artifact on Save to source.
const RAW_TEXT_INSPECT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

// Decide whether a `<style ...>` opening tag actually carries a real
// `data-readable-inspect-overrides` attribute, as opposed to merely mentioning
// the marker text inside another attribute name or value. The naive
// `\bdata-readable-inspect-overrides\b` test against the whole tag text is
// over-broad in two cases:
//
//   1. A longer attribute name that has the marker as a prefix, e.g.
//      `<style data-readable-inspect-overrides-note="docs">`. The `-` after
//      `overrides` is a non-word character, so `\b` matches and the tag
//      gets mis-stripped on save / mis-parsed on hydration.
//   2. The marker spelled inside an attribute value, e.g.
//      `<style title="data-readable-inspect-overrides">`. The whole tag text
//      contains the literal, so the regex matches even though the actual
//      attribute names are `title` only.
//
// Both shapes occur in real artifacts (notes, documentation, fixtures)
// and would either silently drop the user's CSS on save or seed phantom
// overrides into the host map even though the artifact has no real
// override block. So we walk attributes proper, lower-casing each name
// and skipping any quoted value, and report a hit only when one of those
// names is exactly `data-readable-inspect-overrides` (boolean attribute or
// assigned value, both legal HTML for our marker).
function styleTagIsInspectOverrideBlock(tagText: string): boolean {
  const start = /^<style/i.exec(tagText);
  if (!start) return false;
  let i = start[0].length;
  const end = tagText.length;
  while (i < end) {
    const ch = tagText.charAt(i);
    if (ch === '>') return false;
    if (ch === '/' || /\s/.test(ch)) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < end) {
      const c = tagText.charAt(i);
      if (c === '=' || c === '/' || c === '>' || /\s/.test(c)) break;
      i++;
    }
    const name = tagText.slice(nameStart, i).toLowerCase();
    while (i < end && /\s/.test(tagText.charAt(i))) i++;
    if (i < end && tagText.charAt(i) === '=') {
      i++;
      while (i < end && /\s/.test(tagText.charAt(i))) i++;
      const quote = tagText.charAt(i);
      if (quote === '"' || quote === "'") {
        i++;
        const close = tagText.indexOf(quote, i);
        i = close < 0 ? end : close + 1;
      } else {
        while (i < end) {
          const c = tagText.charAt(i);
          if (c === '>' || /\s/.test(c)) break;
          i++;
        }
      }
    }
    if (name === 'data-readable-inspect-overrides') return true;
  }
  return false;
}

// Find the start (`<` position) of the matching close tag for a raw-text
// element, scanning case-insensitively. The close tag must be followed by
// a tag-name boundary (whitespace, `/`, or `>`) so a longer name like
// `</scripted>` doesn't accidentally close a `<script>`.
function findInspectRawTextEnd(source: string, start: number, name: string): number {
  const lower = source.toLowerCase();
  const needle = '</' + name.toLowerCase();
  let p = start;
  while (p < source.length) {
    const idx = lower.indexOf(needle, p);
    if (idx < 0) return -1;
    const after = source.charAt(idx + needle.length);
    if (after === '' || after === '>' || after === '/' || /\s/.test(after)) return idx;
    p = idx + needle.length;
  }
  return -1;
}

type InspectSpliceScan = {
  out: string;
  // Position in `out` immediately after the first top-level `<head ...>`
  // open tag, or -1 if no head was found outside raw-text content.
  headOpenEnd: number;
  // Position in `out` at the first top-level `</head>` close tag, or -1.
  headCloseStart: number;
  // Raw inner-text of every real `<style data-readable-inspect-overrides>` element
  // discovered during the walk, in source order. Excludes occurrences inside
  // raw-text element contents and HTML comments. Hydration parses these
  // bodies for the host map; the splicer ignores them.
  bodies: string[];
};

// Walk `source` and produce a copy with every existing
// `<style data-readable-inspect-overrides>...</style>` block removed, while
// remembering where the real (non-raw-text) `<head>` boundaries land in
// the output. The walker honours HTML comment, doctype/processing
// instruction, and raw-text element boundaries so the splicer can ignore
// tag-shaped literals inside scripts/styles/textareas/titles. Pure string
// transform — no DOM dependency, safe to run during SSR/tests.
function stripInspectOverridesAndIndex(source: string): InspectSpliceScan {
  const parts: string[] = [];
  const bodies: string[] = [];
  let outLen = 0;
  let headOpenEnd = -1;
  let headCloseStart = -1;
  let i = 0;
  function emit(text: string): void {
    if (!text) return;
    parts.push(text);
    outLen += text.length;
  }
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      emit(source.slice(i));
      break;
    }
    if (lt > i) emit(source.slice(i, lt));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      const stop = end < 0 ? source.length : end + 3;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
      const end = source.indexOf('>', i + 2);
      const stop = end < 0 ? source.length : end + 1;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    const tagEnd = source.indexOf('>', i + 1);
    if (tagEnd < 0) {
      emit(source.slice(i));
      break;
    }
    const tagText = source.slice(i, tagEnd + 1);
    const closeMatch = /^<\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
    if (closeMatch) {
      const name = closeMatch[1]!.toLowerCase();
      if (name === 'head' && headCloseStart < 0) headCloseStart = outLen;
      emit(tagText);
      i = tagEnd + 1;
      continue;
    }
    const openMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
    if (!openMatch) {
      emit(tagText);
      i = tagEnd + 1;
      continue;
    }
    const name = openMatch[1]!.toLowerCase();
    const isSelfClose = /\/\s*>$/.test(tagText);
    if (name === 'head' && headOpenEnd < 0) headOpenEnd = outLen + tagText.length;
    if (name === 'style' && styleTagIsInspectOverrideBlock(tagText)) {
      // Strip the entire override block. A self-closing <style /> is a
      // degenerate authoring case; treat it as nothing to skip past.
      if (isSelfClose) {
        i = tagEnd + 1;
        continue;
      }
      const closeStart = findInspectRawTextEnd(source, tagEnd + 1, 'style');
      if (closeStart < 0) {
        // Unterminated override block — drop the rest of the document
        // rather than silently reflowing later content into a dangling
        // <style>. Matches the "stop" behaviour of the previous regex.
        i = source.length;
        continue;
      }
      bodies.push(source.slice(tagEnd + 1, closeStart));
      const closeEnd = source.indexOf('>', closeStart);
      let stop = closeEnd < 0 ? source.length : closeEnd + 1;
      while (stop < source.length && /\s/.test(source.charAt(stop))) stop++;
      i = stop;
      continue;
    }
    if (!isSelfClose && RAW_TEXT_INSPECT_ELEMENTS.has(name)) {
      const closeStart = findInspectRawTextEnd(source, tagEnd + 1, name);
      if (closeStart < 0) {
        emit(source.slice(i));
        i = source.length;
        continue;
      }
      const closeEnd = source.indexOf('>', closeStart);
      const stop = closeEnd < 0 ? source.length : closeEnd + 1;
      // Copy the entire raw-text element (open tag, body, close tag) to
      // the output verbatim so its contents pass through unmodified.
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    emit(tagText);
    i = tagEnd + 1;
  }
  return { out: parts.join(''), headOpenEnd, headCloseStart, bodies };
}

// Splice (or remove) the inspect overrides <style> block in an HTML
// document. Idempotent: calling with the same css produces the same
// document. Empty css strips the block entirely.
//
// HTML-aware: the underlying scan ignores comments and raw-text element
// contents (script / style / textarea / title), so a literal `</head>` or
// `<style data-readable-inspect-overrides>` written inside an inline script or
// style block does not trick the splicer into stripping user code or
// inserting the override block in the middle of JavaScript/CSS.
//
// Exported (via the module) so a unit test can drive it without a live
// browser. Pure string transform — no DOM, no parser dependency.
export function applyInspectOverridesToSource(source: string, css: string): string {
  const trimmed = css.trim();
  const { out, headOpenEnd, headCloseStart } = stripInspectOverridesAndIndex(source);
  if (!trimmed) return out;
  const block = `<style data-readable-inspect-overrides>\n${trimmed}\n</style>\n`;
  if (headCloseStart >= 0) {
    return out.slice(0, headCloseStart) + block + out.slice(headCloseStart);
  }
  if (headOpenEnd >= 0) {
    return out.slice(0, headOpenEnd) + block + out.slice(headOpenEnd);
  }
  return block + out;
}

function CommentPreviewOverlays({
  comments,
  liveTargets,
  hoveredTarget,
  hoveredPodMemberId,
  activeTarget,
  activeExistingCommentId = null,
  boardTool,
  showActivePin = false,
  scale,
  offsetX,
  offsetY,
  strokePoints,
  activeSlideIndex = null,
  onOpenComment,
}: {
  comments: PreviewComment[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
  hoveredTarget: PreviewCommentSnapshot | null;
  hoveredPodMemberId: string | null;
  activeTarget: PreviewCommentSnapshot | null;
  activeExistingCommentId?: string | null;
  boardTool: BoardTool;
  showActivePin?: boolean;
  scale: number;
  offsetX: number;
  offsetY: number;
  strokePoints: StrokePoint[];
  activeSlideIndex?: number | null;
  onOpenComment: (comment: PreviewComment, snapshot: PreviewCommentSnapshot) => void;
}) {
  const overlayOffset = useMemo(() => ({ x: offsetX, y: offsetY }), [offsetX, offsetY]);
  const visibleComments = useMemo(
    () =>
      comments
        .map((comment, globalIndex) => ({
          comment,
          markerNumber: globalIndex + 1,
          snapshot: liveSnapshotForComment(comment, liveTargets),
        }))
        .filter((item): item is { comment: PreviewComment; markerNumber: number; snapshot: PreviewCommentSnapshot } =>
          Boolean(item.snapshot),
        )
        .filter(({ comment }) => commentVisibleOnDeckSlide(comment, activeSlideIndex)),
    [comments, liveTargets, activeSlideIndex],
  );
  // `onOpenComment` is an inline arrow from the parent (new identity every
  // render), so read it through a ref to keep the saved-marker memo below from
  // busting. The closure only calls stable state setters, so a current ref read
  // is always correct.
  const onOpenCommentRef = useRef(onOpenComment);
  onOpenCommentRef.current = onOpenComment;
  // Memoize the saved-marker subtree. While the user draws a pod lasso,
  // `strokePoints` updates on every pointermove and re-renders this overlay;
  // without this, every saved marker (bounds + JSX) was rebuilt each frame.
  // Keyed only on the marker inputs (NOT strokePoints), so a steady set of
  // comments reuses the whole subtree and React skips reconciling it.
  const savedMarkers = useMemo(
    () =>
      visibleComments.map(({ comment, markerNumber, snapshot }) => {
        const bounds = overlayBoundsFromSnapshot(snapshot, scale, overlayOffset);
        const label = commentTargetDisplayName(comment);
        return (
          <div
            key={comment.id}
            className="comment-saved-marker"
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            }}
            data-testid={`comment-saved-marker-${comment.elementId}`}
            onClick={() => onOpenCommentRef.current(comment, snapshot)}
          >
            <div className="comment-saved-outline" />
            <button
              type="button"
              className="comment-saved-pin"
              onClick={(event) => {
                event.stopPropagation();
                onOpenCommentRef.current(comment, snapshot);
              }}
              title={`${markerNumber}. ${label}: ${comment.note}`}
              aria-label={`Open comment for ${label}`}
            >
              {markerNumber}
            </button>
          </div>
        );
      }),
    [visibleComments, scale, overlayOffset],
  );
  const activeSavedIndex = activeExistingCommentId
    ? comments.findIndex((comment) => comment.id === activeExistingCommentId)
    : -1;
  const activePinNumber = activeSavedIndex >= 0
    ? activeSavedIndex + 1
    : comments.length + 1;
  const targetOverlay = activeTarget ?? hoveredTarget;
  return (
    <div className="comment-overlay-layer" aria-hidden={false}>
      {savedMarkers}
      {targetOverlay ? (
        <CommentTargetOverlay
          snapshot={targetOverlay}
          scale={scale}
          offset={overlayOffset}
          selected={Boolean(activeTarget)}
          hoveredMemberId={hoveredPodMemberId}
        />
      ) : null}
      {showActivePin && activeTarget ? (
        <div
          className="comment-active-pin"
          style={activeCommentPinStyle(activeTarget, scale, overlayOffset)}
          data-testid="comment-active-pin"
          aria-hidden="true"
        >
          {activePinNumber}
        </div>
      ) : null}
      {boardTool === 'pod' && strokePoints.length > 1 ? (
        <svg className="board-pod-stroke">
          <polyline
            points={strokePoints.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(' ')}
          />
        </svg>
      ) : null}
    </div>
  );
}

function activeCommentPinStyle(
  target: PreviewCommentSnapshot,
  scale: number,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): CSSProperties {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const anchor = target.hoverPoint ?? {
    x: target.position.x,
    y: target.position.y,
  };
  return {
    left: Math.round(offset.x + anchor.x * safeScale),
    top: Math.round(offset.y + anchor.y * safeScale),
  };
}

export function CommentTargetOverlay({
  snapshot,
  scale,
  offset,
  selected,
  hoveredMemberId,
}: {
  snapshot: PreviewCommentSnapshot;
  scale: number;
  offset?: { x: number; y: number };
  selected: boolean;
  hoveredMemberId?: string | null;
}) {
  const overlayOffset = offset ?? { x: 0, y: 0 };
  const displayMembers = podDisplayMembers(snapshot);
  if (displayMembers.length > 0) {
    const overlayWeights = podOverlayWeights(displayMembers);
    return (
      <>
        {displayMembers.map((member, index) => {
          const bounds = overlayBoundsFromSnapshot(member, scale, overlayOffset);
          const width = Math.round(member.position.width);
          const height = Math.round(member.position.height);
          const overlayWeight = overlayWeights[index] ?? {
            backgroundOpacity: 0.24,
            outlineOpacity: 0.72,
            ringOpacity: 0.18,
          };
          const overlayStyle: CSSProperties & Record<string, string | number> = {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            '--comment-overlay-bg': `rgba(22, 119, 255, ${overlayWeight.backgroundOpacity})`,
            '--comment-overlay-ring': `rgba(22, 119, 255, ${overlayWeight.ringOpacity})`,
            '--comment-overlay-border': `rgba(22, 119, 255, ${overlayWeight.outlineOpacity})`,
          };
          const isHoverFocused = hoveredMemberId === member.elementId;
          return (
            <div
              key={`${member.elementId}-${index}`}
              className={`comment-target-overlay comment-target-overlay--member${selected ? ' selected' : ''}${isHoverFocused ? ' is-hover-focused' : ''}`}
              style={overlayStyle}
              data-testid="comment-target-overlay"
            >
              <span className="comment-target-overlay-label">{snapshot.elementId}</span>
            </div>
          );
        })}
      </>
    );
  }
  // Non-member fallback: single-element snapshots have no per-member chips,
  // so the hover-focus channel never reaches this branch — no is-hover-focused
  // class needed here.
  const bounds = overlayBoundsFromSnapshot(snapshot, scale, overlayOffset);
  return (
    <div
      className={`comment-target-overlay${selected ? ' selected' : ''}`}
      style={{
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      }}
      data-testid="comment-target-overlay"
    >
      <span className="comment-target-overlay-label">{snapshot.elementId}</span>
    </div>
  );
}

function podDisplayMembers(snapshot: PreviewCommentSnapshot): PreviewCommentSnapshot[] {
  if (snapshot.selectionKind !== 'pod' || !Array.isArray(snapshot.podMembers)) return [];
  const memberSnapshots = snapshot.podMembers.map((member) => ({
    filePath: snapshot.filePath,
    elementId: member.elementId,
    selector: member.selector,
    label: member.label,
    text: member.text,
    position: member.position,
    htmlHint: member.htmlHint,
    selectionKind: 'element' as const,
  }));
  const refined = pruneContainerSelections(memberSnapshots);
  return refined.length > 0 ? refined : memberSnapshots;
}

function podOverlayWeights(
  members: PreviewCommentSnapshot[],
): Array<{ backgroundOpacity: number; outlineOpacity: number; ringOpacity: number }> {
  const areas = members.map((member) =>
    Math.max(1, member.position.width * member.position.height),
  );
  const maxArea = Math.max(...areas);
  const minArea = Math.min(...areas);
  return areas.map((area) => {
    const normalized =
      maxArea === minArea ? 1 : 1 - (area - minArea) / (maxArea - minArea);
    const emphasis = Math.pow(normalized, 0.9);
    return {
      backgroundOpacity: roundOverlayOpacity(0.1 + emphasis * 0.6),
      outlineOpacity: roundOverlayOpacity(0.34 + emphasis * 0.36),
      ringOpacity: roundOverlayOpacity(0.08 + emphasis * 0.18),
    };
  });
}

function roundOverlayOpacity(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildPodSnapshot(input: {
  filePath: string;
  strokePoints: StrokePoint[];
  liveTargets: Map<string, PreviewCommentSnapshot>;
}): PreviewCommentSnapshot | null {
  if (input.strokePoints.length < 2) return null;
  const closedLoop = isClosedLoop(input.strokePoints);
  const intersected = Array.from(input.liveTargets.values()).filter((snapshot) =>
    selectionHitsSnapshot({
      points: input.strokePoints,
      snapshot,
      closedLoop,
    }),
  );
  const refined = pruneContainerSelections(intersected);
  const selected = refined.length > 0 ? refined : intersected;
  if (selected.length === 0) return null;
  const bounds = selected.reduce(
    (acc, snapshot) => {
      const rect = snapshot.position;
      return {
        left: Math.min(acc.left, rect.x),
        top: Math.min(acc.top, rect.y),
        right: Math.max(acc.right, rect.x + rect.width),
        bottom: Math.max(acc.bottom, rect.y + rect.height),
      };
    },
    {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const podMembers: PreviewCommentMember[] = selected.map((snapshot) => ({
    elementId: snapshot.elementId,
    selector: snapshot.selector,
    label: snapshot.label,
    text: snapshot.text,
    position: snapshot.position,
    htmlHint: snapshot.htmlHint,
    style: snapshot.style,
  }));
  const summary = selected
    .slice(0, 3)
    .map((snapshot) => summarizeSnapshot(snapshot))
    .join(' · ');
  const htmlHint = selected
    .slice(0, 4)
    .map((snapshot) => snapshot.htmlHint)
    .filter(Boolean)
    .join(' ');
  const combinedSelector = selected
    .slice(0, 8)
    .map((snapshot) => snapshot.selector)
    .filter(Boolean)
    .join(', ');
  return {
    filePath: input.filePath,
    elementId: `pod-${Date.now()}`,
    selector: combinedSelector || 'body *',
    label: summary || `Pod of ${intersected.length} items`,
    text: intersected
      .slice(0, 4)
      .map((snapshot) => snapshot.text)
      .filter(Boolean)
      .join(' · '),
    position: {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.max(1, Math.round(bounds.right - bounds.left)),
      height: Math.max(1, Math.round(bounds.bottom - bounds.top)),
    },
    htmlHint: htmlHint.slice(0, 180),
    selectionKind: 'pod',
    memberCount: selected.length,
    podMembers,
  };
}

function pruneContainerSelections(
  snapshots: PreviewCommentSnapshot[],
): PreviewCommentSnapshot[] {
  if (snapshots.length < 2) return snapshots;
  return snapshots.filter((candidate) => {
    const candidateArea = Math.max(1, candidate.position.width * candidate.position.height);
    const contained = snapshots.filter(
      (other) =>
        other.elementId !== candidate.elementId &&
        rectContains(candidate.position, other.position),
    );
    if (contained.length === 0) return true;
    const union = contained.reduce(
      (acc, other) => ({
        left: Math.min(acc.left, other.position.x),
        top: Math.min(acc.top, other.position.y),
        right: Math.max(acc.right, other.position.x + other.position.width),
        bottom: Math.max(acc.bottom, other.position.y + other.position.height),
      }),
      {
        left: Number.POSITIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY,
      },
    );
    const unionArea = Math.max(1, (union.right - union.left) * (union.bottom - union.top));
    return !(contained.length >= 2 && candidateArea > unionArea * 2.4);
  });
}

function summarizeSnapshot(snapshot: PreviewCommentSnapshot): string {
  const text = snapshot.text.trim();
  if (text) {
    const trimmed = text.length > 28 ? `${text.slice(0, 25)}...` : text;
    return `${snapshot.label || snapshot.elementId} · ${trimmed}`;
  }
  return snapshot.label || snapshot.elementId;
}

function selectionHitsSnapshot(input: {
  points: StrokePoint[];
  snapshot: PreviewCommentSnapshot;
  closedLoop: boolean;
}): boolean {
  const bounds = {
    left: input.snapshot.position.x,
    top: input.snapshot.position.y,
    width: input.snapshot.position.width,
    height: input.snapshot.position.height,
  };
  if (pathIntersectsRect(input.points, bounds)) return true;
  if (!input.closedLoop) return false;
  const center = {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
  };
  if (pointInPolygon(center, input.points)) return true;
  const corners = [
    { x: bounds.left, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top },
    { x: bounds.left + bounds.width, y: bounds.top + bounds.height },
    { x: bounds.left, y: bounds.top + bounds.height },
  ];
  return corners.some((corner) => pointInPolygon(corner, input.points));
}

function isClosedLoop(points: StrokePoint[]): boolean {
  if (points.length < 4) return false;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(first.x - last.x, first.y - last.y) <= 28;
}

function rectContains(
  outer: { x: number; y: number; width: number; height: number },
  inner: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function pathIntersectsRect(
  points: StrokePoint[],
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  if (points.length === 0) return false;
  const x1 = rect.left;
  const y1 = rect.top;
  const x2 = rect.left + rect.width;
  const y2 = rect.top + rect.height;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return true;
    }
    const next = points[index + 1];
    if (!next) continue;
    if (
      lineIntersectsLine(point, next, { x: x1, y: y1 }, { x: x2, y: y1 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y1 }, { x: x2, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x2, y: y2 }, { x: x1, y: y2 }) ||
      lineIntersectsLine(point, next, { x: x1, y: y2 }, { x: x1, y: y1 })
    ) {
      return true;
    }
  }
  return false;
}

function pointInPolygon(point: StrokePoint, polygon: StrokePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x <
        ((pj.x - pi.x) * (point.y - pi.y)) / ((pj.y - pi.y) || Number.EPSILON) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lineIntersectsLine(a1: StrokePoint, a2: StrokePoint, b1: StrokePoint, b2: StrokePoint): boolean {
  const denominator =
    (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (denominator === 0) return false;
  const ua =
    ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub =
    ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

function finiteBridgeInteger(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return clampBridgeCoordinate(value);
}

function normalizeAnnotationStyle(input: unknown): PreviewCommentSnapshot['style'] {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const style: NonNullable<PreviewCommentSnapshot['style']> = {};
  for (const key of ANNOTATION_STYLE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed) style[key] = trimmed.slice(0, 120);
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

const ANNOTATION_STYLE_KEYS = [
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderRadius',
] as const;

function clampBridgeCoordinate(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-MAX_BRIDGE_COORDINATE, Math.min(MAX_BRIDGE_COORDINATE, Math.round(numeric)));
}

// Shown instead of the React runtime when a .jsx/.tsx is a module loaded by a
// sibling HTML entry (issue #2744): such a file has no standalone component to
// render, so point the user at the page(s) that do. Clicking an entry opens
// (or focuses) that page and closes the now-useless module tab.
function ReactModulePointer({
  entries,
  onOpenEntry,
}: {
  entries: string[];
  onOpenEntry?: (name: string) => void;
}) {
  const t = useT();
  return (
    <div className="viewer-module-pointer" role="note">
      <Icon name="info" size={20} />
      <h2 className="viewer-module-pointer__title">{t('fileViewer.jsxModuleTitle')}</h2>
      <p className="viewer-module-pointer__body">{t('fileViewer.jsxModuleBody')}</p>
      <p className="viewer-module-pointer__cta">{t('fileViewer.jsxModuleCta')}</p>
      <ul className="viewer-module-pointer__entries">
        {entries.map((name) => (
          <li key={name}>
            <button
              type="button"
              className="viewer-module-pointer__link"
              onClick={() => onOpenEntry?.(name)}
              disabled={!onOpenEntry}
            >
              <Icon name="external-link" size={14} />
              <span>{name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReactComponentViewer({
  projectId,
  file,
  onOpenFileReplacing,
}: {
  projectId: string;
  file: ProjectFile;
  onOpenFileReplacing?: (openName: string, closeName: string) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [source, setSource] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement | null>(null);
  // HTML entries that load this file as a Babel module. `null` = still
  // checking; `[]` = standalone artifact; non-empty = a module of a
  // multi-file React prototype, which has no standalone preview. Issue #2744.
  const [moduleEntries, setModuleEntries] = useState<string[] | null>(null);
  const isModule = (moduleEntries?.length ?? 0) > 0;

  useEffect(() => {
    setSource(null);
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((text) => {
      if (!cancelled) setSource(text ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  // Detect whether this .jsx/.tsx is a module loaded by a sibling HTML entry.
  // Runs before any srcdoc is built so a module never flashes the raw
  // "No React component export found" error from the React runtime.
  useEffect(() => {
    setModuleEntries(null);
    let cancelled = false;
    void (async () => {
      try {
        const files = await fetchProjectFiles(projectId);
        const htmlNames = files
          .filter((entry) => /\.html?$/i.test(entry.name))
          .map((entry) => entry.name);
        const htmlSources = new Map<string, string>();
        await Promise.all(
          htmlNames.map(async (name) => {
            const text = await fetchProjectFileText(projectId, name).catch(() => null);
            if (text != null) htmlSources.set(name, text);
          }),
        );
        if (cancelled) return;
        setModuleEntries(findHtmlEntriesReferencing(file.name, htmlSources));
      } catch {
        if (!cancelled) setModuleEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  useEffect(() => {
    if (!shareMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!shareRef.current) return;
      if (!shareRef.current.contains(e.target as Node)) setShareMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [shareMenuOpen]);

  const exportTitle = file.name.replace(/\.(jsx|tsx)$/i, '') || file.name;
  const sourceExtension = file.name.toLowerCase().endsWith('.tsx') ? '.tsx' : '.jsx';

  useEffect(() => {
    if (source === null || moduleEntries === null || isModule) {
      // No source yet, still checking module status, or this file is a module
      // with no standalone preview — never build the React runtime srcdoc.
      setSrcDoc('');
      return;
    }

    let cancelled = false;
    const buildSrcDoc = () => {
      const nextSrcDoc = buildReactComponentSrcdoc(source, { title: exportTitle });
      if (!cancelled) setSrcDoc(nextSrcDoc);
    };

    if (source.length > 100_000) {
      setSrcDoc('');
      const timeout = window.setTimeout(buildSrcDoc, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    buildSrcDoc();
    return () => {
      cancelled = true;
    };
  }, [source, exportTitle, moduleEntries, isModule]);

  return (
    <div className="viewer react-component-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only readable-tooltip"
            onClick={() => setReloadKey((n) => n + 1)}
            title={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip-placement="bottom"
            aria-label={`${t('fileViewer.reloadAria')} ${t('fileViewer.preview')}`}
          >
            <Icon name="reload" size={14} />
          </button>
          <span className="viewer-meta">
            {t('fileViewer.reactMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <div className="viewer-tabs">
            <button
              type="button"
              className={`viewer-tab ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              {t('fileViewer.preview')}
            </button>
            <button
              type="button"
              className={`viewer-tab ${mode === 'source' ? 'active' : ''}`}
              onClick={() => setMode('source')}
            >
              {t('fileViewer.source')}
            </button>
          </div>
          {source !== null ? (
            <>
              <span className="viewer-divider" aria-hidden />
              <div className="share-menu" ref={shareRef}>
                <button
                  type="button"
                  className="viewer-action primary viewer-action-export readable-tooltip"
                  aria-haspopup="menu"
                  aria-expanded={shareMenuOpen}
                  title={t('fileViewer.shareLabel')}
                  data-tooltip={t('fileViewer.shareLabel')}
                  data-tooltip-placement="bottom"
                  onClick={() => setShareMenuOpen((v) => !v)}
                >
                  <span className="export-action-spacer" aria-hidden />
                  <span>{t('fileViewer.shareLabel')}</span>
                  <RemixIcon name="arrow-down-s-line" size={14} />
                </button>
                {shareMenuOpen ? (
                  <div className="share-menu-popover" role="menu">
                    <div className="share-menu-section-label" role="presentation">
                      {t('common.share')}
                    </div>
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportAsJsx(source, exportTitle, sourceExtension);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-code-line" size={15} /></span>
                      <span>{t('fileViewer.exportJsx')}</span>
                    </button>
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportReactComponentAsHtml(source, exportTitle);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                      <span>{t('fileViewer.exportReactHtml')}</span>
                    </button>
                    <div className="share-menu-divider" />
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        exportReactComponentAsZip(source, exportTitle, sourceExtension);
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-zip-line" size={15} /></span>
                      <span>{t('fileViewer.exportZip')}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="viewer-body">
        {isModule && mode === 'preview' ? (
          // Module of a multi-file prototype: no standalone preview, so the
          // Preview tab shows a pointer to the HTML entry. The Source tab still
          // renders the raw code below. Issue #2744.
          <ReactModulePointer
            entries={moduleEntries ?? []}
            onOpenEntry={(htmlName) => onOpenFileReplacing?.(htmlName, file.name)}
          />
        ) : source === null || (mode === 'preview' && !srcDoc) ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'preview' ? (
          <PreviewDrawOverlay>
            <iframe
              data-testid="react-component-preview-frame"
              title={file.name}
              sandbox="allow-scripts allow-downloads"
              srcDoc={srcDoc}
              style={{ width: '100%', height: '100%', border: 0 }}
            />
          </PreviewDrawOverlay>
        ) : (
          <CodeWithLines text={source} />
        )}
      </div>
    </div>
  );
}

function BinaryViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  return (
    <div className="viewer binary-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.binaryMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body">
        <div className="viewer-empty">
          {t('fileViewer.binaryNote', { size: file.size })}
        </div>
      </div>
    </div>
  );
}

function DocumentPreviewViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPreview(null);
    void fetchProjectFilePreview(projectId, file.name).then((next) => {
      if (!cancelled) {
        setPreview(next);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime]);

  return (
    <div className="viewer document-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {documentMetaLabel(file, t)} · {humanSize(file.size)}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body">
        {loading ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : preview ? (
          <div className="document-preview">
            <h2>{preview.title}</h2>
            {preview.sections.map((section, idx) => (
              <section key={`${section.title}-${idx}`}>
                <h3>{section.title}</h3>
                {section.lines.map((line, lineIdx) => (
                  <p key={`${lineIdx}-${line}`}>{line}</p>
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="viewer-empty">{t('fileViewer.previewUnavailable')}</div>
        )}
      </div>
    </div>
  );
}

function HtmlViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  onExportAsPptx,
  streaming,
  commentQueueOnSend = false,
  commentSendDisabled = false,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
  commentPortalId,
  onCommentModeChange,
  manualEditPortalId,
  onManualEditInspectorChange,
  shareRequest,
  downloadRequest,
  slideNavRequest,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck: boolean;
  onExportAsPptx?: ((fileName: string) => void) | undefined;
  streaming: boolean;
  commentQueueOnSend?: boolean;
  commentSendDisabled?: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[]) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[], images?: File[]) => Promise<boolean | void> | boolean | void;
  onFileSaved?: () => Promise<void> | void;
  commentPortalId?: string;
  onCommentModeChange?: (active: boolean) => void;
  manualEditPortalId?: string;
  onManualEditInspectorChange?: (active: boolean) => void;
  shareRequest?: { nonce: number } | null;
  downloadRequest?: { nonce: number } | null;
  slideNavRequest?: { slideIndex: number; nonce: number } | null;
}) {
  const { locale, t } = useI18n();
  const analytics = useAnalytics();
  // Shared helper for the share menu: emit studio_click share_option on
  // entry and artifact_export_result on resolution. Sync exports report
  // success immediately after the call returns; async exports get .then
  // / .catch. The same request_id threads both events so PostHog can
  // stitch click → result via $insert_id correlation.
  const fireShareExport = (
    format:
      | 'pdf'
      | 'pptx'
      | 'zip'
      | 'html'
      | 'image'
      | 'markdown'
      | 'template'
      | 'share_link'
      | 'share_page'
      | 'vercel'
      | 'cloudflare_pages',
    fn: () => Promise<unknown> | unknown,
  ) => {
    const requestId = analytics.newRequestId();
    const artifactId = anonymizeArtifactId({ projectId, fileName: file.name });
    const artifactKind = artifactKindToTracking({ fileKind: file.kind ?? null });
    const trackingFormat = format as Exclude<typeof format, 'image'>;
    trackShareOptionPopoverClick(
      analytics.track,
      {
        page_name: 'artifact',
        area: 'share_option_popover',
        artifact_id: artifactId,
        artifact_kind: artifactKind,
        element: trackingFormat,
        project_id: projectId,
        project_kind: projectKind,
      },
      { requestId },
    );
    const started = performance.now();
    const finish = (result: 'success' | 'failed' | 'cancelled', errorCode?: string) => {
      trackArtifactExportResult(
        analytics.track,
        {
          page_name: 'artifact',
          area: 'share_option_popover',
          artifact_id: artifactId,
          artifact_kind: artifactKind,
          project_id: projectId,
          project_kind: projectKind,
          export_format: trackingFormat,
          result,
          ...(errorCode ? { error_code: errorCode } : {}),
          export_duration_ms: Math.round(performance.now() - started),
        },
        { requestId },
      );
    };
    const toastFormats = new Set(['pdf', 'pptx', 'zip', 'image', 'markdown']);
    try {
      const out = fn();
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(
          () => { finish('success'); if (toastFormats.has(format)) setExportToast({ message: t('fileViewer.exportStarted'), tone: 'default' }); },
          (err) => finish('failed', err instanceof Error ? err.name : 'UNKNOWN'),
        );
      } else {
        finish('success');
        if (toastFormats.has(format)) setExportToast({ message: t('fileViewer.exportStarted'), tone: 'default' });
      }
    } catch (err) {
      finish('failed', err instanceof Error ? err.name : 'UNKNOWN');
    }
  };
  // P0 helpers — keep the artifact_id + artifact_kind derivation in one place
  // so each per-button onClick stays a one-liner. We compute lazily inside the
  // closure because `file.kind` / `file.name` can change as the user navigates
  // tabs without remounting HtmlViewer.
  const fireArtifactToolbarClick = (
    element:
      | 'reload'
      | 'preview'
      | 'source'
      | 'tweaks'
      | 'draw'
      | 'comment'
      | 'pods'
      | 'inspect'
      | 'edit'
      | 'zoom_out'
      | 'zoom_level_dropdown'
      | 'zoom_in',
  ) => {
    trackArtifactToolbarClick(analytics.track, {
      page_name: 'artifact',
      area: 'artifact_toolbar',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const fireDrawToolbarClick = (
    element: DrawToolbarElement,
    submitAction?: 'draft' | 'queue' | 'send',
  ) => {
    trackDrawToolbarClick(analytics.track, {
      page_name: 'artifact',
      area: 'draw_toolbar',
      element,
      ...(submitAction ? { submit_action: submitAction } : {}),
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const fireArtifactHeaderClick = (
    element:
      | 'back'
      | 'edit'
      | 'present_dropdown'
      | 'download_dropdown'
      | 'share_dropdown'
      | 'settings',
  ) => {
    trackArtifactHeaderClick(analytics.track, {
      page_name: 'artifact',
      area: 'artifact_header',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const firePresentPopoverClick = (
    element: 'in_this_tab' | 'fullscreen' | 'new_tab',
  ) => {
    trackPresentPopoverClick(analytics.track, {
      page_name: 'artifact',
      area: 'present_popover',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const fireCommentPopoverClick = (
    element: 'save_comment' | 'send_to_chat' | 'add_note',
  ) => {
    trackCommentPopoverClick(analytics.track, {
      page_name: 'artifact',
      area: 'comment_popover',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [source, setSource] = useState<string | null>(liveHtml ?? null);
  const [inlinedSource, setInlinedSource] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const fileViewportKey = previewViewportStateKey(projectId, file);
  const [previewViewport, setPreviewViewportState] = useState<PreviewViewportId>(
    () => htmlPreviewViewportState.get(fileViewportKey) ?? 'desktop',
  );
  const setPreviewViewport = useCallback((viewport: PreviewViewportId) => {
    setPreviewViewportCached(fileViewportKey, viewport);
    setPreviewViewportState(viewport);
  }, [fileViewportKey]);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const [presentMenuOpen, setPresentMenuOpen] = useState(false);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [exportReadyNudge, setExportReadyNudge] = useState(false);
  const exportReadyNudgeSeenRef = useRef<Set<string>>(new Set());
  // Template save UX. We surface a transient "Saved" pill in the share
  // menu so the user gets feedback without a noisy toast layer.
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');

  useEffect(() => {
    setPreviewViewportState(htmlPreviewViewportState.get(fileViewportKey) ?? 'desktop');
  }, [fileViewportKey]);
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<WebDeploymentInfo | null>(null);
  const [deploymentsByProvider, setDeploymentsByProvider] = useState<Partial<Record<WebDeployProviderId, WebDeploymentInfo>>>({});
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const closeDeployModal = useCallback(() => {
    setDeployModalOpen(false);
  }, []);
  const [deployConfig, setDeployConfig] = useState<WebDeployConfigResponse | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployPhase, setDeployPhase] = useState<'idle' | 'deploying' | 'preparing-link'>('idle');
  const [savingDeployConfig, setSavingDeployConfig] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<WebDeployProjectFileResponse | null>(null);
  const [copiedDeployLink, setCopiedDeployLink] = useState<string | null>(null);
  const [deployProviderId, setDeployProviderId] = useState<WebDeployProviderId>(DEFAULT_DEPLOY_PROVIDER_ID);
  const [projectSocialShare, setProjectSocialShare] = useState<SocialShareResponse | null>(null);
  const [deployToken, setDeployToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [cloudflareAccountId, setCloudflareAccountId] = useState('');
  const [cloudflareZones, setCloudflareZones] = useState<CloudflarePagesZoneOption[]>([]);
  const [cloudflareZonesLoading, setCloudflareZonesLoading] = useState(false);
  const [cloudflareZonesError, setCloudflareZonesError] = useState<string | null>(null);
  const [cloudflareZoneId, setCloudflareZoneId] = useState('');
  const [cloudflareDomainPrefix, setCloudflareDomainPrefix] = useState('');
  const deployProviderLoadSeqRef = useRef(0);
  const deployTokenInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!deployModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDeployModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDeployModal, deployModalOpen]);
  const [inTabPresent, setInTabPresent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [boardMode, setBoardMode] = useState(false);
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  const [commentCreateMode, setCommentCreateMode] = useState(false);
  const [boardTool, setBoardTool] = useState<BoardTool>('inspect');
  const [inspectMode, setInspectMode] = useState(false);
  const [agentToolsOpen, setAgentToolsOpen] = useState(false);
  const [drawOverlayOpen, setDrawOverlayOpen] = useState(false);
  // for hint managing hint box state
  const [openHintBox, setOpenHintBox] = useState(true);
  const [manualEditMode, setManualEditModeRaw] = useState(false);
  const [manualEditSrcDocActive, setManualEditSrcDocActive] = useState(false);
  const [manualEditFrozenSource, setManualEditFrozenSource] = useState<string | null>(null);
  // Async saves must not apply their old document after the viewer moves on.
  const manualEditSourceKey = `${projectId}\0${file.name}\0${liveHtml === undefined ? 'raw' : 'live'}`;
  const manualEditSourceKeyRef = useRef(manualEditSourceKey);
  manualEditSourceKeyRef.current = manualEditSourceKey;
  const manualEditSaveGenerationRef = useRef(0);
  // A watcher can return the just-written source before the POST resolves.
  const manualEditInFlightSourceRef = useRef<string | null>(null);
  const [commentPortalHost, setCommentPortalHost] = useState<HTMLElement | null>(null);
  const [manualEditPortalHost, setManualEditPortalHost] = useState<HTMLElement | null>(null);
  const [previewBodyRef, previewBodySize] = usePreviewCanvasSize<HTMLDivElement>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const urlPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDocPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const activatedSrcDocTransportHtmlRef = useRef<string | null>(null);
  // Tracks the iframe DOM node whose dedupe ref was last reset by the
  // srcDoc onLoad handler. We reset the dedupe exactly once per freshly
  // mounted iframe (the first load is the shell HTML), and skip every
  // subsequent load on the same node (those are our own
  // document.open/write/close inside the shell). See onLoad below for
  // the infinite-loop story (issue #2361).
  const srcDocFrameDedupeResetForRef = useRef<HTMLIFrameElement | null>(null);
  const isActivePreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    return !!source && source === iframeRef.current?.contentWindow;
  }, []);
  const isOurPreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    if (!source) return false;
    return (
      source === iframeRef.current?.contentWindow ||
      source === urlPreviewIframeRef.current?.contentWindow ||
      source === srcDocPreviewIframeRef.current?.contentWindow
    );
  }, []);
  const previewScrollRestoreRef = useRef<{
    hostLeft: number;
    hostTop: number;
    frameLeft: number;
    frameTop: number;
    canvasLeft: number;
    canvasTop: number;
    expiresAt: number;
  } | null>(null);
  const previewScrollPositionRef = useRef({
    frameLeft: 0,
    frameTop: 0,
    canvasLeft: 0,
    canvasTop: 0,
  });
  const previewScrollRequestAtRef = useRef(0);
  const dcViewportRef = useRef({
    x: 0,
    y: 0,
    scale: 1,
  });
  const dcViewportRestoreAtRef = useRef(0);
  const setManualEditMode = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setManualEditModeRaw((prev) => {
      const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      return value;
    });
  }, []);
  useEffect(() => {
    setManualEditSrcDocActive(false);
    setManualEditFrozenSource(null);
    manualEditInFlightSourceRef.current = null;
    manualEditSaveGenerationRef.current = 0;
  }, [projectId, file.name]);
  useEffect(() => {
    onCommentModeChange?.(commentPanelOpen);
  }, [commentPanelOpen, onCommentModeChange]);
  useEffect(() => () => {
    onCommentModeChange?.(false);
  }, [onCommentModeChange]);
  useEffect(() => {
    if (!commentPanelOpen || !commentPortalId) {
      setCommentPortalHost(null);
      return;
    }
    let cancelled = false;
    let raf = 0;
    const findHost = () => {
      if (cancelled) return;
      const host = document.getElementById(commentPortalId);
      setCommentPortalHost(host);
      if (!host) raf = window.requestAnimationFrame(findHost);
    };
    findHost();
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      setCommentPortalHost(null);
    };
  }, [commentPanelOpen, commentPortalId]);
  // Tell ProjectView to swap the chat slot for the manual-edit inspector while
  // edit mode is active, and to restore chat on unmount.
  useEffect(() => {
    onManualEditInspectorChange?.(manualEditMode);
  }, [manualEditMode, onManualEditInspectorChange]);
  useEffect(() => () => {
    onManualEditInspectorChange?.(false);
  }, [onManualEditInspectorChange]);
  useEffect(() => {
    if (!manualEditMode || !manualEditPortalId) {
      setManualEditPortalHost(null);
      return;
    }
    let cancelled = false;
    let raf = 0;
    const findHost = () => {
      if (cancelled) return;
      const host = document.getElementById(manualEditPortalId);
      setManualEditPortalHost(host);
      if (!host) raf = window.requestAnimationFrame(findHost);
    };
    findHost();
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      setManualEditPortalHost(null);
    };
  }, [manualEditMode, manualEditPortalId]);
  const capturePreviewScrollPosition = useCallback(() => {
    const host = previewBodyRef.current;
    let frameLeft = 0;
    let frameTop = 0;
    let canvasLeft = 0;
    let canvasTop = 0;
    try {
      const frameDocument = iframeRef.current?.contentWindow?.document;
      const frameScroll = frameDocument?.scrollingElement;
      const canvasScroll = frameDocument?.querySelector<HTMLElement>('.design-canvas');
      frameLeft = frameScroll?.scrollLeft ?? 0;
      frameTop = frameScroll?.scrollTop ?? 0;
      canvasLeft = canvasScroll?.scrollLeft ?? 0;
      canvasTop = canvasScroll?.scrollTop ?? 0;
    } catch {
      frameLeft = 0;
      frameTop = 0;
      canvasLeft = 0;
      canvasTop = 0;
    }
    previewScrollRestoreRef.current = {
      hostLeft: host?.scrollLeft ?? 0,
      hostTop: host?.scrollTop ?? 0,
      frameLeft: frameLeft || previewScrollPositionRef.current.frameLeft,
      frameTop: frameTop || previewScrollPositionRef.current.frameTop,
      canvasLeft: canvasLeft || previewScrollPositionRef.current.canvasLeft,
      canvasTop: canvasTop || previewScrollPositionRef.current.canvasTop,
      expiresAt: Date.now() + 5000,
    };
  }, []);
  const restorePreviewScrollPosition = useCallback(() => {
    const snapshot = previewScrollRestoreRef.current;
    if (!snapshot) return;
    if (Date.now() > snapshot.expiresAt) {
      previewScrollRestoreRef.current = null;
      return;
    }
    const apply = () => {
      const previewBody = previewBodyRef.current;
      if (typeof previewBody?.scrollTo === 'function') {
        previewBody.scrollTo(snapshot.hostLeft, snapshot.hostTop);
      }
      try {
        const frameDocument = iframeRef.current?.contentWindow?.document;
        frameDocument?.scrollingElement?.scrollTo(snapshot.frameLeft, snapshot.frameTop);
        frameDocument?.querySelector<HTMLElement>('.design-canvas')?.scrollTo(snapshot.canvasLeft, snapshot.canvasTop);
        iframeRef.current?.contentWindow?.postMessage({
          type: 'readable-studio:preview-scroll-restore',
          frameLeft: snapshot.frameLeft,
          frameTop: snapshot.frameTop,
          canvasLeft: snapshot.canvasLeft,
          canvasTop: snapshot.canvasTop,
        }, '*');
      } catch {}
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        apply();
        window.setTimeout(apply, 80);
        window.setTimeout(() => {
          if (previewScrollRestoreRef.current === snapshot) {
            apply();
          }
        }, 260);
      });
    });
  }, []);
  const [manualEditTargets, setManualEditTargets] = useState<ManualEditTarget[]>([]);
  const [selectedManualEditTarget, setSelectedManualEditTarget] = useState<ManualEditTarget | null>(null);
  // PPT move-frame mode for the selected element: 'editing' renders ring strips
  // only (caret active), 'selected' adds the interior move surface. Seeded per
  // selection from the target kind; demoted to 'selected' when the iframe
  // reports the rich-edit session ended (Esc/blur).
  const [manualEditMoveMode, setManualEditMoveMode] = useState<'editing' | 'selected'>('selected');
  const [manualEditHoverTarget, setManualEditHoverTarget] = useState<ManualEditTarget | null>(null);
  const [manualEditPageStylesOpen, setManualEditPageStylesOpen] = useState(false);
  const selectedManualEditTargetIdRef = useRef<string | null>(null);
  const selectedManualEditTargetRef = useRef<ManualEditTarget | null>(null);
  const manualEditActionSeqRef = useRef(0);
  const manualEditPostSaveIntentRef = useRef<ManualEditPostSaveIntent | null>(null);
  const [manualEditDraft, setManualEditDraft] = useState<ManualEditDraft>(() => emptyManualEditDraft());
  const [manualEditHistory, setManualEditHistory] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditUndone, setManualEditUndone] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditError, setManualEditError] = useState<string | null>(null);
  const [manualEditResizeFeedback, setManualEditResizeFeedback] = useState<ManualEditResizeFeedback | null>(null);
  const [manualEditSaving, setManualEditSaving] = useState(false);
  const manualEditSavingRef = useRef(false);
  const manualEditHistoryOperationRef = useRef(false);
  const manualEditHistoryQueueRef = useRef<Array<'undo' | 'redo'>>([]);
  const undoManualEditRef = useRef<() => Promise<void>>(async () => {});
  const redoManualEditRef = useRef<() => Promise<void>>(async () => {});
  const manualEditPendingStyleRef = useRef<ManualEditPendingStyleSave | null>(null);
  // Drag-start snapshot for resize-handle style math. The live selected target
  // mutates per preview ack (rect + cssSize), which would shift the delta
  // baseline mid-drag; every frame of one drag must anchor on pointerdown state.
  const manualEditResizeBaselineRef = useRef<{
    id: string;
    styles: Partial<ManualEditStyles>;
    cssSize?: { width: string; height: string };
  } | null>(null);
  const activeManualEditMovementRef = useRef<ActiveManualEditMovement | null>(null);
  const manualEditAltRef = useRef(false);
  const manualEditCtrlRef = useRef(false);
  const manualEditLastUpdateRef = useRef<ManualEditMoveUpdate | null>(null);
  const manualEditDuplicateGenerationRef = useRef(0);
  const manualEditPendingDuplicateSelectionRef = useRef<ManualEditPendingDuplicateSelection | null>(null);
  const [manualEditDuplicateRect, setManualEditDuplicateRect] = useState<ManualEditRect | null>(null);
  const [manualEditSnapGuides, setManualEditSnapGuides] = useState<ManualEditMovementResult['guides']>(EMPTY_MANUAL_EDIT_SNAP_GUIDES);
  const manualEditModeRef = useRef(manualEditMode);
  const manualEditSourceRefreshPendingRef = useRef(false);
  const manualEditPreviewVersionRef = useRef(0);
  const manualEditTargetMessageEpochRef = useRef<string | null>(null);
  const manualEditTargetMessageSequenceRef = useRef(0);
  // Host revision counter sent to the iframe with readable-edit-selected-target. The
  // bridge echoes it back on every nudge so stale (out-of-order) key events are
  // ignored after selection changes or iframe reloads.
  const manualEditPreviewRevisionRef = useRef(0);
  // Document identity the revision was last bumped for. The revision is a DOCUMENT
  // version, bumped once per real document change — NOT per selection re-post —
  // so the bridge's echoed revision stays in sync with the host's and a nudge is
  // never rejected by an off-by-one from an extra re-sync.
  const manualEditPreviewDocRef = useRef<string | null>(null);
  const keyboardBurstRef = useRef<KeyboardBurst | null>(null);
  // Arrow keys whose burst Escape cancelled while they were physically held:
  // their browser repeats are swallowed until the real keyup, so a still-held
  // key cannot reopen the burst it just cancelled.
  const keyboardBurstCancelledKeysRef = useRef<Set<string>>(new Set());
  // Completed bursts queued behind an in-flight save; the finally of each save
  // drains exactly one, so every distinct burst commits as its own write, in order.
  const keyboardBurstQueueRef = useRef<KeyboardBurstQueued[]>([]);
  // Translate currently live in the iframe due to an uncommitted keyboard/pointer
  // movement preview. Cleared on commit/cancel/selection change so baseline math
  // falls back to the last persisted target styles.
  const manualEditOptimisticTranslateRef = useRef<string | null>(null);
  // Last translate value written to source for the selected target, tracked
  // independently because target broadcasts refresh rects but do not always
  // re-emit authored inline styles after a preview stream.
  const lastPersistedTranslateRef = useRef<string | null>(null);
  // Whether the selected-object overlay surface had focus before a render that
  // may have displaced it (iframe reload, target broadcast). Used to restore
  // focus so Escape/Arrow keys keep landing on the overlay.
  const selectedObjectSurfaceHadFocusRef = useRef(false);
  // Auto-clear timer for the movement live-region announcement.
  const manualEditAnnounceTimerRef = useRef<number | null>(null);
  // Highest preview-ack version applied so far. Acks stream back one per
  // preview frame; a drag outruns them, so requiring version === current would
  // drop nearly every mid-drag rect measurement. Monotonic acceptance keeps
  // the overlays tracking the element's real box without reordering glitches.
  const manualEditPreviewAckVersionRef = useRef(0);
  // Semantic feedback clears (selection changes, cancel, history, etc.) form a
  // version boundary. A resize ack issued before that boundary may still arrive
  // later, but must not resurrect feedback that the user already dismissed.
  const manualEditResizeFeedbackInvalidThroughVersionRef = useRef(0);
  const [manualEditRichFormat, setManualEditRichFormat] = useState<ManualEditRichFormatState>(
    { editing: false, hasSelection: false, bold: false, italic: false, underline: false },
  );
  const [manualEditMovementAnnouncement, setManualEditMovementAnnouncement] = useState<ManualEditMoveAnnouncementSegment[] | null>(null);
  const sourceRef = useRef<string | null>(source);
  const sourceFileKeyRef = useRef<string | null>(null);
  const templateNameId = useId();
  const templateDescriptionId = useId();
  const imageExportTitleId = useId();
  // Opt back into the legacy inline-asset srcDoc path via `?forceInline=1`
  // on the host page. Lets users escape-hatch around the URL-load default
  // for non-deck HTML that depends on the in-iframe localStorage shim.
  const forceInline = useMemo(
    () => (typeof window === 'undefined' ? false : parseForceInline(window.location.search)),
    [],
  );
  const [activeCommentTarget, setActiveCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  const [hoveredCommentTarget, setHoveredCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  // True while the pointer is physically over the floating hover card. The card
  // sits on top of the preview iframe, so reaching it makes the iframe fire a
  // mouseout -> readable-studio:comment-leave. We ignore that leave while pinned so the card
  // (and its selectable values) stays put instead of unmounting and flickering.
  // The pointer cannot be over the iframe and the host card at once, so a fresh
  // readable-studio:comment-hover never races this; only the card's own leave clears it.
  const hoverCardPinnedRef = useRef(false);
  // Tearing the card down is always deferred by a beat rather than done
  // synchronously. The iframe's mouseout (readable-studio:comment-leave) arrives async via
  // postMessage; the card's own mouseenter and the next readable-studio:comment-hover are the
  // signals that the pointer actually landed on the card or back on the element
  // it overlaps. Deferring lets those cancel the dismiss before it lands.
  // Synchronous teardown raced ahead of them: the card flickered on the way in
  // and vanished the moment you moved off it back onto the element it described.
  const hoverCardDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverCardDismiss = useCallback(() => {
    if (hoverCardDismissTimerRef.current !== null) {
      clearTimeout(hoverCardDismissTimerRef.current);
      hoverCardDismissTimerRef.current = null;
    }
  }, []);
  const scheduleHoverCardDismiss = useCallback(() => {
    if (hoverCardDismissTimerRef.current !== null) clearTimeout(hoverCardDismissTimerRef.current);
    hoverCardDismissTimerRef.current = setTimeout(() => {
      hoverCardDismissTimerRef.current = null;
      // hoverCardPinnedRef tracks "pointer is physically over the card". If it
      // got (re-)pinned while we waited, this now-stale dismiss must not fire.
      if (!hoverCardPinnedRef.current) setHoveredCommentTarget(null);
    }, HOVER_CARD_DISMISS_DELAY_MS);
  }, []);
  const [hoveredPodMemberId, setHoveredPodMemberId] = useState<string | null>(null);
  // If the card unmounts for any other reason while the pointer is still over
  // it (its onMouseLeave never fires), drop the pin so later leaves dismiss
  // normally instead of being swallowed forever.
  useEffect(() => {
    if (!hoveredCommentTarget) hoverCardPinnedRef.current = false;
  }, [hoveredCommentTarget]);
  // Don't let a pending dismiss outlive the component.
  useEffect(() => cancelHoverCardDismiss, [cancelHoverCardDismiss]);
  const [activePreviewCommentId, setActivePreviewCommentId] = useState<string | null>(null);
  const [liveCommentTargets, setLiveCommentTargets] = useState<Map<string, PreviewCommentSnapshot>>(() => new Map());
  const liveCommentTargetsRef = useRef(liveCommentTargets);
  const [commentOrderIds, setCommentOrderIds] = useState<string[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  // Inspect mode shares the iframe selection bridge with comment mode but
  // routes the picked element to a side panel that mutates per-element CSS
  // overrides via postMessage. The host owns the authoritative override map:
  // it is hydrated from the artifact's persisted <style> block on load and
  // mutated only by host-driven onApply / reset actions. Save-to-source
  // serializes that host map directly — iframe readable-studio:inspect-overrides messages
  // are preview acknowledgements and never feed save input, so artifact JS
  // forging a postMessage cannot tamper with what gets persisted.
  const [activeInspectTarget, setActiveInspectTarget] = useState<InspectTarget | null>(null);
  const [inspectOverrides, setInspectOverrides] = useState<InspectOverrideMap>(() =>
    typeof source === 'string' ? parseInspectOverridesFromSource(source) : {},
  );
  // Track which `source` value the host map was last hydrated from so the
  // setState-during-render hydration below only fires when the artifact
  // text actually changes (file switch, save round-trip, live edits). The
  // ref is initialised to `source` so the matching useState initialiser
  // above counts as the first hydration.
  const inspectHydratedSourceRef = useRef<string | null | undefined>(source);
  const [savingInspect, setSavingInspect] = useState(false);
  const [inspectSavedAt, setInspectSavedAt] = useState<number | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [queuedBoardNotes, setQueuedBoardNotes] = useState<string[]>([]);
  // Images attached to an element comment ("评论此元素"). Kept as raw Files
  // (uploaded on send) with object-URL thumbnails for preview/remove, mirroring
  // the markup overlay's image tray.
  const [boardImages, setBoardImages] = useState<File[]>([]);
  const [activeCommentExistingAttachments, setActiveCommentExistingAttachments] =
    useState<PreviewCommentAttachment[]>([]);
  const [boardImagePreviews, setBoardImagePreviews] = useState<{ file: File; url: string }[]>([]);
  const [boardPreviewIndex, setBoardPreviewIndex] = useState<number | null>(null);
  const [sendingBoardBatch, setSendingBoardBatch] = useState(false);
  useEffect(() => {
    const next = boardImages.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setBoardImagePreviews(next);
    return () => {
      next.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [boardImages]);
  const [commentSavedToast, setCommentSavedToast] = useState<string | null>(null);
  const [templateSavedToast, setTemplateSavedToast] = useState<string | null>(null);
  const [deploySavedToast, setDeploySavedToast] = useState<{ message: string; details: string } | null>(null);
  const [deployActionToast, setDeployActionToast] = useState<string | null>(null);
  const [imageExportModalOpen, setImageExportModalOpen] = useState(false);
  const [imageExportFormat, setImageExportFormat] = useState<ImageExportFormat>('png');
  const [imageExportBusy, setImageExportBusy] = useState(false);
  const [imageExportPreparing, setImageExportPreparing] = useState(false);
  const [imageExportError, setImageExportError] = useState<string | null>(null);
  const [imageExportSavedToast, setImageExportSavedToast] = useState<{ message: string; details: string } | null>(null);
  const [imageExportPreparedBlob, setImageExportPreparedBlob] = useState<{ format: ImageExportFormat; blob: Blob } | null>(null);
  const imageExportSnapshotDataUrlRef = useRef<string | null>(null);
  const imageExportPrepareIdRef = useRef(0);
  const screenshotInFlightRef = useRef(false);
  const [exportToast, setExportToast] = useState<
    { message: string; tone: 'default' | 'success' | 'error' | 'loading' } | null
  >(null);
  const [shareLinkFeedback, setShareLinkFeedback] = useState<'copied' | 'failed' | null>(null);
  const [shareGuideToast, setShareGuideToast] = useState<string | null>(null);
  const [selectedSideCommentIds, setSelectedSideCommentIds] = useState<Set<string>>(() => new Set());
  const [commentSidePanelCollapsed, setCommentSidePanelCollapsed] = useState(false);
  const [strokePoints, setStrokePoints] = useState<StrokePoint[]>([]);
  const previewStateKey = `${projectId}:${file.name}`;
  const previewScale = zoom / 100;
  const localCommentSideDockActive = commentPanelOpen && !commentPortalHost;
  const boardPreviewCanvasSize = commentPreviewCanvasSize(previewBodySize, {
    boardMode: localCommentSideDockActive,
    sidePanelCollapsed: commentSidePanelCollapsed,
    viewport: previewViewport,
  });
  const boardSideDockStacked = usesStackedCommentSideDock(previewBodySize, {
    boardMode: localCommentSideDockActive,
    sidePanelCollapsed: commentSidePanelCollapsed,
    viewport: previewViewport,
  });

  function deploymentMapForCurrentFile(items: WebDeploymentInfo[]) {
    const next: Partial<Record<WebDeployProviderId, WebDeploymentInfo>> = {};
    for (const option of DEPLOY_PROVIDER_OPTIONS) {
      const deploymentForProvider = items
        .filter((item) => item.fileName === file.name && item.providerId === option.id && item.url?.trim())
        .sort(compareDeploymentsByNewest)[0];
      if (deploymentForProvider) next[option.id] = deploymentForProvider;
    }
    return next;
  }

  function syncDeployFormFromConfig(
    providerId: WebDeployProviderId,
    config: WebDeployConfigResponse | null,
  ) {
    const matchingConfig = config?.providerId === providerId ? config : null;
    setDeployProviderId(providerId);
    setDeployConfig(matchingConfig);
    setDeployToken(matchingConfig?.tokenMask || '');
    setTeamId(matchingConfig?.teamId || '');
    setTeamSlug(matchingConfig?.teamSlug || '');
    setCloudflareAccountId(matchingConfig?.accountId || '');
    setCloudflareZoneId(matchingConfig?.cloudflarePages?.lastZoneId || '');
    setCloudflareDomainPrefix(matchingConfig?.cloudflarePages?.lastDomainPrefix || '');
  }

  function cloudflareConfigHintsFromForm() {
    const zone = cloudflareZones.find((item) => item.id === cloudflareZoneId);
    const hints = {
      ...(cloudflareZoneId.trim() ? { lastZoneId: cloudflareZoneId.trim() } : {}),
      ...((zone?.name || deployConfig?.cloudflarePages?.lastZoneName)
        ? { lastZoneName: zone?.name || deployConfig?.cloudflarePages?.lastZoneName }
        : {}),
      ...(cloudflareDomainPrefix.trim()
        ? { lastDomainPrefix: normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix) }
        : {}),
    };
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  function buildDeployConfigRequest(providerId: WebDeployProviderId): WebUpdateDeployConfigRequest {
    const token = deployToken.trim();
    if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID) {
      return {
        providerId,
        token,
        accountId: cloudflareAccountId.trim(),
        cloudflarePages: cloudflareConfigHintsFromForm(),
      };
    }
    return {
      providerId,
      token,
      teamId: teamId.trim(),
      teamSlug: teamSlug.trim(),
    };
  }

  async function loadDeployProvider(
    providerId: WebDeployProviderId,
    options?: { fallbackToExisting?: boolean },
  ) {
    const requestSeq = ++deployProviderLoadSeqRef.current;
    setDeployProviderId(providerId);
    const deployments = await fetchProjectDeployments(projectId);
    const nextDeploymentsByProvider = deploymentMapForCurrentFile(deployments);
    const exactDeployment = nextDeploymentsByProvider[providerId] ?? null;
    const fallbackDeployment = options?.fallbackToExisting
      ? Object.values(nextDeploymentsByProvider)[0] ?? null
      : null;
    const currentDeployment = exactDeployment ?? fallbackDeployment;
    // Use the explicit providerId for config/form so a fallback deployment from
    // another provider only fills the existing-URL display, never the form/credentials.
    const config = await fetchDeployConfig(providerId);
    if (requestSeq !== deployProviderLoadSeqRef.current) {
      return { config: null, currentDeployment: null };
    }
    syncDeployFormFromConfig(providerId, config);
    setDeploymentsByProvider(nextDeploymentsByProvider);
    setDeployment(currentDeployment ?? null);
    setDeployResult(currentDeployment ?? null);
    if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID && config?.configured) {
      void loadCloudflareZones(config, { requestSeq });
    }
    return { config, currentDeployment };
  }

  async function loadCloudflareZones(
    config: WebDeployConfigResponse | null = deployConfig,
    options?: { requestSeq?: number },
  ) {
    if (!config?.configured || config.providerId !== CLOUDFLARE_PAGES_PROVIDER_ID) return;
    const requestSeq = options?.requestSeq ?? deployProviderLoadSeqRef.current;
    setCloudflareZonesLoading(true);
    setCloudflareZonesError(null);
    try {
      const response = await fetchCloudflarePagesZones();
      if (requestSeq !== deployProviderLoadSeqRef.current) return;
      const zones = response?.zones ?? [];
      setCloudflareZones(zones);
      const hintedZoneId = response?.cloudflarePages?.lastZoneId || config.cloudflarePages?.lastZoneId || '';
      const nextZoneId = hintedZoneId && zones.some((zone) => zone.id === hintedZoneId)
        ? hintedZoneId
        : zones[0]?.id || '';
      setCloudflareZoneId(nextZoneId);
      const hintedPrefix = response?.cloudflarePages?.lastDomainPrefix || config.cloudflarePages?.lastDomainPrefix || '';
      if (hintedPrefix) setCloudflareDomainPrefix(hintedPrefix);
    } catch (err) {
      if (requestSeq !== deployProviderLoadSeqRef.current) return;
      setCloudflareZones([]);
      setCloudflareZonesError(err instanceof Error ? err.message : t('fileViewer.cloudflareZonesLoadFailed'));
    } finally {
      if (requestSeq === deployProviderLoadSeqRef.current) setCloudflareZonesLoading(false);
    }
  }

  // Slide deck nav state: the iframe posts the active index + total count
  // back to the host every time a slide settles. Host renders prev/next
  // controls in the toolbar and reflects the count beside them.
  const [slideState, setSlideState] = useState<SlideState | null>(
    () => htmlPreviewSlideState.get(previewStateKey) ?? null,
  );
  const boardPreviewScaleOptions = localCommentSideDockActive ? { canvasPadding: 0 } : undefined;
  const overlayPreviewScale = effectivePreviewScale(
    previewViewport,
    previewScale,
    boardPreviewCanvasSize,
    boardPreviewScaleOptions,
  );
  const overlayPreviewTransform: PreviewOverlayTransform = {
    scale: overlayPreviewScale,
    offsetX: 0,
    offsetY: 0,
  };
  const manualEditOverlayTransform = previewOverlayTransform(
    previewViewport,
    previewScale,
    boardPreviewCanvasSize,
    boardPreviewScaleOptions,
  );
  const shareRef = useRef<HTMLDivElement | null>(null);
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    setChromeActionsHost(resolveChromeActionsHost());
  }, []);

  useEffect(() => {
    liveCommentTargetsRef.current = liveCommentTargets;
  }, [liveCommentTargets]);

  useEffect(() => {
    const prevId = selectedManualEditTargetRef.current?.id ?? null;
    const nextId = selectedManualEditTarget?.id ?? null;
    selectedManualEditTargetRef.current = selectedManualEditTarget;
    if (nextId !== prevId) {
      cancelKeyboardBurst();
      keyboardBurstQueueRef.current = [];
      manualEditOptimisticTranslateRef.current = null;
      lastPersistedTranslateRef.current = selectedManualEditTarget?.styles.translate ?? null;
    }
  }, [selectedManualEditTarget]);

  useEffect(() => {
    manualEditModeRef.current = manualEditMode;
  }, [manualEditMode]);

  useEffect(() => {
    const sourceFileKey = `${projectId}\0${file.name}\0${liveHtml === undefined ? 'raw' : 'live'}`;
    if (liveHtml !== undefined) {
      sourceFileKeyRef.current = sourceFileKey;
      manualEditSaveGenerationRef.current = 0;
      dropActiveManualEditMovementForSourceRefresh(liveHtml);
      setSource(liveHtml);
      sourceRef.current = liveHtml;
      return;
    }
    const fileChanged = sourceFileKeyRef.current !== sourceFileKey;
    sourceFileKeyRef.current = sourceFileKey;
    if (fileChanged) {
      manualEditSaveGenerationRef.current = 0;
      setSource(null);
      sourceRef.current = null;
    }
    dropActiveManualEditMovementForSourceRefresh();
    let cancelled = false;
    const saveGenerationAtRequest = manualEditSaveGenerationRef.current;
    // Cache-bust the fetch on every mtime / reload / files-refresh bump.
    // Without this, an agent edit during Comment mode (srcDoc path) gets
    // stale HTML from the browser HTTP cache — the source state ends up
    // identical to the previous value, srcDoc is byte-equal to the last
    // activated HTML, canActivateSrcDocTransport bails on the dedupe
    // check, and the preview only refreshes when Comment closes and the
    // url-load iframe takes over with its own ?v=mtime cache-bust.
    void fetchProjectFileText(projectId, file.name, {
      cacheBustKey: `${file.mtime}-${reloadKey}-${filesRefreshKey}`,
    }).then(async (text) => {
      if (cancelled) return;
      // Chokidar emits agent rewrites as unlink+add+change bursts; a
      // transient null mid-burst would blank source → srcDoc empty →
      // shell stays on prior frame. Keep the last good text instead.
      if (text == null) return;
      // A raw read started before a save can be either stale pre-save content
      // or a real external write. Re-read once to tell them apart.
      if (saveGenerationAtRequest !== manualEditSaveGenerationRef.current) {
        if (text === sourceRef.current) return;
        const generationAtRecheck = manualEditSaveGenerationRef.current;
        const latest = await fetchProjectFileText(projectId, file.name, {
          cache: 'no-store',
          cacheBustKey: Date.now(),
        });
        if (cancelled || generationAtRecheck !== manualEditSaveGenerationRef.current) return;
        if (latest == null || latest === sourceRef.current) return;
        text = latest;
      }
      if (manualEditSourceRefreshPendingRef.current) {
        manualEditSourceRefreshPendingRef.current = false;
        if (manualEditModeRef.current) {
          dropActiveManualEditMovementForSourceRefresh(text);
        }
      }
      setSource(text);
      sourceRef.current = text;
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, liveHtml, reloadKey, filesRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    setDeployResult(null);
    setDeployError(null);
    setCopiedDeployLink(null);
    setDeployPhase('idle');
    void fetchProjectDeployments(projectId).then((items) => {
      if (cancelled) return;
      const nextDeploymentsByProvider = deploymentMapForCurrentFile(items);
      const current = nextDeploymentsByProvider[deployProviderId] ?? null;
      setDeploymentsByProvider(nextDeploymentsByProvider);
      setDeployment(current ?? null);
      setDeployResult(current ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, deployProviderId]);

  // Detect deck-shaped HTML even when the project's skill didn't declare
  // `mode: deck`. Freeform projects often produce a deck because the user
  // asked for one in plain prose; without this, prev/next and Present
  // never surface and the deck becomes a static, unnavigable preview.
  const looksLikeDeck = useMemo(() => {
    if (!source) return false;
    return /class\s*=\s*['"][^'"]*\bslide\b/i.test(source);
  }, [source]);
  const effectiveDeck = isDeck || looksLikeDeck;
  const livePreviewSource = inlinedSource ?? source;
  // Freeze the iframe input on the snapshot taken at Edit-mode entry. Any
  // source rewrite during edit (1.5s debounced set-style patches) stays
  // invisible to the iframe — live updates flow through readable-edit-preview-style
  // postMessage instead, so the canvas never has to reload.
  useEffect(() => {
    if (!manualEditMode) {
      // Exit invalidates the freeze. set-style commits intentionally never
      // refresh the frozen snapshot (that would reload the canvas mid-edit),
      // so letting it survive the session would resurrect pre-edit geometry
      // on the next entry; re-entry must re-snapshot the current source.
      if (manualEditFrozenSource !== null) setManualEditFrozenSource(null);
      return;
    }
    if (manualEditFrozenSource === null && livePreviewSource != null) {
      setManualEditFrozenSource(livePreviewSource);
    }
  }, [manualEditMode, manualEditFrozenSource, livePreviewSource]);
  const previewSource = (manualEditMode && manualEditFrozenSource !== null)
    ? manualEditFrozenSource
    : livePreviewSource;
  const manualEditPageStylesEnabled = typeof source === 'string' && isManualEditFullHtmlDocument(source);
  const urlModeBridge = hasUrlModeBridge(source);
  const tweaksBridge = hasTweaksTemplate(source);
  const manualEditRequiresSrcDoc = manualEditSrcDocActive && !urlModeBridge;
  // When we URL-load the iframe directly, skip every in-host inlining /
  // srcDoc-rebuilding step. The browser does the asset resolution itself,
  // which is the whole point of the URL-load path.
  // Auto-fall back to the srcDoc path when the artifact will crash under
  // the URL-load iframe's bare `sandbox="allow-scripts"` — Babel-standalone
  // React prototypes and any HTML that reads Web Storage at mount throw
  // SecurityError without `allow-same-origin`. The srcDoc path runs
  // `injectSandboxShim` before any user script, so those artifacts render.
  // Memoized on `source` so HtmlViewer's frequent re-renders (board/inspect/
  // edit mode toggles, slide nav) don't re-scan the HTML each time.
  const needsSandboxShim = useMemo(
    () => source != null && htmlNeedsSandboxShim(source),
    [source],
  );
  const needsFocusGuard = useMemo(
    () => source != null && htmlNeedsFocusGuard(source),
    [source],
  );
  const [urlSelectionBridgeReady, setUrlSelectionBridgeReady] = useState(false);
  const useUrlLoadPreview = shouldUrlLoadHtmlPreview({
    mode,
    isDeck: effectiveDeck,
    commentMode: boardMode,
    urlCommentBridge: urlSelectionBridgeReady,
    editMode: manualEditMode,
    urlModeBridge,
    inspectMode,
    drawMode: drawOverlayOpen,
    tweaksBridge,
    paletteActive: false,
    forceInline,
    needsFocusGuard,
    needsSandboxShim,
  }) && !manualEditRequiresSrcDoc;
  const basePreviewSrcUrl = useMemo(
    () => `${projectRawUrl(projectId, file.name)}?v=${Math.round(file.mtime)}&r=${reloadKey}&odPreviewBridge=scroll&odPreviewBridge=selection&odPreviewBridge=snapshot`,
    [projectId, file.name, file.mtime, reloadKey],
  );
  const [previewSrcUrl, setPreviewSrcUrl] = useState(basePreviewSrcUrl);
  const activePreviewSrcUrl = (
    previewSrcUrl === basePreviewSrcUrl ||
    previewSrcUrl.startsWith(`${basePreviewSrcUrl}&`)
  )
    ? previewSrcUrl
    : basePreviewSrcUrl;
  useEffect(() => {
    setPreviewSrcUrl(basePreviewSrcUrl);
    setUrlSelectionBridgeReady(false);
  }, [basePreviewSrcUrl]);
  useEffect(() => {
    iframeRef.current = useUrlLoadPreview ? urlPreviewIframeRef.current : srcDocPreviewIframeRef.current;
  }, [useUrlLoadPreview]);

  useEffect(() => {
    if (filesRefreshKey === 0) return;
    const nextSrc = `${basePreviewSrcUrl}&fr=${filesRefreshKey}`;
    const timeout = window.setTimeout(() => {
      if (useUrlLoadPreview && urlPreviewIframeRef.current?.contentWindow) {
        urlPreviewIframeRef.current.contentWindow.location.replace(nextSrc);
      } else {
        setPreviewSrcUrl(nextSrc);
      }
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [basePreviewSrcUrl, filesRefreshKey, useUrlLoadPreview]);

  useEffect(() => {
    setInlinedSource(null);
    if (useUrlLoadPreview) return;
    if (!source || effectiveDeck || !hasRelativeAssetRefs(source)) return;
    let cancelled = false;
    void inlineRelativeAssets(source, projectId, file.name).then((next) => {
      if (!cancelled) setInlinedSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, [source, effectiveDeck, projectId, file.name, reloadKey, useUrlLoadPreview]);

  const captureModeActive = drawOverlayOpen;
  const useLazySrcDocTransport = !manualEditRequiresSrcDoc && !captureModeActive && useUrlLoadPreview;
  const buildPreviewSrcDoc = useCallback(() => (!previewSource ? '' : buildSrcdoc(previewSource, {
    deck: effectiveDeck,
    baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
    initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
    selectionBridge: true,
    editBridge: manualEditRequiresSrcDoc,
    paletteBridge: false,
    previewFocusGuard: true,
  })), [previewSource, effectiveDeck, projectId, file.name, previewStateKey, manualEditRequiresSrcDoc]);
  const srcDoc = useMemo(
    () => (useLazySrcDocTransport ? '' : buildPreviewSrcDoc()),
    [buildPreviewSrcDoc, useLazySrcDocTransport],
  );
  const lazySrcDocTransport = useMemo(() => buildLazySrcdocTransport(), []);
  const [manualEditDocumentRevision, setManualEditDocumentRevision] = useState(0);
  function manualEditDocumentEpoch(): string {
    return `${projectId}\u0000${file.name}\u0000${manualEditPreviewRevisionRef.current}`;
  }
  const manualEditSourceRefreshKey = [
    file.mtime,
    liveHtml === undefined ? 'raw' : liveHtml,
    filesRefreshKey,
    reloadKey,
  ].join('\u0000');
  const manualEditMovementOwnerKey = [
    projectId,
    file.name,
    manualEditDocumentRevision,
    manualEditMode ? 'active' : 'inactive',
    selectedManualEditTarget?.id ?? '',
  ].join('\u0000');
  const manualEditMoveFrameKey = `${manualEditMovementOwnerKey}\u0000${manualEditSourceRefreshKey}`;
  useEffect(() => () => {
    clearManualEditMovement();
    manualEditDuplicateGenerationRef.current += 1;
    manualEditSourceRefreshPendingRef.current = false;
  }, [manualEditMovementOwnerKey]);
  const [srcDocTransportResetKey, setSrcDocTransportResetKey] = useState(0);
  const [srcDocShellReady, setSrcDocShellReady] = useState(false);
  const wasUrlLoadPreviewRef = useRef(useUrlLoadPreview);
  const urlPreviewKeepAliveKey = previewIframeKeepAliveKey(projectId, file.name);
  // Reset the shell-ready latch whenever the srcDoc iframe re-mounts. The
  // next shell will post `readable-studio:srcdoc-transport-ready` (or fire onLoad) and
  // flip this back to true. See #2253.
  useEffect(() => {
    setSrcDocShellReady(false);
  }, [srcDocTransportResetKey]);
  // Listen for the shell's ready handshake. Gating activation on this is
  // what fixes the #2253 race: opening Tweaks right after a key-driven
  // re-mount used to post `activate` before the shell's listener was
  // installed, dropping the message and stranding the iframe on the empty
  // 536-byte body.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== srcDocPreviewIframeRef.current?.contentWindow) return;
      const data = ev.data as { type?: string } | null;
      if (data?.type !== 'readable-studio:srcdoc-transport-ready') return;
      setSrcDocShellReady(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const frame = urlPreviewIframeRef.current;
      if (ev.source !== frame?.contentWindow) return;
      if (frame.getAttribute('src') === 'about:blank') return;
      const data = ev.data as { type?: string } | null;
      if (data?.type !== 'readable-studio:url-selection-bridge-ready') return;
      setUrlSelectionBridgeReady(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // Lazy transport preloads an empty shell only while URL-load is the active
  // transport. Once srcdoc becomes active (sandbox shim, Draw, Screenshot,
  // Tweaks, etc.), mount the real artifact HTML directly so we do not depend on
  // a postMessage activation that can race (#2253) and strand the iframe blank
  // (#2361, #2791).
  const srcDocTransportContent = useLazySrcDocTransport
    ? lazySrcDocTransport
    : manualEditSrcDocActive && !useUrlLoadPreview && srcDoc
      ? `${srcDoc}\n<!-- readable-studio:manual-edit-document-revision=${manualEditDocumentRevision} -->`
      : srcDoc;
  const urlTransportSrc = useUrlLoadPreview ? activePreviewSrcUrl : 'about:blank';
  const activateSrcDocTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    const html = srcDoc || buildPreviewSrcDoc();
    if (!canActivateSrcDocTransport({
      srcDoc: html,
      useUrlLoadPreview,
      useLazySrcDocTransport,
      shellReady: srcDocShellReady,
      activatedHtml: activatedSrcDocTransportHtmlRef.current,
    })) return false;
    // A SECOND activation while Comment mode is on would document.open +
    // write over the iframe's existing document. The window-level message
    // listener survives, but iframe.onLoad does NOT refire for
    // document.write, so host-side re-init (slide nav sync, scroll
    // restore, bridge replay) is silently skipped — the visible page can
    // drift out of sync with the host's tracked state (e.g. the page
    // indicator shows 3 while the iframe rendered page 4 of the freshly
    // edited deck). Force a fresh shell mount under Comment so onLoad
    // fires and the full re-init pipeline runs against the new HTML.
    //
    // Skip the remount path in Manual Edit, where the postMessage
    // activate carries the patched HTML and host-side scroll/slide
    // state intentionally stays put across the patch.
    if (boardMode && activatedSrcDocTransportHtmlRef.current !== null) {
      activatedSrcDocTransportHtmlRef.current = null;
      setSrcDocTransportResetKey((key) => key + 1);
      return true;
    }
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'readable-studio:srcdoc-transport-activate', html }, '*');
    activatedSrcDocTransportHtmlRef.current = html;
    return true;
  }, [buildPreviewSrcDoc, srcDoc, useLazySrcDocTransport, useUrlLoadPreview, srcDocShellReady, boardMode]);
  const activateLoadedSrcDocTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    const html = srcDoc || buildPreviewSrcDoc();
    if (!canActivateSrcDocTransport({
      srcDoc: html,
      useUrlLoadPreview,
      useLazySrcDocTransport,
      shellReady: true,
      activatedHtml: activatedSrcDocTransportHtmlRef.current,
    })) return false;
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'readable-studio:srcdoc-transport-activate', html }, '*');
    activatedSrcDocTransportHtmlRef.current = html;
    return true;
  }, [buildPreviewSrcDoc, srcDoc, useLazySrcDocTransport, useUrlLoadPreview]);
  const activateSrcDocSnapshotTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    const html = srcDoc || buildPreviewSrcDoc();
    if (!html) return false;
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'readable-studio:srcdoc-transport-activate', html }, '*');
    return true;
  }, [buildPreviewSrcDoc, srcDoc]);
  useEffect(() => {
    if (useUrlLoadPreview) {
      activatedSrcDocTransportHtmlRef.current = null;
      if (!wasUrlLoadPreviewRef.current) {
        setSrcDocTransportResetKey((key) => key + 1);
      }
      wasUrlLoadPreviewRef.current = true;
      return;
    }
    if (wasUrlLoadPreviewRef.current) {
      setSrcDocTransportResetKey((key) => key + 1);
      activatedSrcDocTransportHtmlRef.current = null;
    }
    wasUrlLoadPreviewRef.current = false;
    activateSrcDocTransport();
  }, [activateSrcDocTransport, useUrlLoadPreview]);
  
  useEffect(() => {
    restorePreviewScrollPosition();
  }, [boardMode, drawOverlayOpen, manualEditMode, srcDoc, restorePreviewScrollPosition]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        frameLeft?: number;
        frameTop?: number;
        canvasLeft?: number;
        canvasTop?: number;
      } | null;
      if (!data || data.type !== 'readable-studio:preview-scroll') return;
      if (previewScrollRestoreRef.current && Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0) return;
      if (
        previewScrollPositionRef.current.canvasLeft !== 0 ||
        previewScrollPositionRef.current.canvasTop !== 0
      ) {
        const isInitialZeroReport = Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0;
        if (isInitialZeroReport && Date.now() - previewScrollRequestAtRef.current < 1200) return;
      }
      previewScrollPositionRef.current = {
        frameLeft: Number(data.frameLeft || 0),
        frameTop: Number(data.frameTop || 0),
        canvasLeft: Number(data.canvasLeft || 0),
        canvasTop: Number(data.canvasTop || 0),
      };
    }
    function onRestoreRequest(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as { type?: string } | null;
      if (!data || data.type !== 'readable-studio:preview-scroll-request') return;
      previewScrollRequestAtRef.current = Date.now();
      const snapshot = previewScrollRestoreRef.current;
      const scroll = snapshot ?? {
        frameLeft: previewScrollPositionRef.current.frameLeft,
        frameTop: previewScrollPositionRef.current.frameTop,
        canvasLeft: previewScrollPositionRef.current.canvasLeft,
        canvasTop: previewScrollPositionRef.current.canvasTop,
      };
      iframeRef.current?.contentWindow?.postMessage({
        type: 'readable-studio:preview-scroll-restore',
        frameLeft: scroll.frameLeft,
        frameTop: scroll.frameTop,
        canvasLeft: scroll.canvasLeft,
        canvasTop: scroll.canvasTop,
      }, '*');
    }
    function onDcViewportMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        x?: number;
        y?: number;
        scale?: number;
      } | null;
      if (!data || !data.type) return;
      if (data.type === '__dc_viewport') {
        const x = Number(data.x || 0);
        const y = Number(data.y || 0);
        const scale = Number(data.scale || 1);
        const hasExistingPosition = dcViewportRef.current.x !== 0 || dcViewportRef.current.y !== 0;
        const isInitialZeroReport = x === 0 && y === 0 && scale === 1;
        if (hasExistingPosition && isInitialZeroReport && Date.now() - dcViewportRestoreAtRef.current < 1500) return;
        dcViewportRef.current = {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        };
        return;
      }
      if (data.type === '__dc_viewport_request') {
        dcViewportRestoreAtRef.current = Date.now();
        iframeRef.current?.contentWindow?.postMessage({
          type: '__dc_set_viewport',
          ...dcViewportRef.current,
        }, '*');
      }
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('message', onRestoreRequest);
    window.addEventListener('message', onDcViewportMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('message', onRestoreRequest);
      window.removeEventListener('message', onDcViewportMessage);
    };
  }, [isActivePreviewIframeSource, isOurPreviewIframeSource]);

  useEffect(() => {
    if (!effectiveDeck) {
      setSlideState(null);
      return;
    }
    setSlideState(htmlPreviewSlideState.get(previewStateKey) ?? null);
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev?.data as
        | { type?: string; active?: number; count?: number }
        | null;
      if (!data || data.type !== 'readable-studio:slide-state') return;
      if (typeof data.active !== 'number' || typeof data.count !== 'number') return;
      const next = { active: data.active, count: data.count };
      setSlideStateCached(previewStateKey, next);
      setSlideState(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [effectiveDeck, isActivePreviewIframeSource, isOurPreviewIframeSource, previewStateKey]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'readable-studio:comment-mode',
      enabled: boardMode,
      mode: boardTool,
    }, '*');
  }, [boardMode, boardTool, srcDoc, useUrlLoadPreview]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    // Bump the revision only when the preview document actually changes (a
    // different file, an srcDoc reload, or a render-mode flip) — never on a plain
    // selection re-sync — so the bridge and host never drift out of sync.
    const docKey = `${file.name} ${useUrlLoadPreview ? 'url' : 'srcdoc'} ${srcDoc ?? ''}`;
    if (manualEditPreviewDocRef.current !== docKey) {
      manualEditPreviewRevisionRef.current += 1;
      manualEditPreviewDocRef.current = docKey;
    }
    win.postMessage({ type: 'readable-edit-mode', enabled: manualEditMode, documentEpoch: manualEditDocumentEpoch() }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null);
  }, [manualEditMode, selectedManualEditTarget?.id, srcDoc, useUrlLoadPreview, file.name]);

  const previewStyleToIframe = useCallback((
    id: string,
    styles: Partial<ManualEditStyles>,
    version: number,
    includeAuthoredSize = false,
    resize?: ManualEditResizeRequest,
  ) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'readable-edit-preview-style', id, styles, version, includeAuthoredSize, ...(resize ? { resize } : {}) }, '*');
    return true;
  }, []);

  const sendManualEditRichFormat = useCallback((command: 'bold' | 'italic' | 'underline') => {
    const win = iframeRef.current?.contentWindow;
    if (win) win.postMessage({ type: 'readable-edit-rich-format', command }, '*');
  }, []);

  const sendManualEditTextEdit = useCallback(
    (message: ManualEditBeginTextEditMessage | ManualEditEndTextEditMessage) => {
      const win = iframeRef.current?.contentWindow;
      if (win) win.postMessage(message, '*');
    },
    [],
  );

  // Post the current DOCUMENT revision (bumped by the document-change effect, not
  // here) so every re-sync for the same document carries the same value the bridge
  // will echo back on nudges/commits.
  function postSelectedManualEditTargetToIframe(id: string | null, target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'readable-edit-selected-target', id, revision: manualEditPreviewRevisionRef.current }, '*');
  }

  function syncBridgeModes(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'readable-studio:comment-mode',
      enabled: boardMode,
      mode: boardTool,
    }, '*');
    win.postMessage({ type: 'readable-edit-mode', enabled: manualEditMode, documentEpoch: manualEditDocumentEpoch() }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null, target);
    win.postMessage({ type: 'readable-studio:inspect-mode', enabled: inspectMode }, '*');
  }

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'readable-studio:inspect-mode', enabled: inspectMode }, '*');
  }, [inspectMode, srcDoc, useUrlLoadPreview]);

  // Mirror the bridge's `readable-studio:comment-targets` broadcast into
  // `liveCommentTargets` whenever EITHER Inspect or Comments mode is
  // active. The boardMode-only useEffect below still handles its
  // own comment-specific events (hover / click target / pod), but
  // the targets list itself is mode-agnostic — it's just "which
  // elements on the page carry data-readable-id / data-screen-label".
  // Without this listener Inspect mode never learns the artifact's
  // annotation count, and the empty-state hint added for #890 would
  // misfire (always firing in Inspect mode, even on annotated
  // artifacts) because the comment-mode listener short-circuits on
  // `!boardMode`. Issue #890.
  useEffect(() => {
    if (!inspectMode && !boardMode) {
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            targets?: Array<Partial<PreviewCommentSnapshot>>;
          }
        | null;
      if (data?.type !== 'readable-studio:comment-targets' || !Array.isArray(data.targets)) return;
      const next = new Map<string, PreviewCommentSnapshot>();
      data.targets.forEach((item) => {
        const elementId = String(item?.elementId || '');
        if (!elementId) return;
        const position = {
          x: clampBridgeCoordinate(item?.position?.x),
          y: clampBridgeCoordinate(item?.position?.y),
          width: clampBridgeCoordinate(item?.position?.width),
          height: clampBridgeCoordinate(item?.position?.height),
        };
        if (!isValidCommentOverlayPosition(position)) return;
        next.set(elementId, {
          filePath: file.name,
          elementId,
          selector: String(item?.selector || ''),
          label: String(item?.label || ''),
          text: String(item?.text || ''),
          position,
          htmlHint: String(item?.htmlHint || ''),
          style: normalizeAnnotationStyle(item?.style),
          selectionKind: 'element',
          memberCount: undefined,
          ...(typeof item?.slideIndex === 'number' ? { slideIndex: item.slideIndex } : {}),
        });
      });
      setLiveCommentTargets((current) => (
        liveCommentTargetMapsEqual(current, next) ? current : next
      ));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, boardMode, file.name, isOurPreviewIframeSource]);

  useEffect(() => {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setLiveCommentTargets(new Map());
    setCommentDraft('');
    setActiveCommentExistingAttachments([]);
    setActiveInspectTarget(null);
    setInspectOverrides({});
    setInspectSavedAt(null);
    setInspectError(null);
    setQueuedBoardNotes([]);
    setStrokePoints([]);
    setManualEditFrozenSource(null);
    setManualEditTargets([]);
    setSelectedManualEditTarget(null);
    selectedManualEditTargetIdRef.current = null;
    selectedManualEditTargetRef.current = null;
    manualEditPostSaveIntentRef.current = null;
    manualEditPendingDuplicateSelectionRef.current = null;
    manualEditActionSeqRef.current += 1;
    setManualEditDraft(emptyManualEditDraft());
    setManualEditHistory([]);
    setManualEditUndone([]);
    setManualEditError(null);
    clearManualEditResizeFeedback();
    manualEditPendingStyleRef.current = null;
    clearManualEditMovement();
  }, [file.name]);

  // Revert any in-flight manual-edit movement if the viewer unmounts mid-drag.
  useEffect(() => () => { clearManualEditMovement(); }, []);

  // Selecting a new file or turning inspect/comment-inspect off resets the panel target.
  useEffect(() => {
    if (!inspectMode && !(boardMode && boardTool === 'inspect')) {
      setActiveInspectTarget(null);
      setInspectError(null);
    }
  }, [inspectMode, boardMode, boardTool]);

  // Hydrate the host-authoritative override map from the artifact source
  // synchronously, *before* React commits a render that carries a new
  // `srcDoc` to the iframe. A `useEffect([source])` would commit the new
  // source first and only re-render with the parsed map afterwards — if
  // the iframe finishes loading the new srcDoc in that window, its
  // `onLoad` handler captures the previous file's empty/stale map in its
  // closure and posts that map back over the bridge's freshly DOM-hydrated
  // overrides, leaving the preview without saved inspect styles until the
  // next reload or mode toggle. Setting state during render is React's
  // documented escape hatch for "store a value derived from props"
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // the in-flight render is discarded and React re-renders with the
  // updated state before commit, so the new `srcDoc` and the new
  // `inspectOverrides` always commit together. After hydration the map
  // only mutates from host-driven onApply / reset callbacks below, so
  // artifact JS forging an readable-studio:inspect-overrides message cannot tamper
  // with what saveInspectToSource will persist.
  if (inspectHydratedSourceRef.current !== source) {
    inspectHydratedSourceRef.current = source;
    setInspectOverrides(typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
  }

  useEffect(() => {
    sourceRef.current = source;
    if (source == null) return;
    setManualEditDraft((current) => (
      current.fullSource === source ? current : { ...current, fullSource: source }
    ));
  }, [source]);

  useEffect(() => {
    selectedManualEditTargetIdRef.current = selectedManualEditTarget?.id ?? null;
  }, [selectedManualEditTarget?.id]);

  useEffect(() => {
    if (!boardMode) {
      setCommentCreateMode(false);
      setActiveCommentTarget((current) => (current ? null : current));
      setHoveredCommentTarget((current) => (current ? null : current));
      setActivePreviewCommentId((current) => (current ? null : current));
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      setQueuedBoardNotes((current) => (current.length > 0 ? [] : current));
      setStrokePoints((current) => (current.length > 0 ? [] : current));
      return;
    }
    const snapshotFromData = (data: Partial<PreviewCommentSnapshot>): PreviewCommentSnapshot => ({
      filePath: file.name,
      elementId: String(data.elementId || ''),
      selector: String(data.selector || ''),
      label: String(data.label || ''),
      text: String(data.text || ''),
      position: {
        x: clampBridgeCoordinate(data.position?.x),
        y: clampBridgeCoordinate(data.position?.y),
        width: clampBridgeCoordinate(data.position?.width),
        height: clampBridgeCoordinate(data.position?.height),
      },
      hoverPoint: data.hoverPoint
        ? {
            x: clampBridgeCoordinate(data.hoverPoint.x),
            y: clampBridgeCoordinate(data.hoverPoint.y),
          }
        : undefined,
      htmlHint: String(data.htmlHint || ''),
      style: normalizeAnnotationStyle(data.style),
      selectionKind: data.selectionKind === 'pod' ? 'pod' : 'element',
      memberCount: finiteBridgeInteger(data.memberCount),
      podMembers: Array.isArray(data.podMembers) ? data.podMembers : undefined,
      ...(typeof data.slideIndex === 'number' ? { slideIndex: data.slideIndex } : {}),
    });
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as (Partial<PreviewCommentSnapshot> & {
        type?: string;
        targets?: Array<Partial<PreviewCommentSnapshot>>;
        points?: StrokePoint[];
      }) | null;
      if (!data?.type) return;
      if (data.type === 'readable-studio:comment-targets' && Array.isArray(data.targets)) {
        const next = new Map<string, PreviewCommentSnapshot>();
        data.targets.forEach((item) => {
          const snapshot = snapshotFromData(item);
          if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
          next.set(snapshot.elementId, snapshot);
        });
        setLiveCommentTargets((current) => (
          liveCommentTargetMapsEqual(current, next) ? current : next
        ));
        setActiveCommentTarget((current) => {
          if (!current) return null;
          if (current.selectionKind === 'pod') return current;
          const updated = next.get(current.elementId);
          if (!updated || !isValidCommentOverlayPosition(updated.position)) return null;
          return commentSnapshotEqual(current, updated) ? current : updated;
        });
        setHoveredCommentTarget((current) => {
          if (!current) return null;
          if (current.selectionKind === 'pod') return current;
          const updated = next.get(current.elementId);
          if (!updated || !isValidCommentOverlayPosition(updated.position)) return null;
          return commentSnapshotEqual(current, updated) ? current : updated;
        });
        return;
      }
      if (data.type === 'readable-studio:comment-active-target-update') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        // Fires on every pointermove while a target is active — skip the Map
        // clone and the active/hovered state writes when nothing changed, so a
        // steady hover doesn't re-render the whole overlay each frame.
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        setActiveCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && !commentSnapshotEqual(current, snapshot)
            ? snapshot
            : current,
        );
        setHoveredCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && !commentSnapshotEqual(current, snapshot)
            ? snapshot
            : current,
        );
        return;
      }
      if (data.type === 'readable-studio:comment-leave') {
        // Already firmly on the card — nothing to dismiss.
        if (hoverCardPinnedRef.current) return;
        // The pointer left the element. It may be sliding onto the floating card
        // (which overlaps the iframe) or hopping toward an adjacent element —
        // both should keep the card up. Defer the dismiss so the card's
        // mouseenter or the next comment-hover can cancel it; only a leave with
        // nothing following actually tears the card down.
        scheduleHoverCardDismiss();
        return;
      }
      if (data.type === 'readable-studio:comment-hover') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        // Pointer landed on an element — cancel any deferred dismiss so moving
        // from the card back onto the element it describes keeps the card.
        cancelHoverCardDismiss();
        // Hover repeats the same snapshot per pointermove frame — keep the
        // existing state object (and skip the Map clone) when it is unchanged.
        setHoveredCommentTarget((current) =>
          current && current.elementId === snapshot.elementId && commentSnapshotEqual(current, snapshot)
            ? current
            : snapshot,
        );
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        return;
      }
      if (data.type === 'readable-studio:comment-target') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId || !isValidCommentOverlayPosition(snapshot.position)) return;
        const shouldOpenComposer = boardMode || commentCreateMode;
        cancelHoverCardDismiss();
        setActiveCommentTarget((current) => (shouldOpenComposer ? snapshot : current));
        setHoveredCommentTarget(snapshot);
        setLiveCommentTargets((current) => {
          const existing = current.get(snapshot.elementId);
          if (existing && commentSnapshotEqual(existing, snapshot)) return current;
          return new Map(current).set(snapshot.elementId, snapshot);
        });
        if (shouldOpenComposer) {
          setActivePreviewCommentId(null);
          setCommentDraft('');
          setQueuedBoardNotes([]);
          setActiveCommentExistingAttachments([]);
        }
        return;
      }
      if (data.type === 'readable-studio:pod-clear') {
        setStrokePoints([]);
        return;
      }
      if (data.type === 'readable-studio:pod-stroke' && Array.isArray(data.points)) {
        setStrokePoints(
          data.points.map((point) => ({
            x: clampBridgeCoordinate(point.x),
            y: clampBridgeCoordinate(point.y),
          })),
        );
        return;
      }
      if (data.type === 'readable-studio:pod-select' && Array.isArray(data.points)) {
        const points = data.points.map((point) => ({
          x: clampBridgeCoordinate(point.x),
          y: clampBridgeCoordinate(point.y),
        }));
        setStrokePoints(points);
        const nextTarget = buildPodSnapshot({
          filePath: file.name,
          strokePoints: points,
          liveTargets: liveCommentTargetsRef.current,
        });
        if (!nextTarget) {
          setStrokePoints([]);
          return;
        }
        setActiveCommentTarget(nextTarget);
        setHoveredCommentTarget(nextTarget);
        setActivePreviewCommentId(null);
        setQueuedBoardNotes([]);
        setCommentDraft('');
        setActiveCommentExistingAttachments([]);
        setStrokePoints([]);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeCommentTarget, boardMode, boardTool, cancelHoverCardDismiss, commentPortalHost, file.name, isOurPreviewIframeSource, previewComments, scheduleHoverCardDismiss]);

  useEffect(() => {
    if (!boardMode || !activeCommentTarget || activeCommentTarget.selectionKind === 'pod') return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'readable-studio:comment-active-target',
      elementId: activeCommentTarget.elementId,
      selector: activeCommentTarget.selector,
    }, '*');
  }, [activeCommentTarget?.elementId, activeCommentTarget?.selector, activeCommentTarget?.selectionKind, boardMode]);

  useEffect(() => {
    if (!manualEditMode) {
      setManualEditTargets([]);
      setSelectedManualEditTarget(null);
      setManualEditHoverTarget(null);
      setManualEditPageStylesOpen(false);
      selectedManualEditTargetIdRef.current = null;
      selectedManualEditTargetRef.current = null;
      manualEditPostSaveIntentRef.current = null;
      manualEditPendingDuplicateSelectionRef.current = null;
      manualEditActionSeqRef.current += 1;
      setManualEditError(null);
      clearManualEditResizeFeedback();
      manualEditPendingStyleRef.current = null;
      clearManualEditMovement();
      setManualEditRichFormat({ editing: false, hasSelection: false, bold: false, italic: false, underline: false });
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as ManualEditBridgeMessage | null;
      if (!data?.type) return;
      if (data.type === 'readable-edit-duplicate-preview') {
        if (!isActivePreviewIframeSource(ev.source)) return;
        if (data.documentEpoch !== manualEditDocumentEpoch()) return;
        const movement = activeManualEditMovementRef.current;
        const duplicate = movement?.duplicate;
        if (!movement || !duplicate || duplicate.transactionId !== data.transactionId) return;
        const sequence = Number(data.sequence);
        if (!Number.isInteger(sequence) || sequence <= duplicate.lastAckSequence) return;
        duplicate.lastAckSequence = sequence;
        if (!data.ok) {
          failManualEditDuplicate(movement, duplicate, data.error || 'Could not create the duplicate preview.');
          return;
        }
        const wasCreating = duplicate.status === 'creating';
        duplicate.status = 'ready';
        duplicate.placementOffset = data.placementOffset
          && Number.isFinite(data.placementOffset.x)
          && Number.isFinite(data.placementOffset.y)
          ? data.placementOffset
          : { x: 0, y: 0 };
        if (data.rect) setManualEditDuplicateRect(data.rect);
        const waiter = duplicate.ackWaiters.get(sequence);
        if (waiter) {
          duplicate.ackWaiters.delete(sequence);
          window.clearTimeout(waiter.timeoutId);
          waiter.resolve(true);
        }
        const latestUpdate = manualEditLastUpdateRef.current;
        // A create acknowledgement may arrive after one or more pointer
        // frames were queued while the source plan was preparing; flush the
        // latest absolute result once in that transition. Update
        // acknowledgements are already responses to a current frame and must
        // not echo it back, or the bridge and host will acknowledge each
        // other's latest update indefinitely.
        if (wasCreating && latestUpdate && manualEditCtrlRef.current) {
          const latestResult = resolveManualEditMovementUpdate(movement, latestUpdate);
          sendManualEditDuplicateUpdate(movement, latestResult);
        }
        const pendingCommit = wasCreating ? duplicate.pendingCommit : null;
        duplicate.pendingCommit = null;
        if (pendingCommit && manualEditCtrlRef.current) void commitManualEditMovement(pendingCommit);
        return;
      }
      if (data.type === 'readable-edit-duplicate-removed') {
        if (!isActivePreviewIframeSource(ev.source)) return;
        if (data.documentEpoch !== manualEditDocumentEpoch()) return;
        const duplicate = activeManualEditMovementRef.current?.duplicate;
        if (!duplicate || duplicate.transactionId !== data.transactionId) return;
        const sequence = Number(data.sequence);
        if (!Number.isInteger(sequence) || sequence <= duplicate.lastAckSequence) return;
        duplicate.lastAckSequence = sequence;
        return;
      }
      if (data.type === 'readable-edit-targets' && Array.isArray(data.targets)) {
        if (data.documentEpoch !== undefined) {
          const epoch = String(data.documentEpoch);
          if (epoch !== manualEditDocumentEpoch()) return;
          if (manualEditTargetMessageEpochRef.current !== epoch) {
            manualEditTargetMessageEpochRef.current = epoch;
            manualEditTargetMessageSequenceRef.current = 0;
          }
          const sequence = Number(data.sequence);
          if (Number.isInteger(sequence)) {
            if (sequence <= manualEditTargetMessageSequenceRef.current) return;
            manualEditTargetMessageSequenceRef.current = sequence;
          }
        }
        setManualEditTargets(data.targets);
        const pendingDuplicate = manualEditPendingDuplicateSelectionRef.current;
        const pendingOwnsSelection = pendingDuplicate
          && pendingDuplicate.seq === manualEditActionSeqRef.current
          && selectedManualEditTargetIdRef.current === pendingDuplicate.ownerId
          && !manualEditPostSaveIntentRef.current;
        if (pendingDuplicate && !pendingOwnsSelection) {
          manualEditPendingDuplicateSelectionRef.current = null;
        }
        if (pendingOwnsSelection) {
          const duplicateTarget = data.targets.find((target) => target.id === pendingDuplicate.id);
          if (duplicateTarget) {
            manualEditPendingDuplicateSelectionRef.current = null;
            const intent: ManualEditPostSaveIntent = {
              seq: manualEditActionSeqRef.current,
              kind: 'select',
              target: duplicateTarget,
            };
            if (manualEditSavingRef.current) manualEditPostSaveIntentRef.current = intent;
            else window.setTimeout(() => runManualEditPostSaveIntent(intent), 0);
          }
        }
        // Target broadcasts can be briefly empty while the iframe/save path is
        // settling; keep the user's inspector selection unless a fresh copy is
        // available to update its metadata.
        setSelectedManualEditTarget((current) => {
          if (!current) return current;
          const fresh = data.targets.find((target) => target.id === current.id);
          if (!fresh) return current;
          // Discovery broadcasts intentionally omit the relatively expensive
          // authored-size cascade probe. Preserve the selected target's last
          // full selection/preview metadata while refreshing its geometry.
          return fresh.authoredSize || !current.authoredSize
            ? fresh
            : { ...fresh, authoredSize: current.authoredSize };
        });
        const selectedId = selectedManualEditTargetIdRef.current;
        if (selectedId) setTimeout(() => postSelectedManualEditTargetToIframe(selectedId), 0);
        return;
      }
      if (data.type === 'readable-edit-select') {
        setManualEditHoverTarget(null);
        void selectManualEditTarget(data.target);
        return;
      }
      if (data.type === 'readable-edit-hover') {
        // Hover only surfaces a lightweight "edit params" affordance; it must
        // NOT switch the pinned inspector. The panel changes only when the
        // user clicks that affordance (or a container/image body), so moving
        // the cursor across the canvas never yanks the panel away mid-edit.
        setManualEditHoverTarget(
          data.target && data.target.id !== selectedManualEditTargetIdRef.current ? data.target : null,
        );
        return;
      }
      if (data.type === 'readable-edit-background') {
        // Clicking empty canvas deselects and opens the compact page-styles
        // card — only meaningful for full HTML documents.
        setManualEditHoverTarget(null);
        if (typeof source === 'string' && isManualEditFullHtmlDocument(source)) {
          void clearManualEditTargetSelection({ openPageStyles: true });
        }
        return;
      }
      if (data.type === 'readable-edit-text-commit') {
        void applyManualEdit({
          id: String(data.id),
          kind: 'set-text',
          value: String(data.value),
        }, 'Edit text');
        return;
      }
      if (data.type === 'readable-edit-html-commit') {
        // Rich inline edits (Ctrl/Cmd+B/U/I, or any element that kept nested
        // markup) commit the element's inner HTML. It flows through the same
        // applyManualEdit history pipeline as set-text, so host Ctrl+Z undo works
        // on rich edits too.
        void applyManualEdit({
          id: String(data.id),
          kind: 'set-inner-html',
          html: String(data.html),
        }, 'Edit text');
        return;
      }
      if (data.type === 'readable-edit-selection-state') {
        setManualEditRichFormat({
          editing: !!data.editing, hasSelection: !!data.hasSelection,
          bold: !!data.bold, italic: !!data.italic, underline: !!data.underline,
        });
        // Rich-edit session ended (Esc/blur) → promote the move frame to
        // object-select. Never force 'editing' here: mode is seeded per selection.
        if (!data.editing) setManualEditMoveMode('selected');
        return;
      }
      if (data.type === 'readable-edit-preview-style-applied') {
        if (!isActivePreviewIframeSource(ev.source)) return;
        const version = typeof data.version === 'number' ? data.version : 0;
        // Drop only out-of-order stragglers; every newer ack is applied even if
        // a later preview is already in flight (see manualEditPreviewAckVersionRef).
        if (version < manualEditPreviewAckVersionRef.current) return;
        manualEditPreviewAckVersionRef.current = version;
        if (data.ok && data.rect && typeof data.id === 'string') {
          // The iframe measured the element AFTER applying the preview styles:
          // this is the real box (layout may have clamped the request), and it
          // is what the resize handles / hover icon must render.
          const rect = data.rect;
          const cssSize = data.cssSize && typeof data.cssSize.width === 'string' && typeof data.cssSize.height === 'string'
            ? { width: data.cssSize.width, height: data.cssSize.height }
            : undefined;
          const authoredSize = data.authoredSize && typeof data.authoredSize.width === 'string' && typeof data.authoredSize.height === 'string'
            ? { width: data.authoredSize.width, height: data.authoredSize.height }
            : undefined;
          setSelectedManualEditTarget((current) =>
            current && current.id === data.id
              ? { ...current, rect, ...(cssSize ? { cssSize } : {}), ...(authoredSize ? { authoredSize } : {}) }
              : current);
        }
        if (
          data.ok
          && data.resize
          && Array.isArray(data.resize.constraints)
          && typeof data.id === 'string'
          && data.id === selectedManualEditTargetIdRef.current
          && version > manualEditResizeFeedbackInvalidThroughVersionRef.current
        ) {
          setManualEditResizeFeedback({
            targetId: data.id,
            constraints: data.resize.constraints,
            announce: data.resize.announce === true,
          });
        }
        if (!data.ok && version === manualEditPreviewVersionRef.current) {
          setManualEditError(data.error || 'Could not apply preview style.');
        }
        return;
      }
      if (data.type === 'readable-edit-undo') {
        // The host's window-level Ctrl+Z/Ctrl+Y shortcut (below) never sees
        // this keystroke: keydown does not bubble out of the cross-document
        // preview iframe. The bridge forwards it here instead, but only when
        // no inline edit session is open in the iframe (native undo keeps
        // priority for in-progress typing).
        if (data.redo) void redoManualEditRef.current();
        else void undoManualEditRef.current();
        return;
      }
      if (data.type === 'readable-edit-nudge') {
        const target = selectedManualEditTargetRef.current;
        if (!target || target.id !== data.targetId) return;
        if (data.revision !== manualEditPreviewRevisionRef.current) return;
        // Nudge any selected object, including text/link targets (overlay mode
        // 'editing'). The bridge already blocks ACTIVE inline editing, so reaching
        // here means the object is selected but not being typed into.
        manualEditAltRef.current = false;
        const delta = manualEditNudgeDeltaFromDirection(data.direction);
        handleKeyboardNudge(delta);
        return;
      }
      if (data.type === 'readable-edit-nudge-commit') {
        handleKeyboardNudgeCommit(data.targetId, data.revision);
        return;
      }
      if (data.type === 'readable-edit-nudge-keyup') {
        // The bridge forwards arrow keyups it does not own, so a host-origin
        // burst still ends when the key physically comes up inside the iframe.
        // Identity must match the open burst exactly, like a bridge commit.
        const burst = keyboardBurstRef.current;
        if (burst && burst.targetId === data.targetId && burst.revision === data.revision) {
          handleKeyboardNudgeKeyUp(data.key);
        }
        return;
      }
      if (data.type === 'readable-edit-burst-cancel') {
        // Cancel an active burst if one exists; otherwise a no-op. Escape inside
        // the iframe must NOT deselect the object (that path stays reserved for
        // the empty-canvas click / host Escape ladder).
        cancelKeyboardBurst();
        return;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isActivePreviewIframeSource, isOurPreviewIframeSource, manualEditMode, source]);

  function nextManualEditPreviewVersion(): number {
    manualEditPreviewVersionRef.current += 1;
    return manualEditPreviewVersionRef.current;
  }

  function clearManualEditResizeFeedback(): void {
    manualEditResizeFeedbackInvalidThroughVersionRef.current = manualEditPreviewVersionRef.current;
    setManualEditResizeFeedback(null);
  }

  function inspectorManualEditStyles(target: ManualEditTarget, baseSource: string): ManualEditStyles {
    const inlineStyles = readManualEditStyles(baseSource, target.id);
    return mergeManualEditInspectorStyles(inlineStyles, target.styles);
  }

  function reconcileManualEditStyleSave(
    id: string,
    savedStyles: Partial<ManualEditStyles>,
    savedSource: string,
  ) {
    if (id !== '__body__' && !readManualEditOuterHtml(savedSource, id)) {
      setManualEditError('The selected target no longer exists in the saved source. Refreshing the preview.');
      selectedManualEditTargetRef.current = null;
      setSelectedManualEditTarget(null);
      setManualEditFrozenSource(null);
      clearManualEditMovement();
      setReloadKey((key) => key + 1);
      return;
    }
    const sourceStyles = readManualEditStyles(savedSource, id);
    const supersededStyles = manualEditSupersededStyleKeys(manualEditPendingStyleRef.current, id, savedStyles);
    const repairStyles: Partial<ManualEditStyles> = {};
    for (const key of Object.keys(savedStyles) as Array<keyof ManualEditStyles>) {
      if (Object.prototype.hasOwnProperty.call(supersededStyles, key)) continue;
      const sourceValue = manualEditInspectorStyleValue(key, sourceStyles[key] ?? '');
      const savedValue = savedStyles[key] ?? '';
      if (manualEditPersistedValueMatchesSavedSnapshot(key, sourceValue, savedValue)) continue;
      repairStyles[key] = sourceValue;
    }
    if (Object.keys(repairStyles).length === 0) return;
    previewStyleToIframe(id, repairStyles, nextManualEditPreviewVersion(), true);
    setManualEditDraft((current) => ({
      ...current,
      styles: { ...current.styles, ...repairStyles },
    }));
    setManualEditError('Saved styles differed from the active preview. Reconciled the selected target from source.');
  }

  function cancelManualEditPendingStyles(id: string, keys: Array<keyof ManualEditStyles>) {
    const nextPending = cancelManualEditPendingStyleSnapshot(manualEditPendingStyleRef.current, id, keys);
    if (!nextPending) {
      manualEditPendingStyleRef.current = null;
      return;
    }
    manualEditPendingStyleRef.current = nextPending;
  }

  async function handleManualEditStyleChange(id: string, styles: Partial<ManualEditStyles>, label: string) {
    clearManualEditResizeFeedback();
    const version = nextManualEditPreviewVersion();
    const currentPending = manualEditPendingStyleRef.current;
    const pendingStyles = currentPending?.id === id
      ? { ...currentPending.styles, ...styles }
      : styles;
    const pending: ManualEditPendingStyleSave = { id, styles: pendingStyles, label, version };
    manualEditPendingStyleRef.current = pending;
    setManualEditError(null);
    // Panel changes are low-frequency and need the exact winning declaration
    // (including stylesheet !important / a cleared inline size). Drag frames
    // deliberately skip this CSSOM probe and request it once on commit below.
    previewStyleToIframe(id, styles, version, true);
  }

  // Translate a drag result (rect-space px) into CSS width/height, anchored on
  // the element's current CSS size — target styles overlaid by any unsaved
  // panel draft — and divided by rectScale so elements under an ancestor
  // transform (deck fit-to-canvas) round-trip with the inspector's numbers.
  // Snapshot the drag baseline at pointerdown: preview acks refresh the live
  // target's cssSize (and commits fold styles) mid-drag, and the delta math
  // must anchor every frame of one drag on the same pre-drag state.
  function beginManualEditResizeBaseline(target: ManualEditTarget) {
    const pending = manualEditPendingStyleRef.current;
    const base: Partial<ManualEditStyles> = { ...target.styles };
    if (pending?.id === target.id) Object.assign(base, pending.styles);
    manualEditResizeBaselineRef.current = { id: target.id, styles: base, cssSize: target.cssSize };
  }

  function manualEditResizeStyles(
    target: ManualEditTarget,
    direction: ResizeHandleDirection,
    size: { width: number; height: number },
    startSize: { width: number; height: number },
  ): Partial<ManualEditStyles> {
    let baseline = manualEditResizeBaselineRef.current;
    if (baseline?.id !== target.id) {
      beginManualEditResizeBaseline(target);
      baseline = manualEditResizeBaselineRef.current;
    }
    const base = baseline?.styles ?? target.styles;
    return resizeCssCommitStyles({
      direction,
      size,
      startSize,
      baseStyles: { width: base.width, height: base.height },
      computedSize: baseline?.cssSize,
      baseMargins: {
        marginLeft: base.marginLeft,
        marginRight: base.marginRight,
        marginTop: base.marginTop,
        marginBottom: base.marginBottom,
      },
      rectScale: target.rectScale,
      flexItemAxis: target.flexItemAxis,
    });
  }

  // Resize-handle drag commits directly (bypassing the panel draft ref): each
  // pointerup writes width/height via the same set-style pipeline as the panel.
  async function commitManualEditResize(
    target: ManualEditTarget,
    direction: ResizeHandleDirection,
    size: { width: number; height: number },
    startSize: { width: number; height: number },
  ) {
    const styles = manualEditResizeStyles(target, direction, size, startSize);
    const ok = await applyManualEdit({ id: target.id, kind: 'set-style', styles }, `Style: ${target.label}`);
    if (!ok) return;
    // Drop the just-committed props from any staged panel draft so a later
    // panel flush can't overwrite the drag result with stale width/height.
    cancelManualEditPendingStyles(target.id, Object.keys(styles) as Array<keyof ManualEditStyles>);
    // Fold the saved styles into the selected target so an Escape/pointercancel
    // on a consecutive drag reverts to the saved size instead of the pre-drag
    // one. The rect deliberately stays untouched: the mouse-implied size is a
    // request the layout may have clamped, and the per-frame preview acks (plus
    // the bridge's deferred readable-edit-targets re-broadcast after the drag) hold
    // the element's real measured box.
    setSelectedManualEditTarget((current) => {
      if (!current || current.id !== target.id) return current;
      return { ...current, styles: { ...current.styles, ...styles } };
    });
    if (selectedManualEditTargetIdRef.current === target.id) {
      setManualEditDraft((current) => ({
        ...current,
        styles: { ...current.styles, ...styles },
      }));
    }
    previewStyleToIframe(
      target.id,
      styles,
      nextManualEditPreviewVersion(),
      true,
      manualEditResizeRequest(direction, size, true),
    );
  }

  // Escape / pointercancel: repaint the iframe with the width/height that were
  // in effect before the drag — the target's selection-time styles overlaid by
  // any unsaved panel draft for the same element. For flex items the drag
  // preview may also have pinned `flex: none`; restore the pre-drag flex too.
  function revertManualEditResizePreview(target: ManualEditTarget) {
    const pending = manualEditPendingStyleRef.current;
    const base: Partial<ManualEditStyles> = { ...target.styles };
    if (pending?.id === target.id) Object.assign(base, pending.styles);
    // Margins revert too: a west/north drag preview shifts the box via
    // marginLeft/marginTop (and may pin the opposite side).
    const revert: Partial<ManualEditStyles> = {
      width: base.width ?? '',
      height: base.height ?? '',
      marginLeft: base.marginLeft ?? '',
      marginRight: base.marginRight ?? '',
      marginTop: base.marginTop ?? '',
      marginBottom: base.marginBottom ?? '',
    };
    if (target.flexItemAxis) revert.flex = base.flex ?? '';
    previewStyleToIframe(target.id, revert, nextManualEditPreviewVersion());
  }

  function baseTranslateFor(target: ManualEditTarget): string {
    const pending = manualEditPendingStyleRef.current;
    if (pending?.id === target.id && pending.styles.translate !== undefined) return pending.styles.translate;
    if (
      selectedManualEditTargetRef.current?.id === target.id
      && manualEditOptimisticTranslateRef.current !== null
    ) {
      return manualEditOptimisticTranslateRef.current;
    }
    return target.styles.translate ?? '';
  }

  // Finalize the movement that owns `session`: drop it, reset the drag scratch
  // state, and clear guides — optionally reverting the preview to the pre-drag
  // translate. The ownership check is load-bearing: an async save can resolve
  // after a newer drag has already begun, and that stale completion must not
  // revert or clear the newer movement.
  function finalizeOwnedMovement(session: ManualEditMovementSession, revert: boolean): void {
    if (activeManualEditMovementRef.current?.session !== session) return;
    const movement = activeManualEditMovementRef.current;
    if (movement.duplicate) {
      cancelManualEditDuplicatePreview(movement);
    }
    if (revert) {
      previewStyleToIframe(
        session.targetId,
        { translate: session.baselineTranslate ?? '' },
        nextManualEditPreviewVersion(),
      );
    }
    activeManualEditMovementRef.current = null;
    manualEditAltRef.current = false;
    manualEditCtrlRef.current = false;
    manualEditLastUpdateRef.current = null;
    setManualEditDuplicateRect(null);
    setManualEditSnapGuides(EMPTY_MANUAL_EDIT_SNAP_GUIDES);
  }

  // Abort any in-flight movement now, reverting the preview to baseline. Called
  // from synchronous lifecycle gaps (selection change, reload, mode exit, file
  // change, unmount) where the active movement is always the one to discard.
  function clearManualEditMovement(): void {
    const movement = activeManualEditMovementRef.current;
    if (movement) {
      finalizeOwnedMovement(movement.session, true);
      return;
    }
    manualEditAltRef.current = false;
    manualEditCtrlRef.current = false;
    manualEditLastUpdateRef.current = null;
    setManualEditDuplicateRect(null);
    setManualEditSnapGuides(EMPTY_MANUAL_EDIT_SNAP_GUIDES);
  }

  function beginManualEditMovement(
    target: ManualEditTarget,
    source: ManualEditMovementSource,
  ): void {
    // Callers set manualEditAltRef before this: keyboard nudges reset it to false
    // (they never snap), and pointer drags leave it for the move frame to seed
    // from its threshold Alt report.
    manualEditLastUpdateRef.current = null;
    manualEditCtrlRef.current = false;
    setManualEditDuplicateRect(null);
    setManualEditSnapGuides(EMPTY_MANUAL_EDIT_SNAP_GUIDES);
    const { candidates, selectedParentId, selectedAncestorIds, selectedIndex, snapCandidatesReady } = buildManualEditMovementCandidates(
      manualEditTargets,
      target.id,
    );
    activeManualEditMovementRef.current = {
      session: {
        targetId: target.id,
        source,
        startRect: { ...target.rect },
        baselineTranslate: baseTranslateFor(target),
        ...(target.rectScale ? { rectScale: { ...target.rectScale } } : {}),
        scale: overlayPreviewScale,
        candidates,
        selectedParentId,
        selectedAncestorIds,
        selectedIndex,
        snapCandidatesReady,
        latch: createManualEditSnapLatch(),
      },
      label: `Style: ${target.label}`,
      latestResult: null,
      duplicate: null,
    };
  }

  function syncManualEditDuplicateCandidates(movement: ActiveManualEditMovement, duplicate: boolean): void {
    const hasStationaryOriginal = movement.session.candidates.some(
      (candidate) => candidate.isStationaryOriginal && candidate.id === movement.session.targetId,
    );
    if (hasStationaryOriginal === duplicate) return;
    if (duplicate) {
      // The ordinary candidates are the immutable pointer-down snapshot. Add
      // the stationary original to that snapshot instead of rebuilding from
      // the live target broadcasts, which may already describe the ordinary
      // preview position or a later external reflow.
      if (movement.session.snapCandidatesReady !== false) {
        movement.session.candidates = [
          ...movement.session.candidates,
          {
            id: movement.session.targetId,
            rect: movement.session.startRect,
            parentId: movement.session.selectedParentId,
            ancestorIds: movement.session.selectedAncestorIds,
            index: movement.session.selectedIndex ?? manualEditTargets.findIndex(
              (target) => target.id === movement.session.targetId,
            ),
            isStationaryOriginal: true,
          },
        ];
      }
    } else {
      movement.session.candidates = movement.session.candidates.filter(
        (candidate) => !(candidate.isStationaryOriginal && candidate.id === movement.session.targetId),
      );
    }
    movement.session.latch = createManualEditSnapLatch();
    movement.session.stationaryOriginalEscaped = undefined;
  }

  async function waitForManualEditSaveIdle(): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!manualEditSavingRef.current) return true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    return !manualEditSavingRef.current;
  }

  function duplicatePreparationIsCurrent(
    movement: ActiveManualEditMovement,
    duplicate: ActiveManualEditDuplicate,
  ): boolean {
    return activeManualEditMovementRef.current === movement
      && movement.duplicate === duplicate
      && duplicate.generation === manualEditDuplicateGenerationRef.current
      && manualEditCtrlRef.current;
  }

  function failManualEditDuplicate(
    movement: ActiveManualEditMovement,
    duplicate: ActiveManualEditDuplicate,
    error: string,
  ): void {
    if (movement.duplicate !== duplicate) return;
    duplicate.status = 'failed';
    duplicate.pendingUpdate = null;
    setManualEditDuplicateRect(null);
    setManualEditError(error);
    const shouldRevert = duplicate.pendingCommit !== null || duplicate.pendingFinalCommit !== null;
    duplicate.pendingCommit = null;
    duplicate.pendingFinalCommit = null;
    for (const waiter of duplicate.ackWaiters.values()) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(false);
    }
    duplicate.ackWaiters.clear();
    if (shouldRevert && activeManualEditMovementRef.current === movement) {
      finalizeOwnedMovement(movement.session, true);
    }
  }

  function sendManualEditDuplicateUpdate(
    movement: ActiveManualEditMovement,
    result: ManualEditMovementResult,
  ): number | null {
    const duplicate = movement.duplicate;
    const win = iframeRef.current?.contentWindow;
    if (!duplicate || duplicate.status !== 'ready' || !win) return null;
    duplicate.sequence += 1;
    const sequence = duplicate.sequence;
    win.postMessage({
      type: 'readable-edit-duplicate-update',
      documentEpoch: manualEditDocumentEpoch(),
      transactionId: duplicate.transactionId,
      sequence,
      translate: result.styles.translate ?? '',
    }, '*');
    return sequence;
  }

  function waitForManualEditDuplicateAck(
    duplicate: ActiveManualEditDuplicate,
    sequence: number,
  ): Promise<boolean> {
    if (sequence <= duplicate.lastAckSequence) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        duplicate.ackWaiters.delete(sequence);
        resolve(false);
      }, 1000);
      duplicate.ackWaiters.set(sequence, { resolve, timeoutId });
    });
  }

  function suspendManualEditDuplicatePreview(movement: ActiveManualEditMovement): void {
    const duplicate = movement.duplicate;
    if (!duplicate) return;
    manualEditDuplicateGenerationRef.current += 1;
    for (const waiter of duplicate.ackWaiters.values()) {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve(false);
    }
    duplicate.ackWaiters.clear();
    const win = iframeRef.current?.contentWindow;
    if (win && (duplicate.status === 'creating' || duplicate.status === 'ready')) {
      duplicate.sequence += 1;
      // Invalidate an in-flight create/update acknowledgement before posting
      // the cancel. The bridge processes messages in order, but the host can
      // observe the older acknowledgement after this synchronous transition.
      duplicate.lastAckSequence = duplicate.sequence;
      win.postMessage({
        type: 'readable-edit-duplicate-cancel',
        documentEpoch: manualEditDocumentEpoch(),
        transactionId: duplicate.transactionId,
        sequence: duplicate.sequence,
      }, '*');
    }
    duplicate.pendingUpdate = null;
    duplicate.pendingCommit = null;
    duplicate.pendingFinalCommit = null;
    duplicate.placementOffset = null;
    duplicate.status = 'suspended';
    setManualEditDuplicateRect(null);
  }

  function cancelManualEditDuplicatePreview(movement: ActiveManualEditMovement): void {
    if (!movement.duplicate) return;
    suspendManualEditDuplicatePreview(movement);
    movement.duplicate = null;
  }

  function startManualEditDuplicatePreparation(
    movement: ActiveManualEditMovement,
    update: ManualEditMoveUpdate,
  ): void {
    const existing = movement.duplicate;
    if (existing) {
      if (existing.status === 'suspended' && existing.plan) {
        existing.generation = ++manualEditDuplicateGenerationRef.current;
        existing.pendingUpdate = update;
        existing.placementOffset = null;
        existing.sequence += 1;
        existing.status = existing.plan ? 'creating' : 'preparing';
        const win = iframeRef.current?.contentWindow;
        if (existing.plan && win) {
          win.postMessage({
            type: 'readable-edit-duplicate-create',
            documentEpoch: manualEditDocumentEpoch(),
            transactionId: existing.transactionId,
            sequence: existing.sequence,
            originalId: existing.plan.originalId,
            duplicateRootId: existing.plan.duplicateRootId,
            previewHtml: existing.plan.previewHtml,
            baselineTranslate: existing.plan.baselineTranslate,
          }, '*');
        }
        return;
      }
      if (existing.status === 'suspended') {
        // Preparation was cancelled before an identity plan existed. There is
        // nothing stable to reuse yet, so start one fresh preparation below.
        movement.duplicate = null;
      }
      if (movement.duplicate === existing) {
        existing.pendingUpdate = update;
        if (existing.status === 'ready' && movement.latestResult) {
          sendManualEditDuplicateUpdate(movement, movement.latestResult);
        }
        return;
      }
    }
    const duplicate: ActiveManualEditDuplicate = {
      transactionId: `manual-edit-duplicate-${Date.now()}-${manualEditDuplicateGenerationRef.current + 1}`,
      plan: null,
      status: 'preparing',
      sequence: 0,
      placementOffset: null,
      lastAckSequence: 0,
      pendingUpdate: update,
      pendingCommit: null,
      pendingFinalCommit: null,
      ackWaiters: new Map(),
      generation: manualEditDuplicateGenerationRef.current + 1,
    };
    manualEditDuplicateGenerationRef.current = duplicate.generation;
    movement.duplicate = duplicate;
    setManualEditDuplicateRect(null);
    void (async () => {
      // Let the bridge finish the text-edit blur/commit message before taking
      // the source snapshot. The CAS on the eventual write is the final guard.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      if (!duplicatePreparationIsCurrent(movement, duplicate)) return;
      if (!(await waitForManualEditSaveIdle())) {
        failManualEditDuplicate(movement, duplicate, 'Could not finish the current edit before duplicating.');
        return;
      }
      if (!(await flushManualEditStyleSave())) {
        failManualEditDuplicate(movement, duplicate, 'Could not save the current edit before duplicating.');
        return;
      }
      const snapshot = sourceRef.current;
      if (snapshot == null || !duplicatePreparationIsCurrent(movement, duplicate)) return;
      const planned = planManualEditDuplicate(snapshot, movement.session.targetId);
      if (!planned.ok) {
        failManualEditDuplicate(movement, duplicate, planned.error);
        return;
      }
      if (!duplicatePreparationIsCurrent(movement, duplicate)) return;
      const win = iframeRef.current?.contentWindow;
      if (!win) {
        failManualEditDuplicate(movement, duplicate, 'The preview is unavailable for duplication.');
        return;
      }
      const plan: ManualEditDuplicatePlan = {
        ...planned.plan,
        // Use the immutable pointer-down baseline. The bridge may rebroadcast
        // the target with a preview translate while the async source plan is
        // being prepared; using that refreshed live style would offset the
        // clone before its first frame and make the geometry preflight fail.
        // The session baseline already includes computed/stylesheet translate
        // captured from the selected target before the drag began.
        baselineTranslate: movement.session.baselineTranslate ?? planned.plan.baselineTranslate,
      };
      duplicate.plan = plan;
      duplicate.status = 'creating';
      duplicate.sequence = 1;
      win.postMessage({
        type: 'readable-edit-duplicate-create',
        documentEpoch: manualEditDocumentEpoch(),
        transactionId: duplicate.transactionId,
        sequence: duplicate.sequence,
        originalId: plan.originalId,
        duplicateRootId: plan.duplicateRootId,
        previewHtml: plan.previewHtml,
        baselineTranslate: plan.baselineTranslate,
      }, '*');
    })();
  }

  function resolveManualEditMovementUpdate(
    movement: ActiveManualEditMovement,
    update: ManualEditMoveUpdate,
  ): ManualEditMovementResult {
    manualEditLastUpdateRef.current = update;
    syncManualEditDuplicateCandidates(movement, manualEditCtrlRef.current);
    const result = resolveManualEditMovement(movement.session, update.delta, {
      alt: manualEditAltRef.current,
      shiftKey: update.shiftKey,
      axis: update.axis,
    });
    movement.latestResult = result;
    setManualEditSnapGuides(result.guides);
    return result;
  }

  function previewManualEditMovement(update: ManualEditMoveUpdate): void {
    const movement = activeManualEditMovementRef.current;
    if (!movement) return;
    const result = resolveManualEditMovementUpdate(movement, update);
    if (manualEditCtrlRef.current) {
      if (movement.duplicate?.status === 'failed') cancelManualEditDuplicatePreview(movement);
      if (!movement.duplicate || movement.duplicate.status === 'suspended') {
        // Ctrl can be pressed after an ordinary preview frame. Return the
        // source object to its immutable origin before the duplicate becomes
        // the only moving subject; otherwise the original would remain at the
        // pre-toggle drag position underneath the transient clone.
        previewStyleToIframe(
          result.targetId,
          { translate: movement.session.baselineTranslate ?? '' },
          nextManualEditPreviewVersion(),
        );
        startManualEditDuplicatePreparation(movement, update);
      } else {
        movement.duplicate.pendingUpdate = update;
        sendManualEditDuplicateUpdate(movement, result);
      }
      return;
    }
    if (movement.duplicate) suspendManualEditDuplicatePreview(movement);
    previewStyleToIframe(result.targetId, result.styles, nextManualEditPreviewVersion());
    if (result.styles.translate !== undefined && movement.session.source === 'keyboard') {
      manualEditOptimisticTranslateRef.current = result.styles.translate;
    }
  }

  // Alt toggled mid-drag (pointer possibly stationary): re-resolve the last
  // update with the new Alt state so snapping engages/disengages immediately.
  function rePreviewManualEditMovementWithAlt(altKey: boolean): void {
    manualEditAltRef.current = altKey;
    const movement = activeManualEditMovementRef.current;
    const update = manualEditLastUpdateRef.current;
    if (!movement || !update) return;
    previewManualEditMovement(update);
  }

  async function commitManualEditMovement(update: ManualEditMoveUpdate): Promise<void> {
    const movement = activeManualEditMovementRef.current;
    if (!movement) return;
    const { session, label } = movement;
    const previousResult = movement.latestResult;
    const result = resolveManualEditMovementUpdate(movement, update);
    if (manualEditCtrlRef.current) {
      if (result.appliedDelta.x === 0 && result.appliedDelta.y === 0) {
        finalizeOwnedMovement(session, false);
        return;
      }
      const duplicate = movement.duplicate;
      if (!duplicate || duplicate.status === 'failed') {
        setManualEditError('Could not prepare the duplicate preview.');
        finalizeOwnedMovement(session, true);
        return;
      }
      if (duplicate.status !== 'ready' || !duplicate.plan || !duplicate.placementOffset) {
        duplicate.pendingCommit = update;
        duplicate.pendingUpdate = update;
        return;
      }
      duplicate.pendingFinalCommit = update;
      const finalSequence = sendManualEditDuplicateUpdate(movement, result);
      if (finalSequence === null) {
        duplicate.pendingFinalCommit = null;
        setManualEditError('The duplicate preview is no longer available.');
        finalizeOwnedMovement(session, true);
        return;
      }
      const finalAcked = await waitForManualEditDuplicateAck(duplicate, finalSequence);
      if (!finalAcked) {
        if (activeManualEditMovementRef.current === movement && movement.duplicate === duplicate) {
          duplicate.pendingFinalCommit = null;
          setManualEditError('The duplicate preview changed before it could be saved.');
          finalizeOwnedMovement(session, true);
        }
        return;
      }
      if (activeManualEditMovementRef.current !== movement || movement.duplicate !== duplicate) return;
      duplicate.pendingFinalCommit = null;
      const plan = duplicate.plan;
      const placementOffset = duplicate.placementOffset;
      cancelManualEditDuplicatePreview(movement);
      manualEditPendingDuplicateSelectionRef.current = {
        id: plan.duplicateRootId,
        ownerId: result.targetId,
        seq: manualEditActionSeqRef.current,
      };
      const ok = await applyManualEdit({
        id: result.targetId,
        kind: 'duplicate-and-move',
        plan,
        finalTranslate: result.styles.translate ?? '',
        placementOffset,
      }, label);
      if (!ok) {
        manualEditPendingDuplicateSelectionRef.current = null;
        finalizeOwnedMovement(session, true);
        manualEditOptimisticTranslateRef.current = null;
        return;
      }
      finalizeOwnedMovement(session, false);
      manualEditOptimisticTranslateRef.current = null;
      return;
    }
    if (movement.duplicate) cancelManualEditDuplicatePreview(movement);
    // The final pointerup update can differ from the last flushed preview frame.
    if (previousResult?.styles.translate !== result.styles.translate) {
      previewStyleToIframe(result.targetId, result.styles, nextManualEditPreviewVersion());
    }
    // A net-zero move (dragged back to origin, or Shift-cancelled) writes nothing.
    if (result.appliedDelta.x === 0 && result.appliedDelta.y === 0) {
      finalizeOwnedMovement(session, false);
      return;
    }
    const ok = await applyManualEdit(
      { id: result.targetId, kind: 'set-style', styles: result.styles },
      label,
    );
    if (!ok) {
      finalizeOwnedMovement(session, true);
      manualEditOptimisticTranslateRef.current = null;
      return;
    }
    cancelManualEditPendingStyles(result.targetId, ['translate']);
    setSelectedManualEditTarget((current) => {
      if (!current || current.id !== result.targetId) return current;
      return { ...current, styles: { ...current.styles, ...result.styles } };
    });
    if (selectedManualEditTargetIdRef.current === result.targetId) {
      setManualEditDraft((current) => ({
        ...current,
        styles: { ...current.styles, ...result.styles },
      }));
    }
    // Success keeps the committed translate — finalize without reverting.
    finalizeOwnedMovement(session, false);
    manualEditOptimisticTranslateRef.current = null;
  }

  function cancelManualEditMovement(): void {
    const movement = activeManualEditMovementRef.current;
    if (!movement) return;
    finalizeOwnedMovement(movement.session, true);
    manualEditOptimisticTranslateRef.current = null;
  }

  function addNudgeDelta(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  function previewKeyboardBurst(burst: KeyboardBurst): void {
    const movement = activeManualEditMovementRef.current;
    if (!movement || movement.session.targetId !== burst.targetId) return;
    const result = resolveManualEditMovement(movement.session, burst.netDelta);
    burst.lastResult = result;
    previewStyleToIframe(result.targetId, result.styles, nextManualEditPreviewVersion());
    // The previewed translate is now live in the iframe; record it so a burst
    // begun before this one has committed (e.g. while its save is in flight)
    // baselines off the moved position, not a lagging target.styles snapshot.
    if (result.styles.translate !== undefined) {
      manualEditOptimisticTranslateRef.current = result.styles.translate;
    }
  }

  function beginKeyboardBurst(
    target: ManualEditTarget,
    revision: number,
    delta: { x: number; y: number },
    keys: string[] = [],
  ): void {
    beginManualEditMovement(target, 'keyboard');
    const movement = activeManualEditMovementRef.current;
    if (!movement) return;
    const burst: KeyboardBurst = {
      targetId: target.id,
      revision,
      heldKeys: new Set(keys),
      netDelta: delta,
      startBaseline: movement.session.baselineTranslate ?? '',
      lastResult: null,
    };
    keyboardBurstRef.current = burst;
    previewKeyboardBurst(burst);
  }

  // A single owned keydown. `key` is set for host-origin nudges so keyup can end
  // the burst; iframe-origin nudges omit it and are ended by the bridge's
  // readable-edit-nudge-commit message. Never auto-commits — the burst stays open
  // (accumulating net delta, one preview per keydown) until keyup/commit, blur,
  // or Escape, so a held key produces exactly one write.
  function handleKeyboardNudge(delta: { x: number; y: number }, key?: string): void {
    const target = selectedManualEditTargetRef.current;
    if (!target) return;
    // One movement session at a time: a live pointer drag owns the target.
    if (activeManualEditMovementRef.current?.session.source === 'pointer') return;
    const revision = manualEditPreviewRevisionRef.current;
    const burst = keyboardBurstRef.current;
    // Match the open burst on TARGET only. A same-target host re-sync (e.g. the
    // post-save selection re-post) bumps the preview revision mid-hold; keying the
    // match on revision would split a still-held burst into two writes. Iframe
    // nudges are already revision-validated at message ingress; keep the burst's
    // revision fresh so its identity stays current.
    if (burst && burst.targetId === target.id) {
      burst.revision = revision;
      if (key) burst.heldKeys.add(key);
      burst.netDelta = addNudgeDelta(burst.netDelta, delta);
      previewKeyboardBurst(burst);
    } else {
      // A burst for a different target: end it (it enqueues/commits itself and
      // leaves the fresh burst below intact) and start clean.
      if (burst) void flushKeyboardBurst();
      beginKeyboardBurst(target, revision, delta, key ? [key] : []);
    }
  }

  // Host-side keyup: drop the released key; when no owned arrow key remains held
  // the host-origin burst is complete and commits.
  function handleKeyboardNudgeKeyUp(key: string): void {
    const burst = keyboardBurstRef.current;
    if (!burst || !burst.heldKeys.delete(key)) return;
    if (burst.heldKeys.size === 0) void flushKeyboardBurst();
  }

  // Iframe-origin burst end: the bridge released its last held arrow key. Both
  // target AND revision must match the active burst — the burst's revision is kept
  // current by each keydown and by same-target re-syncs, so a genuinely stale
  // commit from a superseded document is rejected without stranding a live burst.
  function handleKeyboardNudgeCommit(targetId: string, revision: number): void {
    const burst = keyboardBurstRef.current;
    if (!burst || burst.targetId !== targetId || burst.revision !== revision) return;
    void flushKeyboardBurst();
  }

  function announceManualEditMovement(netDelta: { x: number; y: number }): void {
    const segments = manualEditMoveAnnouncementSegments(netDelta);
    if (segments.length === 0) return;
    if (manualEditAnnounceTimerRef.current) window.clearTimeout(manualEditAnnounceTimerRef.current);
    setManualEditMovementAnnouncement(segments);
    manualEditAnnounceTimerRef.current = window.setTimeout(() => {
      setManualEditMovementAnnouncement(null);
      manualEditAnnounceTimerRef.current = null;
    }, 1000);
  }

  // Cancels ONLY the active (open) burst and its preview. Completed bursts already
  // in the FIFO stay intact so they still drain — Escape on a later burst must not
  // discard an earlier completed move. Transition/failure paths clear the FIFO.
  // Escape callers pass latchHeldKeys: the cancelled burst's keys are physically
  // held, so repeats are swallowed until keyup instead of reopening a burst.
  function cancelKeyboardBurst(opts?: { latchHeldKeys?: boolean }): boolean {
    const burst = keyboardBurstRef.current;
    if (!burst) return false;
    if (opts?.latchHeldKeys) {
      for (const key of burst.heldKeys) keyboardBurstCancelledKeysRef.current.add(key);
    }
    const movement = activeManualEditMovementRef.current;
    if (movement && movement.session.targetId === burst.targetId) {
      previewStyleToIframe(
        burst.targetId,
        { translate: burst.startBaseline },
        nextManualEditPreviewVersion(),
      );
      activeManualEditMovementRef.current = null;
    }
    keyboardBurstRef.current = null;
    manualEditOptimisticTranslateRef.current = null;
    return true;
  }

  // Ends the open keyboard burst: net-zero -> cancel; a prior burst's save still
  // in flight -> push the COMPLETED result onto the FIFO (each distinct burst
  // drains as its own write, in order); otherwise commit it now. Awaitable so
  // transitions can finalize the burst before proceeding.
  async function flushKeyboardBurst(): Promise<boolean> {
    const burst = keyboardBurstRef.current;
    if (!burst) return false;
    const result = burst.lastResult;
    if (!result || isManualEditNudgeNetZero(burst.netDelta)) {
      cancelKeyboardBurst();
      return false;
    }
    keyboardBurstRef.current = null;
    const committedDelta = burst.netDelta;
    if (manualEditSavingRef.current) {
      // A prior save is still running: enqueue this completed burst; it commits
      // when that save drains. Every distinct burst stays its own write, in order.
      keyboardBurstQueueRef.current.push({ result, netDelta: committedDelta, startBaseline: burst.startBaseline });
      return false;
    }
    const label = activeManualEditMovementRef.current?.label ?? 'Style: move';
    if (activeManualEditMovementRef.current?.session.targetId === burst.targetId) {
      activeManualEditMovementRef.current = null;
    }
    await commitBurstResult(result, committedDelta, burst.startBaseline, label);
    return true;
  }

  // Persists ONE completed burst result — from a direct flush or a FIFO drain — as
  // a single write. Success updates selection/draft/persisted/optimistic and
  // announces; failure reverts to the last persisted translate and discards the
  // fallout (the FIFO and any open burst baselined off the failed move).
  async function commitBurstResult(
    result: ManualEditMovementResult,
    committedDelta: { x: number; y: number },
    startBaseline: string,
    label: string,
  ): Promise<void> {
    const ok = await applyManualEdit(
      { id: result.targetId, kind: 'set-style', styles: result.styles },
      label,
    );
    if (ok) {
      cancelManualEditPendingStyles(result.targetId, ['translate']);
      setSelectedManualEditTarget((current) => {
        if (!current || current.id !== result.targetId) return current;
        return { ...current, styles: { ...current.styles, ...result.styles } };
      });
      if (selectedManualEditTargetIdRef.current === result.targetId) {
        setManualEditDraft((current) => ({
          ...current,
          styles: { ...current.styles, ...result.styles },
        }));
      }
      lastPersistedTranslateRef.current = result.styles.translate ?? startBaseline;
      // Do NOT advance the optimistic baseline here. The live iframe already shows
      // the newest previewed position (previewKeyboardBurst set optimistic to it),
      // which for a FIFO drain is a LATER burst than this (older) committed result.
      // Rewinding optimistic to this result would make the next burst baseline off
      // a stale translate and drop movement. optimistic is cleared on selection
      // change and reset to the persisted value on failure.
      announceManualEditMovement(committedDelta);
    } else {
      const persisted = lastPersistedTranslateRef.current ?? startBaseline;
      previewStyleToIframe(result.targetId, { translate: persisted }, nextManualEditPreviewVersion());
      manualEditOptimisticTranslateRef.current = persisted || null;
      keyboardBurstQueueRef.current = [];
      const open = keyboardBurstRef.current as KeyboardBurst | null;
      if (open && open.targetId === result.targetId) {
        keyboardBurstRef.current = null;
        if (activeManualEditMovementRef.current?.session.targetId === open.targetId) {
          activeManualEditMovementRef.current = null;
        }
      }
    }
  }

  function dropActiveManualEditMovementForSourceRefresh(snapshot?: string): void {
    if (snapshot === undefined) {
      // Wait for the fetched source before deciding whether this is a real
      // document replacement. The watcher often echoes the current save.
      manualEditSourceRefreshPendingRef.current = true;
      return;
    }
    if (snapshot === manualEditInFlightSourceRef.current || snapshot === sourceRef.current) return;
    // A source refresh replaces the document beneath any open keyboard burst:
    // tear the burst (and any queued-but-undrained commits) down so a late
    // keyup cannot write pre-refresh movement into the new document.
    cancelKeyboardBurst();
    keyboardBurstQueueRef.current = [];
    if (activeManualEditMovementRef.current) cancelManualEditMovement();
    if (!manualEditModeRef.current) return;
    const invalidThrough = nextManualEditPreviewVersion();
    manualEditPreviewAckVersionRef.current = invalidThrough;
    manualEditResizeFeedbackInvalidThroughVersionRef.current = invalidThrough;
    setManualEditResizeFeedback(null);
    refreshManualEditDocument(snapshot);
  }

  async function flushManualEditStyleSave(): Promise<boolean> {
    const pending = manualEditPendingStyleRef.current;
    if (!pending) return true;
    if (manualEditSavingRef.current) return false;
    const ok = await applyManualEdit({ id: pending.id, kind: 'set-style', styles: pending.styles }, pending.label);
    // Only clear if a newer edit hasn't already replaced this pending entry
    // while the save was in flight.
    if (ok && manualEditPendingStyleRef.current === pending) {
      manualEditPendingStyleRef.current = null;
    }
    return ok;
  }

  function cancelManualEditStyleDraft() {
    const pending = manualEditPendingStyleRef.current;
    if (!pending) return;
    manualEditPendingStyleRef.current = null;
    const base = sourceRef.current ?? '';
    const target = pending.id === '__body__'
      ? null
      : selectedManualEditTarget?.id === pending.id
        ? selectedManualEditTarget
        : manualEditTargets.find((item) => item.id === pending.id) ?? null;
    const sourceStyles = target
      ? inspectorManualEditStyles(target, base)
      : readManualEditStyles(base, pending.id);
    const resetStyles = MANUAL_EDIT_STYLE_PROPS.reduce<Partial<ManualEditStyles>>((acc, key) => {
      acc[key] = sourceStyles[key] ?? '';
      return acc;
    }, {});
    previewStyleToIframe(pending.id, resetStyles, nextManualEditPreviewVersion(), true);
    if (!target || target.id === selectedManualEditTarget?.id) {
      setManualEditDraft((current) => ({
        ...current,
        styles: target ? sourceStyles : current.styles,
        fullSource: base,
      }));
    }
    setManualEditError(null);
  }

  function runManualEditPostSaveIntent(intent: ManualEditPostSaveIntent) {
    if (intent.seq !== manualEditActionSeqRef.current) return;
    manualEditPendingDuplicateSelectionRef.current = null;
    if (intent.kind === 'select') {
      void selectManualEditTarget(intent.target, intent.seq);
    } else if (intent.kind === 'clear') {
      void clearManualEditTargetSelection({ openPageStyles: intent.openPageStyles }, intent.seq);
    } else {
      void exitManualEditModeAfterFlush(intent.seq);
    }
  }

  async function exitManualEditModeAfterFlush(actionSeq = ++manualEditActionSeqRef.current): Promise<boolean> {
    await flushKeyboardBurst();
    if (manualEditSavingRef.current) {
      manualEditPostSaveIntentRef.current = { seq: actionSeq, kind: 'exit' };
      return false;
    }
    cancelManualEditMovement();
    const ok = await flushManualEditStyleSave();
    if (actionSeq !== manualEditActionSeqRef.current) return false;
    if (!ok) return false;
    iframeRef.current?.contentWindow?.postMessage({ type: 'readable-edit-click-cancel' } satisfies ManualEditActivationMessage, '*');
    setManualEditMode(false);
    return true;
  }

  // Clears the hover affordance and re-arms the iframe's per-element hover
  // dedupe so re-entering the same element re-announces it. Called from the
  // workspace's own mouseleave (host-side), NOT the iframe's mouseleave — the
  // affordance overlays the iframe, so reacting to the iframe leaving would
  // yank it out from under the cursor and strobe on/off.
  function clearManualEditHover() {
    if (!manualEditHoverTarget) return;
    setManualEditHoverTarget(null);
    const win = iframeRef.current?.contentWindow;
    if (win) win.postMessage({ type: 'readable-edit-hover-reset' }, '*');
  }

  async function selectManualEditTarget(target: ManualEditTarget, actionSeq = ++manualEditActionSeqRef.current) {
    manualEditPendingDuplicateSelectionRef.current = null;
    await flushKeyboardBurst();
    manualEditPostSaveIntentRef.current = null;
    clearManualEditResizeFeedback();
    clearManualEditMovement();
    if (manualEditSavingRef.current) {
      manualEditPostSaveIntentRef.current = { seq: actionSeq, kind: 'select', target };
      return;
    }
    cancelManualEditMovement();
    if (manualEditPendingStyleRef.current?.id !== target.id) {
      const ok = await flushManualEditStyleSave();
      if (actionSeq !== manualEditActionSeqRef.current) return;
      if (!ok) return;
    }
    if (actionSeq !== manualEditActionSeqRef.current) return;
    setManualEditPageStylesOpen(false);
    const base = sourceRef.current ?? '';
    const fields = readManualEditFields(base, target.id);
    selectedManualEditTargetIdRef.current = target.id;
    selectedManualEditTargetRef.current = target;
    setSelectedManualEditTarget(target);
    // A genuine new selection re-snapshots the panel's placement anchor. This
    // is the single funnel for readable-edit-select, the panel's onSelectTarget,
    // and the hover-affordance click — none of them call setSelectedManualEditTarget directly.
    // Text/link land in the caret (PPT click-into-textbox); everything else is
    // object-selected so the whole box is a move surface.
    setManualEditMoveMode(target.kind === 'text' || target.kind === 'link' ? 'editing' : 'selected');
    setManualEditDraft({
      text: fields.text ?? target.fields.text ?? target.text,
      href: fields.href ?? target.fields.href ?? '',
      src: fields.src ?? target.fields.src ?? '',
      alt: fields.alt ?? target.fields.alt ?? '',
      styles: inspectorManualEditStyles(target, base),
      attributesText: JSON.stringify(readManualEditAttributes(base, target.id), null, 2),
      outerHtml: readManualEditOuterHtml(base, target.id) || target.outerHtml,
      fullSource: base,
    });
    setManualEditError(null);
  }

  async function clearManualEditTargetSelection(
    options: { openPageStyles?: boolean } = {},
    actionSeq = ++manualEditActionSeqRef.current,
  ): Promise<boolean> {
    manualEditPendingDuplicateSelectionRef.current = null;
    await flushKeyboardBurst();
    clearManualEditResizeFeedback();
    clearManualEditMovement();
    if (manualEditSavingRef.current) {
      manualEditPostSaveIntentRef.current = { seq: actionSeq, kind: 'clear', openPageStyles: !!options.openPageStyles };
      return false;
    }
    cancelManualEditMovement();
    const ok = await flushManualEditStyleSave();
    if (actionSeq !== manualEditActionSeqRef.current) return false;
    if (!ok) return false;
    if (actionSeq !== manualEditActionSeqRef.current) return false;
    selectedManualEditTargetIdRef.current = null;
    selectedManualEditTargetRef.current = null;
    setSelectedManualEditTarget(null);
    setManualEditDraft(emptyManualEditDraft(sourceRef.current ?? ''));
    setManualEditError(null);
    setManualEditRichFormat({ editing: false, hasSelection: false, bold: false, italic: false, underline: false });
    if (options.openPageStyles) setManualEditPageStylesOpen(true);
    return true;
  }

  // The inspector is scoped to one element (or the page). Closing it should
  // only collapse the panel and keep the user in edit mode — exiting edit is
  // the toolbar toggle's job. Dismiss flushes any in-flight tweak first so
  // nothing is lost; cancel reverts the in-flight unsaved tweak instead.
  async function dismissManualEditPanel() {
    const ok = await flushManualEditStyleSave();
    if (!ok) return;
    setManualEditPageStylesOpen(false);
  }

  function cancelManualEditPanel() {
    cancelManualEditStyleDraft();
    setManualEditPageStylesOpen(false);
  }

  async function applyManualEdit(patch: ManualEditPatch, label: string): Promise<boolean> {
    if (manualEditSavingRef.current) return false;
    if (sourceRef.current == null) return false;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    setManualEditError(null);
    let saveOk = false;
    try {
      const sourceKey = manualEditSourceKey;
      const baseSource = sourceRef.current;
      const result = applyManualEditPatch(baseSource, patch);
      if (!result.ok) {
        setManualEditError(result.error ?? 'Could not apply edit.');
        return false;
      }
      if (!(await confirmManualEditHistorySource(
        baseSource,
        'The file changed outside manual edit mode. Refreshing before applying manual edits.',
        sourceKey,
      ))) return false;
      let expectedContentSha256: string;
      try {
        expectedContentSha256 = await sha256Hex(baseSource);
      } catch (error) {
        setManualEditError(error instanceof Error ? error.message : 'Could not verify the source before saving.');
        return false;
      }
      if (!isCurrentManualEditSource(sourceKey)) return false;
      manualEditInFlightSourceRef.current = result.source;
      let saved: Awaited<ReturnType<typeof writeProjectTextFileDetailed>>;
      try {
        saved = await writeProjectTextFileDetailed(projectId, file.name, result.source, {
          artifactManifest: file.artifactManifest,
          expectedContentSha256,
        });
      } catch (error) {
        manualEditInFlightSourceRef.current = null;
        throw error;
      }
      if (!isCurrentManualEditSource(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return false;
      }
      if (!saved.ok) {
        manualEditInFlightSourceRef.current = null;
        if ('conflict' in saved && saved.conflict) {
          setManualEditError('The file changed outside Manual Edit. Refresh the preview before applying this edit.');
          return false;
        }
        const status = 'status' in saved ? saved.status : undefined;
        const code = 'code' in saved ? saved.code : undefined;
        const message = 'message' in saved ? saved.message : 'Unknown save error';
        setManualEditError(
          `Could not save the edited file${status ? ` (${status}${code ? ` ${code}` : ''})` : ''}: ${message}`,
        );
        return false;
      }
      const sourceAfterSave = sourceRef.current;
      if (!recordManualEditSourceCommit(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return false;
      }
      manualEditInFlightSourceRef.current = null;
      // The source write is the durable commit point. Preview refresh is a
      // follow-up and must never make a successful write look like a failed
      // edit or cause its history entry to be lost.
      saveOk = true;
      const entry: ManualEditHistoryEntry = {
        id: `${Date.now()}-${manualEditHistory.length}`,
        label,
        patch,
        beforeSource: baseSource,
        afterSource: result.source,
        createdAt: Date.now(),
        ...(patch.kind === 'duplicate-and-move'
          ? { selectionIntent: { beforeId: patch.id, afterId: patch.plan.duplicateRootId } }
          : {}),
      };
      if (sourceAfterSave != null && sourceAfterSave !== baseSource && sourceAfterSave !== result.source) {
        replaceManualEditSource(
          sourceAfterSave,
          'The file changed outside Manual Edit. Refresh the preview before applying this edit.',
        );
        return false;
      }
      setSource(result.source);
      sourceRef.current = result.source;
      setInlinedSource(null);
      if (patch.kind !== 'set-style') {
        setManualEditFrozenSource(result.source);
      }
      setManualEditHistory((current) => [entry, ...current]);
      setManualEditUndone([]);
      setManualEditDraft((current) => ({ ...current, fullSource: result.source }));
      if (patch.kind === 'set-text') {
        setSelectedManualEditTarget((current) => current?.id === patch.id
          ? { ...current, text: patch.value, fields: { ...current.fields, text: patch.value } }
          : current);
      } else if (patch.kind === 'remove-element') {
        if (manualEditPendingStyleRef.current?.id === patch.id) {
          manualEditPendingStyleRef.current = null;
        }
        selectedManualEditTargetIdRef.current = null;
        selectedManualEditTargetRef.current = null;
        setSelectedManualEditTarget(null);
        clearManualEditResizeFeedback();
        clearManualEditMovement();
        setManualEditTargets((current) => current.filter((target) => target.id !== patch.id));
        setManualEditDraft(emptyManualEditDraft(result.source));
        postSelectedManualEditTargetToIframe(null);
      } else {
        setManualEditDraft((current) => ({ ...current, fullSource: result.source }));
      }
      if (patch.kind === 'set-style') {
        reconcileManualEditStyleSave(patch.id, patch.styles, result.source);
        // Track the last persisted translate for the selected target so a later
        // failed keyboard save reverts to it. Covers EVERY translate write —
        // keyboard commit, pointer-drag commit, and inspector direct move.
        if (patch.styles.translate !== undefined && selectedManualEditTargetRef.current?.id === patch.id) {
          lastPersistedTranslateRef.current = patch.styles.translate;
        }
      }
      setManualEditError(null);
      try {
        await onFileSaved?.();
      } catch {
        setManualEditError('Saved the edit, but the preview could not be refreshed.');
      }
      return true;
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
      if (manualEditPostSaveIntentRef.current) {
        window.setTimeout(() => {
          const intent = manualEditPostSaveIntentRef.current;
          if (!intent) return;
          manualEditPostSaveIntentRef.current = null;
          runManualEditPostSaveIntent(intent);
        }, 0);
      }
      // Commit the burst queued behind this save as its own write. A still-OPEN
      // burst (keys held) is NOT queued, so a held burst spanning a save commits
      // once on its own keyup. On failure nothing drains here: the failed commit
      // already discarded the queue (its entries baselined off the failed move).
      if (saveOk) {
        const next = keyboardBurstQueueRef.current.shift();
        if (next) void commitBurstResult(next.result, next.netDelta, next.startBaseline, 'Style: move');
      }
    }
  }

  async function confirmManualEditHistorySource(
    expectedSource: string,
    message: string,
    sourceKey: string,
  ): Promise<boolean> {
    const persisted = await fetchProjectFileText(projectId, file.name, {
      cache: 'no-store',
      cacheBustKey: Date.now(),
    });
    if (!isCurrentManualEditSource(sourceKey)) return false;
    if (persisted == null) return true;
    if (persisted === expectedSource) return true;
    replaceManualEditSource(persisted, message);
    return false;
  }

  function replaceManualEditSource(source: string, message: string) {
    setSource(source);
    sourceRef.current = source;
    setInlinedSource(null);
    setManualEditHistory([]);
    setManualEditUndone([]);
    manualEditPendingStyleRef.current = null;
    setManualEditDraft((current) => ({ ...current, fullSource: source }));
    setManualEditError(message);
  }

  function isCurrentManualEditSource(sourceKey: string): boolean {
    return sourceKey === manualEditSourceKeyRef.current;
  }

  function recordManualEditSourceCommit(sourceKey: string): boolean {
    if (!isCurrentManualEditSource(sourceKey)) return false;
    manualEditSaveGenerationRef.current += 1;
    return true;
  }

  function refreshManualEditDocument(snapshot: string) {
    capturePreviewScrollPosition();
    setManualEditFrozenSource(snapshot);
    setManualEditDocumentRevision((revision) => revision + 1);
  }

  function runNextQueuedManualEditHistory() {
    const direction = manualEditHistoryQueueRef.current.shift();
    if (!direction) return;
    window.setTimeout(() => {
      if (direction === 'undo') void undoManualEditRef.current();
      else void redoManualEditRef.current();
    }, 0);
  }

  async function undoManualEdit() {
    await flushKeyboardBurst();
    if (manualEditSavingRef.current) {
      if (manualEditHistoryOperationRef.current) manualEditHistoryQueueRef.current.push('undo');
      return;
    }
    const [latest, ...rest] = manualEditHistory;
    if (!latest) {
      runNextQueuedManualEditHistory();
      return;
    }
    clearManualEditResizeFeedback();
    clearManualEditMovement();
    manualEditSavingRef.current = true;
    manualEditHistoryOperationRef.current = true;
    setManualEditSaving(true);
    try {
      const sourceKey = manualEditSourceKey;
      if (!(await confirmManualEditHistorySource(
        latest.afterSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
        sourceKey,
      ))) return;
      let expectedContentSha256: string;
      try {
        expectedContentSha256 = await sha256Hex(latest.afterSource);
      } catch (error) {
        setManualEditError(error instanceof Error ? error.message : 'Could not verify the source before undoing.');
        return;
      }
      if (!isCurrentManualEditSource(sourceKey)) return;
      manualEditInFlightSourceRef.current = latest.beforeSource;
      let saved: Awaited<ReturnType<typeof writeProjectTextFile>>;
      try {
        saved = await writeProjectTextFile(projectId, file.name, latest.beforeSource, {
          artifactManifest: file.artifactManifest,
          expectedContentSha256,
        });
      } catch (error) {
        manualEditInFlightSourceRef.current = null;
        throw error;
      }
      if (!isCurrentManualEditSource(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return;
      }
      if (!saved) {
        manualEditInFlightSourceRef.current = null;
        setManualEditError('Could not save the undo result.');
        return;
      }
      const sourceAfterSave = sourceRef.current;
      if (!recordManualEditSourceCommit(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return;
      }
      manualEditInFlightSourceRef.current = null;
      if (
        latest.selectionIntent
        && selectedManualEditTargetIdRef.current === latest.selectionIntent.afterId
      ) {
        manualEditPendingDuplicateSelectionRef.current = {
          id: latest.selectionIntent.beforeId,
          ownerId: latest.selectionIntent.afterId,
          seq: manualEditActionSeqRef.current,
        };
      }
      if (sourceAfterSave != null && sourceAfterSave !== latest.afterSource && sourceAfterSave !== latest.beforeSource) {
        replaceManualEditSource(
          sourceAfterSave,
          'The file changed outside Manual Edit. Refresh the preview before undoing.',
        );
        return;
      }
      setSource(latest.beforeSource);
      sourceRef.current = latest.beforeSource;
      setInlinedSource(null);
      refreshManualEditDocument(latest.beforeSource);
      setManualEditHistory(rest);
      setManualEditUndone((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.beforeSource }));
      try {
        await onFileSaved?.();
      } catch {
        setManualEditError('Saved the undo result, but the preview could not be refreshed.');
      }
    } finally {
      manualEditSavingRef.current = false;
      manualEditHistoryOperationRef.current = false;
      setManualEditSaving(false);
      if (manualEditPostSaveIntentRef.current) {
        window.setTimeout(() => {
          const intent = manualEditPostSaveIntentRef.current;
          if (!intent) return;
          manualEditPostSaveIntentRef.current = null;
          runManualEditPostSaveIntent(intent);
        }, 0);
      }
      runNextQueuedManualEditHistory();
    }
  }

  async function redoManualEdit() {
    await flushKeyboardBurst();
    if (manualEditSavingRef.current) {
      if (manualEditHistoryOperationRef.current) manualEditHistoryQueueRef.current.push('redo');
      return;
    }
    const [latest, ...rest] = manualEditUndone;
    if (!latest) {
      runNextQueuedManualEditHistory();
      return;
    }
    clearManualEditResizeFeedback();
    clearManualEditMovement();
    manualEditSavingRef.current = true;
    manualEditHistoryOperationRef.current = true;
    setManualEditSaving(true);
    try {
      const sourceKey = manualEditSourceKey;
      if (!(await confirmManualEditHistorySource(
        latest.beforeSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
        sourceKey,
      ))) return;
      let expectedContentSha256: string;
      try {
        expectedContentSha256 = await sha256Hex(latest.beforeSource);
      } catch (error) {
        setManualEditError(error instanceof Error ? error.message : 'Could not verify the source before redoing.');
        return;
      }
      if (!isCurrentManualEditSource(sourceKey)) return;
      manualEditInFlightSourceRef.current = latest.afterSource;
      let saved: Awaited<ReturnType<typeof writeProjectTextFile>>;
      try {
        saved = await writeProjectTextFile(projectId, file.name, latest.afterSource, {
          artifactManifest: file.artifactManifest,
          expectedContentSha256,
        });
      } catch (error) {
        manualEditInFlightSourceRef.current = null;
        throw error;
      }
      if (!isCurrentManualEditSource(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return;
      }
      if (!saved) {
        manualEditInFlightSourceRef.current = null;
        setManualEditError('Could not save the redo result.');
        return;
      }
      const sourceAfterSave = sourceRef.current;
      if (!recordManualEditSourceCommit(sourceKey)) {
        manualEditInFlightSourceRef.current = null;
        return;
      }
      manualEditInFlightSourceRef.current = null;
      if (
        latest.selectionIntent
        && selectedManualEditTargetIdRef.current === latest.selectionIntent.beforeId
      ) {
        manualEditPendingDuplicateSelectionRef.current = {
          id: latest.selectionIntent.afterId,
          ownerId: latest.selectionIntent.beforeId,
          seq: manualEditActionSeqRef.current,
        };
      }
      if (sourceAfterSave != null && sourceAfterSave !== latest.beforeSource && sourceAfterSave !== latest.afterSource) {
        replaceManualEditSource(
          sourceAfterSave,
          'The file changed outside Manual Edit. Refresh the preview before redoing.',
        );
        return;
      }
      setSource(latest.afterSource);
      sourceRef.current = latest.afterSource;
      setInlinedSource(null);
      refreshManualEditDocument(latest.afterSource);
      setManualEditUndone(rest);
      setManualEditHistory((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.afterSource }));
      try {
        await onFileSaved?.();
      } catch {
        setManualEditError('Saved the redo result, but the preview could not be refreshed.');
      }
    } finally {
      manualEditSavingRef.current = false;
      manualEditHistoryOperationRef.current = false;
      setManualEditSaving(false);
      if (manualEditPostSaveIntentRef.current) {
        window.setTimeout(() => {
          const intent = manualEditPostSaveIntentRef.current;
          if (!intent) return;
          manualEditPostSaveIntentRef.current = null;
          runManualEditPostSaveIntent(intent);
        }, 0);
      }
      runNextQueuedManualEditHistory();
    }
  }

  // Inspect-mode picker: same `readable-studio:comment-target` payload, different sink.
  // The bridge tags the message with a computed-style snapshot so the panel
  // can show real starting values for color / typography / spacing / radius.
  useEffect(() => {
    if (!inspectMode) return;
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            elementId?: string;
            selector?: string;
            label?: string;
            text?: string;
            style?: InspectStyleSnapshot;
            clickedDescendant?: Partial<InspectClickedDescendant>;
          }
        | null;
      if (!data || data.type !== 'readable-studio:comment-target') return;
      if (!data.elementId || !data.selector) return;
      const clickedDescendant =
        data.clickedDescendant && typeof data.clickedDescendant === 'object'
          ? {
              label: String(data.clickedDescendant.label || ''),
              text: String(data.clickedDescendant.text || ''),
            }
          : null;
      setActiveInspectTarget({
        elementId: String(data.elementId),
        selector: String(data.selector),
        label: String(data.label || ''),
        text: String(data.text || ''),
        style: data.style && typeof data.style === 'object' ? data.style : {},
        ...(clickedDescendant ? { clickedDescendant } : {}),
      });
      setInspectError(null);
      setInspectSavedAt(null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, isOurPreviewIframeSource]);

  function postSlide(action: 'next' | 'prev' | 'first' | 'last') {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'readable-studio:slide', action }, '*');
  }

  function syncCachedSlideStateToIframe(target: HTMLIFrameElement | null = iframeRef.current) {
    const active = htmlPreviewSlideState.get(previewStateKey)?.active;
    const win = target?.contentWindow;
    if (!win || typeof active !== 'number') return;
    win.postMessage({ type: 'readable-studio:slide', action: 'go', index: active }, '*');
  }

  function postInspectSet(elementId: string, selector: string, prop: string, value: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { type: 'readable-studio:inspect-set', elementId, selector, prop, value },
      '*',
    );
  }

  function postInspectReset(elementId?: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'readable-studio:inspect-reset', elementId }, '*');
  }

  // Replay the host's authoritative override map into the freshly loaded
  // iframe. The bridge inside the iframe only sees rules persisted in the
  // artifact source via its own hydrateOverridesFromDom() — any unsaved
  // edit lives on the host side until Save-to-source. Without this replay,
  // toggling Inspect off/on, switching to Comment mode, or any other
  // srcdoc rebuild reloads the iframe from previewSource without the
  // unsaved style block, so the preview drops the live edits while
  // saveInspectToSource() can still persist them later from the stale
  // host map. The bridge re-validates each entry under its own allow-list,
  // so a parent that posted a hostile replay can only land overrides the
  // bridge would also have accepted via readable-studio:inspect-set.
  //
  // The render-time hydration above keeps `inspectOverrides` aligned with
  // the current `source` whenever React commits, but the iframe `onLoad`
  // callback fires from a separate event-loop turn after the new srcDoc
  // is parsed; if it ever races a stale closure (e.g. an interleaved
  // remount), reading React state would post the previous file's map over
  // the bridge's DOM-hydrated one and silently strip the persisted styles
  // from preview. Re-derive synchronously from `source` whenever the
  // hydration ref disagrees so onLoad never sends a stale snapshot.
  function replayInspectOverridesToIframe(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    const overrides = inspectHydratedSourceRef.current === source
      ? inspectOverrides
      : (typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
    win.postMessage({ type: 'readable-studio:inspect-replay', overrides }, '*');
  }

  // Persist accumulated inspect overrides into the artifact source: replace
  // (or insert) a single <style data-readable-inspect-overrides> block in <head>.
  // The CSS body is serialized from the host's own override map, hydrated
  // from source on load and updated only by host-driven onApply / reset
  // callbacks. We deliberately do NOT round-trip through the iframe at save
  // time: artifact JS rendered inside the preview shares the same
  // contentWindow as the bridge and could forge an readable-studio:inspect-overrides
  // reply that flips allow-listed properties on elements the user never
  // touched. POSTing to /api/projects/:id/files upserts the file via
  // writeProjectFile (multipart-or-JSON; we use JSON).
  async function saveInspectToSource() {
    if (!source) return;
    setSavingInspect(true);
    setInspectError(null);
    try {
      const css = serializeInspectOverrides(inspectOverrides).trim();
      const next = applyInspectOverridesToSource(source, css);
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: next }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(payload?.error || payload?.message || `Save failed (${resp.status})`);
      }
      setSource(next);
      setInspectSavedAt(Date.now());
      setReloadKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setInspectError(msg);
      // The error banner inside the inspect panel is easy to miss when the
      // user is focused on the iframe preview — surface failures in the
      // console as well so quota/network errors aren't silently lost.
      console.error('[inspect] saveToSource failed:', err);
    } finally {
      setSavingInspect(false);
    }
  }

  // Keyboard nav on the host, so the user can press ←/→ even when focus
  // is on the chat composer or any other host control.
  useEffect(() => {
    if (!effectiveDeck || mode !== 'preview') return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
        // Arrows owned by a focused selected-object surface nudge the object, not
        // the deck. The host capture listener already stops those, but yield
        // explicitly so intent survives any listener-order change.
        if (target.closest('[data-readable-edit-selected-surface]')) return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        postSlide('next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        postSlide('prev');
      } else if (e.key === 'Home') {
        e.preventDefault();
        postSlide('first');
      } else if (e.key === 'End') {
        e.preventDefault();
        postSlide('last');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveDeck, mode]);

  // Host-level undo/redo for manual edits. The undo/redo logic already rewrites
  // the file (see undoManualEdit / redoManualEdit); this surfaces it through the
  // platform-standard Ctrl/Cmd+Z (and Shift+… / Ctrl+Y for redo). We read the
  // latest handlers through refs so the listener never goes stale between
  // renders, and skip events from text fields / contenteditable so typing-undo
  // inside an inline editor or any input keeps its native meaning.
  undoManualEditRef.current = undoManualEdit;
  redoManualEditRef.current = redoManualEdit;
  useEffect(() => {
    if (!manualEditMode) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        // `isContentEditable` is the primary signal, but a custom contentEditable
        // host (or a non-reflecting engine) may not expose it; fall back to the
        // attribute so typing-undo inside any editable host keeps its meaning.
        const inEditableHost = typeof target.closest === 'function'
          && target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable || inEditableHost) return;
      }
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) void redoManualEditRef.current();
        else void undoManualEditRef.current();
      } else if (key === 'y' && !e.shiftKey) {
        e.preventDefault();
        void redoManualEditRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manualEditMode]);

  // Host Esc ladder: with an object-selected element, Esc deselects (like
  // clicking empty canvas). The editing→selected Esc is handled inside the
  // iframe (the move frame promotes on the resulting editing:false broadcast);
  // a mid-drag Esc is swallowed by the move frame's own handler. NOTE: the
  // second Esc may not fire when focus is trapped in the iframe post-edit —
  // empty-canvas click is the reliable deselect (no focus-juggling for v1).
  useEffect(() => {
    if (!manualEditMode || !selectedManualEditTarget || manualEditMoveMode !== 'selected') return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (cancelKeyboardBurst({ latchHeldKeys: true })) {
        e.preventDefault();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      void clearManualEditTargetSelection();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manualEditMode, selectedManualEditTarget, manualEditMoveMode]);

  // A keyboard burst must also end where the browser can no longer deliver the
  // keyup: window blur and tab visibility loss strand physically held keys, so
  // the open burst finalizes there once instead of leaking into the next
  // interaction. flushKeyboardBurst no-ops when no burst is open.
  useEffect(() => {
    if (!manualEditMode) return;
    function onWindowBlur() {
      void flushKeyboardBurst();
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') void flushKeyboardBurst();
    }
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [manualEditMode]);

  // Host-side arrow-key nudge ownership: when focus is on the selected-object
  // overlay surface, drive object movement from the host so deck/other host
  // listeners never see the arrow. Scoped to the surface so arrows elsewhere
  // (e.g. deck nav with no overlay focus) keep their meaning. Capture phase runs
  // before host buttons/menus. Blocked targets (inputs, contenteditable, ARIA
  // widgets, IME composition) keep native behavior. keyup ends the burst.
  useEffect(() => {
    if (!manualEditMode || !selectedManualEditTarget) return;
    // Object-selected overlays own arrows; editing-mode overlays (a text/link
    // target selected to its ring, with no active inline session) own them too
    // — matching the iframe adapter, which nudges any selected object.
    if (manualEditMoveMode !== 'selected' && (manualEditMoveMode !== 'editing' || manualEditRichFormat.editing)) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!isManualEditNudgeKey(e.key)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-readable-edit-selected-surface]')) return;
      if (isManualEditNudgeBlocked(e.target, { isComposing: e.isComposing })) return;
      // Prove ownership BEFORE consuming the event: if a pointer drag owns the
      // movement session (or nothing is selected), leave the arrow untouched.
      if (!selectedManualEditTargetRef.current) return;
      if (activeManualEditMovementRef.current?.session.source === 'pointer') return;
      if (keyboardBurstCancelledKeysRef.current.has(e.key)) {
        // Browser repeats of a key whose burst Escape just cancelled: consumed
        // (the overlay owns arrows) but never nudged, until the real keyup.
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      // stopImmediatePropagation so no other host listener (deck nav, any other
      // capture listener) can also act on an owned arrow key.
      e.stopImmediatePropagation();
      handleKeyboardNudge(manualEditNudgeDelta(e.key), e.key);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (!isManualEditNudgeKey(e.key)) return;
      // Releasing a latched key only ends the latch; it never ends a burst.
      if (keyboardBurstCancelledKeysRef.current.delete(e.key)) return;
      handleKeyboardNudgeKeyUp(e.key);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [manualEditMode, selectedManualEditTarget, manualEditMoveMode, manualEditRichFormat.editing]);

  useEffect(() => () => {
    if (manualEditAnnounceTimerRef.current) window.clearTimeout(manualEditAnnounceTimerRef.current);
  }, []);

  // Track whether the selected-object overlay surface owned focus right before a
  // target change or iframe reload, then restore it onto the new surface. This
  // keeps Arrow/Escape routed to the overlay after the iframe re-renders.
  useLayoutEffect(() => {
    return () => {
      if (!manualEditMode) return;
      // Recognize focus on ANY selected-object surface (the move frame OR the
      // resize handles, which coexist), not just the primary one.
      const active = document.activeElement;
      selectedObjectSurfaceHadFocusRef.current = active instanceof HTMLElement
        && active.closest('[data-readable-edit-selected-surface]') !== null;
    };
  }, [manualEditMode, selectedManualEditTarget?.id, manualEditMoveMode, manualEditDocumentRevision]);

  useEffect(() => {
    if (!selectedObjectSurfaceHadFocusRef.current) return;
    selectedObjectSurfaceHadFocusRef.current = false;
    const surface = document.querySelector<HTMLElement>('[data-readable-edit-primary-surface]')
      ?? document.querySelector<HTMLElement>('[data-readable-edit-selected-surface]');
    if (surface && typeof surface.focus === 'function') {
      surface.focus({ preventScroll: true });
    }
  }, [selectedManualEditTarget?.id, manualEditMoveMode, manualEditDocumentRevision]);

  useEffect(() => {
    if (!presentMenuOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.present-wrap')) return;
      setPresentMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresentMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [presentMenuOpen]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!zoomMenuRef.current) return;
      if (!zoomMenuRef.current.contains(e.target as Node)) setZoomMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    if (!agentToolsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.artifact-tool-menu-anchor')) return;
      closeArtifactToolMenus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArtifactToolMenus();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentToolsOpen]);

  useEffect(() => {
    if (!deployMenuOpen && !downloadMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!shareRef.current) return;
      if (shareRef.current.contains(e.target as Node)) return;
      setDeployMenuOpen(false);
      setDownloadMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDeployMenuOpen(false);
      setDownloadMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [deployMenuOpen, downloadMenuOpen]);

  useEffect(() => {
    if (!inTabPresent) return;
    const bodyStyle = document.body.style;
    const previousChromeHeight = bodyStyle.getPropertyValue('--workspace-tabs-chrome-height');
    const updateChromeHeight = () => {
      const chrome = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header');
      const height = chrome?.getBoundingClientRect().height ?? 0;
      if (height > 0) {
        bodyStyle.setProperty('--workspace-tabs-chrome-height', `${Math.round(height)}px`);
      } else {
        bodyStyle.removeProperty('--workspace-tabs-chrome-height');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInTabPresent(false);
    };
    updateChromeHeight();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updateChromeHeight);
    const chrome = document.querySelector<HTMLElement>('.workspace-tabs-chrome.app-chrome-header');
    const observer = chrome && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateChromeHeight) : null;
    if (observer && chrome) observer.observe(chrome);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updateChromeHeight);
      observer?.disconnect();
      if (previousChromeHeight) {
        bodyStyle.setProperty('--workspace-tabs-chrome-height', previousChromeHeight);
      } else {
        bodyStyle.removeProperty('--workspace-tabs-chrome-height');
      }
    };
  }, [inTabPresent]);

  function openInNewTab() {
    if (!source) return;
    openSandboxedPreviewInNewTab(source, exportTitle, {
      deck: effectiveDeck,
      baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
      initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
    });
  }

  // Snapshot this project as a reusable template. The daemon snapshots
  // EVERY html/text/code file in the project (not just the file open in
  // the viewer), so the template captures the whole design, not a single
  // page. Surfaced here in the Download menu because templates are saved
  // from the same artifact output surface as files.
  function openSaveAsTemplateModal() {
    setDownloadMenuOpen(false);
    const defaultName =
      file.name.replace(/\.html?$/i, '') || t('fileViewer.templateNameDefault');
    setTemplateName(defaultName);
    setTemplateDescription('');
    setTemplateSaveError(null);
    setTemplateModalOpen(true);
  }

  async function handleSaveAsTemplate() {
    const name = templateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    setTemplateNote(null);
    setTemplateSaveError(null);
    let savedName: string | null = null;
    try {
      const tpl = await saveTemplate({
        name,
        description: templateDescription.trim() || undefined,
        sourceProjectId: projectId,
      });
      if (!tpl) {
        setTemplateSaveError(t('fileViewer.savedTemplateFail'));
        return;
      }
      savedName = tpl.name;
      setTemplateModalOpen(false);
      setTemplateName('');
      setTemplateDescription('');
      setTemplateNote(t('fileViewer.savedTemplate', { name: tpl.name }));
      // Show success toast
      setTemplateSavedToast(t('fileViewer.savedTemplate', { name: tpl.name }));
    } finally {
      setSavingTemplate(false);
      if (savedName) {
        // Auto-clear the note so the menu doesn't keep stale state next open.
        setTimeout(() => setTemplateNote(null), 4000);
      }
    }
  }

  async function openDeployModal(nextProviderId: WebDeployProviderId = deployProviderId) {
    setDeployMenuOpen(false);
    setDeployModalOpen(true);
    setDeployError(null);
    setDeployActionToast(null);
    setCopiedDeployLink(null);
    setDeployPhase('idle');
    await loadDeployProvider(nextProviderId, { fallbackToExisting: true });
  }

  async function openSocialShareFlow() {
    const providerWithDeployment = DEPLOY_PROVIDER_OPTIONS.find(
      (option) => deploymentsByProvider[option.id]?.url?.trim(),
    )?.id;
    await openDeployModal(providerWithDeployment ?? deployProviderId);
  }

  async function changeDeployProvider(nextProviderId: WebDeployProviderId) {
    if (nextProviderId === deployProviderId) return;
    setDeployError(null);
    setDeployPhase('idle');
    await loadDeployProvider(nextProviderId);
  }

  async function saveDeployConfig() {
    setSavingDeployConfig(true);
    setDeployError(null);
    setDeployActionToast(null);
    try {
      if (deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID) {
        if (!deployToken.trim()) {
          setDeployActionToast(t('fileViewer.cloudflareApiTokenRequired'));
          deployTokenInputRef.current?.focus();
          return null;
        }
        if (!cloudflareAccountId.trim()) {
          throw new Error(t('fileViewer.cloudflareAccountIdRequired'));
        }
      }
      const config = await updateDeployConfig(buildDeployConfigRequest(deployProviderId));
      if (!config || config.providerId !== deployProviderId) {
        throw new Error(t('fileViewer.deployProviderConfigSaveFailed', { provider: deployProviderLabel }));
      }
      syncDeployFormFromConfig(deployProviderId, config);
      if (deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID) {
        await loadCloudflareZones(config);
      }
      return config;
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : t('fileViewer.deployProviderConfigSaveFailed', { provider: deployProviderLabel }));
      return null;
    } finally {
      setSavingDeployConfig(false);
    }
  }

  function buildCloudflarePagesDeploySelection(): WebCloudflarePagesDeploySelection | undefined {
    if (deployProviderId !== CLOUDFLARE_PAGES_PROVIDER_ID) return undefined;
    const prefix = normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix);
    if (!prefix) return undefined;
    if (!isValidCloudflareDomainPrefixInput(prefix)) {
      throw new Error(t('fileViewer.cloudflareDomainPrefixInvalid'));
    }
    const zone = cloudflareZones.find((item) => item.id === cloudflareZoneId);
    if (!zone) {
      throw new Error(t('fileViewer.cloudflareZoneRequired'));
    }
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domainPrefix: prefix,
    };
  }

  async function deployToSelectedProvider() {
    setDeploying(true);
    setDeployPhase('deploying');
    setDeployError(null);
    setDeployActionToast(null);
    setCopiedDeployLink(null);
    try {
      const cloudflarePagesSelection = buildCloudflarePagesDeploySelection();
      const typedToken = deployToken.trim();
      const hasNewToken = typedToken && typedToken !== deployConfig?.tokenMask;
      const cloudflareHints = cloudflareConfigHintsFromForm();
      const cloudflareHintsChanged = deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID && Boolean(
        cloudflareHints?.lastZoneId !== deployConfig?.cloudflarePages?.lastZoneId ||
        cloudflareHints?.lastZoneName !== deployConfig?.cloudflarePages?.lastZoneName ||
        cloudflareHints?.lastDomainPrefix !== deployConfig?.cloudflarePages?.lastDomainPrefix,
      );
      const needsConfigSave =
        hasNewToken ||
        teamId.trim() !== (deployConfig?.teamId || '') ||
        teamSlug.trim() !== (deployConfig?.teamSlug || '') ||
        cloudflareAccountId.trim() !== (deployConfig?.accountId || '') ||
        cloudflareHintsChanged ||
        !deployConfig?.configured;
      if (needsConfigSave) {
        const nextConfig = await saveDeployConfig();
        if (!nextConfig) return;
        if (!nextConfig?.configured) {
          const option = getDeployProviderOption(deployProviderId);
          throw new Error(t(option.tokenRequiredKey, { provider: t(option.labelKey) }));
        }
      }
      setDeployPhase('preparing-link');
      const next = await deployProjectFile(projectId, file.name, deployProviderId, cloudflarePagesSelection);
      setDeploymentsByProvider((current) => ({
        ...current,
        [next.providerId]: next,
      }));
      setDeployment(next);
      setDeployResult(next);
      if (deployResultState(next.status) !== 'failed') {
        setDeploySavedToast({
          message: t('fileViewer.deploySuccessToast'),
          details: t('fileViewer.deploySuccessToastDetails', {
            provider: deployProviderLabel,
            url: next.url,
          }),
        });
      }
    } catch (err) {
      const option = getDeployProviderOption(deployProviderId);
      const message = err instanceof Error
        ? err.message
        : t('fileViewer.deployProviderFailed', { provider: t(option.labelKey) });
      if (message === t(option.tokenRequiredKey, { provider: t(option.labelKey) })) {
        setDeployActionToast(message);
        deployTokenInputRef.current?.focus();
      } else {
        setDeployError(message);
      }
    } finally {
      setDeploying(false);
      setDeployPhase('idle');
    }
  }

  async function retryDeploymentLink() {
    const current = deployResult || deployment;
    if (!current?.id) return;
    setDeployError(null);
    setDeployPhase('preparing-link');
    try {
      const next = await checkDeploymentLink(projectId, current.id);
      setDeploymentsByProvider((items) => ({
        ...items,
        [next.providerId]: next,
      }));
      setDeployment(next);
      setDeployResult(next);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : t('fileViewer.deployFailed'));
    } finally {
      setDeployPhase('idle');
    }
  }

  async function copyDeployLink(url: string) {
    const safeUrl = url.trim();
    if (!safeUrl) return;
    try {
      await navigator.clipboard.writeText(safeUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = safeUrl;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedDeployLink(safeUrl);
    window.setTimeout(() => {
      setCopiedDeployLink((current) => (current === safeUrl ? null : current));
    }, 1800);
  }

  async function copyShareLink(url: string) {
    const safeUrl = url.trim();
    if (!safeUrl) {
      setShareLinkFeedback('failed');
      setExportToast({ message: t('useEverywhere.copyFailed'), tone: 'error' });
      return false;
    }
    const ok = await copyToClipboard(safeUrl);
    const feedback = ok ? 'copied' : 'failed';
    setShareLinkFeedback(feedback);
    if (!ok) setExportToast({ message: t('useEverywhere.copyFailed'), tone: 'error' });
    window.setTimeout(() => {
      setShareLinkFeedback((current) => (current === feedback ? null : current));
    }, 1800);
    return ok;
  }

  function presentInThisTab() {
    setPresentMenuOpen(false);
    setMode('preview');
    setInTabPresent(true);
  }

  function presentFullscreen() {
    setPresentMenuOpen(false);
    const el = previewBodyRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      el.requestFullscreen().catch(() => setInTabPresent(true));
    } else {
      setInTabPresent(true);
    }
  }

  function presentNewTab() {
    setPresentMenuOpen(false);
    openInNewTab();
  }

  function reloadHtmlPreview() {
    if (manualEditMode) clearManualEditMovement();
    fireArtifactToolbarClick('reload');
    capturePreviewScrollPosition();
    imageExportSnapshotDataUrlRef.current = null;
    setInlinedSource(null);
    setReloadKey((key) => key + 1);
    if (!useUrlLoadPreview) {
      activatedSrcDocTransportHtmlRef.current = null;
      setSrcDocShellReady(false);
      setSrcDocTransportResetKey((key) => key + 1);
    }
  }

  function selectMode(nextMode: 'preview' | 'source') {
    if (nextMode === 'source') setDrawOverlayOpen(false);
    setMode(nextMode);
  }

  function activateBoard(nextTool?: BoardTool) {
    setMode('preview');
    setBoardMode(true);
    if (nextTool) setBoardTool(nextTool);
  }

  function activateBoardPicker(nextTool: BoardTool) {
    clearBoardComposer();
    fireArtifactToolbarClick(nextTool === 'pod' ? 'pods' : 'comment');
    setCommentPanelOpen(false);
    setCommentCreateMode(false);
    activateBoard(nextTool);
    setAgentToolsOpen(false);
  }

  function clearBoardComposer() {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setHoveredPodMemberId(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedBoardNotes([]);
    setBoardImages([]);
    setActiveCommentExistingAttachments([]);
    setBoardPreviewIndex(null);
    setStrokePoints([]);
  }

  function addBoardImages(files: File[]) {
    const imgs = files.filter((file) => file.type.startsWith('image/'));
    if (imgs.length > 0) setBoardImages((current) => [...current, ...imgs]);
  }

  function removeBoardImage(index: number) {
    setBoardImages((current) => current.filter((_, i) => i !== index));
    setBoardPreviewIndex(null);
  }

  function closeArtifactToolMenus() {
    setAgentToolsOpen(false);
  }

  function activateDrawTool() {
    fireArtifactToolbarClick('draw');
    const next = !drawOverlayOpen;
    if (!next) {
      setDrawOverlayOpen(false);
      setAgentToolsOpen(false);
      return;
    }
    capturePreviewScrollPosition();
    const activateDraw = () => {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      setBoardMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setMode('preview');
      setDrawOverlayOpen(true);
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateDraw();
      });
      return;
    }
    activateDraw();
  }

  function activateCommentTool() {
    fireArtifactToolbarClick('comment');
    capturePreviewScrollPosition();
    if (boardMode && !commentCreateMode && boardTool === 'inspect') {
      setBoardMode(false);
      setCommentCreateMode(false);
      clearBoardComposer();
      setAgentToolsOpen(false);
      return;
    }
    const activateComment = () => {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      activateBoard('inspect');
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateComment();
      });
      return;
    }
    activateComment();
  }

  function activateCommentCreateTool() {
    fireArtifactToolbarClick('comment');
    capturePreviewScrollPosition();
    if (boardMode && commentCreateMode) {
      setBoardMode(false);
      setCommentCreateMode(false);
      setCommentPanelOpen(false);
      clearBoardComposer();
      closeArtifactToolMenus();
      return;
    }
    const activateCommentCreate = () => {
      setCommentPanelOpen(true);
      setCommentSidePanelCollapsed(false);
      setCommentCreateMode(true);
      if (!activeCommentTarget) clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      activateBoard('inspect');
      closeArtifactToolMenus();
    };
    if (manualEditMode) {
      void exitManualEditModeAfterFlush().then((ok) => {
        if (ok) activateCommentCreate();
      });
      return;
    }
    activateCommentCreate();
  }

  function activateManualEditTool() {
    fireArtifactToolbarClick('edit');
    capturePreviewScrollPosition();
    if (!manualEditMode) {
      setCommentPanelOpen(false);
      setCommentCreateMode(false);
      setBoardMode(false);
      clearBoardComposer();
      setInspectMode(false);
      setDrawOverlayOpen(false);
      setMode('preview');
      setManualEditSrcDocActive(true);
      setManualEditMode(true);
      closeArtifactToolMenus();
      return;
    }
    closeArtifactToolMenus();
    void exitManualEditModeAfterFlush();
  }

  function queueCurrentDraft() {
    const note = commentDraft.trim();
    if (!note) return;
    setQueuedBoardNotes((current) => [...current, note]);
    setCommentDraft('');
  }

  function currentActiveComposerComment(): PreviewComment | null {
    if (!activePreviewCommentId) return null;
    return previewComments.find((comment) => (
      comment.id === activePreviewCommentId &&
      comment.filePath === file.name &&
      comment.status === 'open'
    )) ?? null;
  }

  function currentActiveComposerAttachments(): PreviewCommentAttachment[] {
    return currentActiveComposerComment()?.attachments ?? activeCommentExistingAttachments;
  }

  function withDeckSlideIndex(target: PreviewCommentTarget): PreviewCommentTarget {
    if (!effectiveDeck || typeof slideState?.active !== 'number') return target;
    if (typeof target.slideIndex === 'number') return target;
    return { ...target, slideIndex: slideState.active };
  }

  async function sendBoardBatch() {
    if (!activeCommentTarget || !onSendBoardCommentAttachments) return;
    const nextNotes = [...queuedBoardNotes];
    if (commentDraft.trim()) nextNotes.push(commentDraft.trim());
    if (nextNotes.length === 0 && boardImages.length === 0) {
      const existingComment = currentActiveComposerComment();
      if (existingComment) {
        setSendingBoardBatch(true);
        try {
          await onSendBoardCommentAttachments(commentsToAttachments([existingComment]));
          clearBoardComposer();
        } finally {
          setSendingBoardBatch(false);
        }
      }
      return;
    }
    setSendingBoardBatch(true);
    try {
      const existingAttachments = currentActiveComposerAttachments();
      const attachments = buildBoardCommentAttachments({
        target: withDeckSlideIndex(targetFromSnapshot(activeCommentTarget)),
        notes: nextNotes,
        includeImageOnly: boardImages.length > 0,
        imageAttachmentCount: boardImages.length,
      }).map((attachment) => (
        existingAttachments.length > 0
          ? { ...attachment, imageAttachments: existingAttachments }
          : attachment
      ));
      const accepted = await onSendBoardCommentAttachments(
        attachments,
        boardImages,
      );
      if (accepted === false) return;
      clearBoardComposer();
    } finally {
      setSendingBoardBatch(false);
    }
  }

  async function savePersistentComment() {
    if (!activeCommentTarget || !onSavePreviewComment) return;
    // Allow saving when there is text OR an attached image (image-only notes).
    if (!commentDraft.trim() && boardImages.length === 0 && currentActiveComposerAttachments().length === 0) return;
    const isFreePin = activeCommentTarget.elementId.startsWith('pin-');
    setSendingBoardBatch(true);
    try {
      const target = withDeckSlideIndex(targetFromSnapshot(activeCommentTarget));
      const saved = await onSavePreviewComment(
        target,
        commentDraft.trim(),
        false,
        boardImages,
      );
      if (saved) {
        rememberSavedPreviewCommentOrder(saved.id);
        clearBoardComposer();
        setActiveCommentExistingAttachments(saved.attachments ?? []);
        setBoardMode(true);
        setCommentCreateMode(true);
        setCommentPanelOpen(true);
        setCommentSidePanelCollapsed(false);
        setActivePreviewCommentId(saved.id);
        setCommentSavedToast(isFreePin ? t('chat.comments.pinSavedToast') : t('chat.comments.savedToast'));
      }
    } finally {
      setSendingBoardBatch(false);
    }
  }

  async function savePanelComment(note: string) {
    if (!onSavePreviewComment) return false;
    const cleanNote = note.trim();
    if (!cleanNote) return false;
    const idSeed = Date.now().toString(36);
    const target: PreviewCommentTarget = activeCommentTarget
      ? targetFromSnapshot(activeCommentTarget)
      : {
          filePath: file.name,
          elementId: `file-comment-${idSeed}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          selector: 'html',
          label: file.name,
          text: '',
          position: { x: 0, y: 0, width: 0, height: 0 },
          htmlHint: '',
          selectionKind: 'element',
        };
    setSendingBoardBatch(true);
    try {
      const saved = await onSavePreviewComment(target, cleanNote, false);
      if (saved) {
        rememberSavedPreviewCommentOrder(saved.id);
        setCommentSavedToast(t('chat.comments.savedToast'));
        if (activeCommentTarget) clearBoardComposer();
      }
      return Boolean(saved);
    } finally {
      setSendingBoardBatch(false);
    }
  }

  const showPresent = source !== null;
  const exportTitle = file.name.replace(/\.html?$/i, '') || file.name;
  const artifactKind = file.artifactManifest?.kind ?? file.artifactKind ?? null;
  const rendererId = file.artifactManifest?.renderer ?? null;
  const isDeckArtifact = isDeck || artifactKind === 'deck' || rendererId === 'deck-html' || file.kind === 'presentation';
  const isMarkdownArtifact =
    artifactKind === 'markdown-document' ||
    rendererId === 'markdown' ||
    file.kind === 'text' && /\.mdx?$/i.test(file.name);
  const isShareableArtifact =
    file.kind === 'html' ||
    isDeckArtifact ||
    artifactKind === 'html' ||
    rendererId === 'html';
  const canShare = source !== null && isShareableArtifact;
  const canDownload = source !== null && (isShareableArtifact || isMarkdownArtifact);
  const canPptx = canShare && isDeckArtifact && Boolean(onExportAsPptx) && !streaming;
  const showPptxExport = canShare && isDeckArtifact;
  const showMarkdownExport = source !== null && isMarkdownArtifact;
  const showImageExport = canShare;

  useEffect(() => {
    const nudgeKey = `${projectId}\n${file.name}`;
    if (!canShare || exportReadyNudgeSeenRef.current.has(nudgeKey)) return;
    exportReadyNudgeSeenRef.current.add(nudgeKey);
    if (hasSeenExportReadyNudge(projectId, file.name)) return;
    markExportReadyNudgeSeen(projectId, file.name);
    setExportReadyNudge(true);
    const timeout = window.setTimeout(() => setExportReadyNudge(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [canShare, file.name, projectId]);

  // Chat-side "Share" next-step action: when a new share request arrives, open
  // the share menu (the toolbar's "Share" button → deploy menu, which holds the
  // share-link items AND the "publish online" providers). This is the right
  // surface for "share" — publishing is the prerequisite for a shareable link,
  // and that publish step lives here; the download menu is export-to-disk, a
  // different intent. The artifact source may still be loading when the request
  // lands (the file was just auto-opened), so we defer until `canShare` flips
  // true and only consume each nonce once.
  const consumedShareNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const nonce = shareRequest?.nonce;
    if (nonce == null) return;
    if (consumedShareNonceRef.current === nonce) return;
    if (!canShare) return;
    consumedShareNonceRef.current = nonce;
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDownloadMenuOpen(false);
    setDeployMenuOpen(true);
  }, [shareRequest?.nonce, canShare, projectId, file.name]);

  // Parallel to shareRequest, but opens the Download / Export menu instead — the
  // assistant "next step" card's Download row routes here so it surfaces the same
  // PDF / image / zip / standalone-HTML / template options the toolbar exposes.
  const consumedDownloadNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const nonce = downloadRequest?.nonce;
    if (nonce == null) return;
    if (consumedDownloadNonceRef.current === nonce) return;
    if (!canShare) return;
    consumedDownloadNonceRef.current = nonce;
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDeployMenuOpen(false);
    setDownloadMenuOpen(true);
  }, [downloadRequest?.nonce, canShare, projectId, file.name]);

  // A queued chat send for this deck just started: flip the preview to the
  // slide its marked element lives on. We write the cached slide state first so
  // a freshly-mounted iframe (the tab may have just been activated) restores to
  // the target on load via syncCachedSlideStateToIframe(), then post directly
  // to cover the already-loaded iframe. The consume-once guard lives in
  // `shouldConsumeSlideNav` (keyed by file outside this component) so it holds
  // across remounts — switching away from and back to the deck must not replay
  // the stale request and yank the preview off wherever the user navigated.
  useEffect(() => {
    const nonce = slideNavRequest?.nonce;
    if (nonce == null) return;
    if (!effectiveDeck) return;
    const requested = slideNavRequest?.slideIndex;
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) return;
    if (!shouldConsumeSlideNav(previewStateKey, nonce)) return;
    const target = Math.floor(requested);
    const cachedCount = htmlPreviewSlideState.get(previewStateKey)?.count;
    const count = slideState?.count ?? cachedCount ?? target + 1;
    setSlideStateCached(previewStateKey, { active: target, count });
    setSlideState({ active: target, count });
    syncCachedSlideStateToIframe();
  }, [slideNavRequest?.nonce, slideNavRequest?.slideIndex, effectiveDeck, previewStateKey, slideState?.count]);

  const openDownloadMenu = () => {
    fireArtifactHeaderClick('download_dropdown');
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDeployMenuOpen(false);
    setDownloadMenuOpen((v) => !v);
  };
  const openDeployMenu = () => {
    fireArtifactHeaderClick('share_dropdown');
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setDownloadMenuOpen(false);
    setDeployMenuOpen((v) => !v);
  };
  const captureExportImageSnapshot = useCallback(async () => {
    // Prefer the desktop compositor screenshot of the visible preview region:
    // it returns the real rendered pixels (fonts, external CSS, gradients,
    // images) and is never tainted, so it cannot produce the black/blank frames
    // the in-iframe SVG-foreignObject bridge does. Works for both srcDoc and
    // URL-load previews. Falls through to the bridge on pure web (no host).
    const visibleIframe = iframeRef.current ?? srcDocPreviewIframeRef.current;
    const hostSnapshot = await captureHostIframeSnapshot(visibleIframe);
    if (hostSnapshot) return hostSnapshot;

    if (!useUrlLoadPreview) {
      const activeIframe = srcDocPreviewIframeRef.current ?? iframeRef.current;
      if (!activeIframe) return null;
      await waitForIframeLoadOrTimeout(activeIframe, 250);
      await waitForAnimationFrame();
      return requestPreviewSnapshotWithRetry(activeIframe);
    }

    const urlIframe = iframeRef.current ?? urlPreviewIframeRef.current;
    if (urlIframe) {
      await waitForIframeLoadOrTimeout(urlIframe, 250);
      await waitForAnimationFrame();
      const urlSnapshot = await requestPreviewSnapshotWithRetry(urlIframe);
      if (urlSnapshot) return urlSnapshot;
    }

    const srcDocIframe = srcDocPreviewIframeRef.current;
    if (!srcDocIframe) {
      const activeIframe = iframeRef.current;
      if (!activeIframe) return null;
      return requestPreviewSnapshotWithRetry(activeIframe);
    }

    if (useLazySrcDocTransport && !srcDocShellReady) {
      await waitForIframeLoadOrTimeout(srcDocIframe, 500);
    }
    if (useLazySrcDocTransport && activateSrcDocSnapshotTransport(srcDocIframe)) {
      await waitForIframeLoadOrTimeout(srcDocIframe);
    }
    const restoreVisibility = temporarilyExposeIframeForSnapshot(srcDocIframe);
    try {
      await waitForAnimationFrame();
      return requestPreviewSnapshotWithRetry(srcDocIframe);
    } finally {
      restoreVisibility();
    }
  }, [
    activateSrcDocSnapshotTransport,
    srcDocShellReady,
    useLazySrcDocTransport,
    useUrlLoadPreview,
  ]);

  const handleCopyScreenshot = useCallback(async () => {
    if (screenshotInFlightRef.current) return;
    screenshotInFlightRef.current = true;
    setExportToast({ message: t('fileViewer.screenshotCopying'), tone: 'loading' });
    try {
      const snap = await captureExportImageSnapshot();
      if (!snap) {
        setExportToast({ message: t('fileViewer.screenshotPreviewLoading'), tone: 'error' });
        return;
      }
      const result = await copyImageDataUrlToClipboard(snap.dataUrl);
      setExportToast(
        result === 'copied'
          ? { message: t('fileViewer.screenshotCopied'), tone: 'success' }
          : {
              message: t(
                result === 'denied'
                  ? 'fileViewer.screenshotClipboardDenied'
                  : 'fileViewer.screenshotCaptureFailed',
              ),
              tone: 'error',
            },
      );
    } catch (err) {
      console.warn('[handleCopyScreenshot] failed:', err);
      setExportToast({ message: t('fileViewer.screenshotCaptureFailed'), tone: 'error' });
    } finally {
      screenshotInFlightRef.current = false;
    }
  }, [captureExportImageSnapshot, t]);

  const prepareImageExportBlob = useCallback(async (format: ImageExportFormat) => {
    const prepareId = imageExportPrepareIdRef.current + 1;
    imageExportPrepareIdRef.current = prepareId;
    setImageExportPreparing(true);
    setImageExportError(null);
    setImageExportPreparedBlob(null);
    try {
      let dataUrl = imageExportSnapshotDataUrlRef.current;
      if (!dataUrl) {
        const snap = await captureExportImageSnapshot();
        if (!snap) throw new Error('Snapshot capture returned null');
        dataUrl = snap.dataUrl;
        imageExportSnapshotDataUrlRef.current = dataUrl;
      }
      const blob = await imageDataUrlToBlob(dataUrl, format);
      if (blob.size <= 0) throw new Error('Snapshot capture produced an empty image');
      if (imageExportPrepareIdRef.current === prepareId) {
        setImageExportPreparedBlob({ format, blob });
      }
    } catch (err) {
      console.warn('[exportAsImage] failed to prepare snapshot:', err);
      if (imageExportPrepareIdRef.current === prepareId) {
        setImageExportError(t('fileViewer.exportImageFailed'));
      }
    } finally {
      if (imageExportPrepareIdRef.current === prepareId) {
        setImageExportPreparing(false);
      }
    }
  }, [captureExportImageSnapshot, t]);

  const openImageExportModal = async () => {
    flushSync(() => {
      setDownloadMenuOpen(false);
    });
    setImageExportError(null);
    setImageExportPreparedBlob(null);
    imageExportSnapshotDataUrlRef.current = null;
    await waitForAnimationFrame();
    await waitForAnimationFrame();
    setImageExportModalOpen(true);
    void prepareImageExportBlob(imageExportFormat);
  };

  const changeImageExportFormat = (format: ImageExportFormat) => {
    setImageExportFormat(format);
    void prepareImageExportBlob(format);
  };

  async function handleImageExportSave() {
    const prepared = imageExportPreparedBlob;
    if (!prepared || prepared.format !== imageExportFormat) {
      setImageExportError(t('fileViewer.exportImageFailed'));
      return;
    }
    setImageExportBusy(true);
    setImageExportError(null);
    try {
      const target = await prepareImageExportTarget(exportTitle, imageExportFormat, { useNativePicker: false });
      if (!target) return;
      const preparedDataUrl = imageExportSnapshotDataUrlRef.current;
      if (target.method === 'download' && imageExportFormat === 'png' && preparedDataUrl) {
        downloadImageDataUrl(preparedDataUrl, target.filename);
      } else {
        await target.save(prepared.blob);
      }
      setImageExportModalOpen(false);
      setImageExportSavedToast({
        message: target.method === 'picker'
          ? t('fileViewer.exportImageSaved')
          : t('fileViewer.exportImageDownloadStarted'),
        details: target.method === 'picker'
          ? target.filename
          : t('fileViewer.exportImageDownloadDetails', { filename: target.filename }),
      });
    } catch (err) {
      console.warn('[exportAsImage] failed to save snapshot:', err);
      setImageExportError(t('fileViewer.exportImageFailed'));
    } finally {
      setImageExportBusy(false);
    }
  }
  const creationSortedSideComments = useMemo(
    () => previewComments
      .filter((comment) => comment.filePath === file.name && comment.status === 'open')
      .sort((a, b) => commentCreatedAt(a) - commentCreatedAt(b)),
    [file.name, previewComments],
  );
  useEffect(() => {
    const creationIds = creationSortedSideComments.map((comment) => comment.id);
    setCommentOrderIds((current) => {
      const visible = new Set(creationIds);
      const kept = current.filter((id) => visible.has(id));
      const added = creationIds.filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      return next.join('\0') === current.join('\0') ? current : next;
    });
  }, [creationSortedSideComments]);
  const visibleSideComments = useMemo(() => {
    if (commentOrderIds.length === 0) return creationSortedSideComments;
    const byId = new Map(creationSortedSideComments.map((comment) => [comment.id, comment]));
    const ordered = commentOrderIds
      .map((id) => byId.get(id))
      .filter((comment): comment is PreviewComment => Boolean(comment));
    const orderedIds = new Set(ordered.map((comment) => comment.id));
    const missing = creationSortedSideComments.filter((comment) => !orderedIds.has(comment.id));
    return [...ordered, ...missing];
  }, [creationSortedSideComments, commentOrderIds]);
  function rememberSavedPreviewCommentOrder(savedId: string) {
    setCommentOrderIds((current) =>
      appendSavedPreviewCommentOrder(current, visibleSideComments, savedId),
    );
  }
  const activeSideCommentId = activePreviewCommentId;
  const activeCommentTargetVisible = commentTargetIntersectsPreview(
    activeCommentTarget,
    overlayPreviewScale,
    { x: overlayPreviewTransform.offsetX, y: overlayPreviewTransform.offsetY },
    previewBodySize,
  );
  useEffect(() => {
    if (!boardMode || !activePreviewCommentId) return;
    const stillOpen = visibleSideComments.some((comment) => comment.id === activePreviewCommentId);
    if (!stillOpen) clearBoardComposer();
  }, [activePreviewCommentId, boardMode, visibleSideComments]);
  useEffect(() => {
    if (!effectiveDeck || slideState == null || !boardMode) return;
    if (!activePreviewCommentId) return;
    const activeComment = visibleSideComments.find((comment) => comment.id === activePreviewCommentId);
    if (activeComment && !commentVisibleOnDeckSlide(activeComment, slideState.active)) {
      clearBoardComposer();
    }
  }, [activePreviewCommentId, boardMode, effectiveDeck, slideState?.active, visibleSideComments]);
  const activeDeployment = deployResult || deployment;
  const activeDeployedUrl = activeDeployment?.url?.trim() || '';
  const activeDeploymentDelayed = activeDeployment?.status === 'link-delayed';
  const activeDeploymentProtected = activeDeployment?.status === 'protected';
  const activeCloudflarePages = activeDeployment?.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
    ? activeDeployment.cloudflarePages
    : undefined;
  const activeCloudflareCustomDomain = activeCloudflarePages?.customDomain;
  const deployProvider = getDeployProviderOption(deployProviderId);
  const deployProviderLabel = t(deployProvider.labelKey);
  const selectedCloudflareZone = cloudflareZones.find((zone) => zone.id === cloudflareZoneId) ?? null;
  const normalizedCloudflarePrefix = normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix);
  const cloudflareHostnamePreview =
    selectedCloudflareZone && normalizedCloudflarePrefix
      ? `${normalizedCloudflarePrefix}.${selectedCloudflareZone.name}`
      : '';
  const deployResultCards: DeployResultCard[] = activeCloudflarePages
    ? (() => {
        const cards: DeployResultCard[] = [];
        const pagesDevUrl = activeCloudflarePages.pagesDev?.url || activeDeployedUrl;
        if (pagesDevUrl) {
          cards.push({
            id: 'pages-dev',
            label: t('fileViewer.cloudflarePagesDevLinkLabel'),
            url: pagesDevUrl,
            status: activeCloudflarePages.pagesDev?.status || activeDeployment?.status || 'link-delayed',
            message: activeCloudflarePages.pagesDev?.statusMessage,
          });
        }
        if (activeCloudflareCustomDomain?.url) {
          cards.push({
            id: 'custom-domain',
            label: t('fileViewer.cloudflareCustomDomainLinkLabel'),
            url: activeCloudflareCustomDomain.url,
            status: activeCloudflareCustomDomain.status,
            message:
              activeCloudflareCustomDomain.errorMessage ||
              activeCloudflareCustomDomain.statusMessage,
          });
        }
        return cards;
      })()
    : activeDeployedUrl
      ? [{
          id: 'default',
          label: activeDeploymentProtected
            ? t('fileViewer.deployLinkProtectedLabel')
            : activeDeploymentDelayed
              ? t('fileViewer.deployLinkPreparingLabel')
              : t('fileViewer.deployResultLabel'),
          url: activeDeployedUrl,
          status: activeDeployment?.status || 'ready',
          message: activeDeploymentProtected
            ? t('fileViewer.deployLinkProtected')
            : activeDeploymentDelayed
              ? t('fileViewer.deployLinkDelayed')
              : activeDeployment?.statusMessage,
        }]
      : [];
  const deployActionLabelFor = (providerId: WebDeployProviderId) => {
    const option = getDeployProviderOption(providerId);
    const label = t(option.labelKey);
    const hasActiveDeploymentForProvider = Boolean(deploymentsByProvider[providerId]?.url?.trim());
    return hasActiveDeploymentForProvider
      ? t('fileViewer.redeployToProvider', { provider: label })
      : t('fileViewer.deployToProvider', { provider: label });
  };
  const deployedEntries = DEPLOY_PROVIDER_OPTIONS
    .map((option) => deploymentsByProvider[option.id])
    .filter((item): item is WebDeploymentInfo => Boolean(item?.url?.trim()));
  const shareableDeploymentUrl =
    DEPLOY_PROVIDER_OPTIONS.map((option) => deploymentsByProvider[option.id])
      .map((item) => publicShareUrlForDeployment(item))
      .find(Boolean) ?? '';
  const socialShareBlockedDeployment =
    shareableDeploymentUrl
      ? null
      : deployedEntries.find((item) => deployResultState(item.status) === 'protected' && !publicShareUrlForDeployment(item)) ??
        deployedEntries.find((item) => !publicShareUrlForDeployment(item)) ??
        null;
  const socialShareBlockedState = socialShareBlockedDeployment
    ? deployResultState(socialShareBlockedDeployment.status)
    : null;
  const socialShareDisplayUrl =
    shareableDeploymentUrl || socialShareBlockedDeployment?.url?.trim() || activeDeployedUrl;
  const socialShareUnavailableMessage =
    socialShareBlockedState === 'protected'
      ? t('fileViewer.deployLinkProtected')
      : socialShareBlockedState === 'delayed'
        ? t('fileViewer.deployLinkDelayed')
        : t('socialShare.deployFirst');
  const projectSocialShareRequest = useMemo<SocialShareRequest | null>(() => {
    if (!socialShareDisplayUrl) return null;
    const title = t('socialShare.projectTitle', { title: exportTitle });
    const text = t('socialShare.projectText', {
      title: exportTitle,
      repo: READABLE_GITHUB_REPO_URL,
    });
    return {
      kind: 'project-html',
      locale,
      url: socialShareDisplayUrl,
      title,
      text,
      copyText: t('socialShare.projectCopyText', {
        title: exportTitle,
        url: socialShareDisplayUrl,
        repo: READABLE_GITHUB_REPO_URL,
      }),
    };
  }, [exportTitle, locale, socialShareDisplayUrl, t]);
  const projectSocialShareFallback = useMemo(
    () => (projectSocialShareRequest ? buildSocialSharePayload(projectSocialShareRequest) : null),
    [projectSocialShareRequest],
  );
  // Gate the async payload load on a stable *content* key, not the memo's
  // object identity. The request object can take a fresh identity on renders
  // where its inputs are value-equal (e.g. while deployment polling re-sets
  // state with a new map reference), and keying the effect on that identity
  // made `setProjectSocialShare` re-fire every render — an infinite render
  // loop once a deployment URL is available (#regression: ready-deploy share).
  const projectSocialShareKey = projectSocialShareRequest
    ? JSON.stringify(projectSocialShareRequest)
    : '';
  useEffect(() => {
    setProjectSocialShare(null);
    if (!projectSocialShareRequest) return;
    let cancelled = false;
    void createSocialSharePayload(projectSocialShareRequest)
      .then((payload) => {
        if (!cancelled) setProjectSocialShare(payload);
      })
      .catch(() => {
        if (!cancelled) setProjectSocialShare(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSocialShareKey]);
  const activeProjectSocialShare = projectSocialShare ?? projectSocialShareFallback;
  const socialShareMenuLabel =
    activeProjectSocialShare
      ? t('socialShare.projectSection')
      : socialShareBlockedState === 'protected'
        ? t('fileViewer.deployLinkProtectedLabel')
        : socialShareBlockedState === 'delayed'
        ? t('fileViewer.deployLinkPreparingLabel')
          : t('socialShare.deployFirst');
  const deployActionIconFor = (providerId: WebDeployProviderId) => {
    if (providerId === 'cloudflare-pages') return 'pages-line';
    return 'upload-cloud-line';
  };
  const latestShareDeployment = useMemo(
    () => pickLatestShareDeployment(deploymentsByProvider),
    [deploymentsByProvider],
  );
  const latestDeployedShareUrl = latestShareDeployment
    ? shareUrlForDeployment(latestShareDeployment)
    : '';
  const latestShareState = latestShareDeployment
    ? deployResultState(latestShareDeployment.status)
    : null;
  const sharePageUrl = useMemo(
    () => resolveShareUrl(latestDeployedShareUrl),
    [latestDeployedShareUrl],
  );
  const canCopyShareLink = !streaming && Boolean(sharePageUrl);
  const canOpenSharePage = !streaming && Boolean(sharePageUrl) && latestShareState !== 'delayed';
  const shareLinkStatusHint =
    streaming
      ? t('fileViewer.shareAfterGenerationComplete')
      : latestShareState === 'delayed'
      ? t('fileViewer.deployLinkDelayed')
      : latestShareState === 'protected'
        ? t('fileViewer.deployLinkProtected')
        : '';
  const shareUnavailableHint = streaming
    ? t('fileViewer.shareAfterGenerationComplete')
    : t('fileViewer.shareLinkRequiresDeploy');
  const copyShareLinkLabel =
    shareLinkFeedback === 'copied'
      ? t('fileViewer.copied')
      : shareLinkFeedback === 'failed'
        ? t('useEverywhere.copyFailed')
        : t('fileViewer.copyShareLink');
  const shareMenuLabel = t('fileViewer.shareLabel');
  const deployMenuLabel = t('fileViewer.deployModalTitle') || 'Deploy';
  const deployButtonLabel =
    deployPhase === 'deploying'
      ? t('fileViewer.deployingToProvider', { provider: deployProviderLabel })
      : deployPhase === 'preparing-link'
        ? t('fileViewer.preparingPublicLink')
        : deployMenuLabel;
  const copyDeployLabel = (url: string) =>
    copiedDeployLink === url.trim()
      ? t('fileViewer.copied')
      : t('fileViewer.copyDeployLink');
  const statusLabelFor = (state: ReturnType<typeof deployResultState>) => {
    if (state === 'ready') return t('fileViewer.deployLinkReady');
    if (state === 'protected') return t('fileViewer.deployLinkProtectedLabel');
    if (state === 'failed') return t('fileViewer.deployLinkFailed');
    return t('fileViewer.deployLinkPreparingLabel');
  };
  const boardAvailable = mode === 'preview' && source !== null;
  const showPreviewToolbarControls = mode === 'preview';
  const commentPreviewLayoutClass = [
    'comment-preview-layer',
    localCommentSideDockActive ? 'comment-preview-layer-with-side-dock' : '',
    localCommentSideDockActive && commentSidePanelCollapsed ? 'comment-preview-layer-dock-collapsed' : '',
    boardSideDockStacked ? 'comment-preview-layer-side-dock-stacked' : '',
  ].filter(Boolean).join(' ');
  // Selected targets use docked controls; the floating panel is reserved for
  // page styles opened from the empty canvas.
  const manualEditPageCardActive =
    manualEditMode && !selectedManualEditTarget && manualEditPageStylesOpen;
  const manualEditShapeToolbarActive =
    manualEditMode && !!selectedManualEditTarget;
  const pickManualEditImage = async (pickedFile: File) => {
    const result = await uploadProjectFiles(projectId, [pickedFile]);
    const uploaded = result.uploaded[0];
    if (!uploaded?.path) {
      setManualEditError(result.error ?? t('manualEdit.uploadImageFailed'));
      return null;
    }
    setManualEditError(null);
    return toOwnerRelativePath(file.name, uploaded.path);
  };
  // The floating page-styles card is the fallback surface only. In the project
  // workspace (portal host present) the Page section lives in the left inspector.
  const manualEditPanel = manualEditPageCardActive && !manualEditPortalId ? (
    <ManualEditPanel
      error={manualEditError}
      canUndo={manualEditHistory.length > 0}
      canRedo={manualEditUndone.length > 0}
      busy={manualEditSaving}
      pageStylesEnabled={manualEditPageStylesEnabled}
      onStyleChange={(id, styles, label) => {
        void handleManualEditStyleChange(id, styles, label);
      }}
      onInvalidStyle={cancelManualEditPendingStyles}
      onError={setManualEditError}
      onExit={() => {
        void dismissManualEditPanel();
      }}
      onCancelDraft={() => {
        cancelManualEditPanel();
      }}
      onSaveDraft={() => {
        void dismissManualEditPanel();
      }}
      onUndo={() => {
        void undoManualEdit();
      }}
      onRedo={() => {
        void redoManualEdit();
      }}
    />
  ) : null;
  const manualEditHoverAffordance =
    manualEditMode &&
    manualEditHoverTarget &&
    manualEditHoverTarget.id !== selectedManualEditTarget?.id ? (
      <button
        type="button"
        className="manual-edit-hover-action"
        data-testid="manual-edit-hover-open"
        aria-label={t('manualEdit.editParams')}
        title={t('manualEdit.editParams')}
        style={manualEditHoverIconStyle(
          manualEditHoverTarget,
          overlayPreviewScale,
          previewBodySize,
          manualEditOverlayTransform.offsetX,
          manualEditOverlayTransform.offsetY,
        )}
        onClick={() => {
          const target = manualEditHoverTarget;
          setManualEditHoverTarget(null);
          const win = iframeRef.current?.contentWindow;
          if (win) win.postMessage({ type: 'readable-edit-select-target', id: target.id }, '*');
          else void selectManualEditTarget(target);
        }}
      >
        <Icon name="sliders" size={15} />
      </button>
    ) : null;
  const manualEditResizeLabels = useMemo<Record<ResizeHandleDirection, string>>(
    () => RESIZE_HANDLE_DIRECTIONS.reduce((acc, direction) => {
      acc[direction] = t(`manualEdit.resize.${direction}`);
      return acc;
    }, {} as Record<ResizeHandleDirection, string>),
    [t],
  );
  const selectedManualEditResizeFeedback = selectedManualEditTarget
    && manualEditResizeFeedback?.targetId === selectedManualEditTarget.id
    && manualEditResizeFeedback.constraints.length
      ? manualEditResizeFeedback
      : null;
  const manualEditResizeCanvasFeedback = selectedManualEditResizeFeedback?.constraints.map((constraint) => {
    const axis = t(constraint.axis === 'width' ? 'manualEdit.shape.width' : 'manualEdit.shape.height');
    const hasNamedLimit = selectedManualEditResizeFeedback.announce
      && constraint.reason !== 'layout'
      && constraint.property
      && constraint.value;
    const limit = hasNamedLimit
      ? t('manualEdit.resize.limit', { axis, property: constraint.property!, value: constraint.value! })
      : t('manualEdit.resize.layoutLimit', { axis });
    return `${limit} · ${Math.round(constraint.applied)}px`;
  }).join('\n');
  // Resize handles ride the same iframe→canvas transform as the hover
  // affordance, and only when the srcDoc edit bridge is live (URL-load preview
  // has no readable-edit-preview-style channel), with edit mode on, an element
  // selected, and a valid rect.
  const manualEditResizeRect =
    manualEditMode && selectedManualEditTarget && !useUrlLoadPreview
      ? manualEditResizeOverlayRect(
          selectedManualEditTarget,
          overlayPreviewScale,
          previewBodySize,
          manualEditOverlayTransform.offsetX,
          manualEditOverlayTransform.offsetY,
        )
      : null;
  const manualEditMoveRect =
    manualEditDuplicateRect && selectedManualEditTarget
      ? manualEditResizeOverlayRect(
        { ...selectedManualEditTarget, rect: manualEditDuplicateRect },
        overlayPreviewScale,
        previewBodySize,
        manualEditOverlayTransform.offsetX,
        manualEditOverlayTransform.offsetY,
      )
      : manualEditResizeRect;
  const postManualEditHoverAt = (clientX: number, clientY: number) => {
    const frame = iframeRef.current;
    const win = frame?.contentWindow;
    if (!frame || !win || !selectedManualEditTarget) return;
    const frameRect = frame.getBoundingClientRect();
    const message: ManualEditHoverAtMessage = {
      type: 'readable-edit-hover-at',
      clientX: (clientX - frameRect.left) / overlayPreviewScale,
      clientY: (clientY - frameRect.top) / overlayPreviewScale,
      selectedId: selectedManualEditTarget.id,
      documentEpoch: manualEditDocumentEpoch(),
    };
    win.postMessage(message, '*');
  };
  const manualEditResizeHandles =
    manualEditResizeRect && selectedManualEditTarget ? (
      <ManualEditResizeHandles
        rect={manualEditResizeRect}
        startSize={{
          width: selectedManualEditTarget.rect.width,
          height: selectedManualEditTarget.rect.height,
        }}
        scale={overlayPreviewScale}
        disabled={manualEditSaving}
        labels={manualEditResizeLabels}
        frameLabel={t('manualEdit.resize.frameLabel')}
        resizeConstraints={selectedManualEditResizeFeedback?.constraints}
        resizeFeedback={manualEditResizeCanvasFeedback}
        bounds={previewBodySize}
        onResizeStart={() => {
          cancelKeyboardBurst();
          clearManualEditResizeFeedback();
          clearManualEditMovement();
          beginManualEditResizeBaseline(selectedManualEditTarget);
        }}
        onHoverClear={clearManualEditHover}
        onBurstCancel={() => cancelKeyboardBurst({ latchHeldKeys: true })}
        onResizePreview={(direction, size, startSize) => {
          previewStyleToIframe(
            selectedManualEditTarget.id,
            manualEditResizeStyles(selectedManualEditTarget, direction, size, startSize),
            nextManualEditPreviewVersion(),
            false,
            manualEditResizeRequest(direction, size),
          );
        }}
        onResizeCommit={(direction, size, startSize) => {
          void commitManualEditResize(selectedManualEditTarget, direction, size, startSize);
        }}
        onResizeCancel={() => {
          clearManualEditHover();
          clearManualEditResizeFeedback();
          revertManualEditResizePreview(selectedManualEditTarget);
        }}
      />
    ) : null;
  // Move frame: same overlay rect + gate as the resize handles, one z-index
  // below them so handle drags = resize and elsewhere = move (PPT model).
  const manualEditMoveFrame =
    manualEditMoveRect && selectedManualEditTarget ? (
      <ManualEditMoveFrame
        key={manualEditMoveFrameKey}
        rect={manualEditMoveRect}
        scale={overlayPreviewScale}
        mode={manualEditMoveMode}
        label={t('manualEdit.move.frame')}
        selectBehindHint={selectedManualEditTarget.kind === 'text' || selectedManualEditTarget.kind === 'link'
          ? undefined
          : t('manualEdit.selectBehindHint')}
        onMoveStart={() => {
          clearManualEditHover();
          cancelKeyboardBurst();
          beginManualEditMovement(selectedManualEditTarget, 'pointer');
          // Dragging the border while editing commits the text and promotes to
          // object-select before the move (PPT).
          if (manualEditMoveMode === 'editing') {
            sendManualEditTextEdit({ type: 'readable-edit-end-text-edit' });
            setManualEditMoveMode('selected');
          }
        }}
        onMovePreview={previewManualEditMovement}
        onMoveCommit={(update) => {
          void commitManualEditMovement(update);
        }}
        onMoveCancel={() => {
          clearManualEditHover();
          cancelManualEditMovement();
        }}
        onHoverAt={postManualEditHoverAt}
        onAltChange={(altKey) => {
          rePreviewManualEditMovementWithAlt(altKey);
        }}
        onCtrlChange={(ctrlKey) => {
          manualEditCtrlRef.current = ctrlKey;
          const update = manualEditLastUpdateRef.current;
          if (update) previewManualEditMovement(update);
        }}
        onBurstCancel={() => cancelKeyboardBurst({ latchHeldKeys: true })}
        onPressStart={() => {
          // A fresh press starts Alt-clear; the move frame reports the real Alt
          // state at the drag threshold.
          manualEditAltRef.current = false;
          manualEditCtrlRef.current = false;
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'readable-edit-click-cancel' } satisfies ManualEditActivationMessage,
            '*',
          );
        }}
        onActivate={({ clientX, clientY, altKey }) => {
          if (manualEditMoveMode !== 'selected' && !altKey) return;
          const frame = iframeRef.current;
          const win = frame?.contentWindow;
          if (!frame || !win) return;
          const frameRect = frame.getBoundingClientRect();
          const point = {
            clientX: (clientX - frameRect.left) / overlayPreviewScale,
            clientY: (clientY - frameRect.top) / overlayPreviewScale,
          };
          const message: ManualEditActivationMessage = altKey
            ? { type: 'readable-edit-alt-click', ...point }
            : { type: 'readable-edit-click', ...point, selectedId: selectedManualEditTarget.id };
          win.postMessage(message, '*');
        }}
        onSurfaceDoubleClick={() => {
          const textTargetId = selectedManualEditTarget.kind === 'text' || selectedManualEditTarget.kind === 'link'
            ? selectedManualEditTarget.id
            : selectedManualEditTarget.textEditTargetId;
          if (!textTargetId || manualEditMoveMode !== 'selected') return;
          sendManualEditTextEdit({ type: 'readable-edit-begin-text-edit', id: textTargetId });
          setManualEditMoveMode('editing');
        }}
      />
    ) : null;
  const activeComposerComment = activePreviewCommentId
    ? visibleSideComments.find((comment) => comment.id === activePreviewCommentId) ?? null
    : null;
  const activeComposerAttachments =
    activeComposerComment?.attachments ?? activeCommentExistingAttachments;
  const commentComposer = boardMode && activeCommentTarget && activeCommentTargetVisible ? (
    <BoardComposerPopover
      target={activeCommentTarget}
      existing={activeComposerComment}
      draft={commentDraft}
      notes={queuedBoardNotes}
      onDraft={setCommentDraft}
      onAddDraft={queueCurrentDraft}
      onRemoveQueuedNote={(index) =>
        setQueuedBoardNotes((current) => current.filter((_, currentIndex) => currentIndex !== index))
      }
      onClose={clearBoardComposer}
      onSaveComment={() => { fireCommentPopoverClick('save_comment'); return savePersistentComment(); }}
      onSendBatch={() => { fireCommentPopoverClick('send_to_chat'); return sendBoardBatch(); }}
      images={boardImagePreviews}
      existingImages={
        activeComposerAttachments.map((attachment) => ({
          url: projectRawUrl(projectId, attachment.path),
          name: attachment.name,
        }))
      }
      onAttachImages={addBoardImages}
      onRemoveImage={removeBoardImage}
      onPreviewImage={setBoardPreviewIndex}
      onRemoveMember={(elementId) => {
        setActiveCommentTarget((current) => {
          const { next, shouldClose } = applyPodMemberRemoval(current, elementId);
          if (shouldClose) clearBoardComposer();
          return next;
        });
        setHoveredPodMemberId((current) => (current === elementId ? null : current));
      }}
      onHoverMember={setHoveredPodMemberId}
      onDeleteComment={onRemovePreviewComment ? async (commentId) => {
        await onRemovePreviewComment(commentId);
        clearBoardComposer();
        setSelectedSideCommentIds((current) => {
          if (!current.has(commentId)) return current;
          const next = new Set(current);
          next.delete(commentId);
          return next;
        });
        setActivePreviewCommentId((current) => (current === commentId ? null : current));
      } : undefined}
      sending={sendingBoardBatch}
      queueOnSend={commentQueueOnSend}
      sendDisabled={commentSendDisabled}
      t={t}
      scale={overlayPreviewScale}
      offset={{ x: overlayPreviewTransform.offsetX, y: overlayPreviewTransform.offsetY }}
      bounds={previewBodySize}
      docked={false}
      commenting
    />
  ) : null;
  const boardPreviewImage =
    boardPreviewIndex !== null ? boardImagePreviews[boardPreviewIndex] ?? null : null;
  const boardImagePreviewModal = boardPreviewImage
    ? createPortal(
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={boardPreviewImage.file.name}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setBoardPreviewIndex(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={boardPreviewImage.file.name}>{boardPreviewImage.file.name}</span>
              <button
                type="button"
                className="icon-only readable-tooltip"
                onClick={() => setBoardPreviewIndex(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={boardPreviewImage.url} alt={boardPreviewImage.file.name} />
          </div>
        </div>,
        document.body,
      )
    : null;
  const commentSidePanel = commentPanelOpen ? (
    <CommentSideDock
      comments={visibleSideComments}
      projectId={projectId}
      selectedIds={selectedSideCommentIds}
      activeCommentId={activeSideCommentId}
      collapsed={commentPortalHost ? false : commentSidePanelCollapsed}
      onCollapsedChange={setCommentSidePanelCollapsed}
      onToggleSelect={(commentId) => {
        setSelectedSideCommentIds((current) => {
          const next = new Set(current);
          if (next.has(commentId)) next.delete(commentId);
          else next.add(commentId);
          return next;
        });
      }}
      onSelectAll={() => setSelectedSideCommentIds(new Set(visibleSideComments.map((comment) => comment.id)))}
      onClearSelection={() => setSelectedSideCommentIds(new Set())}
      onReorder={(orderedIds) => setCommentOrderIds(orderedIds)}
      onReply={(comment) => {
        // Reply == edit on a flat-thread model: prefill the
        // popover with the existing note so the user sees and
        // mutates the current text. Save runs through the
        // same upsert path; matching project/conv/file/element
        // updates note in place rather than creating a new row.
        const snapshot = liveSnapshotForComment(comment, liveCommentTargets) ?? {
          filePath: comment.filePath,
          elementId: comment.elementId,
          selector: comment.selector,
          label: comment.label,
          text: comment.text,
          position: comment.position,
          htmlHint: comment.htmlHint,
          style: comment.style,
          selectionKind: comment.selectionKind ?? 'element',
          memberCount: comment.memberCount,
          podMembers: comment.podMembers,
          ...(typeof comment.slideIndex === 'number' ? { slideIndex: comment.slideIndex } : {}),
        };
        setActiveCommentTarget(snapshot);
        setHoveredCommentTarget(snapshot);
        setActivePreviewCommentId(comment.id);
        setCommentDraft(comment.note);
        setQueuedBoardNotes([]);
        setActiveCommentExistingAttachments(comment.attachments ?? []);
        setBoardMode(true);
        setCommentCreateMode(true);
        setCommentPanelOpen(true);
        setCommentSidePanelCollapsed(false);
      }}
      onSendSelected={async () => {
        if (!onSendBoardCommentAttachments) return;
        const selected = visibleSideComments.filter(
          (comment) => selectedSideCommentIds.has(comment.id),
        );
        if (selected.length === 0) return;
        fireCommentPopoverClick('send_to_chat');
        const sentIds = new Set(selected.map((comment) => comment.id));
        setSendingBoardBatch(true);
        try {
          const accepted = await onSendBoardCommentAttachments(commentsToAttachments(selected));
          if (accepted !== false) {
            setSelectedSideCommentIds(new Set());
            setCommentOrderIds((current) => current.filter((id) => !sentIds.has(id)));
            setActivePreviewCommentId((current) => current && sentIds.has(current) ? null : current);
          }
        } finally {
          setSendingBoardBatch(false);
        }
      }}
      onCreateComment={savePanelComment}
      sending={sendingBoardBatch}
      queueOnSend={commentQueueOnSend}
      sendDisabled={commentSendDisabled}
      renderCreateForm={!commentPortalHost}
      t={t}
      composer={null}
    />
  ) : null;

  return (
    <div className={`viewer html-viewer${inTabPresent ? ' is-tab-present' : ''}`}>
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only readable-tooltip"
            onClick={reloadHtmlPreview}
            title={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip={`${t('fileViewer.reload')} ${t('fileViewer.preview')}`}
            data-tooltip-placement="bottom"
            aria-label={`${t('fileViewer.reloadAria')} ${t('fileViewer.preview')}`}
          >
            <Icon name="reload" size={14} />
          </button>
          <div className="viewer-tabs" role="tablist" aria-label="View mode">
            {([
              ['preview', t('fileViewer.preview')],
              ['source', t('fileViewer.source')],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`viewer-tab ${mode === id ? 'active' : ''}`}
                aria-selected={mode === id}
                onClick={() => {
                  fireArtifactToolbarClick(id);
                  selectMode(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {showPreviewToolbarControls ? (
            <>
              <span className="viewer-divider" aria-hidden />
              <PreviewViewportControls
                viewport={previewViewport}
                onViewport={setPreviewViewport}
                t={t}
              />
            </>
          ) : null}
          {showPreviewToolbarControls && effectiveDeck ? (
            <span
              className="deck-nav"
              role="group"
              aria-label={t('fileViewer.slideNavAria')}
            >
              <button
                type="button"
                className="icon-only readable-tooltip"
                onClick={() => postSlide('prev')}
                title={t('fileViewer.previousSlide')}
                data-tooltip={t('fileViewer.previousSlide')}
                data-tooltip-placement="bottom"
                aria-label={t('fileViewer.previousSlide')}
                disabled={slideState !== null && slideState.active <= 0}
              >
                <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="deck-nav-counter">
                {slideState
                  ? `${slideState.active + 1} / ${slideState.count}`
                  : '— / —'}
              </span>
              <button
                type="button"
                className="icon-only readable-tooltip"
                onClick={() => postSlide('next')}
                title={t('fileViewer.nextSlide')}
                data-tooltip={t('fileViewer.nextSlide')}
                data-tooltip-placement="bottom"
                aria-label={t('fileViewer.nextSlide')}
                disabled={
                  slideState !== null &&
                  slideState.active >= slideState.count - 1
                }
              >
                <Icon name="chevron-right" size={14} />
              </button>
            </span>
          ) : null}
        </div>
        <div className="viewer-toolbar-actions">
          {showPreviewToolbarControls ? (
            <>
              {mode === 'preview' ? (
                <button
                  type="button"
                  className="viewer-action viewer-action-icon readable-tooltip"
                  data-testid="screenshot-copy-button"
                  data-tooltip={t('fileViewer.screenshot')}
                  data-tooltip-placement="bottom"
                  title={t('fileViewer.screenshot')}
                  aria-label={t('fileViewer.screenshot')}
                  onClick={handleCopyScreenshot}
                >
                  <RemixIcon name="screenshot-2-line" size={15} />
                </button>
              ) : null}
              <div className="artifact-tool-menu-anchor">
                <button
                  type="button"
                  className={`viewer-action viewer-action-icon viewer-comment-toggle readable-tooltip${boardMode && !commentCreateMode && boardTool === 'inspect' ? ' active' : ''}`}
                  data-testid="board-mode-toggle"
                  data-tooltip={t('fileViewer.comment')}
                  data-tooltip-placement="bottom"
                  title={t('fileViewer.comment')}
                  aria-label={t('fileViewer.comment')}
                  aria-pressed={boardMode && !commentCreateMode && boardTool === 'inspect'}
                  onClick={activateCommentTool}
                >
                  <RemixIcon name="chat-new-line" size={15} />
                </button>
              </div>
              <button
                className={`viewer-action viewer-action-icon readable-tooltip${drawOverlayOpen ? ' active' : ''}`}
                type="button"
                data-testid="draw-overlay-toggle"
                data-tooltip={t('fileViewer.mark')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.mark')}
                aria-label={t('fileViewer.mark')}
                aria-pressed={drawOverlayOpen}
                onClick={activateDrawTool}
              >
                <RemixIcon name="mark-pen-line" size={15} />
              </button>
              <span className="viewer-toolbar-tool-divider" aria-hidden />
              <button
                className={`viewer-action viewer-action-icon readable-tooltip${manualEditMode ? ' active' : ''}`}
                type="button"
                data-testid="manual-edit-mode-toggle"
                data-tooltip={t('fileViewer.edit')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.edit')}
                aria-label={t('fileViewer.edit')}
                aria-pressed={manualEditMode}
                onClick={activateManualEditTool}
              >
                <RemixIcon name="edit-line" size={15} />
              </button>
              <span className="viewer-toolbar-tool-divider" aria-hidden />
              <button
                type="button"
                className={`viewer-action viewer-comment-count-trigger viewer-comment-toggle readable-tooltip${boardMode && commentCreateMode ? ' active' : ''}`}
                data-testid="comment-panel-toggle"
                data-tooltip={t('chat.tabComments')}
                data-tooltip-placement="bottom"
                title={t('chat.tabComments')}
                aria-label={`${t('chat.tabComments')} (${visibleSideComments.length})`}
                aria-pressed={boardMode && commentCreateMode}
                onClick={activateCommentCreateTool}
              >
                <RemixIcon name="message-3-line" size={15} />
                <span className="viewer-comment-count" aria-hidden>{visibleSideComments.length}</span>
              </button>
              {source !== null && mode === 'preview' ? (
                <div className="zoom-menu viewer-toolbar-zoom" ref={zoomMenuRef}>
                  <button
                    type="button"
                    className="viewer-action zoom-trigger readable-tooltip"
                    aria-haspopup="menu"
                    aria-expanded={zoomMenuOpen}
                    title={t('fileViewer.resetZoom')}
                    data-tooltip={t('fileViewer.resetZoom')}
                    data-tooltip-placement="bottom"
                    onClick={() => {
                      fireArtifactToolbarClick('zoom_level_dropdown');
                      setZoomMenuOpen((v) => !v);
                    }}
                  >
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{zoom}%</span>
                  </button>
                  {zoomMenuOpen ? (
                    <div className="zoom-menu-popover" role="menu">
                      {[50, 75, 100, 125, 150, 200].map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`zoom-menu-item${zoom === level ? ' active' : ''}`}
                          role="menuitem"
                          onClick={() => {
                            setZoom(level);
                            setZoomMenuOpen(false);
                          }}
                        >
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{level}%</span>
                          {zoom === level ? (
                            <Icon name="check" size={13} />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {/* Docked (fallback) toolbars: only when no left-inspector host is
          provided (FileViewer used outside the project workspace). In the
          project workspace the controls render in the left inspector below. */}
      {!manualEditPortalId && manualEditMode && selectedManualEditTarget
        && (selectedManualEditTarget.kind === 'text'
          || selectedManualEditTarget.kind === 'link'
          || selectedManualEditTarget.kind === 'token'
          || !!selectedManualEditTarget.textEditTargetId) ? (
        <ManualEditTypographyToolbar
          target={selectedManualEditTarget}
          styles={manualEditDraft.styles}
          richFormat={manualEditRichFormat}
          onStyleField={(key, value) => applyManualEditStyleField({
            target: selectedManualEditTarget,
            draft: manualEditDraft,
            key,
            value,
            onDraftChange: setManualEditDraft,
            onError: setManualEditError,
            onInvalidStyle: cancelManualEditPendingStyles,
            onStyleChange: (id, styleUpdates, label) => { void handleManualEditStyleChange(id, styleUpdates, label); },
          })}
          onRichFormat={sendManualEditRichFormat}
        />
      ) : null}
      {!manualEditPortalId && manualEditShapeToolbarActive && selectedManualEditTarget ? (
        <ManualEditShapeToolbar
          target={selectedManualEditTarget}
          styles={manualEditDraft.styles}
          draftAlt={manualEditDraft.alt}
          error={manualEditError}
          resizeConstraints={manualEditResizeFeedback?.targetId === selectedManualEditTarget.id
            ? manualEditResizeFeedback.constraints
            : undefined}
          announceResizeConstraints={manualEditResizeFeedback?.targetId === selectedManualEditTarget.id
            && manualEditResizeFeedback.announce}
          busy={manualEditSaving}
          canUndo={manualEditHistory.length > 0}
          canRedo={manualEditUndone.length > 0}
          getActiveTarget={() => selectedManualEditTargetRef.current}
          onStyleField={(key, value) => applyManualEditStyleField({
            target: selectedManualEditTarget,
            draft: manualEditDraft,
            key,
            value,
            onDraftChange: setManualEditDraft,
            onError: setManualEditError,
            onInvalidStyle: cancelManualEditPendingStyles,
            onStyleChange: (id, styleUpdates, label) => { void handleManualEditStyleChange(id, styleUpdates, label); },
          })}
          onApplyPatch={(patch, label) => { void applyManualEdit(patch, label); }}
          onPickImage={pickManualEditImage}
          onError={setManualEditError}
          onUndo={() => { void undoManualEdit(); }}
          onRedo={() => { void redoManualEdit(); }}
        />
      ) : null}
      {/* Left-panel inspector: the primary manual-edit surface in the project
          workspace. Portaled into the chat slot host provided by ProjectView. */}
      {manualEditMode && manualEditPortalHost
        ? createPortal(
            <ManualEditLeftInspector
              target={selectedManualEditTarget}
              styles={manualEditDraft.styles}
              richFormat={manualEditRichFormat}
              draftAlt={manualEditDraft.alt}
              error={manualEditError}
              resizeConstraints={selectedManualEditTarget && manualEditResizeFeedback?.targetId === selectedManualEditTarget.id
                ? manualEditResizeFeedback.constraints
                : undefined}
              announceResizeConstraints={!!selectedManualEditTarget
                && manualEditResizeFeedback?.targetId === selectedManualEditTarget.id
                && manualEditResizeFeedback.announce}
              busy={manualEditSaving}
              canUndo={manualEditHistory.length > 0}
              canRedo={manualEditUndone.length > 0}
              pageStylesEnabled={manualEditPageStylesEnabled}
              getActiveTarget={() => selectedManualEditTargetRef.current}
              onStyleField={(key, value) => {
                if (!selectedManualEditTarget) return;
                applyManualEditStyleField({
                  target: selectedManualEditTarget,
                  draft: manualEditDraft,
                  key,
                  value,
                  onDraftChange: setManualEditDraft,
                  onError: setManualEditError,
                  onInvalidStyle: cancelManualEditPendingStyles,
                  onStyleChange: (id, styleUpdates, label) => { void handleManualEditStyleChange(id, styleUpdates, label); },
                });
              }}
              onStyleFields={(styleUpdates) => {
                if (!selectedManualEditTarget) return;
                applyManualEditStyleFields({
                  target: selectedManualEditTarget,
                  draft: manualEditDraft,
                  styles: styleUpdates,
                  onDraftChange: setManualEditDraft,
                  onError: setManualEditError,
                  onInvalidStyle: cancelManualEditPendingStyles,
                  onStyleChange: (id, normalizedStyles, label) => { void handleManualEditStyleChange(id, normalizedStyles, label); },
                });
              }}
              onRichFormat={sendManualEditRichFormat}
              onApplyPatch={(patch, label) => { void applyManualEdit(patch, label); }}
              onPickImage={pickManualEditImage}
              onError={setManualEditError}
              onUndo={() => { void undoManualEdit(); }}
              onRedo={() => { void redoManualEdit(); }}
              onPageStyleChange={(id, pageStyles, label) => { void handleManualEditStyleChange(id, pageStyles, label); }}
              onPageInvalidStyle={cancelManualEditPendingStyles}
              onExit={activateManualEditTool}
            />,
            manualEditPortalHost,
          )
        : null}
      {((filePrimaryActions: ReactNode) => (
        chromeActionsHost ? createPortal(filePrimaryActions, chromeActionsHost) : filePrimaryActions
      ))(<>
          {showPresent ? (
            <div className="present-wrap chrome-present-wrap">
              <button
                className="chrome-action chrome-action-secondary chrome-action-icon present-trigger readable-tooltip"
                aria-haspopup="menu"
                aria-expanded={presentMenuOpen}
                aria-label={t('fileViewer.present')}
                data-tooltip={t('fileViewer.present')}
                data-tooltip-placement="bottom"
                title={t('fileViewer.present')}
                onClick={() => {
                  fireArtifactHeaderClick('present_dropdown');
                  setPresentMenuOpen((v) => !v);
                }}
              >
                <RemixIcon name="slideshow-3-line" size={15} />
              </button>
              {presentMenuOpen ? (
                <div className="present-menu" role="menu">
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('in_this_tab'); presentInThisTab(); }}>
                    <span className="present-icon"><RemixIcon name="eye-line" size={14} /></span>{' '}
                    {t('fileViewer.presentInTab')}
                  </button>
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('fullscreen'); presentFullscreen(); }}>
                    <span className="present-icon"><RemixIcon name="play-line" size={14} /></span>{' '}
                    {t('fileViewer.presentFullscreen')}
                  </button>
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('new_tab'); presentNewTab(); }}>
                    <span className="present-icon"><RemixIcon name="share-forward-line" size={14} /></span>{' '}
                    {t('fileViewer.presentNewTab')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {canShare || canDownload ? (
            <div className="chrome-file-action-menus" ref={shareRef}>
              {canShare ? (
                <div className="share-menu chrome-share-menu">
                  <button
                    type="button"
                    className="chrome-action chrome-action-secondary chrome-action-with-label chrome-action-text-only"
                    aria-haspopup="menu"
                    aria-expanded={deployMenuOpen}
                    aria-label={shareMenuLabel}
                    onClick={openDeployMenu}
                  >
                    <span>{shareMenuLabel}</span>
                  </button>
                  {deployMenuOpen ? (
                    <div className="share-menu-popover" role="menu">
                      <div className="share-menu-section-label" role="presentation">
                        {t('fileViewer.shareMenuShareLink')}
                      </div>
                      {sharePageUrl ? (
                        <>
                          <button
                            type="button"
                            className="share-menu-item"
                            role="menuitem"
                            disabled={!canCopyShareLink}
                            title={!canCopyShareLink ? shareUnavailableHint : shareLinkStatusHint || undefined}
                            onClick={() => {
                              if (!canCopyShareLink || !sharePageUrl) return;
                              fireShareExport('share_link', async () => {
                                const ok = await copyShareLink(sharePageUrl);
                                if (!ok) throw new Error('copy_share_link_failed');
                              });
                            }}
                          >
                            <span className="share-menu-icon"><RemixIcon name="file-copy-line" size={15} /></span>
                            <span className="share-menu-text">
                              <span>{copyShareLinkLabel}</span>
                              {shareLinkStatusHint ? (
                                <small>{shareLinkStatusHint}</small>
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="share-menu-item"
                            role="menuitem"
                            disabled={!canOpenSharePage}
                            title={!canOpenSharePage ? shareLinkStatusHint || shareUnavailableHint : shareLinkStatusHint || undefined}
                            onClick={() => {
                              if (!canOpenSharePage || !sharePageUrl) return;
                              setDeployMenuOpen(false);
                              fireShareExport('share_page', () => {
                                window.open(sharePageUrl, '_blank', 'noopener');
                              });
                            }}
                          >
                            <span className="share-menu-icon"><RemixIcon name="external-link-line" size={15} /></span>
                            <span className="share-menu-text">
                              <span>{t('fileViewer.openSharePage')}</span>
                              {shareLinkStatusHint ? (
                                <small>{shareLinkStatusHint}</small>
                              ) : null}
                            </span>
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="share-menu-item share-menu-guide"
                          role="menuitem"
                          title={shareUnavailableHint}
                          onClick={() => {
                            setShareGuideToast(shareUnavailableHint);
                          }}
                        >
                          <span className="share-menu-icon"><RemixIcon name="link" size={15} /></span>
                          <span className="share-menu-text">
                            <span>
                              {streaming
                                ? t('fileViewer.shareAfterGenerationComplete')
                                : t('fileViewer.shareLinkPublishGuide')}
                            </span>
                          </span>
                        </button>
                      )}
                      <div className="share-menu-divider" />
                      <div className="share-menu-section-label" role="presentation">
                        {t('fileViewer.shareMenuPublishOnline')}
                      </div>
                      {DEPLOY_PROVIDER_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className="share-menu-item"
                          role="menuitem"
                          onClick={() => {
                            const format =
                              option.id === 'cloudflare-pages'
                                ? 'cloudflare_pages'
                                : option.id === 'vercel-self'
                                  ? 'vercel'
                                  : 'vercel';
                            fireShareExport(format, () => openDeployModal(option.id));
                          }}
                        >
                          <span className="share-menu-icon">
                            <RemixIcon name={deployActionIconFor(option.id)} size={15} />
                          </span>
                          <span>{deployActionLabelFor(option.id)}</span>
                        </button>
                      ))}
                      <div className="share-menu-divider" />
                      <div className="share-menu-section-label" role="presentation">
                        {t('socialShare.projectSection')}
                      </div>
                      <button
                        type="button"
                        className="share-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setDeployMenuOpen(false);
                          fireShareExport('vercel', () => openSocialShareFlow());
                        }}
                      >
                        <span className="share-menu-icon">
                          <RemixIcon
                            name={activeProjectSocialShare ? 'share-forward-line' : 'upload-cloud-line'}
                            size={15}
                          />
                        </span>
                        <span>{socialShareMenuLabel}</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {canDownload ? (
                <div className="share-menu chrome-share-menu">
                  <button
                    type="button"
                    className={
                      'chrome-action chrome-action-primary chrome-action-export' +
                      (exportReadyNudge ? ' export-ready-nudge' : '')
                    }
                    aria-haspopup="menu"
                    aria-expanded={downloadMenuOpen}
                    onClick={openDownloadMenu}
                  >
                    <span>{t('fileViewer.download')}</span>
                  </button>
                  {downloadMenuOpen ? (
                    <div className="share-menu-popover" role="menu">
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      fireShareExport('pdf', () => exportProjectAsPdf({
                        deck: effectiveDeck,
                        fallbackPdf: () => exportAsPdf(source ?? '', exportTitle, { deck: effectiveDeck }),
                        filePath: file.name,
                        projectId,
                        title: exportTitle,
                      }));
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                    <span>{t('fileViewer.exportPdf')}</span>
                  </button>
                  {showPptxExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      disabled={!canPptx}
                      title={
                        onExportAsPptx
                          ? streaming
                            ? t('fileViewer.exportPptxBusy')
                            : t('fileViewer.exportPptxHint')
                          : t('fileViewer.exportPptxNa')
                      }
                      onClick={() => {
                        setDownloadMenuOpen(false);
                        fireShareExport('pptx', () => {
                          if (onExportAsPptx) onExportAsPptx(file.name);
                        });
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-ppt-line" size={15} /></span>
                      <span>{t('fileViewer.exportPptx')}</span>
                    </button>
                  ) : null}
                  {showImageExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={openImageExportModal}
                    >
                      <span className="share-menu-icon"><RemixIcon name="image-line" size={15} /></span>
                      <span>{t('fileViewer.exportImage')}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      fireShareExport('zip', () => exportProjectAsZip({
                        projectId,
                        filePath: file.name,
                        fallbackHtml: source ?? '',
                        fallbackTitle: exportTitle,
                      }));
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-zip-line" size={15} /></span>
                    <span>{t('fileViewer.exportZip')}</span>
                  </button>
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      fireShareExport('html', async () => {
                        try {
                          const summary = await exportProjectAsHtml({
                            projectId,
                            filePath: file.name,
                            title: exportTitle,
                          });
                          const external = summary.externalReferenceCount;
                          const missing = summary.missingLocalReferenceCount;
                          setExportToast({
                            message: external && missing
                              ? t('fileViewer.standaloneExportExternalAndMissing', { external, missing })
                              : external
                                ? t('fileViewer.standaloneExportExternal', { count: external })
                                : missing
                                  ? t('fileViewer.standaloneExportMissing', { count: missing })
                                  : t('fileViewer.standaloneExportSuccess'),
                            tone: 'default',
                          });
                        } catch (error) {
                          setExportToast({
                            message: error instanceof Error && error.name === 'PAYLOAD_TOO_LARGE'
                              ? t('fileViewer.standaloneExportTooLarge')
                              : t('fileViewer.standaloneExportFailed'),
                            tone: 'error',
                          });
                          throw error;
                        }
                      });
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-code-line" size={15} /></span>
                    <span>{t('fileViewer.exportHtml')}</span>
                  </button>
                  {showMarkdownExport ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setDownloadMenuOpen(false);
                        fireShareExport('markdown', () => exportAsMd(source ?? '', exportTitle));
                      }}
                    >
                      <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                      <span>{t('fileViewer.exportMd')}</span>
                    </button>
                  ) : null}
                  <div className="share-menu-divider" />
                  <div className="share-menu-section-label" role="presentation">
                    {t('fileViewer.shareMenuSave')}
                  </div>
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    disabled={savingTemplate}
                    onClick={() => {
                      fireShareExport('template', () => {
                        openSaveAsTemplateModal();
                      });
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-copy-line" size={15} /></span>
                    <span>
                      {savingTemplate
                        ? t('fileViewer.savingTemplate')
                        : templateNote
                          ? templateNote
                          : t('fileViewer.saveAsTemplate')}
                    </span>
                  </button>
                </div>
                ) : null}
              </div>
              ) : null}
            </div>
          ) : null}
        </>)}
      <div className="viewer-body" ref={previewBodyRef}>
        {source === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'preview' ? (
          <div
            className={`${manualEditMode ? 'manual-edit-workspace' : commentPreviewLayoutClass} preview-viewport preview-viewport-${previewViewport}${drawOverlayOpen ? ' preview-draw-active' : ''}`}
            data-testid={manualEditMode ? undefined : 'comment-preview-layout'}
            style={previewViewportStyle(previewViewport, previewScale, boardPreviewCanvasSize, boardPreviewScaleOptions)}
            onMouseLeave={manualEditMode ? clearManualEditHover : undefined}
          >
            {manualEditPanel}
            {manualEditHoverAffordance}
            {manualEditMoveFrame}
            {manualEditResizeHandles}
            {/* Guides paint above the resize handles (z-index 33 over 32). */}
            <ManualEditSnapGuides
              guides={manualEditSnapGuides}
              scale={overlayPreviewScale}
              offsetX={manualEditOverlayTransform.offsetX}
              offsetY={manualEditOverlayTransform.offsetY}
            />
            {manualEditMovementAnnouncement && manualEditMovementAnnouncement.length > 0 ? (
              <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
                {manualEditMovementAnnouncement.map((segment, index) => (
                  <span key={segment.key + index}>
                    {t(segment.key, { amount: segment.amount })}
                    {index < manualEditMovementAnnouncement.length - 1 ? ', ' : ''}
                  </span>
                ))}
              </VisuallyHidden>
            ) : null}
            <div
              className={manualEditMode ? 'manual-edit-canvas' : 'comment-preview-canvas'}
              data-testid={manualEditMode ? undefined : 'comment-preview-canvas'}
            >
              <div className={manualEditMode ? undefined : 'comment-frame-clip'} style={manualEditMode ? { height: '100%' } : undefined}>
                <div style={previewScaleShellStyle(previewViewport, previewScale)}>
                  <PreviewDrawOverlay
                    active={drawOverlayOpen}
                    onActiveChange={setDrawOverlayOpen}
                    captureViewport
                    captureSnapshot={captureExportImageSnapshot}
                    captureTarget={null}
                    filePath={file.name}
                    sendDisabled={streaming}
                    sendDisabledReason={t('chat.annotationSendDisabledReason')}
                    onToolbarClick={fireDrawToolbarClick}
                  >
                    <div className="artifact-preview-transport-stack">
                      {READABLE_PREVIEW_KEEP_ALIVE ? (
                        <PooledIframe
                          ref={urlPreviewIframeRef}
                          cacheKey={urlPreviewKeepAliveKey}
                          data-testid={useUrlLoadPreview ? 'artifact-preview-frame' : 'artifact-preview-frame-url-load'}
                          data-readable-render-mode="url-load"
                          data-readable-active={useUrlLoadPreview ? 'true' : 'false'}
                          aria-hidden={useUrlLoadPreview ? undefined : true}
                          tabIndex={useUrlLoadPreview ? 0 : -1}
                          title={file.name}
                          sandbox="allow-scripts allow-downloads"
                          src={urlTransportSrc}
                          onLoad={() => {
                            const frame = urlPreviewIframeRef.current;
                            if (useUrlLoadPreview) iframeRef.current = frame;
                            setUrlSelectionBridgeReady(false);
                            dcViewportRestoreAtRef.current = Date.now();
                            frame?.contentWindow?.postMessage({
                              type: '__dc_set_viewport',
                              ...dcViewportRef.current,
                            }, '*');
                            frame?.contentWindow?.postMessage({ type: 'readable-studio:url-selection-bridge-probe' }, '*');
                            syncBridgeModes(frame);
                            if (useUrlLoadPreview) restorePreviewScrollPosition();
                          }}
                        />
                      ) : (
                        <iframe
                          ref={urlPreviewIframeRef}
                          data-testid={useUrlLoadPreview ? 'artifact-preview-frame' : 'artifact-preview-frame-url-load'}
                          data-readable-render-mode="url-load"
                          data-readable-active={useUrlLoadPreview ? 'true' : 'false'}
                          aria-hidden={useUrlLoadPreview ? undefined : true}
                          tabIndex={useUrlLoadPreview ? 0 : -1}
                          title={file.name}
                          sandbox="allow-scripts allow-downloads"
                          src={urlTransportSrc}
                          onLoad={() => {
                            const frame = urlPreviewIframeRef.current;
                            if (useUrlLoadPreview) iframeRef.current = frame;
                            setUrlSelectionBridgeReady(false);
                            dcViewportRestoreAtRef.current = Date.now();
                            frame?.contentWindow?.postMessage({
                              type: '__dc_set_viewport',
                              ...dcViewportRef.current,
                            }, '*');
                            frame?.contentWindow?.postMessage({ type: 'readable-studio:url-selection-bridge-probe' }, '*');
                            syncBridgeModes(frame);
                            if (useUrlLoadPreview) restorePreviewScrollPosition();
                          }}
                        />
                      )}
                      <iframe
                        key={srcDocTransportResetKey}
                        ref={srcDocPreviewIframeRef}
                        data-testid={useUrlLoadPreview ? 'artifact-preview-frame-srcdoc' : 'artifact-preview-frame'}
                        data-readable-render-mode="srcdoc"
                        data-readable-active={useUrlLoadPreview ? 'false' : 'true'}
                        aria-hidden={useUrlLoadPreview ? true : undefined}
                        tabIndex={useUrlLoadPreview ? -1 : 0}
                        title={file.name}
                        sandbox="allow-scripts allow-downloads"
                        srcDoc={srcDocTransportContent}
                        onLoad={() => {
                          const frame = srcDocPreviewIframeRef.current;
                          if (!useUrlLoadPreview) iframeRef.current = frame;
                          // Reset the activation dedupe exactly ONCE per
                          // freshly mounted iframe DOM node, never on the
                          // subsequent load events that the same node
                          // emits during normal srcDoc rendering.
                          //
                          // The iframe's load event fires twice for one
                          // successful activation: once when the lazy
                          // transport shell HTML loads, and again when
                          // our own document.open/write/close inside the
                          // shell finishes. PR #2699 reset the dedupe on
                          // every load so that switching
                          // preview -> source -> preview (which remounts
                          // this iframe as a fresh DOM node) would
                          // re-activate the new shell. But resetting on
                          // every load also re-activated on the SECOND
                          // load of a non-remounted frame, which
                          // re-triggered document.open/write/close, which
                          // re-fired the load event, ad infinitum. The
                          // dedupe ref oscillated between null and the
                          // current srcDoc thousands of times per render
                          // and each iteration restarted every CSS
                          // animation from its `from` keyframe. Designs
                          // using `animation-fill-mode: both` with
                          // `from { opacity: 0 }` stayed at opacity 0
                          // forever and the preview read as blank.
                          // That is issue #2361.
                          //
                          // Tracking the last frame we reset for lets us
                          // keep PR #2699's "remount after Source toggle"
                          // fix while breaking the loop on plain renders.
                          if (frame && srcDocFrameDedupeResetForRef.current !== frame) {
                            srcDocFrameDedupeResetForRef.current = frame;
                            activatedSrcDocTransportHtmlRef.current = null;
                          }
                          if (useLazySrcDocTransport) setSrcDocShellReady(true);
                          activateLoadedSrcDocTransport(frame);
                          dcViewportRestoreAtRef.current = Date.now();
                          frame?.contentWindow?.postMessage({
                            type: '__dc_set_viewport',
                            ...dcViewportRef.current,
                          }, '*');
                          replayInspectOverridesToIframe(frame);
                          syncBridgeModes(frame);
                          syncCachedSlideStateToIframe(frame);
                          if (!useUrlLoadPreview) restorePreviewScrollPosition();
                        }}
                      />
                    </div>
                  </PreviewDrawOverlay>
                </div>
              </div>
              {boardMode ? (
                <CommentPreviewOverlays
                  comments={commentCreateMode ? visibleSideComments : []}
                  liveTargets={liveCommentTargets}
                  hoveredTarget={hoveredCommentTarget}
                  hoveredPodMemberId={hoveredPodMemberId}
                  activeTarget={activeCommentTarget}
                  activeExistingCommentId={activeComposerComment?.id ?? null}
                  boardTool={boardTool}
                  showActivePin={commentCreateMode}
                  scale={overlayPreviewScale}
                  offsetX={overlayPreviewTransform.offsetX}
                  offsetY={overlayPreviewTransform.offsetY}
                  strokePoints={strokePoints}
                  activeSlideIndex={effectiveDeck ? slideState?.active ?? null : null}
                  onOpenComment={(comment, snapshot) => {
                    setCommentPanelOpen(true);
                    setCommentSidePanelCollapsed(false);
                    setCommentCreateMode(true);
                    setBoardMode(true);
                    setActiveCommentTarget(snapshot);
                    setHoveredCommentTarget(snapshot);
                    setActivePreviewCommentId(comment.id);
                    setCommentDraft(comment.note);
                    setQueuedBoardNotes([]);
                    setActiveCommentExistingAttachments(comment.attachments ?? []);
                  }}
                />
              ) : null}
              {/* Portaled to <body> so the screenshot/export toast escapes the
                  preview pane's transform + overflow:hidden. */}
              {exportToast
                ? createPortal(
                    <Toast
                      message={exportToast.message}
                      tone={exportToast.tone}
                      role={exportToast.tone === 'error' ? 'alert' : 'status'}
                      ttlMs={exportToast.tone === 'loading' ? 8000 : 2200}
                      placement="top"
                      onDismiss={() => setExportToast(null)}
                    />,
                    document.body,
                  )
                : null}
              {commentSavedToast ? (
                <div className="comment-toast-anchor">
                  <Toast
                    message={commentSavedToast}
                    ttlMs={2200}
                    onDismiss={() => setCommentSavedToast(null)}
                  />
                </div>
              ) : null}
              {templateSavedToast ? (
                <div className="comment-toast-anchor">
                  <Toast
                    message={templateSavedToast}
                    ttlMs={2200}
                    onDismiss={() => setTemplateSavedToast(null)}
                  />
                </div>
              ) : null}
              {commentComposer}
              {boardMode && !commentCreateMode && hoveredCommentTarget && (!activeCommentTarget || commentPortalHost) ? (
                <AnnotationHoverPopover
                  target={hoveredCommentTarget}
                  scale={overlayPreviewScale}
                  onMouseEnter={() => {
                    hoverCardPinnedRef.current = true;
                    cancelHoverCardDismiss();
                  }}
                  onMouseLeave={() => {
                    hoverCardPinnedRef.current = false;
                    scheduleHoverCardDismiss();
                  }}
                />
              ) : null}
              {/*
                Hint banner for Inspect / Picker modes. The bridge in
                `apps/web/src/runtime/srcdoc.ts` posts `readable-studio:comment-targets`
                with every element annotated with `data-readable-id` /
                `data-screen-label`, so `liveCommentTargets.size` is the
                authoritative annotation count for the current artifact.

                Two states:
                - "has targets": the existing copy ("Click any element with
                  `data-readable-id` to tune its style.") for users who just don't
                  see the crosshair cursor.
                - "no targets" (issue #890): a freeform-generated artifact
                  (e.g. PRD → HTML through a Claude-Code-compatible CLI
                  without a skill) ships zero `data-readable-id` annotations. The
                  bridge's click handler walks up to <html>, finds nothing,
                  and bails — clicks no-op silently. The static copy made
                  this look broken; the empty-state copy explains what's
                  missing and how to fix it. Mirrored across Inspect and
                  element-pick annotation mode because the failure surface is identical.
              */}
              {inspectMode
                && openHintBox
                && !activeInspectTarget
                && !activeCommentTarget ? (
                <div
                  className="inspect-empty-hint-container"
                  data-testid="inspect-empty-hint-container"
                >
                  {liveCommentTargets.size === 0 ? (
                    <div
                      className="inspect-empty-hint"
                      data-testid="inspect-empty-hint-no-targets"
                    >
                      {inspectMode
                        ? t('chat.inspect.noEditableTargets')
                        : t('chat.inspect.noCommentTargets')}
                    </div>
                  ) : (
                    <div
                      className="inspect-empty-hint"
                      data-testid="inspect-empty-hint"
                    >
                      {inspectMode ? t('chat.inspect.editHint') : t('chat.inspect.commentHint')}
                    </div>
                  )}
                  <button
                    type="button"
                    title="Close Inspect Hint"
                    aria-label="Close Inspect Hint"
                    onClick={() => setOpenHintBox(false)}
                    className="ghost-icon-btn"
                  >
                    <Icon className="" name="close" size={12} />
                  </button>
                </div>
              ) : null}
            </div>
            {boardImagePreviewModal}
            {commentPortalHost && commentSidePanel
              ? createPortal(commentSidePanel, commentPortalHost)
              : commentPortalId
                ? null
                : commentSidePanel}
            {inspectMode && activeInspectTarget ? (
              <InspectPanel
                target={activeInspectTarget}
                onApply={(prop, value) => {
                  const target = activeInspectTarget;
                  setInspectOverrides((current) =>
                    updateInspectOverride(current, target.elementId, target.selector, prop, value),
                  );
                  postInspectSet(target.elementId, target.selector, prop, value);
                }}
                onResetElement={(elementId) => {
                  setInspectOverrides((current) => {
                    if (!(elementId in current)) return current;
                    const next = { ...current };
                    delete next[elementId];
                    return next;
                  });
                  postInspectReset(elementId);
                  setActiveInspectTarget((current) => current && current.elementId === elementId
                    ? current
                    : current);
                }}
                onSaveToSource={() => {
                  void saveInspectToSource();
                }}
                onClose={() => {
                  setActiveInspectTarget(null);
                  if (boardMode && boardTool === 'inspect') {
                    setActiveCommentTarget(null);
                    setHoveredCommentTarget(null);
                  }
                }}
                saving={savingInspect}
                savedAt={inspectSavedAt}
                error={inspectError}
              />
            ) : null}
          </div>
        ) : (
          <pre className="viewer-source">{source}</pre>
        )}
      </div>
      {inTabPresent && source && typeof document !== 'undefined' ? createPortal(
        <div
          className="present-overlay"
          role="dialog"
          aria-label={t('fileViewer.exitPresentation')}
        >
          <button
            className="present-exit"
            onClick={() => setInTabPresent(false)}
            aria-label={t('fileViewer.exitPresentation')}
          >
            <Icon name="close" size={13} /> {t('fileViewer.exitPresentation')}
          </button>
          {useUrlLoadPreview ? (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-readable-render-mode="url-load"
              src={activePreviewSrcUrl}
            />
          ) : (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-readable-render-mode="srcdoc"
              srcDoc={srcDoc}
            />
          )}
        </div>,
        document.body,
      ) : null}
      {imageExportModalOpen && typeof document !== 'undefined' ? createPortal(
        <div className="modal-backdrop viewer-modal-backdrop image-export-backdrop" role="presentation">
          <div
            className="modal deploy-modal image-export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={imageExportTitleId}
          >
            <div className="modal-head">
              <div className="kicker">IMAGE</div>
              <h2 id={imageExportTitleId}>{t('fileViewer.exportImage')}</h2>
              <p className="subtitle">{t('fileViewer.exportImageModalSubtitle')}</p>
            </div>
            <div className="deploy-form image-export-form">
              <fieldset className="image-export-format-field" disabled={imageExportBusy}>
                <legend>{t('fileViewer.exportImageFormatLabel')}</legend>
                <div className="image-export-format-options">
                  {IMAGE_EXPORT_FORMAT_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`image-export-format-option${imageExportFormat === option.value ? ' active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="image-export-format"
                        value={option.value}
                        aria-label={option.label}
                        checked={imageExportFormat === option.value}
                        onChange={() => changeImageExportFormat(option.value)}
                      />
                      <span className="image-export-format-text">
                        <strong>{option.label}</strong>
                        <span aria-hidden="true">{option.extension}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {imageExportError ? (
                <p className="deploy-error" role="alert">{imageExportError}</p>
              ) : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                disabled={imageExportBusy}
                onClick={() => {
                  setImageExportModalOpen(false);
                  setImageExportError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={imageExportBusy || imageExportPreparing || !imageExportPreparedBlob}
                onClick={() => {
                  void handleImageExportSave();
                }}
              >
                {imageExportBusy ? t('fileViewer.exportImageSaving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {templateModalOpen && typeof document !== 'undefined' ? createPortal(
        <div className="modal-backdrop viewer-modal-backdrop" role="presentation">
          <div className="modal deploy-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="kicker">TEMPLATE</div>
              <h2>{t('fileViewer.saveAsTemplate')}</h2>
              <p className="subtitle">{t('fileViewer.templateDescPrompt')}</p>
            </div>
            <div className="deploy-form">
              <label className="field" htmlFor={templateNameId}>
                <span className="field-label">{t('fileViewer.templateNamePrompt')}</span>
                <input
                  id={templateNameId}
                  type="text"
                  value={templateName}
                  placeholder={t('fileViewer.templateNameDefault')}
                  autoFocus
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
              <label className="field" htmlFor={templateDescriptionId}>
                <span className="field-label">{t('fileViewer.templateDescPrompt')}</span>
                <textarea
                  id={templateDescriptionId}
                  rows={3}
                  value={templateDescription}
                  placeholder={t('fileViewer.optional')}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                />
              </label>
              {templateSaveError ? <p className="deploy-error">{templateSaveError}</p> : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                disabled={savingTemplate}
                onClick={() => {
                  setTemplateModalOpen(false);
                  setTemplateSaveError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={savingTemplate || !templateName.trim()}
                onClick={() => {
                  void handleSaveAsTemplate();
                }}
              >
                {savingTemplate ? t('fileViewer.savingTemplate') : t('common.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {deployModalOpen && typeof document !== 'undefined' ? createPortal(
        <div
          className="modal-backdrop viewer-modal-backdrop deploy-flow-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDeployModal();
          }}
        >
          <div className="modal deploy-modal deploy-flow-modal" role="dialog" aria-modal="true">
            <div className="deploy-flow-modal__scroll">
              <div className="modal-head">
                <div className="kicker">{deployProviderLabel}</div>
                <h2>{t('fileViewer.deployToProvider', { provider: deployProviderLabel })}</h2>
                <p className="subtitle">{t('fileViewer.deployModalSubtitle')}</p>
              </div>
              <div className="deploy-form">
                <div className={`deploy-social-share${activeProjectSocialShare ? '' : ' is-locked'}${socialShareBlockedState ? ` is-${socialShareBlockedState}` : ''}`}>
                  <div className="deploy-social-share__head">
                    <div className="deploy-social-share__label">
                      {t('socialShare.projectSection')}
                    </div>
                    {socialShareDisplayUrl ? (
                      <a
                        className="deploy-social-share__url"
                        href={socialShareDisplayUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {socialShareDisplayUrl}
                      </a>
                    ) : null}
                  </div>
                  {!activeProjectSocialShare || socialShareBlockedState ? (
                    <p className="hint">{socialShareUnavailableMessage}</p>
                  ) : null}
                  {activeProjectSocialShare ? (
                    <SocialShareGrid
                      share={activeProjectSocialShare}
                      onAfterShare={closeDeployModal}
                    />
                  ) : null}
                  {socialShareBlockedDeployment?.url ? (
                    <div className="deploy-social-share__actions">
                      <button
                        type="button"
                        className="viewer-action"
                        onClick={() => {
                          void copyDeployLink(socialShareBlockedDeployment.url);
                        }}
                      >
                        <Icon name="copy" size={14} />
                        <span>{copyDeployLabel(socialShareBlockedDeployment.url)}</span>
                      </button>
                      {activeDeployment?.id === socialShareBlockedDeployment.id ? (
                        <button
                          type="button"
                          className="viewer-action"
                          disabled={deployPhase === 'preparing-link'}
                          onClick={() => {
                            void retryDeploymentLink();
                          }}
                        >
                          {deployPhase === 'preparing-link'
                            ? t('fileViewer.preparingPublicLink')
                            : t('fileViewer.retryLink')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              <label className="deploy-provider-field">
                <span className="deploy-field-title">{t('fileViewer.deployProviderLabel')}</span>
                <select
                  value={deployProviderId}
                  onChange={(e) => {
                    void changeDeployProvider(e.target.value as WebDeployProviderId);
                  }}
                >
                  {DEPLOY_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-label-row deploy-token-label-row">
                <label htmlFor="deploy-token" className="deploy-field-title required">{t(deployProvider.tokenLabelKey)}</label>
                <a
                  href={deployProvider.tokenLink}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t(deployProvider.tokenLinkKey)}
                </a>
              </div>
              <div className="deploy-token-input-row">
                <input
                  ref={deployTokenInputRef}
                  id="deploy-token"
                  type="password"
                  value={deployToken}
                  placeholder={t(deployProvider.tokenPlaceholderKey, { provider: deployProviderLabel })}
                  onChange={(e) => setDeployToken(e.target.value)}
                />
                <button
                  type="button"
                  className="ghost-link button-like"
                  disabled={savingDeployConfig}
                  onClick={() => {
                    void saveDeployConfig();
                  }}
                >
                  {savingDeployConfig ? t('fileViewer.savingConfig') : t('fileViewer.save')}
                </button>
              </div>
              {deployConfig?.configured || deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID ? (
                <div className="deploy-token-hints">
                  {deployConfig?.configured ? (
                    <p className="hint">{t(deployProvider.tokenReuseHintKey, { provider: deployProviderLabel })}</p>
                  ) : null}
                  {deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID ? (
                    <p className="hint">{t('fileViewer.cloudflareApiTokenScopeHint')}</p>
                  ) : null}
                </div>
              ) : null}
              {deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID ? (
                <>
                  <div className="deploy-field-grid single-field">
                    <label>
                      <span className="deploy-field-title required">{t('fileViewer.cloudflareAccountId')}</span>
                      <input
                        value={cloudflareAccountId}
                        onChange={(e) => setCloudflareAccountId(e.target.value)}
                      />
                      <span className="field-hint">{t('fileViewer.cloudflareAccountIdHint')}</span>
                    </label>
                  </div>
                  <div className="deploy-field-grid cloudflare-domain-grid">
                    <label>
                      <span className="deploy-field-title">{t('fileViewer.cloudflareDomainPrefixLabel')}</span>
                      <input
                        value={cloudflareDomainPrefix}
                        placeholder={t('fileViewer.cloudflareDomainPrefixPlaceholder')}
                        onChange={(e) => setCloudflareDomainPrefix(e.target.value)}
                      />
                    </label>
                    <div className="deploy-field-control">
                      <span className="deploy-field-title-row">
                        <label className="deploy-field-title" htmlFor="cloudflare-zone-select">
                          {t('fileViewer.cloudflareZoneLabel')}
                        </label>
                        <button
                          type="button"
                          className="ghost-link deploy-field-inline-action"
                          disabled={cloudflareZonesLoading || !deployConfig?.configured}
                          onClick={() => {
                            void loadCloudflareZones();
                          }}
                        >
                          <RemixIcon name="refresh-line" size={13} />
                          {cloudflareZonesLoading ? t('fileViewer.cloudflareZonesLoading') : t('fileViewer.cloudflareZonesRefresh')}
                        </button>
                      </span>
                      <select
                        id="cloudflare-zone-select"
                        value={cloudflareZoneId}
                        disabled={cloudflareZonesLoading || (!deployConfig?.configured && !cloudflareZones.length)}
                        onChange={(e) => setCloudflareZoneId(e.target.value)}
                      >
                        {cloudflareZones.length === 0 ? (
                          <option value="">{t('fileViewer.cloudflareZonePlaceholder')}</option>
                        ) : null}
                        {cloudflareZones.map((zone) => (
                          <option key={zone.id} value={zone.id}>
                            {zone.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {cloudflareZonesError ? (
                    <p className="deploy-error">{cloudflareZonesError}</p>
                  ) : cloudflareZonesLoading ? (
                    <p className="hint">{t('fileViewer.cloudflareZonesLoading')}</p>
                  ) : deployConfig?.configured && cloudflareZones.length === 0 ? (
                    <p className="hint">{t('fileViewer.cloudflareZonesEmpty')}</p>
                  ) : null}
                  {cloudflareDomainPrefix.trim() && !isValidCloudflareDomainPrefixInput(cloudflareDomainPrefix) ? (
                    <p className="deploy-error">{t('fileViewer.cloudflareDomainPrefixInvalid')}</p>
                  ) : cloudflareHostnamePreview ? (
                    <p className="hint">
                      {t('fileViewer.cloudflareHostnamePreview', { hostname: cloudflareHostnamePreview })}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="deploy-field-grid">
                  <label>
                    <span className="deploy-field-title">{t('fileViewer.vercelTeamId')}</span>
                    <input
                      value={teamId}
                      placeholder={t('fileViewer.optional')}
                      onChange={(e) => setTeamId(e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="deploy-field-title">{t('fileViewer.vercelTeamSlug')}</span>
                    <input
                      value={teamSlug}
                      placeholder={t('fileViewer.optional')}
                      onChange={(e) => setTeamSlug(e.target.value)}
                    />
                  </label>
                </div>
              )}
              {deployError ? <p className="deploy-error">{deployError}</p> : null}
              {!deployError
                && deployPhase === 'idle'
                && deployResultCards.length > 0
                && deployResultState(activeDeployment?.status) === 'ready' ? (
                <p className="hint" role="status">
                  {t('fileViewer.deployLinkReady')} · {t('fileViewer.deployResultLabel')}
                </p>
              ) : null}
              {deployResultCards.length > 0 ? (
                <div className={`deploy-result-block ${deployResultState(activeDeployment?.status)}`}>
                  <div className="deploy-result-summary">
                    <div className="deploy-result-summary-head">
                      <div className="deploy-result-label">{t('fileViewer.deployResultLabel')}</div>
                      <div className={`deploy-result-badge ${deployResultState(activeDeployment?.status)}`}>
                        {statusLabelFor(deployResultState(activeDeployment?.status))}
                      </div>
                    </div>
                    {activeDeployment?.statusMessage ? (
                      <p className="deploy-result-message">{activeDeployment.statusMessage}</p>
                    ) : null}
                    <div className="deploy-result-links">
                      {deployResultCards.map((card) => {
                        const state = deployResultState(card.status);
                        const canRetry = state === 'delayed' || state === 'protected';
                        const isDisabled = state === 'protected' || state === 'failed';
                        return (
                          <div key={card.id} className={`deploy-result-link ${state}`}>
                            <div className="deploy-result-link-main">
                              <div className="deploy-result-link-head">
                                <span className="deploy-result-link-label">{card.label}</span>
                                <span className={`deploy-result-link-state ${state}`}>{statusLabelFor(state)}</span>
                              </div>
                              {card.message ? (
                                <p className="deploy-result-link-message">{card.message}</p>
                              ) : null}
                              <a
                                className="deploy-result-url"
                                href={card.url}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {card.url}
                              </a>
                            </div>
                            <div className="deploy-result-actions">
                              {canRetry ? (
                                <button
                                  type="button"
                                  className="viewer-action"
                                  disabled={deployPhase === 'preparing-link'}
                                  onClick={() => {
                                    void retryDeploymentLink();
                                  }}
                                >
                                  {deployPhase === 'preparing-link'
                                    ? t('fileViewer.preparingPublicLink')
                                    : t('fileViewer.retryLink')}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="viewer-action"
                                onClick={() => {
                                  void copyDeployLink(card.url);
                                }}
                              >
                                <Icon name="copy" size={14} />
                                <span>{copyDeployLabel(card.url)}</span>
                              </button>
                              <a
                                className={`ghost-link ${isDisabled ? 'disabled' : ''}`}
                                href={isDisabled ? undefined : card.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                aria-disabled={isDisabled}
                              >
                                <Icon name="upload" size={14} />
                                {t('fileViewer.open')}
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
              </div>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                onClick={closeDeployModal}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={deploying || savingDeployConfig || deployPhase !== 'idle'}
                onClick={() => {
                  void deployToSelectedProvider();
                }}
              >
                {deployButtonLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {deploySavedToast ? (
        <Toast
          message={deploySavedToast.message}
          details={deploySavedToast.details}
          tone="success"
          placement="top"
          ttlMs={3600}
          onDismiss={() => setDeploySavedToast(null)}
        />
      ) : null}
      {deployActionToast && typeof document !== 'undefined' ? createPortal(
        <Toast
          message={deployActionToast}
          placement="top"
          ttlMs={2400}
          role="alert"
          onDismiss={() => setDeployActionToast(null)}
        />,
        document.body,
      ) : null}
      {imageExportSavedToast ? (
        <Toast
          message={imageExportSavedToast.message}
          details={imageExportSavedToast.details}
          tone="success"
          placement="top"
          ttlMs={3600}
          onDismiss={() => setImageExportSavedToast(null)}
        />
      ) : null}
      {shareGuideToast && typeof document !== 'undefined' ? createPortal(
        <Toast
          message={shareGuideToast}
          placement="top"
          ttlMs={2200}
          onDismiss={() => setShareGuideToast(null)}
        />,
        document.body,
      ) : null}
    </div>
  );
}

function baseDirFor(fileName: string): string {
  const idx = fileName.lastIndexOf('/');
  return idx >= 0 ? fileName.slice(0, idx + 1) : '';
}

function toOwnerRelativePath(ownerFileName: string, targetPath: string): string {
  const normalize = (value: string) => decodeURIComponent(value).replace(/^\/+/, '');
  const squash = (parts: string[]) => {
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (out.length > 0) out.pop();
        continue;
      }
      out.push(part);
    }
    return out;
  };
  const ownerDirPath = normalize(baseDirFor(ownerFileName));
  const targetFilePath = normalize(targetPath);
  const ownerParts = squash(ownerDirPath.split('/'));
  const targetParts = squash(targetFilePath.split('/'));

  let common = 0;
  while (
    common < ownerParts.length &&
    common < targetParts.length &&
    ownerParts[common] === targetParts[common]
  ) {
    common += 1;
  }

  const up = new Array(ownerParts.length - common).fill('..');
  const down = targetParts.slice(common);
  const rel = [...up, ...down].join('/');
  return rel || '.';
}

function hasRelativeAssetRefs(html: string): boolean {
  const attr = /\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(html)) !== null) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(value)) continue;
    return true;
  }
  return false;
}

async function inlineRelativeAssets(
  html: string,
  projectId: string,
  fileName: string,
): Promise<string> {
  const replacements: Array<Promise<{ from: string; to: string } | null>> = [];
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const rel = readHtmlAttr(tag, 'rel');
    const href = readHtmlAttr(tag, 'href');
    if (!rel || !/\bstylesheet\b/i.test(rel) || !href) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, href).then((css) =>
        css == null
          ? null
          : {
              from: tag,
              to:
                `<style data-readable-inline-asset="${escapeHtmlAttr(href)}">\n` +
                `${css.replace(/<\/style/gi, '<\\/style')}\n</style>`,
            },
      ),
    );
  }

  const scripts = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi) ?? [];
  for (const tag of scripts) {
    const src = readHtmlAttr(tag, 'src');
    if (!src) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, src).then((js) => {
        if (js == null) return null;
        const open = tag.match(/^<script\b[^>]*>/i)?.[0] ?? '<script>';
        const attrs = open
          .replace(/^<script/i, '')
          .replace(/>$/i, '')
          .replace(/\ssrc\s*=\s*(['"])[\s\S]*?\1/i, '');
        return {
          from: tag,
          to: `<script${attrs}>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`,
        };
      }),
    );
  }

  const resolved = (await Promise.all(replacements)).filter(
    (item): item is { from: string; to: string } => item !== null,
  );
  return resolved.reduce((next, { from, to }) => next.replace(from, () => to), html);
}

async function fetchProjectRelativeText(
  projectId: string,
  ownerFileName: string,
  assetRef: string,
): Promise<string | null> {
  const filePath = resolveProjectRelativePath(ownerFileName, assetRef);
  if (!filePath) return null;
  try {
    const resp = await fetch(projectRawUrl(projectId, filePath));
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function resolveProjectRelativePath(ownerFileName: string, assetRef: string): string | null {
  if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(assetRef)) return null;
  try {
    const url = new URL(assetRef, `https://readable.local/${baseDirFor(ownerFileName)}`);
    if (url.origin !== 'https://readable.local') return null;
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

function readHtmlAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] ?? null;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ImageViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer image-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {file.kind === 'sketch'
              ? t('fileViewer.sketchMeta', { size: humanSize(file.size) })
              : t('fileViewer.imageMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            download={file.name}
          >
            {t('fileViewer.download')}
          </a>
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('fileViewer.open')}
          </a>
        </div>
      </div>
      <div className="viewer-body image-body">
        <img alt={file.name} src={url} />
      </div>
    </div>
  );
}

function SketchViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  return (
    <div className="viewer image-viewer sketch-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.sketchMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body image-body">
        <SketchPreview projectId={projectId} file={file} className="viewer-sketch-preview" />
      </div>
    </div>
  );
}

function VideoViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer video-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.videoMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body video-body">
        <video src={url} controls playsInline preload="metadata" />
      </div>
    </div>
  );
}

function AudioViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}`;
  return (
    <div className="viewer audio-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.audioMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <FileActions projectId={projectId} file={file} />
      </div>
      <div className="viewer-body audio-body">
        <div className="audio-card">
          <Icon name="mic" size={28} />
          <div className="audio-card-name">{file.name}</div>
          <audio src={url} controls preload="metadata" />
        </div>
      </div>
    </div>
  );
}

type SvgViewerMode = 'preview' | 'source';

interface SvgViewerProps {
  projectId: string;
  file: ProjectFile;
  initialMode?: SvgViewerMode;
  initialSource?: string | null | undefined;
}

export function SvgViewer({
  projectId,
  file,
  initialMode = 'preview',
  initialSource,
}: SvgViewerProps) {
  const t = useT();
  const [mode, setMode] = useState<SvgViewerMode>(initialMode);
  const [source, setSource] = useState<string | null>(initialSource ?? null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const url = `${projectFileUrl(projectId, file.name)}?v=${Math.round(file.mtime)}&r=${reloadKey}`;

  useEffect(() => {
    if (mode !== 'source') return;
    if (initialSource !== undefined && reloadKey === 0) return;
    let cancelled = false;
    setLoadingSource(true);
    setSourceError(false);
    void fetchProjectFileText(projectId, file.name, {
      cache: 'no-store',
      cacheBustKey: `${Math.round(file.mtime)}-${reloadKey}`,
    }).then((next) => {
      if (cancelled) return;
      if (next === null) {
        setSource('');
        setSourceError(true);
      } else {
        setSource(next);
      }
      setLoadingSource(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, initialSource, mode, reloadKey]);

  return (
    <div className="viewer svg-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <span className="viewer-meta">
            {t('fileViewer.imageMeta', { size: humanSize(file.size) })}
          </span>
        </div>
        <div className="viewer-toolbar-actions">
          <div className="viewer-tabs">
            <button
              type="button"
              className={`viewer-tab ${mode === 'preview' ? 'active' : ''}`}
              aria-pressed={mode === 'preview'}
              onClick={() => setMode('preview')}
            >
              {t('fileViewer.preview')}
            </button>
            <button
              type="button"
              className={`viewer-tab ${mode === 'source' ? 'active' : ''}`}
              aria-pressed={mode === 'source'}
              onClick={() => setMode('source')}
            >
              {t('fileViewer.source')}
            </button>
          </div>
          <span className="viewer-divider" aria-hidden />
          <button
            type="button"
            className="viewer-action"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reloadDisk')}
          >
            <Icon name="reload" size={13} />
            <span>{t('fileViewer.reload')}</span>
          </button>
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            download={file.name}
          >
            {t('fileViewer.download')}
          </a>
          <a
            className="ghost-link"
            href={projectFileUrl(projectId, file.name)}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('fileViewer.open')}
          </a>
        </div>
      </div>
      <div className={`viewer-body ${mode === 'preview' ? 'image-body' : ''}`}>
        {mode === 'preview' ? (
          <img alt={file.name} src={url} />
        ) : loadingSource ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : sourceError ? (
          <div className="viewer-empty">{t('fileViewer.previewUnavailable')}</div>
        ) : (
          <pre className="viewer-source">{source ?? ''}</pre>
        )}
      </div>
    </div>
  );
}

function TextViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setText(null);
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((t) => {
      if (!cancelled) setText(t ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  async function copy() {
    if (text == null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  const displayText = useMemo(
    () => (text == null ? null : formatJsonFileTextForDisplay(file, text)),
    [file.name, file.mime, text],
  );
  const lineCount = displayText ? displayText.split('\n').length : 0;

  return (
    <div className="viewer text-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left" />
        <div className="viewer-toolbar-actions">
          <button
            type="button"
            className="viewer-action"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reloadDisk')}
          >
            <Icon name="reload" size={13} />
            <span>{t('fileViewer.reload')}</span>
          </button>
          <button
            type="button"
            className="viewer-action"
            disabled
            title={t('fileViewer.saveDisabled')}
          >
            <Icon name="check" size={13} />
            <span>{t('fileViewer.save')}</span>
          </button>
          <button
            type="button"
            className="viewer-action"
            onClick={() => void copy()}
            title={t('fileViewer.copyTitle')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            <span>{copied ? t('fileViewer.copied') : t('fileViewer.copy')}</span>
          </button>
        </div>
      </div>
      <div className="viewer-body">
        {text === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : displayText !== null && lineCount > 0 ? (
          <CodeWithLines text={displayText} />
        ) : (
          <pre className="viewer-source">{displayText}</pre>
        )}
      </div>
    </div>
  );
}

function formatJsonFileTextForDisplay(file: ProjectFile, text: string): string {
  if (!isJsonFile(file)) return text;
  try {
    if (hasPrecisionSensitiveJsonNumberText(text)) return text;
    const parsed = JSON.parse(text) as unknown;
    if (hasUnsafeJsonNumber(parsed)) return text;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function hasPrecisionSensitiveJsonNumberText(text: string): boolean {
  let inString = false;
  let escaped = false;
  const numberTokenPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      i += 1;
      continue;
    }

    numberTokenPattern.lastIndex = i;
    const match = numberTokenPattern.exec(text);
    if (!match) {
      i += 1;
      continue;
    }

    const token = match[0];
    if (isSignedNegativeZeroJsonNumberToken(token)) return true;
    if (/[.eE]/.test(token) && isPrecisionSensitiveJsonNumberToken(token)) return true;
    i = numberTokenPattern.lastIndex;
  }
  return false;
}

function isSignedNegativeZeroJsonNumberToken(token: string): boolean {
  return /^-0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(token);
}

function isPrecisionSensitiveJsonNumberToken(token: string): boolean {
  const parsed = Number(token);
  if (!Number.isFinite(parsed)) return true;
  const rendered = JSON.stringify(parsed);
  if (!rendered) return true;
  const originalValue = parseJsonNumberTokenAsDecimal(token);
  const renderedValue = parseJsonNumberTokenAsDecimal(rendered);
  return (
    !originalValue ||
    !renderedValue ||
    originalValue.coefficient !== renderedValue.coefficient ||
    originalValue.exponent !== renderedValue.exponent
  );
}

function parseJsonNumberTokenAsDecimal(token: string): { coefficient: bigint; exponent: number } | null {
  const match = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;
  const [, sign, integerPart, fractionPart = '', exponentPart = '0'] = match;
  const coefficient = BigInt(`${sign ?? ''}${integerPart}${fractionPart}`);
  const exponent = Number(exponentPart) - fractionPart.length;
  return normalizeDecimalParts(coefficient, exponent);
}

function normalizeDecimalParts(coefficient: bigint, exponent: number): { coefficient: bigint; exponent: number } {
  if (coefficient === 0n) return { coefficient: 0n, exponent: 0 };
  let normalizedCoefficient = coefficient;
  let normalizedExponent = exponent;
  while (normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedExponent += 1;
  }
  return { coefficient: normalizedCoefficient, exponent: normalizedExponent };
}

function hasUnsafeJsonNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  }
  if (Array.isArray(value)) return value.some(hasUnsafeJsonNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasUnsafeJsonNumber);
  return false;
}

function isJsonFile(file: ProjectFile): boolean {
  return file.name.toLowerCase().endsWith('.json') || file.mime.toLowerCase().startsWith('application/json');
}

function MarkdownViewer({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const markdownArticleRef = useRef<HTMLElement | null>(null);
  const copyBlockTimerRef = useRef<number | null>(null);
  const copiedMarkdownBlockRef = useRef<HTMLElement | null>(null);
  const status = file.artifactManifest?.status ?? 'complete';
  const isStreaming = status === 'streaming';
  const isError = status === 'error';
  const exportTitle = file.name.replace(/\.mdx?$/i, '') || file.name;

  useEffect(() => {
    setText(null);
    copiedMarkdownBlockRef.current = null;
    if (copyBlockTimerRef.current) {
      window.clearTimeout(copyBlockTimerRef.current);
      copyBlockTimerRef.current = null;
    }
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((next) => {
      if (!cancelled) setText(next ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, reloadKey]);

  useEffect(() => {
    return () => {
      copiedMarkdownBlockRef.current = null;
      if (copyBlockTimerRef.current) {
        window.clearTimeout(copyBlockTimerRef.current);
      }
    };
  }, []);

  async function copy() {
    if (text == null) return;
    const didCopy = await copyTextToClipboard(text);
    if (didCopy) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  const html = useMemo(() => {
    if (text === null) return null;
    const renderPartial = MarkdownRenderer.renderPartial ?? renderMarkdownToSafeHtml;
    return decorateMarkdownCodeBlocks(renderPartial(text));
  }, [text]);

  useEffect(() => {
    const article = markdownArticleRef.current;
    if (!article) return;
    ensureMarkdownCodeBlockControls(article, t);
    if (copiedMarkdownBlockRef.current?.isConnected) {
      setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, true, t);
    }
  }, [html, t]);

  async function handleMarkdownBodyClick(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(`button[${MARKDOWN_COPY_BLOCK_ATTR}]`);
    if (!button) return;
    const block = button.closest('.markdown-code-block');
    if (!(block instanceof HTMLElement)) return;
    const pre = block.querySelector('pre');
    if (!pre) return;
    const didCopy = await copyTextToClipboard(pre.textContent ?? '');
    if (!didCopy) return;
    if (copiedMarkdownBlockRef.current && copiedMarkdownBlockRef.current !== block) {
      setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, false, t);
    }
    copiedMarkdownBlockRef.current = block;
    setMarkdownCodeBlockCopiedState(block, true, t);
    if (copyBlockTimerRef.current) {
      window.clearTimeout(copyBlockTimerRef.current);
    }
    copyBlockTimerRef.current = window.setTimeout(() => {
      if (copiedMarkdownBlockRef.current) {
        setMarkdownCodeBlockCopiedState(copiedMarkdownBlockRef.current, false, t);
      }
      copiedMarkdownBlockRef.current = null;
      copyBlockTimerRef.current = null;
    }, 1800);
  }

  return (
    <div className="viewer text-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          {isStreaming ? <span className="viewer-meta">{t('fileViewer.markdownStreamingMeta')}</span> : null}
          {isError ? <span className="viewer-meta">{t('fileViewer.markdownErrorMeta')}</span> : null}
        </div>
        <div className="viewer-toolbar-actions">
          <button
            type="button"
            className="viewer-action"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reloadDisk')}
          >
            <Icon name="reload" size={13} />
            <span>{t('fileViewer.reload')}</span>
          </button>
          <button
            type="button"
            className="viewer-action"
            onClick={() => void copy()}
            title={t('fileViewer.copyTitle')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            <span>{copied ? t('fileViewer.copied') : t('fileViewer.copy')}</span>
          </button>
          {text !== null ? (
            <div className="share-menu chrome-share-menu">
              <button
                type="button"
                className="viewer-action"
                aria-haspopup="menu"
                aria-expanded={downloadMenuOpen}
                onClick={() => setDownloadMenuOpen((v) => !v)}
              >
                <Icon name="download" size={13} />
                <span>{t('fileViewer.download')}</span>
              </button>
              {downloadMenuOpen ? (
                <div className="share-menu-popover" role="menu">
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setDownloadMenuOpen(false);
                      exportAsMd(text, exportTitle);
                    }}
                  >
                    <span className="share-menu-icon"><RemixIcon name="file-line" size={15} /></span>
                    <span>{t('fileViewer.exportMd')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="viewer-body">
        {html === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : (
          <>
            {isStreaming ? <div className="markdown-status">{t('fileViewer.markdownStreamingStatus')}</div> : null}
            {isError ? <div className="markdown-status markdown-status-error">{t('fileViewer.markdownErrorStatus')}</div> : null}
            {/* Safe by contract: renderMarkdownToSafeHtml escapes raw HTML and rejects unsafe link protocols. */}
            <article
              ref={markdownArticleRef}
              className="markdown-rendered"
              onClick={(event) => void handleMarkdownBodyClick(event)}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function CodeWithLines({ text }: { text: string }) {
  const lines = text.split('\n');
  // Trailing newline produces a phantom empty line — keep gutter aligned.
  const gutter = lines.map((_, i) => `${i + 1}`).join('\n');
  return (
    <pre className="code-viewer">
      <code className="gutter" aria-hidden>
        {gutter}
      </code>
      <code className="lines">{text}</code>
    </pre>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function documentMetaLabel(file: ProjectFile, t: TranslateFn): string {
  if (file.kind === 'pdf') return t('fileViewer.pdfMeta');
  if (file.kind === 'document') return t('fileViewer.documentMeta');
  if (file.kind === 'presentation') return t('fileViewer.presentationMeta');
  if (file.kind === 'spreadsheet') return t('fileViewer.spreadsheetMeta');
  return t('fileViewer.binaryMeta', { size: humanSize(file.size) });
}
