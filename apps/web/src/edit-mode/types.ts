export type ManualEditKind = 'text' | 'link' | 'image' | 'container' | 'token';

export interface ManualEditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ManualEditFields {
  text?: string;
  href?: string;
  src?: string;
  alt?: string;
}

export interface ManualEditStyles {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  color: string;
  textAlign: string;
  lineHeight: string;
  letterSpacing: string;
  width: string;
  height: string;
  minHeight: string;
  // Standalone CSS `translate` (e.g. "10px 20px"). Drives layout-neutral move
  // drags: it offsets the element visually without reflowing siblings and
  // composes with any existing `transform`. Empty string = no translation.
  translate: string;
  gap: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  flex: string;
  backgroundColor: string;
  opacity: string;
  padding: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  margin: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  border: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  borderStyle: string;
  borderColor: string;
  borderRadius: string;
}

export interface ManualEditTarget {
  id: string;
  kind: ManualEditKind;
  label: string;
  tagName: string;
  className: string;
  text: string;
  rect: ManualEditRect;
  /**
   * getBoundingClientRect px per CSS px on each axis — the accumulated
   * ancestor transform scale (e.g. a deck's fit-to-canvas transform).
   * Absent or 1 for untransformed elements.
   */
  rectScale?: { x: number; y: number };
  /**
   * Immediate source-mappable parent target id. Null when no discoverable
   * ancestor exists; only present when the parent is itself a discoverable
   * manual-edit target.
   */
  parentId?: string | null;
  /**
   * Source-mappable ancestor target ids, nearest-first: the immediate
   * discoverable parent, then its parent, out to the outermost discoverable
   * ancestor. Empty for root-level targets.
   */
  ancestorIds?: readonly string[];
  /**
   * Post-layout getComputedStyle width/height (used px values). Unlike
   * `styles.width/height` (inline value first, which layout may have clamped
   * or ignored), this is what actually renders — the resize drag baseline.
   */
  cssSize?: { width: string; height: string };
  /** Winning authored width/height declarations (inline or stylesheet), kept
   * separate from computed size so the inspector can distinguish Auto, Fill,
   * and an explicitly sized element without mistaking a used px value for an
   * authored fixed size. */
  authoredSize?: { width: string; height: string };
  /**
   * Main axis of the parent flex container when the element is a flex item
   * ('row' → width is the main axis, 'column' → height), else null. Main-axis
   * drag commits must pin the item (flex: none) or the flex algorithm
   * overrides the written width/height.
   */
  flexItemAxis?: 'row' | 'column' | null;
  textEditTargetId?: string;
  fields: ManualEditFields;
  attributes: Record<string, string>;
  styles: ManualEditStyles;
  isLayoutContainer: boolean;
  isHidden?: boolean;
  outerHtml: string;
  /**
   * Whether the element is still connected to the document. Discovery targets
   * are always connected; preview acks may carry stale disconnected elements.
   */
  isConnected?: boolean;
}

export interface ManualEditDuplicatePlan {
  /** Exact canonical source used to build the plan. */
  expectedSource: string;
  originalId: string;
  originalTagName: string;
  parentPath: string;
  expectedNextSiblingPath: string | null;
  duplicateRootId: string;
  /** Source-derived markup used only for the transient iframe preview. */
  previewHtml: string;
  manualIdMap: Record<string, string>;
  nativeIdMap: Record<string, string>;
  baselineTranslate: string;
}

export type ManualEditPatch =
  | { id: string; kind: 'set-text'; value: string }
  | { id: string; kind: 'set-link'; text: string; href: string }
  | { id: string; kind: 'set-image'; src: string; alt: string }
  | { id: string; kind: 'remove-element' }
  | { kind: 'set-token'; token: string; value: string }
  | { id: string; kind: 'set-style'; styles: Partial<ManualEditStyles> }
  | { id: string; kind: 'set-attributes'; attributes: Record<string, string> }
  | { id: string; kind: 'set-inner-html'; html: string }
  | { id: string; kind: 'set-outer-html'; html: string }
  | {
      id: string;
      kind: 'duplicate-and-move';
      plan: ManualEditDuplicatePlan;
      finalTranslate: string;
      placementOffset?: { x: number; y: number };
    }
  | { kind: 'set-full-source'; source: string };

