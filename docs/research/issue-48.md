# Issue #48 research: PowerPoint-style Ctrl-drag duplication

Date: 2026-07-27
Repository: `sanghyunna/readable-studio-sandboxed`
Revision inspected: `028571bb` (`main` and the issue branch currently point at the same commit)
Status: research only; no product implementation is included in this report.

Issue: [#48 — Manual Edit: add PowerPoint-style Ctrl-drag object duplication with atomic source insertion](https://github.com/sanghyunna/readable-studio-sandboxed/issues/48)

## Executive finding

Issue #48 is feasible, but it is not an `event.ctrlKey` feature and it is not a variation of the existing `set-style` move patch. It is a small transaction system spanning four already-separated concerns:

1. The host overlay owns pointer capture, the 4/5 px activation rule, modifier transitions, and cancellation.
2. `movement-session.ts` owns immutable-baseline geometry, Shift constraint, Alt snap bypass, magnetic snapping, guides, transform-scale conversion, and translation serialization.
3. The srcDoc iframe bridge must own a short-lived, inert, source-derived preview clone and its synchronous layout preflight.
4. The host source/history pipeline must create one source-backed duplicate-and-move operation, one file write, one history entry, and a deterministic selection result.

The safest shape is therefore:

```text
canonical source + selected source locator
        │
        ├─ source-aware duplicate plan
        │    (new identity map, rewritten internal references, eligibility proof)
        │
        ├─ bridge preview transaction
        │    (one inert clone, real-parent insertion, layout preflight, live translate)
        │
        └─ one duplicate-and-move source operation on pointerup
             (one insertion + final root translate + one snapshot write)
```

The existing movement resolver should remain the geometry authority. The new work should add a separate *preview subject* and a duplicate transaction around it; it should not make the resolver parse HTML or make the bridge decide how source identities are allocated.

The largest correctness hazards are:

- cloning the runtime iframe node, whose markup contains preview-only IDs, source paths, selection markers, and potentially live application state;
- allowing the clone to enter target discovery, hit testing, snapping, accessibility, or mutation-observer broadcasts;
- using the current runtime DOM as the source baseline while text editing or inspector styles are still pending;
- using the selected target's ID as both the moving subject and the stationary original snap candidate;
- allowing insertion to reflow flex/grid/sibling-selector layouts and then persisting a result that did not match the preview;
- treating source write success and post-write preview rehydration as the same failure boundary;
- restoring only the React selection state without an explicit undo/redo selection intent.

## Issue contract, separated from implementation suggestions

The issue body defines a deliberately narrow first release:

- one selected Manual Edit object only;
- Ctrl-drag duplicates the selected subtree and moves the duplicate;
- the original must remain unchanged during duplicate preview and after commit;
- duplicate insertion is immediately after the original in the same parent;
- the duplicate is selected after a successful commit;
- the operation is one source mutation, one file write, and one Manual Edit history entry;
- below-threshold movement must not clone, write, or create history;
- Ctrl may be pressed or released while the pointer is stationary, and repeated toggles must reuse one mapping and one transient clone;
- the final pointerup event is authoritative for the effective Ctrl/Shift/Alt state and final coordinates;
- Shift and Alt retain the movement behavior already delivered by issues #45 and #47;
- unsupported active content, ambiguous identity/reference graphs, unstable layout, pending source flushes, save conflicts, and busy writes reject without leaving residue;
- Ctrl+D, multi-select/group duplication, clipboard behavior, cross-slide/file duplication, resize duplication, reparenting, reordering, and arbitrary HTML/framework state are out of scope.

The issue cites Microsoft PowerPoint's established interaction. Microsoft's shortcut documentation lists both `Ctrl+D` and `Ctrl+Drag the mouse` for duplicating selected objects: [Microsoft Support — Use keyboard shortcuts to create PowerPoint presentations](https://support.microsoft.com/en-us/accessibility/powerpoint/use-keyboard-shortcuts-to-create-powerpoint-presentations).

The prerequisite issues are present in the current history and are no longer blockers in this checkout:

- #44 supplied the immutable movement session and common pointer/keyboard movement seam.
- #45 supplied magnetic edge alignment, guides, candidate snapshots, latch hysteresis, and live Alt bypass.
- #47 supplied the stable dominant-axis Shift constraint and modifier ordering.

Issue #48 currently has no comments, so the issue body is the complete product contract available from GitHub.

## Current end-to-end architecture

The current Manual Edit move path is:

```text
host ManualEditMoveFrame
  → threshold / pointer capture / rAF / Shift+Alt tracking
  → FileViewer.beginManualEditMovement
  → movement-session.resolveManualEditMovement
  → postMessage(readable-edit-preview-style)
  → iframe bridge finds the existing target and writes inline translate
  → postMessage(readable-edit-preview-style-applied)
  → FileViewer updates the selected target rect and host overlay
  → pointerup → applyManualEdit(set-style)
  → source-patches.applyManualEditPatch
  → conflict check → one project file write → history snapshot
```

The current implementation has no clone subject or duplicate transaction. A Ctrl-drag is consequently just an ordinary drag: Ctrl is not represented in `ManualEditMoveUpdate`, the move frame has no Ctrl tracker, the bridge only applies styles to an existing target, and pointerup persists a `set-style` patch against the original.

### Host movement surface

`apps/web/src/components/ManualEditMoveFrame.tsx` is the correct place for pointer-scoped modifier tracking:

- `DRAG_THRESHOLD` is 5 client pixels, with the existing `< 5` comparison preserving a click through 4 px and starting a real drag at 5 px on either axis.
- pointer capture is taken at pointerdown;
- the first threshold-crossing move invokes `onMoveStart`;
- pointer movement is converted from host client pixels to iframe rect-space by `scale`;
- preview updates are coalesced through one rAF;
- Shift and Alt are tracked only for a real drag and their exact listeners are removed by `endDrag`;
- pointerup recomputes the final delta from authoritative pointerup coordinates;
- Escape and pointercancel tear down the drag and invoke cancellation;
- below-threshold pointerup remains an activation/click, not a movement commit.

Relevant code: `apps/web/src/components/ManualEditMoveFrame.tsx:14-53, 100-239, 270-347`.

There is no Ctrl state in this component. This matters because the issue requires live Ctrl transitions while stationary. A future `ManualEditMoveUpdate` needs to carry the final modifier state (at least `ctrlKey`, `shiftKey`, and `altKey`) or the commit callback needs an equivalent authoritative modifier snapshot. Relying on the last rAF or on a separate mutable host ref is insufficient when the user changes Ctrl between the last pointermove and pointerup.

The Ctrl tracker should be installed and removed exactly like the existing Alt tracker, after threshold activation only. It should not become a document-wide Ctrl shortcut listener. This is also the cleanest way to avoid interfering with the existing iframe text-edit Ctrl shortcuts and host Ctrl/Cmd+Z history shortcut.

### Shared movement session

`apps/web/src/edit-mode/movement-session.ts` already provides most of the required geometry:

- immutable `startRect` and `baselineTranslate`;
- `rectScale` for ancestor transforms;
- raw absolute delta resolution;
- stable Shift axis selection;
- Alt snap bypass;
- pointer-only magnetic snapping;
- candidate snapshotting and per-axis latch hysteresis;
- `moveCssCommitStyles`, which folds the rect-space delta into standalone CSS `translate`.

Relevant code: `apps/web/src/edit-mode/movement-session.ts:13-74, 107-145, 169-356, 356-427` and `apps/web/src/edit-mode/resize-geometry.ts:210-241`.

The session currently assumes that `targetId` is the moving subject and that the selected subject is absent from the candidate set. That is correct for ordinary movement. It is not sufficient for duplication because the stationary original must be an eligible snap candidate while the proposed duplicate is the moving subject. A candidate cannot safely be represented by the same `id` without making matching, guides, relationship ranking, and subject identity ambiguous.

The geometry layer needs a conceptual distinction between:

- the persistent/source identity of the original;
- the preview subject key for the transient duplicate;
- the snap candidate key for the stationary original.

That can be expressed by a candidate role/key or by a duplicate-specific candidate wrapper. It should not be faked with an ID that could accidentally be sent to `findById`, source patching, or selection.

### Source identity and srcDoc annotations

Manual Edit has several identity forms:

- authored `data-readable-id`, which is intended to be persistent;
- preview-only `data-readable-source-path`, added by `buildSrcdoc`;
- preview-only `data-readable-runtime-id`, generated by the bridge for path-addressed elements;
- path IDs such as `path-0-1`, resolved against source DOM child indexes.

`apps/web/src/runtime/srcdoc.ts:565-642` adds source paths and missing preview IDs before injecting the bridge. `apps/web/src/edit-mode/bridge.ts:1-65` and `bridge.ts:416-480` resolve stable IDs and strip runtime-only attributes from the target `outerHtml` sent to the host. The host source resolver in `apps/web/src/edit-mode/source-patches.ts:190-216` resolves authored IDs, runtime IDs, source paths, and path IDs in that order.

This explains why runtime `target.outerHtml` is not safe input for duplication. It is a convenience snapshot produced after preview annotations, selection state, hover state, editing state, and bridge nodes exist. It is not a canonical source subtree. The duplicate plan must resolve the selected target against the canonical source snapshot and serialize a source-derived clone. The bridge may receive that plan for preview, but it must not manufacture the persisted clone from runtime outerHTML.

### Iframe bridge

`apps/web/src/edit-mode/bridge.ts` currently:

- discovers targets using a fixed selector and requires a source-mappable element;
- filters inline text wrappers and hidden/degenerate targets;
- emits target geometry, structural ancestors, computed styles, and optional outer HTML;
- finds targets through authored ID, runtime ID, source path, or host-node-filtered path traversal;
- applies preview styles only to the existing element found by `findById`;
- emits a post-apply rect acknowledgement;
- broadcasts target lists after mutations, layout changes, scroll, resize, transitions, animation, and media load.

Relevant code: `apps/web/src/edit-mode/bridge.ts:416-480, 755-821, 1110-1140`.

There is no bridge message for clone insertion/removal, no transient-target exclusion, no geometry preflight, and no distinction between a source target and a preview-only target. Simply adding a `cloneNode(true)` call here would violate the source/preview boundary and would also copy duplicate native IDs. MDN documents both hazards: `cloneNode()` copies attributes, can copy inline event-handler attributes, does not copy listeners installed with `addEventListener`, and warns that cloning can create duplicate element IDs. See [MDN — `Node.cloneNode()`](https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode). The HTML `id` attribute is required to be unique within the document: [MDN — `id` global attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/id).

### Host persistence and history

`apps/web/src/components/FileViewer.tsx` freezes the source while Manual Edit is active, routes live style movement through `readable-edit-preview-style`, and rebuilds the srcDoc document for non-style source changes. The key flows are:

- `FileViewer.tsx:4243-4370`: frozen source, srcDoc activation, preview revision, and transport selection;
- `FileViewer.tsx:4630-4658`: mode and selected-target synchronization;
- `FileViewer.tsx:5000-5165`: bridge target, selection, text commit, preview acknowledgement, and history messages;
- `FileViewer.tsx:5350-5520`: movement session creation, preview, cancellation, and pointer commit;
- `FileViewer.tsx:5765-6148`: pending inspector-style flush, source patch application, conflict checking, undo, and redo;
- `FileViewer.tsx:7790-7890`: the overlay rect, resize handles, move frame, and current movement callbacks.

`apps/web/src/edit-mode/types.ts:59-136` defines `ManualEditTarget`, `ManualEditPatch`, and `ManualEditHistoryEntry`. The patch union currently has no duplicate operation. A history entry stores `beforeSource` and `afterSource`, but no selection intent. Undo and redo replace the source and refresh the document; they do not carry an explicit “select duplicate” or “select original fallback” instruction.

The existing `applyManualEdit` pipeline already provides the desired write primitive: it computes a source result, confirms that persisted source still matches the expected base, writes once, and only then records history. A duplicate operation should use this pipeline with a dedicated patch kind rather than calling a separate insertion save and then a separate movement save.

The existing failure semantics also matter. `applyManualEdit` immediately rejects when `manualEditSavingRef` is busy. `flushManualEditStyleSave` rejects if a save is already active. `confirmManualEditHistorySource` clears Manual Edit history and refreshes source on an external conflict. A duplicate transaction must treat all three as pre-commit aborts and remove the transient clone before returning control to the user.

## Requirement-to-code gap audit

| Issue requirement | Current state | Consequence for design |
| --- | --- | --- |
| Ctrl activates duplicate mode at the normal threshold | Ctrl is absent from the move-frame protocol | Add pointer-scoped state and authoritative final modifier payload. |
| Original remains stationary in duplicate mode | Existing resolver always writes `translate` to the selected ID | Maintain an immutable original baseline and route preview styles to a distinct transient subject. |
| Clone frame follows duplicate | Overlay rect comes only from `selectedManualEditTarget` | Keep source selection and preview subject separate; add transient rect state/ack. |
| Live Ctrl press/release while stationary | Only Alt has live transition plumbing | Add mode transition callbacks that reuse the same movement session and absolute delta. |
| One clone/mapping across toggles | No transaction or identity plan exists | Allocate an immutable duplicate plan once per drag. |
| Original participates in duplicate snapping | Candidate builder excludes selected ID | Add a typed stationary-origin candidate; exclude clone and original descendants. |
| Clone excluded from discovery/hit/snap/a11y | `allTargets` has no transient filter | Add a bridge-owned transient marker and filter every discovery/hit/selection path. |
| Source-derived, atomic insertion | Only set-style/HTML replacement patches exist | Add a dedicated duplicate-and-move source operation. |
| Native and Manual Edit ID/reference rewriting | No clone identity graph exists | Implement an explicit allowlist/rewrite analyzer and reject unknown forms. |
| Layout-preserving insertion | Bridge applies style to one existing node only | Insert in the real parent, measure original and every existing target before movement, and abort on reflow. |
| Pending edit/source baseline ordering | Move start begins session before sending end-text-edit; inspector flush is separate | Duplicate preparation must await canonical source baseline before allocating the plan. |
| Duplicate selected after save | Selection state is keyed to existing target and history has no intent | Store original/duplicate selection intent and restore only after target rediscovery. |
| Undo/redo reuses IDs and geometry | Snapshots preserve source bytes but selection identity is implicit | Keep the duplicate mapping in the history entry and use it on redo; never allocate a new mapping. |
| Synchronous cleanup | Existing cleanup knows only how to restore one target's style | Centralize transaction abort so clone removal, original restoration, listener removal, and guide cleanup happen together. |

## Recommended design

### 1. Create an immutable duplicate plan from canonical source

Conceptually, the first Ctrl activation should produce a plan containing:

```text
DuplicatePlan
  expectedSource / source revision
  original locator (authored id, source path, or validated path)
  original parent locator and insertion position
  serialized source-derived clone subtree
  old → new data-readable-id map
  old → new native id map
  persistent duplicate root data-readable-id
  final source root translate field (updated at commit)
  preview transaction key
  eligibility and reference-analysis result
```

The plan is created from `sourceRef.current` after the issue's required baseline sequence:

1. finish/flush active inline text editing;
2. flush pending inspector style edits;
3. wait for a non-busy source-backed baseline;
4. re-resolve the selected target against that exact source;
5. analyze the subtree and allocate all new IDs;
6. only then ask the bridge to preview it.

The plan must retain the exact source snapshot it was built from. If source changes while the asynchronous flush or preflight is in progress, the plan is stale and must be discarded. The existing persisted-source conflict check remains the final authority before writing.

The plan should be stable for the entire pointer drag. Ctrl toggles, preview acks, rAF coalescing, pointerup, commit, undo, and redo must all refer to the same mapping. A second independent Ctrl-drag gets a new collision-free mapping.

### 2. Keep movement math independent of duplication

The movement session should continue to resolve:

```text
immutable origin
  → absolute raw pointer delta
  → stable Shift axis constraint
  → Alt snap bypass
  → magnetic snap correction and guides
  → rect-space translated rect
  → standalone CSS translate using rectScale
```

The duplicate transaction decides where the result is rendered:

- ordinary mode: original live element;
- duplicate mode: transient clone root;
- Ctrl release: original live element, using the same absolute result;
- final Ctrl on: source duplicate operation with the final result.

Do not rebase from iframe preview acknowledgements. The existing issue #44/#45/#47 contract is explicitly absolute and immutable; a clone preview ack may refine the visible clone rect but must not change the movement origin or source translation baseline.

For duplicate snapping, build the candidate snapshot before inserting the clone:

- include the stationary original as a typed “duplicate origin” candidate;
- include the ordinary eligible candidates from the original's pre-insertion target snapshot;
- exclude the original's descendants, because they move with the duplicated subtree;
- exclude the clone and all clone descendants by construction;
- keep the original candidate's geometry fixed for the session.

The origin candidate needs an explicit escape rule. At zero delta it is geometrically coincident with the duplicate, so ordinary snap acquisition would immediately latch the clone back to the original. Suppress this one candidate while the duplicate remains within the release band of its starting position; once the user has escaped that band, allow normal acquire/release hysteresis. Alt must clear or bypass that latch exactly as it does for other candidates.

### 3. Model the host as a duplicate transaction

The host needs a transaction state separate from React's selected target:

```text
idle
  → ordinary movement
  → duplicate preparing
  → duplicate previewing
  → committing
  → completed
  → aborted
```

The transaction owns:

- the movement session;
- the duplicate plan, if Ctrl has ever activated it;
- the current preview subject key and rect;
- the latest absolute movement update;
- bridge transaction/version identifiers;
- the original's baseline preview style;
- whether origin snap has escaped;
- cleanup ownership.

The existing `selectedManualEditTarget` should remain the source/inspector selection until commit. Selecting the transient clone in that state would cause `selectManualEditTarget` to read a preview-only ID from canonical source, clear the movement, and corrupt the inspector baseline. The overlay can render from a separate transient rect while the source selection remains original.

Mode transitions should be deterministic:

- Ctrl is on at threshold: prepare the plan, restore/retain the original baseline, insert one clone after preflight, then apply the latest absolute result to the clone.
- Ctrl is pressed during ordinary movement while stationary: restore original baseline, prepare from the same persisted source baseline, insert/reuse the one clone, and apply the already accumulated absolute delta.
- Ctrl is released during duplicate movement while stationary: remove the clone, restore the original selection and original live subject, and apply the same latest absolute result to the original.
- repeated toggles: reuse the plan, clone key, candidate snapshot, and listeners; do not allocate another ID or insert another clone.
- pointerup: reconcile the pointerup coordinates and all three modifiers before deciding ordinary move versus duplicate commit.

If preparation is still pending at pointerup, the safe outcome is no source write unless the transaction can complete its preflight while still owned by the same drag and the final authoritative update is applied. A stale or late preparation result must be ignored by transaction key.

### 4. Bridge preview must be source-derived and inert

The host should send the bridge a source-derived serialized clone/plan, not `target.outerHtml` and not a live runtime node. The bridge should:

1. validate the transaction key and selected original;
2. parse the already-analyzed clone payload into a template/document fragment;
3. reject any payload that still contains forbidden active elements or runtime annotations;
4. insert the root immediately after the original in the original's actual parent;
5. mark the root/subtree with a private transient marker;
6. make it inert: `inert` where available, `aria-hidden`, no autofocus/contenteditable/edit markers, pointer-events disabled, no hit/hover/selection participation;
7. measure and run layout preflight synchronously;
8. report the clone rect and preflight result;
9. apply only the transaction's current translated-root style after preflight passes.

The transient marker must be recognized by all relevant bridge paths, not just `allTargets`:

- discovery and `postTargets`;
- `findById` and target-for-selection logic;
- pointerover/click hit testing;
- hover outlines and selected outlines;
- text editing lookup;
- snap candidate export;
- accessibility/focus behavior;
- mutation/resize observer target broadcasts.

The existing bridge's mutation observer will otherwise see insertion/removal as a document change and can emit stale target lists while the host is still in a drag. It should either filter transient mutations/targets or defer them under a transaction mute window, while still allowing the dedicated preview acknowledgement through.

The clone must not execute scripts, inline handlers, media, embedded documents, plugins, stylesheet links, custom-element behavior, or equivalent active content. Parsing alone is not enough: insertion can cause custom-element construction, resource loading, or other observable effects. The eligibility analyzer should reject these before insertion; the bridge should perform a defensive check as well.

### 5. Layout preflight is a correctness gate, not a visual nicety

Inserting the clone immediately after the original can change layout even when the clone has the same natural size. Flex and grid item counts, block flow, `:nth-child`, sibling selectors, percentage sizing, auto margins, and intrinsic content can all affect the original or unrelated targets.

The bridge should take one geometry revision containing every existing editable target that will be used by Manual Edit. Then:

1. capture original and all preexisting target rects;
2. insert the inert clone in the real parent and immediate-sibling position;
3. measure the clone's natural rect before movement;
4. remeasure the original and every preexisting target;
5. compare with an explicit browser-pixel tolerance;
6. reject and synchronously remove the clone if any preexisting target moved or changed size;
7. reject if clone natural geometry cannot be reconciled with the original baseline under the supported translation contract;
8. only after passing, apply live translation to the clone.

The preflight should be tested at 50%, 100%, and 200% preview zoom, under the existing ancestor-transform scale contract, and with flex/grid/absolute-positioned fixtures. The source commit must use the same standalone root `translate` that the preview used. The existing `moveCssCommitStyles` conversion is the right place to preserve CSS-pixel versus rect-pixel behavior; do not recompute it from the clone's post-apply rect.

There are two distinct layout failures:

- **preflight failure before commit:** abort with no source change and remove the clone;
- **external reflow during an active duplicate drag:** invalidate the transaction or rerun a strict geometry check. Continuing to commit a plan whose original/other targets have moved breaks the “preview equals saved source” invariant.

### 6. Source-aware identity and reference rewriting

The source operation must clone the selected subtree while preserving ordinary authored content and rewriting only references that are provably internal to the cloned subtree.

Identity rules:

- allocate a persistent, globally unique duplicate-root `data-readable-id` even if the original was found only by a generated path;
- recursively allocate collision-free replacements for authored descendant `data-readable-id` values;
- recursively allocate collision-free replacements for native `id` values;
- keep the old-to-new maps in the plan and history entry;
- never persist `data-readable-runtime-id`, `data-readable-source-path`, selected/hover/editing markers, bridge attributes, or other preview annotations;
- do not allocate new IDs on redo; reuse the history plan's exact IDs.

References that can be rewritten structurally include the issue's stated set:

- fragment `href` and SVG `xlink:href`;
- `url(#id)` in inline style values and SVG presentation attributes such as `fill`, `stroke`, `filter`, `clip-path`, `mask`, and `marker-*`;
- HTML `for`, `form`, and `list` relationships;
- `headers`;
- ARIA IDREF/IDREFS values including `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-activedescendant`, `aria-details`, `aria-errormessage`, and `aria-flowto`.

For each reference, rewrite only when its target ID is inside the old-to-new map. References to nodes outside the subtree stay pointed at the original external target. References outside the subtree continue to point at the original IDs. Do not perform arbitrary string replacement across HTML, CSS, script text, URLs, or visible text.

The analyzer should reject rather than guess for:

- duplicate/ambiguous native IDs or `data-readable-id` values;
- script-visible IDs, inline event handlers, scripts, or custom elements;
- CSS selectors that depend on the old native/data identity but cannot be safely duplicated;
- stylesheet text or selector forms that would require global or sibling rewrites;
- unknown IDREF-like attributes;
- shadow DOM/template/reference forms outside the supported catalog;
- form-control/name-group semantics that would couple the original and clone;
- non-px or otherwise unsupported existing standalone translate values;
- any subtree whose source serialization cannot be proven to produce one root at the same insertion point.

This conservative reject policy is preferable to a duplicate that looks right in one preview but silently breaks an internal SVG, ARIA relationship, anchor, CSS rule, form relationship, or script assumption.

### 7. Atomic source operation and history intent

Add one dedicated source operation conceptually equivalent to:

```text
duplicate-and-move:
  resolve selected node in expected canonical source
  validate locator and source revision
  clone/rewrite the analyzed subtree
  insert immediately after original
  set final standalone root translate on the new root
  serialize one source snapshot
```

The interaction should submit this operation through `applyManualEdit`, not submit `set-full-source` and not submit insertion and movement separately. The operation must be the only path that decides insertion and persisted identity mapping.

The history entry needs enough selection intent to make the interaction deterministic:

```text
before selection: original locator/identity
after selection: duplicate root data-readable-id
duplicate plan: stable old→new map and final geometry contract
```

After a successful write, the transient clone should be removed and the normal source-backed srcDoc rebuild should occur. Do not report the duplicate as fully successful until the new root is rediscovered and its rect matches the expected final rect within the same explicit tolerance. If write succeeds but rehydration fails, the source is already committed; do not perform a second compensating write that would violate the one-write/history contract. Surface a recoverable preview/selection error and retry rehydration instead.

Undo should restore `beforeSource` and prefer selecting the original only when the duplicate entry owns the current selection; it should not steal an unrelated user selection. Redo should restore `afterSource`, select the exact stored duplicate root ID, and reuse the same geometry/identity mapping. Existing snapshot-based source history already preserves the bytes; the missing piece is explicit selection ownership and post-rebuild re-selection.

## Modifier behavior matrix

The product behavior should be expressed as a single matrix and tested at both preview and pointerup:

| Ctrl | Shift | Alt | Preview subject | Geometry resolution |
| --- | --- | --- | --- | --- |
| off | off | off | original | raw absolute delta → magnetic snap |
| off | on | off | original | raw → stable dominant axis → magnetic snap |
| off | any | on | original | raw → Shift if active; no snap |
| on | off | off | transient clone | raw absolute delta → origin-aware magnetic snap |
| on | on | off | transient clone | raw → stable dominant axis → origin-aware magnetic snap |
| on | any | on | transient clone | raw → Shift if active; no snap |

The same session origin and candidate snapshot must be used across all six cells. Toggling Ctrl changes the rendered subject, not the math origin. Toggling Alt changes snapping, not the subject. Toggling Shift changes only the stable axis constraint. The final pointerup state is authoritative even if no pointermove occurred after the last modifier transition.

## Cancellation and failure matrix

Every abort path needs one owner-checked cleanup routine. It must:

- remove the transient clone synchronously if present;
- restore the original's immutable baseline preview style;
- restore the original bridge selection marker and host frame subject;
- clear snap guides, pending movement update, origin escape latch, preview subject rect, and proposed IDs;
- cancel rAF/timers and remove Ctrl/Shift/Alt listeners;
- invalidate late bridge acknowledgements by transaction key/version;
- leave source, history, and persisted selection unchanged.

The routine must be used for:

- Escape;
- pointercancel or lost ownership;
- mode exit, target selection change, file change, source refresh, iframe replacement, slide/mode replacement, and teardown;
- unsupported subtree or failed identity/reference analysis;
- layout preflight rejection;
- pending text/style flush failure;
- busy save mutex;
- persisted-source conflict;
- source patch failure or file-write failure.

The current owner checks in `finalizeOwnedMovement` are a good model for preventing late save completions from reverting a newer movement. The duplicate transaction needs the same protection for bridge clone creation/removal and post-save selection.

## Validation plan before implementation is considered complete

### Pure source operation tests

Extend or split `apps/web/tests/edit-mode/source-patches.test.ts` for:

- authored root and nested `data-readable-id` remapping;
- generated-path source target receiving a persistent duplicate root ID;
- native `id` remapping and collision allocation;
- internal fragment, SVG, CSS URL, form, headers, and ARIA references;
- external references remaining external;
- insertion immediately after original;
- final standalone root translate, including an existing baseline translate;
- repeated duplication and stable redo mapping;
- unsupported script/media/embedded/plugin/custom/reference cases rejected with source unchanged;
- ambiguous identities and malformed reference graphs rejected atomically.

### Pure movement tests

Extend `apps/web/tests/edit-mode/movement-session.test.ts` for:

- stationary original as a distinct duplicate-origin snap candidate;
- clone and original descendants excluded;
- no origin latch at zero delta;
- origin acquisition after release-band escape;
- Ctrl/Shift/Alt matrix using the same absolute delta;
- rectScale and fractional snap translation matching ordinary movement;
- immutable candidate snapshots despite target-list broadcasts.

### Move-frame tests

Extend `apps/web/tests/components/ManualEditMoveFrame.test.tsx` for:

- no clone/callback/write through 4 px;
- Ctrl active at exactly the 5 px threshold;
- Ctrl pressed and released with no pointer movement;
- repeated toggles not duplicating callbacks/listeners;
- pointerup modifier state overriding the last pointermove state;
- cancellation removing the Ctrl listener and making trailing pointerup/key events no-ops;
- ordinary activation/click behavior unaffected by Ctrl below threshold.

### Bridge tests

Add focused bridge tests for:

- source-derived transient insertion at the immediate sibling position;
- exactly one transient clone per transaction;
- inertness, no pointer/hit/hover/text/selection/a11y participation;
- no `readable-edit-targets` inclusion for the clone or its descendants;
- synchronous clone removal;
- preflight rejection when original or any existing target moves;
- preflight acceptance at supported zoom/transform/layout fixtures;
- stale transaction/version messages ignored;
- active content and forbidden runtime annotations rejected.

### FileViewer/unit integration tests

Add scenarios to `apps/web/tests/components/FileViewer.manual-edit-move.test.tsx` for:

- Ctrl drag keeps original source/runtime geometry unchanged until commit;
- clone frame tracks preview acknowledgements;
- Ctrl transitions at rest restore the same absolute position without jumps;
- text-edit finish and inspector-style flush complete before plan creation;
- busy save/conflict/layout rejection performs no write/history;
- one successful duplicate produces one write, one history entry, and selects the new root;
- source conflict after plan creation invalidates the plan;
- undo selects original when appropriate, redo selects the same duplicate ID;
- late preview ack, source refresh, mode exit, and iframe remount leave no clone or stale frame.

### Real-browser acceptance

Add Playwright coverage under `e2e/ui/` using a source fixture in `e2e/resources/manual-edit.ts`:

- static text/image/container cases supported by the chosen eligibility policy;
- nested SVG and reference fixtures;
- real `Control` down/up during pointer drag, including stationary modifier transitions;
- Shift and Alt combinations;
- 50%, 100%, and 200% preview zoom;
- ancestor transform scale;
- flex/grid layout rejection and stable absolute-position acceptance;
- Escape, pointercancel, selection change, mode exit, and source-refresh cleanup;
- one-write assertion and source identity count;
- commit selection, undo/redo selection, duplicate geometry, and original immobility.

The unit tests cannot prove browser layout, custom-element construction, resource loading, pointer capture, or cross-document focus. The Windows-capable browser test is therefore an acceptance requirement, not an optional polish pass.

## Recommended implementation order, once implementation is authorized

1. Finalize the source operation and identity/reference eligibility contract with pure tests.
2. Extend the movement candidate/result model to separate subject and stationary-origin identities, with pure snap tests.
3. Add the pointer-scoped Ctrl protocol and frame tests without changing persistence.
4. Add the bridge transaction protocol, inert clone filtering, and synchronous preflight tests.
5. Add the host duplicate transaction and source flush ordering.
6. Add atomic persistence/history selection intent and rehydration verification.
7. Add browser fixtures and exercise zoom, transforms, layout, focus, cancellation, and undo/redo.

Do not start by patching `onMoveStart` to conditionally call `cloneNode`. That would put source identity, active-content safety, preview cleanup, snap candidate ownership, and persistence atomicity in the wrong layer and would make the happy path appear to work while leaving the hard invariants unowned.

## Scope and repository boundaries

The issue's stated surface is Manual Edit movement routing, the srcDoc iframe bridge, the source patch model, and Manual Edit history/selection intent. No daemon endpoint, contracts package, CLI command, source migration, dependency, or cross-app capability is indicated. The existing repository boundary rules therefore support keeping the change inside `apps/web` and its web tests/e2e tests.

No implementation, dependency change, lockfile change, or test run was performed as part of this research pass.