export interface ManualEditHistoryEntry {
  id: string;
  label: string;
  patch: ManualEditPatch;
  beforeSource: string;
  afterSource: string;
  createdAt: number;
  selectionIntent?: {
    beforeId: string;
    afterId: string;
  };
}

export interface ManualEditTargetMessage {
  type: 'readable-edit-targets';
  targets: ManualEditTarget[];
  documentEpoch?: string;
  sequence?: number;
}

export interface ManualEditSelectMessage {
  type: 'readable-edit-select';
  target: ManualEditTarget;
}

export interface ManualEditHoverMessage {
  type: 'readable-edit-hover';
  target: ManualEditTarget | null;
}

/** Host overlay -> iframe: re-resolve hover beneath an overlay surface. */
export interface ManualEditHoverAtMessage {
  type: 'readable-edit-hover-at';
  clientX: number;
  clientY: number;
  selectedId: string;
  documentEpoch: string;
}

export interface ManualEditBackgroundMessage {
  type: 'readable-edit-background';
}

export type ManualEditResizeAxis = 'width' | 'height';

/** Rect-space size requested by a resize drag. */
export interface ManualEditResizeRequest {
  axes: ManualEditResizeAxis[];
  requested: Pick<ManualEditRect, 'width' | 'height'>;
  /** Opts the low-frequency final frame into authored constraint diagnosis. */
  includeDetails?: boolean;
}

export interface ManualEditResizeConstraint {
  axis: ManualEditResizeAxis;
  requested: number;
  applied: number;
  reason: 'min' | 'max' | 'layout';
  property?: 'min-width' | 'max-width' | 'min-height' | 'max-height';
  value?: string;
}

export interface ManualEditResizeOutcome {
  constraints: ManualEditResizeConstraint[];
  /** True only for the low-frequency final result that should be announced. */
  announce: boolean;
}

export interface ManualEditPreviewAppliedMessage {
  type: 'readable-edit-preview-style-applied';
  id: string;
  version: number;
  ok: boolean;
  error?: string;
  /**
   * The target's post-apply getBoundingClientRect. Streamed back per preview
   * frame so the host overlays track the element's REAL box during a drag —
   * flex/grid/min-content constraints can clamp or ignore the requested size.
   */
  rect?: ManualEditRect;
  /**
   * Post-apply computed width/height. Feeds the host's resize baseline: when
   * layout clamps a request, this is the value that actually took effect.
   */
  cssSize?: { width: string; height: string };
  /** Post-apply winning authored width/height declarations. */
  authoredSize?: { width: string; height: string };
  /** Requested resize axes whose post-layout rect differs by more than 1px. */
  resize?: ManualEditResizeOutcome;
}

export interface ManualEditDuplicateCreateMessage {
  type: 'readable-edit-duplicate-create';
  documentEpoch: string;
  transactionId: string;
  sequence: number;
  originalId: string;
  duplicateRootId: string;
  previewHtml: string;
  baselineTranslate: string;
}

export interface ManualEditDuplicateUpdateMessage {
  type: 'readable-edit-duplicate-update';
  documentEpoch: string;
  transactionId: string;
  sequence: number;
  translate: string;
}

export interface ManualEditDuplicateCancelMessage {
  type: 'readable-edit-duplicate-cancel';
  documentEpoch: string;
  transactionId: string;
  sequence: number;
}

export interface ManualEditDuplicatePreviewMessage {
  type: 'readable-edit-duplicate-preview';
  documentEpoch: string;
  transactionId: string;
  sequence: number;
  ok: boolean;
  error?: string;
  rect?: ManualEditRect;
  naturalRect?: ManualEditRect;
  placementOffset?: { x: number; y: number };
}

export interface ManualEditDuplicateRemovedMessage {
  type: 'readable-edit-duplicate-removed';
  documentEpoch: string;
  transactionId: string;
  sequence: number;
}

export interface ManualEditTextCommitMessage {
  type: 'readable-edit-text-commit';
  id: string;
  value: string;
}

export interface ManualEditHtmlCommitMessage {
  type: 'readable-edit-html-commit';
  id: string;
  html: string;
}

export interface ManualEditUndoMessage {
  type: 'readable-edit-undo';
  redo: boolean;
}

export interface ManualEditNudgeMessage {
  type: 'readable-edit-nudge';
  direction: 'up' | 'down' | 'left' | 'right';
  /** Stable id of the selected target that must still be selected on the host. */
  targetId: string;
  /** Host preview revision at the time the key was pressed. Stale revisions are ignored. */
  revision: number;
}

export interface ManualEditBurstCancelMessage {
  type: 'readable-edit-burst-cancel';
}

// iframe -> host: all owned arrow keys were released inside the preview, so the
// keyboard burst is complete and should be committed. keyup does not cross the
// iframe boundary, so the bridge tracks its own held arrow keys and emits this
// once the set empties. Carries identity so a stale burst end is ignored.
export interface ManualEditNudgeCommitMessage {
  type: 'readable-edit-nudge-commit';
  targetId: string;
  revision: number;
}

// iframe -> host: an arrow keyup fired inside the preview that the bridge did
// NOT own (its held-key set does not cover it, no Escape latch, not synthetic).
// A host-origin burst whose key physically comes up inside the iframe (focus
// crossed the boundary mid-hold) ends on this signal. Carries identity so a
// stale keyup is ignored.
export interface ManualEditNudgeKeyupMessage {
  type: 'readable-edit-nudge-keyup';
  key: string;
  targetId: string;
  revision: number;
}

// iframe -> host: reports the live rich-text edit/selection/format state so the
// typography toolbar can enable + show pressed state for B/I/U.
export interface ManualEditSelectionStateMessage {
  type: 'readable-edit-selection-state';
  editing: boolean;       // an element is in a rich (contenteditable="true") edit session
  hasSelection: boolean;  // a non-collapsed selection sits inside that element
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

// host -> iframe: apply an execCommand format command to the current selection.
export interface ManualEditRichFormatMessage {
  type: 'readable-edit-rich-format';
  command: 'bold' | 'italic' | 'underline';
}

// host -> iframe: explicitly enter the rich-text edit session for an element
// (for example, a structured container's double-click).
export interface ManualEditBeginTextEditMessage {
  type: 'readable-edit-begin-text-edit';
  id: string;
}

// host -> iframe: leave the rich-text edit session but keep the element
// selected (PowerPoint "Esc / border-drag promotes caret to object select").
// The bridge tears down contenteditable and re-broadcasts selection-state
// (editing: false) so the host flips the move frame to object-selected mode.
export interface ManualEditEndTextEditMessage {
  type: 'readable-edit-end-text-edit';
}

export interface ManualEditClickMessage {
  type: 'readable-edit-click';
  clientX: number;
  clientY: number;
  selectedId: string;
}

export interface ManualEditClickCancelMessage {
  type: 'readable-edit-click-cancel';
}

export interface ManualEditAltClickMessage {
  type: 'readable-edit-alt-click';
  clientX: number;
  clientY: number;
}

export type ManualEditActivationMessage =
  | ManualEditClickMessage
  | ManualEditClickCancelMessage
  | ManualEditAltClickMessage;

export type ManualEditBridgeMessage =
  | ManualEditTargetMessage
  | ManualEditSelectMessage
  | ManualEditHoverMessage
  | ManualEditBackgroundMessage
  | ManualEditPreviewAppliedMessage
  | ManualEditDuplicatePreviewMessage
  | ManualEditDuplicateRemovedMessage
  | ManualEditTextCommitMessage
  | ManualEditHtmlCommitMessage
  | ManualEditUndoMessage
  | ManualEditNudgeMessage
  | ManualEditBurstCancelMessage
  | ManualEditNudgeCommitMessage
  | ManualEditNudgeKeyupMessage
  | ManualEditSelectionStateMessage;

export const MANUAL_EDIT_STYLE_PROPS: readonly (keyof ManualEditStyles)[] = [
  'fontFamily', 'fontSize', 'fontWeight', 'color', 'textAlign', 'lineHeight', 'letterSpacing',
  'width', 'height', 'minHeight', 'translate',
  'gap', 'flexDirection', 'justifyContent', 'alignItems', 'flex',
  'backgroundColor', 'opacity',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'border', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderStyle', 'borderColor', 'borderRadius',
];

export function emptyManualEditStyles(): ManualEditStyles {
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    acc[key] = '';
    return acc;
  }, {} as ManualEditStyles);
}
