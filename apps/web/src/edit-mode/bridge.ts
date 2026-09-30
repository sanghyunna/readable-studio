export const MANUAL_EDIT_DISCOVERY_SELECTOR = 'main, nav, section, article, header, footer, div, h1, h2, h3, h4, h5, h6, p, li, label, a, button, img, strong, span, small, em, b, i, u, s, mark, code, pre, time, abbr, cite, q, sub, sup, kbd, samp, var, dfn, ins, del, bdi, bdo, figcaption, caption, th, td, dt, dd, summary, output';
export const MANUAL_EDIT_SEMANTIC_TARGET_SELECTOR = 'svg';
export const MANUAL_EDIT_TARGET_SELECTOR = `${MANUAL_EDIT_DISCOVERY_SELECTOR}, ${MANUAL_EDIT_SEMANTIC_TARGET_SELECTOR}`;
export const MANUAL_EDIT_SOURCE_PATH_ATTR = 'data-readable-source-path';
export const MANUAL_EDIT_TRANSIENT_ATTR = 'data-readable-edit-transient';
const MANUAL_EDIT_RUNTIME_HOVER_ATTR = 'data-readable-runtime-hovered';
const MANUAL_EDIT_INLINE_TEXT_WRAPPER_SELECTOR = 'strong, span, small, em, b, i, u, s, mark, code, time, abbr, cite, q, sub, sup, kbd, samp, var, dfn, ins, del, bdi, bdo';
const MANUAL_EDIT_TEXT_PASSAGE_SELECTOR = 'div, h1, h2, h3, h4, h5, h6, p, li, label, a, button, figcaption, caption, th, td, dt, dd, summary, output';
export const MANUAL_EDIT_HOST_NODE_SELECTOR = [
  '[data-readable-sandbox-shim]',
  '[data-readable-deck-bridge]',
  '[data-readable-comment-bridge]',
  '[data-readable-edit-bridge]',
  '[data-readable-comment-bridge-style]',
  '[data-readable-edit-bridge-style]',
  '[data-readable-deck-fix]',
].join(',');

export function manualEditDomPathForElement(el: Element): string {
  const parts: number[] = [];
  let node: Element | null = el;
  while (node && node !== node.ownerDocument.body) {
    const parentEl: Element | null = node.parentElement;
    if (!parentEl) break;
    const children = Array.from(parentEl.children).filter((child) => !isManualEditHostNode(child));
    parts.unshift(children.indexOf(node));
    node = parentEl;
  }
  return parts.length ? `path-${parts.join('-')}` : '';
}

export function isManualEditHostNode(el: Element): boolean {
  return el.matches(MANUAL_EDIT_HOST_NODE_SELECTOR);
}

export function manualEditStableIdForElement(el: Element): string {
  const explicit = el.getAttribute('data-readable-id');
  if (explicit) return explicit;
  const generated = el.getAttribute(MANUAL_EDIT_SOURCE_PATH_ATTR) || el.getAttribute('data-readable-runtime-id') || manualEditDomPathForElement(el);
  if (generated) el.setAttribute('data-readable-runtime-id', generated);
  return generated || 'unknown';
}

export function isMeaningfulManualEditElement(el: Element, rect: Pick<DOMRect, 'width' | 'height'>): boolean {
  return isSourceMappableManualEditElement(el)
    && isManualEditDiscoveryElement(el)
    && !hasManualEditTextPassageAncestor(el)
    && rect.width >= 4
    && rect.height >= 4;
}

export function isSourceMappableManualEditElement(el: Element): boolean {
  return el.hasAttribute('data-readable-id') || el.hasAttribute(MANUAL_EDIT_SOURCE_PATH_ATTR);
}

export function isManualEditSemanticVisualElement(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'svg') return false;
  if (el.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') return false;
  const role = el.getAttribute('role')?.trim().toLowerCase();
  if (role && role !== 'img') return false;
  if (
    role !== 'img'
    && !el.getAttribute('aria-label')?.trim()
    && !el.getAttribute('aria-labelledby')?.trim()
    && !el.getAttribute('title')?.trim()
    && !Array.from(el.children).some((child) => child.tagName.toLowerCase() === 'title' && !!child.textContent?.trim())
  ) return false;
  let parent = el.parentElement;
  while (parent) {
    const tag = parent.tagName.toLowerCase();
    if (parent.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') return false;
    if (tag === 'a' || tag === 'button' || parent.getAttribute('role') === 'button') return false;
    parent = parent.parentElement;
  }
  return true;
}

export function isManualEditDiscoveryElement(el: Element): boolean {
  return el.matches(MANUAL_EDIT_DISCOVERY_SELECTOR)
    || isManualEditSemanticVisualElement(el);
}

function hasManualEditTextPassageAncestor(el: Element): boolean {
  if (!el.matches(MANUAL_EDIT_INLINE_TEXT_WRAPPER_SELECTOR)) return false;
  let parent = el.parentElement;
  while (parent && parent !== parent.ownerDocument.body) {
    if (isSourceMappableManualEditElement(parent) && parent.matches(MANUAL_EDIT_TEXT_PASSAGE_SELECTOR)) return true;
    if (isSourceMappableManualEditElement(parent) && parent.matches(MANUAL_EDIT_DISCOVERY_SELECTOR)) return false;
    parent = parent.parentElement;
  }
  return false;
}

export function buildManualEditBridge(enabled: boolean): string {
  return `<script data-readable-edit-bridge>(function(){
  var enabled = ${JSON.stringify(enabled)};
  var bridgeDocument = document;
  var layoutSuspended = false;
  var discoverySelector = ${JSON.stringify(MANUAL_EDIT_DISCOVERY_SELECTOR)};
  var targetSelector = ${JSON.stringify(MANUAL_EDIT_TARGET_SELECTOR)};
  var hostNodeSelector = ${JSON.stringify(MANUAL_EDIT_HOST_NODE_SELECTOR)};
  var sourcePathAttr = ${JSON.stringify(MANUAL_EDIT_SOURCE_PATH_ATTR)};
  var transientAttr = ${JSON.stringify(MANUAL_EDIT_TRANSIENT_ATTR)};
  var runtimeHoverAttr = ${JSON.stringify(MANUAL_EDIT_RUNTIME_HOVER_ATTR)};
  var textPassageSelector = ${JSON.stringify(MANUAL_EDIT_TEXT_PASSAGE_SELECTOR)};
  var styleProps = ['fontFamily','fontSize','fontWeight','color','textAlign','lineHeight','letterSpacing','width','height','minHeight','translate','gap','flexDirection','justifyContent','alignItems','flex','backgroundColor','opacity','padding','paddingTop','paddingRight','paddingBottom','paddingLeft','margin','marginTop','marginRight','marginBottom','marginLeft','border','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderStyle','borderColor','borderRadius'];
  var authoredSizeProbeSeq = 0;
  var documentEpoch = null;
  var bridgeSequence = 0;
  var duplicateTransaction = null;
  var resizeTransaction = null;
  var resizeClosedSequence = 0;
  var inlineTextWrapperTags = { strong:1, span:1, small:1, em:1, b:1, i:1, u:1, s:1, mark:1, code:1, time:1, abbr:1, cite:1, q:1, sub:1, sup:1, kbd:1, samp:1, var:1, dfn:1, ins:1, del:1, bdi:1, bdo:1 };
  var decorativeTextlessTags = { div:1, svg:1, g:1, path:1, circle:1, ellipse:1, rect:1, line:1, polyline:1, polygon:1, defs:1, lineargradient:1, radialgradient:1, stop:1, clippath:1, mask:1, use:1 };
  function isHostNode(el){
    return !!(el && el.matches && el.matches(hostNodeSelector));
  }
  function isTransient(el){
    return !!(el && el.closest && el.closest('[' + transientAttr + '="true"]'));
  }
  function postManualMessage(message, sequenceOverride){
    if (documentEpoch !== null) {
      message.documentEpoch = documentEpoch;
      message.sequence = sequenceOverride === undefined ? ++bridgeSequence : sequenceOverride;
    }
    window.parent.postMessage(message, '*');
  }
  function domPath(el){
    var parts = [];
    var node = el;
    while (node && node !== document.body) {
      var parent = node.parentElement;
      if (!parent) break;
      var children = Array.prototype.slice.call(parent.children).filter(function(child){ return !isHostNode(child); });
      parts.unshift(children.indexOf(node));
      node = parent;
    }
    return parts.length ? 'path-' + parts.join('-') : '';
  }
  function stableId(el){
    var explicit = el.getAttribute('data-readable-id');
    if (explicit) return explicit;
    var generated = el.getAttribute(sourcePathAttr) || el.getAttribute('data-readable-runtime-id') || domPath(el);
    if (generated) el.setAttribute('data-readable-runtime-id', generated);
    return generated || 'unknown';
  }
  function isCanonicalDeckScaffold(el){
    // The canonical deck shell and fixed-size stage are viewport machinery, not
    // document content. Selecting the shell from the black letterbox creates a
    // viewport-sized host resize frame whose handles overflow the scrollport;
    // classic scrollbars then resize the iframe and retrigger the deck's fit()
    // loop. Slides and everything authored inside them remain normal targets.
    var stage = document.getElementById('deck-stage');
    if (!stage || !el) return false;
    if (el === stage) return true;
    return !!(el.classList && el.classList.contains('deck-shell') && el.contains(stage));
  }
  function isSourceMappable(el){
    return !!(el && !isTransient(el) && !isCanonicalDeckScaffold(el) && el.hasAttribute && (el.hasAttribute('data-readable-id') || el.hasAttribute(sourcePathAttr)));
  }
  function isSemanticVisualRoot(el){
    if (!el || !el.tagName || el.tagName.toLowerCase() !== 'svg') return false;
    if (String(el.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') return false;
    var role = String(el.getAttribute('role') || '').trim().toLowerCase();
    if (role && role !== 'img') return false;
    if (role !== 'img') {
      var hasTitleElement = false;
      var children = el.children || [];
      for (var childIndex = 0; childIndex < children.length; childIndex++) {
        var child = children[childIndex];
        if (child.tagName && child.tagName.toLowerCase() === 'title' && String(child.textContent || '').trim()) {
          hasTitleElement = true;
          break;
        }
      }
      if (!String(el.getAttribute('aria-label') || '').trim()
        && !String(el.getAttribute('aria-labelledby') || '').trim()
        && !String(el.getAttribute('title') || '').trim()
        && !hasTitleElement) return false;
    }
    var parent = el.parentElement;
    while (parent) {
      var tag = parent.tagName ? parent.tagName.toLowerCase() : '';
      if (String(parent.getAttribute('aria-hidden') || '').trim().toLowerCase() === 'true') return false;
      if (tag === 'a' || tag === 'button' || parent.getAttribute('role') === 'button') return false;
      parent = parent.parentElement;
    }
    return true;
  }
  function isDiscoveryTarget(el){
    return !!(el && el.matches && (el.matches(discoverySelector) || (isSemanticVisualRoot(el) && !isHiddenTarget(el))));
  }
  function isInlineTextWrapper(el){
    var tag = el && el.tagName ? el.tagName.toLowerCase() : '';
    return !!inlineTextWrapperTags[tag];
  }
  function textPassageParentTarget(el){
    if (!isInlineTextWrapper(el)) return null;
    var current = el.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isSourceMappable(current) && isDiscoveryTarget(current)) {
        return current.matches(textPassageSelector) ? current : null;
      }
      current = current.parentElement;
    }
    return null;
  }
  function targetForInlineText(el){
    return textPassageParentTarget(el) || el;
  }
  function hasElementChildren(el){
    for (var i = 0; i < el.children.length; i++) {
      if (!isHostNode(el.children[i])) return true;
    }
    return false;
  }
  function singleEditableTextNode(el){
    var textNode = null;
    function visit(node){
      var children = node.childNodes || [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 3) {
          if (!(child.textContent || '').trim()) continue;
          if (textNode) return false;
          textNode = child;
          continue;
        }
        if (child.nodeType === 1) {
          var tag = child.tagName ? child.tagName.toLowerCase() : '';
          if (!inlineTextWrapperTags[tag]) return false;
          if (!visit(child)) return false;
          continue;
        }
        if (child.nodeType === 8) continue;
        return false;
      }
      return true;
    }
    return visit(el) ? textNode : null;
  }
  function hasStructuredEditableText(el){
    var hasText = false;
    var children = el.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) {
        if ((child.textContent || '').trim()) hasText = true;
        continue;
      }
      if (child.nodeType === 1) {
        if (isHostNode(child)) continue;
        var tag = child.tagName ? child.tagName.toLowerCase() : '';
        if (inlineTextWrapperTags[tag]) {
          if ((child.textContent || '').trim()) hasText = true;
          continue;
        }
        if (!decorativeTextlessTags[tag] || (child.textContent || '').trim()) return false;
        continue;
      }
      if (child.nodeType === 8) continue;
      return false;
    }
    return hasText;
  }
  function inferKind(el){
    var explicit = el.getAttribute('data-readable-edit');
    if (explicit) return explicit;
    if (isSemanticVisualRoot(el)) return 'container';
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'a') return 'link';
    if (tag === 'img') return 'image';
    if (['section','main','nav','div','article','header','footer'].indexOf(tag) >= 0) {
      return hasElementChildren(el) && !singleEditableTextNode(el) ? 'container' : 'text';
    }
    return 'text';
  }
  function labelFor(el, id, kind){
    var explicit = el.getAttribute('data-readable-label');
    if (explicit) return explicit;
    var accessible = isSemanticVisualRoot(el) ? (el.getAttribute('aria-label') || el.getAttribute('title')) : '';
    if (!accessible && isSemanticVisualRoot(el)) {
      var labelledBy = el.getAttribute('aria-labelledby') || '';
      var labelIds = labelledBy.trim() ? labelledBy.trim().split(/\\s+/) : [];
      var labelParts = [];
      for (var labelIndex = 0; labelIndex < labelIds.length; labelIndex++) {
        var labelledNode = document.getElementById(labelIds[labelIndex]);
        var labelText = labelledNode ? (labelledNode.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (labelText) labelParts.push(labelText);
      }
      accessible = labelParts.join(' ');
    }
    if (accessible) return accessible;
    var tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 42);
    if (kind === 'image') return el.getAttribute('alt') || id;
    return tag + ' #' + id;
  }
  function attrsFor(el){
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var attr = el.attributes[i];
      if (!attr || attr.name.indexOf('data-readable-runtime') === 0 || attr.name === 'data-readable-edit-selected') continue;
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }
  function stylesFor(el){
    var computed = window.getComputedStyle(el);
    var styles = {};
    styleProps.forEach(function(prop){ styles[prop] = el.style[prop] || computed[prop] || ''; });
    return styles;
  }
  function isLayoutContainer(el){
    var display = window.getComputedStyle(el).display || '';
    if (display.indexOf('flex') >= 0 || display.indexOf('grid') >= 0) return true;
    return hasOwnDisplayHiddenState(el) && inferKind(el) === 'container';
  }
  function hasOwnDisplayHiddenState(el){
    var computed = window.getComputedStyle(el);
    return computed.display === 'none' || el.hasAttribute('hidden');
  }
  function hasHiddenAncestorDisplayState(el){
    var node = el;
    while (node && node !== document.documentElement) {
      if (hasOwnDisplayHiddenState(node)) return true;
      node = node.parentElement;
    }
    return false;
  }
  function isHiddenTarget(el, rect){
    var targetVisibility = window.getComputedStyle(el).visibility;
    if (targetVisibility === 'hidden' || targetVisibility === 'collapse') return true;
    return hasHiddenAncestorDisplayState(el);
  }
  function flexItemAxisFor(el){
    // Skip boxless wrappers: allocation belongs to the effective layout parent.
    var parent = layoutParentFor(el);
    if (!parent) return null;
    var display = window.getComputedStyle(parent).display;
    if (display !== 'flex' && display !== 'inline-flex') return null;
    var direction = window.getComputedStyle(parent).flexDirection || 'row';
    return direction.indexOf('column') === 0 ? 'column' : 'row';
  }
  function rectScaleAxis(rectSize, layoutSize){
    // offsetWidth/offsetHeight are layout (pre-transform) border-box px, so
    // rect/offset isolates the accumulated ancestor transform scale without
    // conflating box-sizing padding/borders. SVG and inline elements report
    // no usable offset size; treat them as unscaled.
    if (!layoutSize || !isFinite(layoutSize) || layoutSize <= 0) return 1;
    var k = rectSize / layoutSize;
    if (!isFinite(k) || k <= 0) return 1;
    return Math.round(k * 10000) / 10000;
  }
  function cssSizeFor(el){
    // Post-layout computed width/height: the used px values, unlike inline
    // styles which layout may clamp or ignore. Resize-drag baseline data.
    var computed = window.getComputedStyle(el);
    return { width: computed.width || '', height: computed.height || '' };
  }
  function mediaTextFor(media){
    if (!media) return '';
    if (typeof media === 'string') return media.trim();
    return typeof media.mediaText === 'string' ? media.mediaText.trim() : '';
  }
  function wrapRulesForMedia(rules, media){
    var text = mediaTextFor(media);
    if (!rules || !text || text.toLowerCase() === 'all') return rules;
    return '@media ' + text + '{' + rules + '}';
  }
  function authoredCssProvenanceFor(el, propertyName){
    var propertyNames = Array.isArray(propertyName) ? propertyName : [propertyName];
    var complete = true;
    var order = 0;
    // getComputedStyle only exposes the USED value, so an undeclared auto
    // width and a stylesheet-authored 320px width both look like px. Mirror
    // every author declaration onto a unique custom property and let the
    // browser's own cascade choose the winner (specificity, !important,
    // active @media/@supports/@container rules, and inline style included).
    // The zero-specificity marker declaration prevents a matching ancestor's
    // custom property from inheriting onto a target whose width is actually
    // undeclared.
    authoredSizeProbeSeq += 1;
    var probeName = '--readable-authored-size-' + authoredSizeProbeSeq;
    var markerName = 'data-readable-authored-size-probe';
    var markerValue = 'p' + authoredSizeProbeSeq;
    var values = [null];
    function declarations(declaration, metadata){
      var output = '';
      if (!declaration || !declaration.getPropertyValue) return output;
      for (var d = 0; d < declaration.length; d++) {
        var property = declaration.item(d);
        if (propertyNames.indexOf(property) < 0) continue;
        var value = declaration.getPropertyValue(property).trim();
        if (!value) continue;
        if (/^(revert|revert-layer|inherit|unset)$/.test(value)) complete = false;
        var priority = declaration.getPropertyPriority(property) === 'important' ? 'important' : '';
        values.push(Object.assign({ property: property, value: value, priority: priority }, metadata));
        output += probeName + ':' + (values.length - 1) + (priority ? ' !important' : '') + ';';
      }
      return output;
    }
    function mirroredRules(ruleList, metadata){
      var output = '';
      if (!ruleList) return output;
      for (var i = 0; i < ruleList.length; i++) {
        var rule = ruleList[i];
        if (!rule) continue;
        if (rule.type === 1 && rule.selectorText && rule.style) {
          var body = declarations(rule.style, Object.assign({}, metadata, { selector: rule.selectorText, ruleOrder: ++order }));
          if (body) output += rule.selectorText + '{' + body + '}';
          if (rule.cssRules && rule.cssRules.length) complete = false;
          continue;
        }
        if (rule.type === 3 && rule.styleSheet) {
          try {
            var importMedia = mediaTextFor(rule.media);
            output += wrapRulesForMedia(mirroredRules(rule.styleSheet.cssRules, Object.assign({}, metadata, { href: rule.href, conditions: metadata.conditions.concat(importMedia ? ['@media ' + importMedia] : []) })), rule.media);
          } catch (_importError) { complete = false; }
          continue;
        }
        if (!rule.cssRules) continue;
        var cssText = rule.cssText || '';
        var brace = cssText.indexOf('{');
        var header = brace >= 0 ? cssText.slice(0, brace).trim() : '';
        if (!/^@(media|supports|container|layer|scope|starting-style)\\b/i.test(header)) continue;
        if (/^@(layer|scope|starting-style)\\b/i.test(header)) complete = false;
        var inner = mirroredRules(rule.cssRules, Object.assign({}, metadata, { conditions: metadata.conditions.concat([header]) }));
        if (inner) output += header + '{' + inner + '}';
      }
      return output;
    }
    var previousMarker = el.getAttribute(markerName);
    var previousInline = el.getAttribute('style');
    var previousProbe = el.style.getPropertyValue(probeName);
    var previousProbePriority = el.style.getPropertyPriority(probeName);
    var probeStyle = document.createElement('style');
    probeStyle.setAttribute('data-readable-authored-size-probe-style', '');
    try {
      el.setAttribute(markerName, markerValue);
      var css = ':where([' + markerName + '=\"' + markerValue + '\"]){' + probeName + ':0;}';
      var sheets = Array.prototype.slice.call(document.styleSheets || []);
      for (var sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
        var sheet = sheets[sheetIndex];
        if (!sheet || sheet.disabled) continue;
        try {
          var sheetMedia = mediaTextFor(sheet.media);
          if (!sheetMedia && sheet.ownerNode && typeof sheet.ownerNode.media === 'string') {
            sheetMedia = sheet.ownerNode.media.trim();
          }
          var sheetRules = mirroredRules(sheet.cssRules, { origin: 'stylesheet', href: sheet.href || undefined, sheetIndex: sheetIndex, conditions: sheetMedia ? ['@media ' + sheetMedia] : [] });
          css += wrapRulesForMedia(sheetRules, sheetMedia);
        } catch (_sheetError) { complete = false; }
      }
      probeStyle.textContent = css;
      (document.head || document.documentElement).appendChild(probeStyle);
      var inlineStart = values.length;
      declarations(el.style, { origin: 'inline', conditions: [] });
      var inlineWinner = null;
      for (var n = inlineStart; n < values.length; n++) {
        if (!inlineWinner || values[n].priority === 'important' || inlineWinner.priority !== 'important') inlineWinner = values[n];
      }
      if (inlineWinner) el.style.setProperty(probeName, String(values.indexOf(inlineWinner)), inlineWinner.priority);
      var winner = Number.parseInt(window.getComputedStyle(el).getPropertyValue(probeName).trim(), 10);
      var result = Number.isInteger(winner) && winner > 0 ? values[winner] : null;
      return result ? Object.assign({}, result, { complete: complete }) : { property: propertyNames[0], value: '', priority: '', origin: 'unknown', conditions: [], complete: complete };
    } finally {
      probeStyle.remove();
      if (previousProbe) el.style.setProperty(probeName, previousProbe, previousProbePriority);
      else el.style.removeProperty(probeName);
      // Probing an absent inline declaration must not create style="" or
      // normalize the authored shorthand order/priority in the selected node.
      restoreInline(el, previousInline);
      if (previousMarker === null) el.removeAttribute(markerName);
      else el.setAttribute(markerName, previousMarker);
    }
  }
  function authoredCssValueFor(el, propertyName){
    return authoredCssProvenanceFor(el, propertyName).value;
  }
  function htmlSizeHintFor(el, propertyName){
    if (!el.tagName || el.tagName.toLowerCase() !== 'img') return '';
    var raw = el.getAttribute && el.getAttribute(propertyName);
    if (!raw) return '';
    var value = raw.trim();
    if (!/^\\d+$/.test(value)) return '';
    var numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) ? numeric + 'px' : '';
  }
  function authoredSizeFor(el){
    var width = authoredCssValueFor(el, 'width');
    var height = authoredCssValueFor(el, 'height');
    return {
      width: width || htmlSizeHintFor(el, 'width'),
      height: height || htmlSizeHintFor(el, 'height')
    };
  }
  function layoutParentFor(el){
    var parent = el.parentElement;
    while (parent && window.getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
    return parent;
  }
  function px(value){
    return /^-?(?:\\d+|\\d*\\.\\d+)px$/i.test(value || '') ? Number.parseFloat(value) : null;
  }
  function edge(computed, name){ return px(computed.getPropertyValue(name)) || 0; }
  function boxFor(el){
    var c = window.getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var horizontal = edge(c, 'padding-left') + edge(c, 'padding-right') + edge(c, 'border-left-width') + edge(c, 'border-right-width');
    var vertical = edge(c, 'padding-top') + edge(c, 'padding-bottom') + edge(c, 'border-top-width') + edge(c, 'border-bottom-width');
    var usedWidth = px(c.width), usedHeight = px(c.height);
    var borderWidth = usedWidth === null ? null : usedWidth + (c.boxSizing === 'border-box' ? 0 : horizontal);
    var borderHeight = usedHeight === null ? null : usedHeight + (c.boxSizing === 'border-box' ? 0 : vertical);
    // Fractional used CSS sizes avoid offsetWidth's integer-rounding scale drift.
    // Corroborate them with layout dimensions; mocks without layout stay unknown.
    var reliableX = borderWidth > 0 && el.offsetWidth > 0 && Math.abs(el.offsetWidth - borderWidth) <= 1;
    var reliableY = borderHeight > 0 && el.offsetHeight > 0 && Math.abs(el.offsetHeight - borderHeight) <= 1;
    // Inline offset dimensions are integer text bounds, not the ignored width.
    var inlineParentBox = c.display === 'inline' && el.parentElement ? boxFor(el.parentElement) : null;
    return { computed: c, rect: r, horizontal: horizontal, vertical: vertical,
      x: reliableX ? r.width / borderWidth : inlineParentBox ? inlineParentBox.x : rectScaleAxis(r.width, el.offsetWidth),
      y: reliableY ? r.height / borderHeight : inlineParentBox ? inlineParentBox.y : rectScaleAxis(r.height, el.offsetHeight),
      reliableX: reliableX, reliableY: reliableY, borderWidth: borderWidth, borderHeight: borderHeight };
  }
  function contentAreaFor(parent){
    if (!parent) return null;
    var b = boxFor(parent), c = b.computed, r = b.rect;
    if (!b.reliableX || !isFinite(b.x) || b.x <= 0) return null;
    var pl = edge(c, 'padding-left'), pr = edge(c, 'padding-right');
    var pt = edge(c, 'padding-top'), pb = edge(c, 'padding-bottom');
    var bl = edge(c, 'border-left-width'), bt = edge(c, 'border-top-width');
    var width = (parent.clientWidth > 0 ? parent.clientWidth : b.borderWidth - bl - edge(c, 'border-right-width')) - pl - pr;
    var height = Math.max(0, (parent.clientHeight > 0 ? parent.clientHeight : (b.borderHeight || 0) - bt - edge(c, 'border-bottom-width')) - pt - pb);
    return { cssWidth: width, x: r.x + (bl + pl) * b.x, y: r.y + (bt + pt) * b.y, width: Math.max(0, width) * b.x, height: height * b.y };
  }
  function gridAreaFor(el, parent, content){
    if (!parent || !content || !/grid/.test(window.getComputedStyle(parent).display)) return null;
    var pc = window.getComputedStyle(parent), c = window.getComputedStyle(el);
    var tracks = pc.gridTemplateColumns.trim().split(/\\s+/).map(px);
    if (!tracks.length || tracks.some(function(track){ return track === null; })) return null;
    // Computed grid-column stays "auto" for ordinary auto-placed children.
    // Measure its stretch allocation reversibly instead of treating the whole
    // parent (including the gap and adjacent columns) as available space.
    if (c.gridColumnStart === 'auto' && parent.children.length > 1) {
      var inline = el.getAttribute('style'), originalTracks = pc.gridTemplateColumns, allocated;
      try {
        ['width', 'min-width', 'max-width', 'margin-left', 'margin-right', 'justify-self'].forEach(function(property, index){
          el.style.setProperty(property, ['auto', '0', 'none', '0', '0', 'stretch'][index], 'important');
        });
        var measured = el.getBoundingClientRect();
        if (window.getComputedStyle(parent).gridTemplateColumns === originalTracks) allocated = { x: measured.x, width: measured.width };
      } finally { restoreInline(el, inline); }
      return allocated || null;
    }
    var start = /^\\d+$/.test(c.gridColumnStart) ? Number(c.gridColumnStart) : parent.children.length === 1 && c.gridColumnStart === 'auto' ? 1 : 0;
    var end = /^\\d+$/.test(c.gridColumnEnd) ? Number(c.gridColumnEnd) : /^span \\d+$/.test(c.gridColumnEnd) ? start + Number(c.gridColumnEnd.slice(5)) : c.gridColumnEnd === 'auto' ? start + 1 : 0;
    if (start < 1 || end <= start || end > tracks.length + 1) return null;
    var gap = px(pc.columnGap) || 0, scale = boxFor(parent).x;
    var preceding = tracks.slice(0, start - 1).reduce(function(a, b){ return a + b; }, 0) + gap * (start - 1);
    var width = tracks.slice(start - 1, end - 1).reduce(function(a, b){ return a + b; }, 0) + gap * (end - start - 1);
    return { x: content.x + preceding * scale, width: width * scale };
  }
  function unsupportedGeometryFor(el){
    if (!el.isConnected || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return 'disconnected-or-non-html';
    if (el.getClientRects().length > 1) return 'fragmented';
    for (var node = el; node; node = node.parentElement) {
      var c = window.getComputedStyle(node);
      if (c.writingMode && c.writingMode !== 'horizontal-tb') return 'writing-mode';
      if (/table/.test(c.display)) return 'table';
      if (c.perspective && c.perspective !== 'none') return 'perspective';
      if (c.rotate && c.rotate !== 'none' && c.rotate !== '0deg') return 'rotation';
      if (c.transform && c.transform !== 'none') {
        var match = /^matrix\\(([^)]+)\\)$/.exec(c.transform);
        var parts = match ? match[1].split(',').map(Number) : [];
        if (parts.length !== 6 || parts[0] <= 0 || parts[3] <= 0 || parts[1] !== 0 || parts[2] !== 0) return 'transform';
      }
      if (node.getAnimations && node.getAnimations().some(function(a){ return a.playState === 'running' || a.playState === 'pending'; })) return 'active-animation';
    }
    var position = window.getComputedStyle(el).position;
    return position === 'absolute' || position === 'fixed' ? 'containing-block' : '';
  }
  function restoreInline(el, inline){
    if (inline === null) el.removeAttribute('style');
    else el.setAttribute('style', inline);
  }
  function trialRect(el, declarations){
    var inline = el.getAttribute('style');
    try {
      declarations.forEach(function(d){ el.style.setProperty(d.property, d.value, 'important'); });
      var r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    } finally { restoreInline(el, inline); }
  }
  function siblingSnapshotFor(el){
    var parent = layoutParentFor(el);
    if (!parent) return [];
    // Boxless descendants participate directly in the parent's formatting context.
    function boxes(node){
      var result = [];
      Array.prototype.forEach.call(node.children, function(child){
        if (child === el || isHostNode(child)) return;
        if (window.getComputedStyle(child).display === 'contents') result = result.concat(boxes(child));
        else result.push({ el: child, rect: child.getBoundingClientRect() });
      });
      return result;
    }
    return boxes(parent);
  }
  function intersectionArea(a, b){
    return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  }
  function resizeOutcomeFor(el, applied, request){
    if (!request || !Array.isArray(request.axes) || !request.requested || request.stage === 'cancel') return null;
    var box = boxFor(el), computed = box.computed;
    var constraints = [], causes = [], failures = [];
    var parent = layoutParentFor(el), area = contentAreaFor(parent);
    var unsupported = unsupportedGeometryFor(el);
    var detailed = request.includeDetails === true || !!request.transactionId;
    function add(code, axis, confidence, declaration, facts){
      var cause = { code: code, axis: axis, confidence: confidence, facts: facts || {} };
      if (declaration) cause.declaration = declaration;
      causes.push(cause);
      return cause;
    }
    function provenance(properties){
      var key = properties.join('|');
      var cache = resizeTransaction && resizeTransaction.provenance;
      if (cache && !request.includeDetails && cache[key]) return cache[key];
      var result = authoredCssProvenanceFor(el, properties);
      if (cache) cache[key] = result;
      return result;
    }
    ['width', 'height'].forEach(function(axis){
      if (request.axes.indexOf(axis) < 0) return;
      var scale = axis === 'width' ? box.x : box.y;
      var tolerance = scale || 1;
      var requested = Number(request.requested[axis]), actual = Number(applied[axis]);
      if (!isFinite(requested) || !isFinite(actual) || Math.abs(requested - actual) <= tolerance) return;
      var constraint = { axis: axis, requested: requested, applied: actual, reason: 'layout' };
      constraints.push(constraint);
      if (!detailed) return;
      var direction = requested > actual ? 'max' : 'min';
      var physical = direction + '-' + axis;
      var logical = direction + '-' + (axis === 'width' ? 'inline-size' : 'block-size');
      var declaration = provenance([physical, logical]);
      var property = declaration.value ? declaration.property : physical;
      var limitText = computed.getPropertyValue(property).trim();
      var limit = px(limitText);
      if (limit === null && axis === 'width' && area && /^\\d+(?:\\.\\d+)?%$/.test(limitText)) limit = area.cssWidth * Number.parseFloat(limitText) / 100;
      var edges = computed.boxSizing === 'border-box' ? 0 : (axis === 'width' ? box.horizontal : box.vertical);
      var normalized = limit === null ? null : (limit + edges) * scale;
      var trial = null;
      if (declaration.value && !unsupported) trial = trialRect(el, [{ property: physical, value: direction === 'max' ? 'none' : '0px' }, { property: logical, value: direction === 'max' ? 'none' : '0px' }]);
      var moved = trial && (direction === 'max' ? trial[axis] > actual + tolerance : trial[axis] < actual - tolerance);
      var widthDeclaration = null, widthTrial = null, combined = null;
      if (axis === 'width' && !unsupported && el.style.getPropertyValue('width')) {
        widthDeclaration = provenance(['width', 'inline-size']);
        var widthOverride = { property: widthDeclaration.property || 'width', value: el.style.getPropertyValue('width') };
        widthTrial = trialRect(el, [widthOverride]);
        if (declaration.value && direction === 'max') combined = trialRect(el, [widthOverride, { property: physical, value: 'none' }, { property: logical, value: 'none' }]);
      }
      var combinedCap = combined && widthTrial && combined.width > widthTrial.width + tolerance;
      var matches = normalized !== null && Math.abs(normalized - actual) <= scale;
      if (declaration.value && (matches || moved || combinedCap)) {
        constraint.reason = direction;
        constraint.property = property;
        constraint.value = declaration.value;
        var reliable = axis === 'width' ? box.reliableX : box.reliableY;
        add(direction === 'min' ? 'intrinsic-minimum' : property === 'max-inline-size' ? 'own-max-inline-size' : 'own-max-width', axis,
          !unsupported && reliable && (moved || combinedCap) ? 'confirmed' : 'unknown', declaration, { normalizedRectLimit: normalized === null ? 'unresolved' : normalized, applied: actual });
      }
      if (widthTrial && (widthTrial.width > actual + tolerance || (combined && trial && combined.width > trial.width + tolerance))) {
        add('own-width-cascade', axis, box.reliableX ? 'confirmed' : 'unknown', widthDeclaration, { applied: actual, trial: widthTrial.width });
        if (!constraint.property) { constraint.property = widthDeclaration.property; constraint.value = widthDeclaration.value; }
      }
      if (axis === 'width' && !causes.some(function(c){ return c.axis === axis; })) {
        if (computed.display === 'inline' && !/^(IMG|VIDEO|CANVAS|IFRAME|INPUT)$/.test(el.tagName) && !unsupported) {
          var inlineTrial = trialRect(el, [{ property: 'display', value: 'inline-block' }, { property: 'max-width', value: 'none' }, { property: 'max-inline-size', value: 'none' }]);
          var inlineConfirmed = inlineTrial.width > actual + tolerance;
          add('own-inline-display', axis, inlineConfirmed ? 'confirmed' : 'unknown', provenance(['display']), { fragments: el.getClientRects().length });
          if (inlineConfirmed && declaration.value) add(property === 'max-inline-size' ? 'own-max-inline-size' : 'own-max-width', axis, 'confirmed', declaration, { combinedInlineTrial: inlineTrial.width });
          constraint.property = 'display';
          constraint.value = 'inline';
        }
        var parentDisplay = parent ? window.getComputedStyle(parent).display : '';
        if (flexItemAxisFor(el) === 'row' && !causes.some(function(c){ return c.axis === axis; })) {
          add('parent-flex-allocation', axis, box.reliableX && !unsupported ? 'confirmed' : 'unknown', null,
            { parentId: stableId(parent), basis: computed.flexBasis, grow: computed.flexGrow, shrink: computed.flexShrink, direction: window.getComputedStyle(parent).flexDirection });
        } else if (/grid/.test(parentDisplay) && !causes.some(function(c){ return c.axis === axis; })) {
          // A grid parent alone does not prove ownership of the mismatch.
          add('parent-grid-allocation', axis, 'unknown', null, { tracks: window.getComputedStyle(parent).gridTemplateColumns, start: computed.gridColumnStart, end: computed.gridColumnEnd });
        }
      }
      if (!causes.some(function(c){ return c.axis === axis; })) add('unknown-cascade', axis, 'unknown', declaration, { applied: actual, requested: requested });
    });
    if (request.axes.indexOf('width') >= 0 && detailed) {
      if (unsupported) add('unsupported-geometry', 'width', 'unknown', null, { reason: unsupported });
      if (area && !unsupported) {
        var ml = edge(computed, 'margin-left') * box.x, mr = edge(computed, 'margin-right') * box.x;
        if (request.requested.width + ml + mr > area.width + box.x || applied.x - ml < area.x - box.x || applied.x + applied.width + mr > area.x + area.width + box.x) {
          var contentCause = add('ancestor-content-limit', 'width', 'confirmed', null, { availableContentWidth: area.width, requested: request.requested.width, applied: applied.width });
          failures.push({ code: contentCause.code, facts: contentCause.facts });
        }
      } else failures.push({ code: 'unsupported-geometry', facts: { reason: unsupported || 'unmeasurable-content-area' } });
      var gridArea = resizeTransaction ? resizeTransaction.gridArea : gridAreaFor(el, parent, area);
      if (gridArea && !unsupported && (request.requested.width > gridArea.width + box.x || applied.x < gridArea.x - box.x || applied.x + applied.width > gridArea.x + gridArea.width + box.x)) {
        var gridCause = add('parent-grid-allocation', 'width', 'confirmed', null, { parentId: stableId(parent), tracks: window.getComputedStyle(parent).gridTemplateColumns, start: computed.gridColumnStart, end: computed.gridColumnEnd, allocatedWidth: gridArea.width, requested: request.requested.width });
        failures.push({ code: gridCause.code, facts: gridCause.facts });
      }
      if (resizeTransaction && !unsupported) {
        var allocationChanged = false;
        resizeTransaction.siblings.forEach(function(sibling){
          if (!sibling.el.isConnected) { failures.push({ code: 'unsupported-geometry', facts: { reason: 'reconstructed-sibling' } }); return; }
          var now = sibling.el.getBoundingClientRect();
          var beforeOverlap = intersectionArea(resizeTransaction.rect, sibling.rect);
          var afterOverlap = intersectionArea(applied, now);
          if (afterOverlap > beforeOverlap + box.x * box.y) {
            var overlap = add('sibling-overlap', 'width', 'confirmed', null, { beforeArea: beforeOverlap, afterArea: afterOverlap });
            failures.push({ code: overlap.code, facts: overlap.facts });
          }
          if (Math.abs(now.x - sibling.rect.x) > box.x || Math.abs(now.width - sibling.rect.width) > box.x) allocationChanged = true;
        });
        var allocationDisplay = parent ? window.getComputedStyle(parent).display : '';
        if (allocationChanged && (flexItemAxisFor(el) === 'row' || /grid/.test(allocationDisplay))) {
          var allocationCode = /grid/.test(allocationDisplay) ? 'parent-grid-allocation' : 'parent-flex-allocation';
          add(allocationCode, 'width', 'confirmed', null, { siblingAllocationChanged: true, parentId: stableId(parent), basis: computed.flexBasis, grow: computed.flexGrow, shrink: computed.flexShrink, direction: window.getComputedStyle(parent).flexDirection, tracks: window.getComputedStyle(parent).gridTemplateColumns });
          failures.push({ code: allocationCode, facts: { siblingAllocationChanged: true } });
        }
      }
      for (var ancestor = parent; ancestor; ancestor = layoutParentFor(ancestor)) {
        var ac = window.getComputedStyle(ancestor);
        if ((ac.clipPath && ac.clipPath !== 'none') || (ac.maskImage && ac.maskImage !== 'none')) failures.push({ code: 'clip', facts: { reason: 'unresolved-clip-or-mask' } });
        if (/(hidden|clip|scroll|auto)/.test(ac.overflowX) || /paint/.test(ac.contain || '')) {
          var clipBox = boxFor(ancestor);
          var clip = clipBox.reliableX ? {
            x: clipBox.rect.x + edge(ac, 'border-left-width') * clipBox.x,
            width: (ancestor.clientWidth || clipBox.borderWidth - edge(ac, 'border-left-width') - edge(ac, 'border-right-width')) * clipBox.x,
          } : null;
          if (clip && (applied.x < clip.x - box.x || applied.x + applied.width > clip.x + clip.width + box.x)) {
            var clipCause = add('clip', 'width', 'confirmed', null, { left: clip.x, right: clip.x + clip.width });
            failures.push({ code: clipCause.code, facts: clipCause.facts });
          }
        }
      }
    }
    causes.forEach(function(c){
      if (c.declaration && !c.declaration.complete) failures.push({ code: 'unknown-cascade', facts: { property: c.declaration.property, reason: 'incomplete-stylesheet-inspection' } });
    });
    if (causes.some(function(c){ return c.axis === 'width' && (c.code === 'ancestor-content-limit' || c.code === 'clip' || c.code === 'sibling-overlap' || c.code.indexOf('parent-') === 0); }) && !constraints.some(function(c){ return c.axis === 'width'; })) {
      constraints.push({ axis: 'width', requested: request.requested.width, applied: applied.width, reason: 'layout' });
    }
    // A causal stylesheet-important winner is a document-style boundary,
    // not permission to emit a per-element important override. The agent can
    // change the shared rule deliberately; inline authored caps remain local.
    var sharedStyleCauses = causes.filter(function(c){
      return c.axis === 'width' && c.code.indexOf('own-') === 0 && c.confidence === 'confirmed'
        && c.declaration && c.declaration.origin === 'stylesheet' && c.declaration.priority === 'important';
    });
    sharedStyleCauses.forEach(function(c){ add('shared-style-width', 'width', 'confirmed', c.declaration, c.facts); });
    var sharedStyle = sharedStyleCauses.length > 0;
    var own = causes.some(function(c){ return c.code.indexOf('own-') === 0; });
    var allocation = causes.some(function(c){ return c.code.indexOf('parent-') === 0 && c.confidence === 'confirmed'; });
    var special = causes.some(function(c){ return c.declaration && (c.declaration.priority === 'important' || c.declaration.conditions.length); });
    var confirmedInline = area && causes.some(function(c){ return c.code === 'own-inline-display' && c.confidence === 'confirmed'; });
    var unknown = !!unsupported || (request.axes.indexOf('width') >= 0 && !box.reliableX && !confirmedInline) || causes.some(function(c){ return c.confidence === 'unknown'; });
    var classification = allocation ? 'parent-owned' : sharedStyle ? 'shared-style' : own ? (special ? 'responsive-or-important' : 'own-cap') : 'unknown';
    if (request.transactionId && request.axes.indexOf('width') >= 0 && (failures.length || unknown) && !constraints.some(function(c){ return c.axis === 'width'; })) {
      constraints.push({ axis: 'width', requested: request.requested.width, applied: applied.width, reason: 'layout' });
    }
    constraints.forEach(function(c){ c.causes = causes.filter(function(cause){ return cause.axis === c.axis; }); c.confidence = c.causes.length && c.causes.every(function(cause){ return cause.confidence === 'confirmed'; }) ? 'confirmed' : 'unknown'; c.classification = classification; });
    return Object.assign({}, resizeIdentity(request), { constraints: constraints, causes: causes, confidence: unknown || (!causes.length && constraints.length) ? 'unknown' : 'confirmed', classification: classification,
      decision: allocation ? 'parent-owned' : sharedStyle || failures.length || unknown ? 'refused' : own ? 'release-own' : 'ordinary',
      requested: request.requested, actual: { x: applied.x, y: applied.y, width: applied.width, height: applied.height }, usedCssWidth: computed.width,
      conversion: { x: box.x, y: box.y, boxSizing: computed.boxSizing || 'content-box', horizontalEdges: box.horizontal, verticalEdges: box.vertical },
      availableContentWidth: area ? area.width : undefined, parentContentRect: area ? { x: area.x, y: area.y, width: area.width, height: area.height } : undefined,
      safetyFailures: failures, proposedDeclarations: [], announce: request.stage ? request.stage === 'finalize' : request.includeDetails === true });
  }
  function resizeIdentity(request){
    if (!request || !request.transactionId) return {};
    return { targetId: request.targetId, documentEpoch: request.documentEpoch, transactionId: request.transactionId, sequence: request.sequence, sourceRevision: request.sourceRevision, stage: request.stage };
  }
  function ancestorIdsFor(el){
    // Nearest-first: immediate discoverable parent, then outward.
    var ids = [];
    var node = el.parentElement;
    while (node && node !== document.body) {
      if (isSourceMappable(node) && isDiscoveryTarget(node)) ids.push(stableId(node));
      node = node.parentElement;
    }
    return ids;
  }
  function targetFrom(el, includeOuterHtml, includeAuthoredSize){
    var rect = el.getBoundingClientRect();
    var kind = inferKind(el);
    var id = stableId(el);
    var textEditTarget = kind === 'container' && hasStructuredEditableText(el) ? el : null;
    var hidden = isHiddenTarget(el, rect);
    var fields = {};
    if (kind === 'link') {
      fields.text = (el.textContent || '').trim();
      fields.href = el.getAttribute('href') || '';
    } else if (kind === 'image') {
      fields.src = el.getAttribute('src') || '';
      fields.alt = el.getAttribute('alt') || '';
    } else {
      fields.text = (el.textContent || '').trim();
    }
    var ancestorIds = ancestorIdsFor(el);
    var target = {
      id: id,
      kind: kind,
      label: labelFor(el, id, kind),
      tagName: el.tagName ? el.tagName.toLowerCase() : 'element',
      className: typeof el.className === 'string' ? el.className : '',
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rectScale: { x: rectScaleAxis(rect.width, el.offsetWidth), y: rectScaleAxis(rect.height, el.offsetHeight) },
      parentId: ancestorIds.length ? ancestorIds[0] : null,
      ancestorIds: ancestorIds,
      cssSize: cssSizeFor(el),
      flexItemAxis: flexItemAxisFor(el),
      textEditTargetId: textEditTarget ? stableId(textEditTarget) : undefined,
      fields: fields,
      attributes: attrsFor(el),
      styles: stylesFor(el),
      isLayoutContainer: isLayoutContainer(el),
      isHidden: hidden,
      isConnected: el.isConnected,
      outerHtml: includeOuterHtml ? (el.outerHTML || '').replace(/\\sdata-readable-runtime-id="[^"]*"/g, '').replace(/\\sdata-readable-runtime-hovered="[^"]*"/g, '').replace(/\\sdata-readable-source-path="[^"]*"/g, '').replace(/\\sdata-readable-edit-selected="[^"]*"/g, '') : ''
    };
    // Only selected targets need cascade provenance and full inline declarations;
    // discovery and hover broadcasts intentionally skip this work.
    if (includeAuthoredSize) {
      target.authoredSize = authoredSizeFor(el);
      target.inlineDeclarations = Array.prototype.map.call(el.style, function(property){ return { property: property, value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) }; });
      target.hasInlineStyle = el.hasAttribute('style');
      var selectedBox = boxFor(el);
      target.rectScale = { x: selectedBox.x, y: selectedBox.y };
    }
    return target;
  }
  function allTargets(){
    var nodes = document.body ? document.body.querySelectorAll(targetSelector) : [];
    var targets = [];
    for (var i = 0; i < nodes.length; i++) {
      var rect = nodes[i].getBoundingClientRect();
      if (isTransient(nodes[i])) continue;
      if (!isSourceMappable(nodes[i])) continue;
      if (!isDiscoveryTarget(nodes[i])) continue;
      if (targetForInlineText(nodes[i]) !== nodes[i]) continue;
      if (!isHiddenTarget(nodes[i], rect) && (rect.width < 4 || rect.height < 4)) continue;
      targets.push(targetFrom(nodes[i], false, false));
    }
    return targets;
  }
  function postTargets(){
    // Text is owned by the live contenteditable until commit. Rediscovering the
    // entire document per keystroke cannot update canonical source or selection.
    if (!hasLiveLayoutDocument() || !enabled || activeTextEditFinish) return;
    postManualMessage({ type: 'readable-edit-targets', targets: allTargets() });
  }
  var lastHoverId;
  var hoveredTarget = null;
  function setHoveredTarget(el){
    if (isTransient(el)) el = null;
    hoveredTarget = el && el.isConnected ? el : null;
    var hovered = document.querySelectorAll('[' + runtimeHoverAttr + ']');
    for (var i = 0; i < hovered.length; i++) {
      if (hovered[i] !== hoveredTarget) hovered[i].removeAttribute(runtimeHoverAttr);
    }
    if (hoveredTarget && hoveredTarget.getAttribute(runtimeHoverAttr) !== 'true') hoveredTarget.setAttribute(runtimeHoverAttr, 'true');
  }
  setHoveredTarget(null);
  function postHoverTarget(el){
    setHoveredTarget(el);
    if (!enabled) return;
    var id = el ? stableId(el) : null;
    if (id === lastHoverId) return;
    lastHoverId = id;
    postManualMessage({ type: 'readable-edit-hover', target: el ? targetFrom(el, true, false) : null });
  }
  function resolveHoverAtPoint(clientX, clientY, fallback){
    var el = topTargetAtPoint(clientX, clientY, fallback);
    if (el && stableId(el) === hostSelectedTargetId) el = null;
    postHoverTarget(el);
  }
  function clearSelectedTarget(){
    var selected = document.querySelectorAll('[data-readable-edit-selected]');
    for (var i = 0; i < selected.length; i++) selected[i].removeAttribute('data-readable-edit-selected');
  }
  function setSelectedTarget(id){
    clearSelectedTarget();
    if (!id) return;
    var el = findById(id);
    if (el) el.setAttribute('data-readable-edit-selected', 'true');
  }
  function ancestorTarget(el){
    if (isTransient(el)) return null;
    while (el && el !== document.documentElement) {
      if (el !== document.body && el !== document.documentElement && isSourceMappable(el) && isDiscoveryTarget(el)) {
        return targetForInlineText(el);
      }
      el = el.parentElement;
    }
    return null;
  }
  function closestTarget(event){
    return ancestorTarget(event.target);
  }
  function targetsAtPoint(x, y){
    if (!document.elementsFromPoint) return [];
    var nodes = document.elementsFromPoint(x, y) || [];
    var targets = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isTransient(nodes[i])) continue;
      var target = ancestorTarget(nodes[i]);
      if (!target || targets.indexOf(target) >= 0) continue;
      targets.push(target);
    }
    return targets;
  }
  function topTargetAtPoint(x, y, fallback){
    var stack = targetsAtPoint(x, y);
    return stack[0] || ancestorTarget(fallback) || null;
  }
  var clickCycle = null;
  var clickCycleTolerance = 4;
  function resetClickCycle(){
    clickCycle = null;
  }
  function stackSignature(stack){
    return stack.map(function(el){ return stableId(el); }).join('\\n');
  }
  function sameClickCycle(x, y, signature){
    return clickCycle
      && Math.abs(clickCycle.x - x) <= clickCycleTolerance
      && Math.abs(clickCycle.y - y) <= clickCycleTolerance
      && clickCycle.signature === signature;
  }
  function clickTarget(event){
    var stack = targetsAtPoint(event.clientX, event.clientY);
    if (!stack.length) {
      var fallback = closestTarget(event);
      if (fallback) stack = [fallback];
    }
    if (!stack.length) {
      resetClickCycle();
      return { el: null, cycled: false };
    }
    var signature = stackSignature(stack);
    var cycled = sameClickCycle(event.clientX, event.clientY, signature);
    var index = cycled
      ? (clickCycle.index + 1) % stack.length
      : (event.altKey && stack.length > 1 ? 1 : 0);
    clickCycle = { x: event.clientX, y: event.clientY, signature: signature, index: index };
    return { el: stack[index], cycled: cycled };
  }
  function currentSelectedRange(){
    try {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      var range = sel.getRangeAt(0);
      return range.collapsed ? null : range;
    } catch (e) {
      return null;
    }
  }
  function targetForSelection(el){
    if (isTransient(el)) return null;
    var range = currentSelectedRange();
    if (!range || !el) return el;
    if (el.contains(range.startContainer) && el.contains(range.endContainer)) return el;
    var node = range.commonAncestorContainer;
    var current = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    while (current && current !== document.documentElement) {
      if (current !== document.body && isSourceMappable(current) && isDiscoveryTarget(current) && current.contains(range.startContainer) && current.contains(range.endContainer)) return current;
      current = current.parentElement;
    }
    return el;
  }
  function caretRangeFromClick(clickEvent){
    try {
      if (document.caretPositionFromPoint) {
        var position = document.caretPositionFromPoint(clickEvent.clientX, clickEvent.clientY);
        if (!position) return null;
        var positionRange = document.createRange();
        positionRange.setStart(position.offsetNode, position.offset);
        positionRange.collapse(true);
        return positionRange;
      }
      if (document.caretRangeFromPoint) {
        return document.caretRangeFromPoint(clickEvent.clientX, clickEvent.clientY);
      }
    } catch (e) {}
    return null;
  }
  function placeCaretFromClick(clickEvent, el){
    var range = caretRangeFromClick(clickEvent);
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    try {
      var sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }
  // execCommand is deprecated, but it is the only formatting path integrated
  // with the browser's native undo manager: raw Range/DOM surgery on a live
  // focused contenteditable corrupts that undo stack (Ctrl+Z stops undoing
  // anything at or before the surgery point for the rest of the session).
  var richFormatCommands = { b: 'bold', i: 'italic', u: 'underline' };
  function selectedRangeWithin(el){
    try {
      var range = currentSelectedRange();
      if (!range) return null;
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
      return range.cloneRange();
    } catch (e) {
      return null;
    }
  }
  function restoreSelectionRange(range){
    try {
      if (!range) return false;
      var sel = window.getSelection();
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) {
      return false;
    }
  }
  function richEditingEl(){
    var el = document.querySelector('[data-readable-editing="true"]');
    return (el && el.getAttribute('contenteditable') === 'true') ? el : null;
  }
  var lastSelectionState = null;
  function postSelectionState(){
    if (!enabled) return;
    var el = document.querySelector('[data-readable-editing="true"]');
    var range = el ? currentSelectedRange() : null;
    var within = !!(range && el.contains(range.startContainer) && el.contains(range.endContainer));
    function q(cmd){ try { return !!document.queryCommandState(cmd); } catch (e) { return false; } }
    var state = { type: 'readable-edit-selection-state', editing: !!el, hasSelection: within,
      bold: !!el && q('bold'), italic: !!el && q('italic'), underline: !!el && q('underline') };
    if (lastSelectionState && state.editing === lastSelectionState.editing
      && state.hasSelection === lastSelectionState.hasSelection && state.bold === lastSelectionState.bold
      && state.italic === lastSelectionState.italic && state.underline === lastSelectionState.underline) return;
    lastSelectionState = state;
    window.parent.postMessage(state, '*');
  }
  function applyRichFormat(command){
    if (command !== 'bold' && command !== 'italic' && command !== 'underline') return;
    var el = richEditingEl();
    if (!el) return;
    try { el.focus(); } catch (e) {}
    try { document.execCommand(command); } catch (e) {}
    postSelectionState();
  }
  var activeTextEditFinish = null;
  function finishActiveTextEdit(){
    if (activeTextEditFinish) activeTextEditFinish(true);
  }
  function makeEditable(el, clickEvent){
    if (!el || isTransient(el) || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === 'plaintext-only') return;
    finishActiveTextEdit();
    // Links (and any element the host routes here as a non-text leaf) stay on the
    // plain-text path: their inline label is the only editable surface and rich
    // markup would fight the panel's link/href fields. Everything else gets a
    // formatting-capable contenteditable so Ctrl/Cmd+B/U/I can produce markup.
    var kind = inferKind(el);
    var rich = kind === 'text' || (kind !== 'link' && hasStructuredEditableText(el));
    setHoveredTarget(null);
    var originalText = el.textContent || '';
    var originalHtml = el.innerHTML;
    var selectedRange = selectedRangeWithin(el);
    clearSelectedTarget();
    resetClickCycle();
    el.setAttribute('contenteditable', rich ? 'true' : 'plaintext-only');
    el.setAttribute('data-readable-editing', 'true');
    // Chromium's execCommand defaults to inline style spans; turning this off
    // once per session makes B/I/U emit <b>/<i>/<u> tags instead.
    if (rich) { try { document.execCommand('styleWithCSS', false, 'false'); } catch (e) {} }
    try { el.focus(); } catch (e) {}
    if (!restoreSelectionRange(selectedRange)) placeCaretFromClick(clickEvent, el);
    if (rich) postSelectionState();
    function finish(commit){
      activeTextEditFinish = null;
      queuePostTargets();
      // Removing contenteditable can synchronously blur in Chromium. Detach
      // first so a keyboard commit cannot re-enter finish and duplicate history.
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-readable-editing');
      setSelectedTarget(hostSelectedTargetId);
      postSelectionState();
      if (!commit) {
        if (rich) el.innerHTML = originalHtml;
        else el.textContent = originalText;
        return;
      }
      // Rich edits that introduced (or kept) inline markup commit the full inner
      // HTML so nested formatting and sibling markup survive; pure-text edits stay
      // on the lighter text-commit path the source patcher escapes safely.
      var hasMarkup = false;
      for (var i = 0; i < el.children.length; i++) {
        if (!isHostNode(el.children[i])) { hasMarkup = true; break; }
      }
      if (rich && hasMarkup) {
        setHoveredTarget(null);
        var html = el.innerHTML;
        if (html !== originalHtml) {
          window.parent.postMessage({
            type: 'readable-edit-html-commit',
            id: stableId(el),
            html: html
          }, '*');
        }
        return;
      }
      var value = (el.textContent || '').trim();
      if (value !== originalText.trim()) {
        window.parent.postMessage({
          type: 'readable-edit-text-commit',
          id: stableId(el),
          value: value
        }, '*');
      }
    }
    function onBlur(){ finish(true); }
    function onKey(ev){
      if (rich && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
        var formatCommand = richFormatCommands[(ev.key || '').toLowerCase()];
        if (formatCommand) {
          ev.preventDefault();
          try { document.execCommand(formatCommand); } catch (e) {}
          postSelectionState();
          return;
        }
      }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true);
        try { el.blur(); } catch (e) {}
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(true); // PPT: Esc commits typed text and promotes to object-select; undo stays on host Ctrl+Z
        try { el.blur(); } catch (e) {}
      }
    }
    activeTextEditFinish = finish;
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
  }
  function camelToKebab(name){ return String(name).replace(/[A-Z]/g, function(m){ return '-' + m.toLowerCase(); }); }
  function cssEscapeId(value){ if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value); return String(value).replace(/"/g, '\\\\"'); }
  function findById(id){
    if (!id) return null;
    if (id === '__body__') return document.body;
    function firstLive(selector){
      var matches = document.querySelectorAll(selector);
      for (var matchIndex = 0; matchIndex < matches.length; matchIndex++) {
        if (!isTransient(matches[matchIndex])) return matches[matchIndex];
      }
      return null;
    }
    var el = firstLive('[data-readable-id="' + cssEscapeId(id) + '"]')
          || firstLive('[data-readable-runtime-id="' + cssEscapeId(id) + '"]')
          || firstLive('[' + sourcePathAttr + '="' + cssEscapeId(id) + '"]');
    if (el && isSourceMappable(el)) return el;
    if (typeof id === 'string' && id.indexOf('path-') === 0) {
      var parts = id.slice('path-'.length).split('-').map(function(s){ return Number(s); });
      var node = document.body;
      for (var i = 0; i < parts.length; i++) {
        if (!node) return null;
        var idx = parts[i];
        if (!Number.isInteger(idx) || idx < 0) return null;
        var children = Array.prototype.slice.call(node.children).filter(function(c){ return !isHostNode(c); });
        node = children[idx] || null;
      }
      return node && !isTransient(node) && isSourceMappable(node) ? node : null;
    }
    return null;
  }
  function applyPreviewStyles(id, styles, version, includeAuthoredSize, resizeRequest){
    var identity = resizeIdentity(resizeRequest);
    if (resizeRequest && resizeRequest.transactionId && (resizeRequest.documentEpoch !== documentEpoch || resizeRequest.targetId !== id || resizeRequest.sequence <= resizeClosedSequence)) return;
    var el = findById(id);
    if (!el || !el.isConnected) {
      postManualMessage(Object.assign({ type: 'readable-edit-preview-style-applied', id: id || '', version: Number(version) || 0, ok: false, error: 'Target not found' }, identity), identity.sequence);
      return;
    }
    if (resizeRequest && resizeRequest.transactionId) {
      if (resizeTransaction && (resizeRequest.sequence <= resizeTransaction.sequence || (resizeTransaction.id === resizeRequest.transactionId && resizeTransaction.sourceRevision !== resizeRequest.sourceRevision))) return;
      if (!resizeTransaction || resizeTransaction.id !== resizeRequest.transactionId) {
        if (resizeRequest.stage === 'cancel') return;
        // A new gesture supersedes the old snapshot, never its current styling.
        resizeTransaction = { id: resizeRequest.transactionId, sourceRevision: resizeRequest.sourceRevision, sequence: 0, el: el, inline: el.getAttribute('style'), rect: el.getBoundingClientRect(), siblings: siblingSnapshotFor(el), gridArea: gridAreaFor(el, layoutParentFor(el), contentAreaFor(layoutParentFor(el))), provenance: {} };
      }
      resizeTransaction.sequence = resizeRequest.sequence;
      // Every frame is assessed from the authored baseline, not the previous
      // released preview. Cancellation preserves its exact attribute bytes.
      restoreInline(el, resizeTransaction.inline);
    }
    var keys = resizeRequest && (resizeRequest.stage === 'cancel' || resizeRequest.stage === 'begin') ? [] : Object.keys(styles || {});
    // Mute window: live preview streams one inline-style write per frame during
    // a drag; without it the layout observer below would echo a full
    // readable-edit-targets post per frame. queuePostTargets DEFERS (not drops) the
    // muted echo, so one coalesced re-broadcast still lands after the stream
    // quiets; mid-drag the per-frame ack below carries the fresh rect instead.
    suppressObservedLayoutUntil = Date.now() + 64;
    try {
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = styles[key];
        var cssName = camelToKebab(key);
        if (typeof value !== 'string' || value.trim() === '') el.style.removeProperty(cssName);
        else el.style.setProperty(cssName, value.trim());
      }
      // Post-apply measurement: the host renders resize handles from the
      // element's REAL box (flex/grid/min-content can clamp or ignore the
      // requested size), so every ack feeds the applied geometry back.
      var applied = el.getBoundingClientRect();
      if (resizeRequest && resizeRequest.sizeMode && el.hasAttribute('data-readable-width-release')) {
        resizeRequest = Object.assign({}, resizeRequest, { requested: { width: applied.width, height: resizeRequest.requested.height } });
      }
      var appliedMessage = {
        type: 'readable-edit-preview-style-applied',
        id: id,
        version: Number(version) || 0,
        ok: true,
        rect: { x: applied.x, y: applied.y, width: applied.width, height: applied.height },
        cssSize: cssSizeFor(el)
      };
      if (includeAuthoredSize) appliedMessage.authoredSize = authoredSizeFor(el);
      var resize = resizeOutcomeFor(el, applied, resizeRequest);
      if (resize && resizeTransaction && resizeRequest.axes.indexOf('width') >= 0
        && resize.classification !== 'shared-style'
        && ((resize.decision !== 'parent-owned' && resize.confidence === 'confirmed' && resize.causes.some(function(c){ return c.code.indexOf('own-') === 0; }))
          || (el.hasAttribute('data-readable-width-release') && resize.decision === 'ordinary'))) {
        var ownCauses = resize.causes.filter(function(c){ return c.code.indexOf('own-') === 0; });
        var preferred = resizeRequest.sizeMode ? px(window.getComputedStyle(el).width) : px(styles.width);
        var preferredValue = resizeRequest.sizeMode ? styles.width : 'min(' + preferred + 'px, 100%)';
        var declarations = [];
        if (preferred > 0) {
          Object.keys(styles).forEach(function(key){ declarations.push({ property: camelToKebab(key), value: key === 'width' ? preferredValue : styles[key], priority: '' }); });
          var maxima = ['max-width'];
          if (ownCauses.some(function(c){ return c.code === 'own-max-inline-size'; })) maxima.push('max-inline-size');
          maxima.forEach(function(property){ ['100%', '-moz-available', 'stretch'].forEach(function(value){ declarations.push({ property: property, value: value, priority: '' }); }); });
          if (ownCauses.some(function(c){ return c.code === 'own-inline-display'; })) declarations.push({ property: 'display', value: 'inline-block', priority: '' });
          if (ownCauses.some(function(c){ return c.code === 'own-width-cascade' && c.declaration.property === 'inline-size'; })) declarations.push({ property: 'inline-size', value: preferredValue, priority: '' });
          declarations.forEach(function(d){ el.style.setProperty(d.property, d.value); });
          var candidateRect = el.getBoundingClientRect();
          var accepted = resizeOutcomeFor(el, candidateRect, resizeRequest);
          if (accepted.decision === 'ordinary' && Math.abs(candidateRect.width - resizeRequest.requested.width) <= (resize.conversion.x || 1)) {
            accepted.decision = 'release-own';
            accepted.causes = ownCauses;
            accepted.proposedDeclarations = declarations;
            accepted.preferredCssPx = preferred;
            if (resizeRequest.sizeMode) accepted.mode = resizeRequest.sizeMode;
            if (resizeRequest.stage === 'finalize') {
              var candidateInline = el.getAttribute('style');
              restoreInline(el, resizeTransaction.inline);
              var clone = document.documentElement.cloneNode(true);
              clone.querySelectorAll('script').forEach(function(script){
                var host = Array.prototype.some.call(script.attributes, function(a){ return a.name.indexOf('data-readable-') === 0; });
                if (!host && script.type !== 'application/json' && script.type !== 'application/ld+json') accepted.safetyFailures.push({ code: 'unsupported-geometry', facts: { reason: 'script-owned-document' } });
                script.remove();
              });
              clone.querySelectorAll(hostNodeSelector).forEach(function(node){ node.remove(); });
              clone.querySelectorAll('[data-readable-edit-selected],[data-readable-editing]').forEach(function(node){ node.removeAttribute('data-readable-edit-selected'); node.removeAttribute('data-readable-editing'); });
              accepted.preflight = { source: '<!doctype html>' + clone.outerHTML, targetId: id, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, baselineRect: { x: resizeTransaction.rect.x, y: resizeTransaction.rect.y, width: resizeTransaction.rect.width, height: resizeTransaction.rect.height }, declarations: declarations };
              restoreInline(el, candidateInline);
              if (accepted.safetyFailures.length) accepted.decision = 'refused';
            }
            resize = accepted;
            appliedMessage.rect = { x: candidateRect.x, y: candidateRect.y, width: candidateRect.width, height: candidateRect.height };
            appliedMessage.cssSize = cssSizeFor(el);
            if (includeAuthoredSize) appliedMessage.authoredSize = authoredSizeFor(el);
          } else if (accepted.classification === 'shared-style') {
            // Removing an inline cap can expose a shared important winner.
            // Preserve that explicit hand-off diagnosis rather than a generic failure.
            resize = accepted;
          } else {
            resize.decision = 'refused';
            resize.safetyFailures.push({ code: 'unknown-cascade', facts: { reason: 'release-ineffective' } });
          }
        } else resize.decision = 'refused';
      }
      if (resize && resizeTransaction && resizeRequest.stage === 'preview'
        && (resize.decision === 'ordinary' || resize.decision === 'release-own') && !resize.safetyFailures.length) {
        resizeTransaction.lastSafeInline = el.getAttribute('style');
      }
      // Assess the ordinary selected-only trial before exposing it. A refused
      // horizontal transaction restores the entire snapshot, including paired
      // height/margins; no structural or overflowing preview survives a frame.
      if (resize && resizeTransaction && resizeRequest.axes.indexOf('width') >= 0
        && (resize.decision === 'parent-owned' || resize.decision === 'refused')) {
        restoreInline(el, resizeRequest.stage === 'preview' && resizeTransaction.lastSafeInline !== undefined
          ? resizeTransaction.lastSafeInline : resizeTransaction.inline);
        var restored = el.getBoundingClientRect();
        appliedMessage.rect = { x: restored.x, y: restored.y, width: restored.width, height: restored.height };
        appliedMessage.cssSize = cssSizeFor(el);
        if (includeAuthoredSize) appliedMessage.authoredSize = authoredSizeFor(el);
        resize.actual = appliedMessage.rect;
        resize.constraints.forEach(function(c){ c.applied = restored[c.axis]; });
      }
      if (resize) appliedMessage.resize = resize;
      postManualMessage(Object.assign(appliedMessage, identity), identity.sequence);
      if (resizeRequest && resizeRequest.stage === 'finalize' && resize && resize.decision === 'release-own' && resizeTransaction) {
        // The host still owes conservative responsive acceptance. Keep source
        // and live document at the baseline until its atomic source transaction.
        restoreInline(el, resizeTransaction.inline);
      }
      if (resizeRequest && (resizeRequest.stage === 'cancel' || resizeRequest.stage === 'finalize')) {
        resizeClosedSequence = resizeRequest.sequence || resizeClosedSequence;
        resizeTransaction = null;
      }
    } catch (e) {
      if (resizeTransaction) restoreInline(el, resizeTransaction.inline);
      postManualMessage(Object.assign({ type: 'readable-edit-preview-style-applied', id: id, version: Number(version) || 0, ok: false, error: e && e.message ? String(e.message) : 'Could not apply preview styles' }, identity), identity.sequence);
    }
  }
  var duplicateForbiddenTags = {
    audio:1, base:1, button:1, canvas:1, dialog:1, datalist:1, details:1, embed:1, form:1,
    frame:1, frameset:1, iframe:1, input:1, link:1, meta:1, object:1,
    optgroup:1, option:1, portal:1, script:1, select:1, slot:1, source:1,
    style:1, summary:1, template:1, textarea:1, title:1, track:1, video:1, label:1,
    animate:1, animatemotion:1, animatetransform:1, marquee:1, set:1
  };
  // Static data assets are valid preview content and are preserved by the
  // source planner. Only executable or local-file schemes are rejected here.
  var duplicateForbiddenUrl = /^(?:javascript|vbscript|file):/i;
  function duplicateElements(root){
    var elements = [root];
    var descendants = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < descendants.length; i++) elements.push(descendants[i]);
    return elements;
  }
  function validateDuplicateMarkup(root){
    var elements = duplicateElements(root);
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (duplicateForbiddenTags[tag] || tag.indexOf('-') >= 0) return 'Unsupported element in duplicate.';
      for (var j = 0; j < el.attributes.length; j++) {
        var attr = el.attributes[j];
        var name = attr.name.toLowerCase();
        if (
          name.indexOf('on') === 0
          || name === 'srcdoc'
          || name === transientAttr
          || name === 'data-readable-source-path'
          || name.indexOf('data-readable-runtime-') === 0
          || name === 'data-readable-edit-selected'
          || name === 'data-readable-editing'
          || name === 'data-readable-edit-mode'
          || name === 'data-readable-authored-size-probe'
          || name === 'data-readable-authored-size-probe-style'
        ) return 'Unsafe duplicate attribute.';
        if (
          name === 'autofocus'
          || name === 'formaction'
          || name === 'formenctype'
          || name === 'formmethod'
          || name === 'formnovalidate'
          || name === 'formtarget'
          || name === 'name'
          || name === 'itemref'
          || (name === 'contenteditable' && String(attr.value).toLowerCase() !== 'false')
        ) return 'Unsupported duplicate attribute.';
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && duplicateForbiddenUrl.test(attr.value.replace(/[\\u0000-\\u0020]+/g, ''))) {
          return 'Unsafe duplicate URL.';
        }
      }
    }
    return null;
  }
  function duplicatePseudoSignature(el, pseudo){
    try {
      var style = window.getComputedStyle(el, pseudo);
      var parts = [];
      for (var i = 0; i < style.length; i++) {
        var name = style.item(i);
        if (!name || duplicateIgnoredComputedProperties[name]) continue;
        parts.push(name + ':' + style.getPropertyValue(name));
      }
      parts.sort();
      return parts.join(';');
    } catch (e) {
      return '';
    }
  }
  // The transient clone deliberately changes a few computed properties to
  // become inert. Compare every other computed property at insertion time so
  // sibling-sensitive selectors (for example :last-child or an id selector)
  // cannot silently change the original or make the clone look different.
  var duplicateIgnoredComputedProperties = {
    'animation': 1,
    'animation-delay': 1,
    'animation-direction': 1,
    'animation-duration': 1,
    'animation-fill-mode': 1,
    'animation-iteration-count': 1,
    'animation-name': 1,
    'animation-play-state': 1,
    'animation-timing-function': 1,
    'interactivity': 1,
    'pointer-events': 1,
    'transition': 1,
    'transition-delay': 1,
    'transition-duration': 1,
    'transition-property': 1,
    'transition-timing-function': 1,
    'translate': 1
  };
  function duplicateComputedStyleSignature(el, allowBlockGrowth){
    try {
      var style = window.getComputedStyle(el);
      var parts = [];
      for (var i = 0; i < style.length; i++) {
        var name = style.item(i);
        if (!name || duplicateIgnoredComputedProperties[name]
          || (allowBlockGrowth && (name === 'height' || name === 'block-size'
            || (name === 'transform-origin' && style.transform === 'none')
            || (name === 'perspective-origin' && style.perspective === 'none')))) continue;
        parts.push(name + ':' + style.getPropertyValue(name));
      }
      parts.sort();
      return parts.join(';');
    } catch (e) {
      return '';
    }
  }
  function duplicateLayoutSnapshot(flowRoot){
    var nodes = [];
    if (document.body) nodes.push(document.body);
    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      if (isHostNode(all[i]) || isTransient(all[i])) continue;
      nodes.push(all[i]);
    }
    return nodes.map(function(el){
      var rect = el.getBoundingClientRect();
      return {
        el: el,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        before: duplicatePseudoSignature(el, '::before'),
        after: duplicatePseudoSignature(el, '::after'),
        computed: duplicateComputedStyleSignature(el, flowRoot && el !== flowRoot && el.contains(flowRoot))
      };
    });
  }
  function closeEnough(a, b){ return Math.abs(a - b) <= 1; }
  function duplicateSnapshotUnchanged(snapshot, flowRoot){
    for (var i = 0; i < snapshot.length; i++) {
      var item = snapshot[i];
      if (!item.el.isConnected || isTransient(item.el)) return false;
      var rect = item.el.getBoundingClientRect();
      var ancestor = flowRoot && item.el !== flowRoot && item.el.contains(flowRoot);
      var following = flowRoot && !flowRoot.contains(item.el) && (flowRoot.compareDocumentPosition(item.el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!closeEnough(rect.x, item.rect.x) || (following ? rect.y < item.rect.y - 1 : !closeEnough(rect.y, item.rect.y))
        || !closeEnough(rect.width, item.rect.width) || (ancestor ? rect.height < item.rect.height - 1 : !closeEnough(rect.height, item.rect.height))
        || duplicatePseudoSignature(item.el, '::before') !== item.before
        || duplicatePseudoSignature(item.el, '::after') !== item.after) return false;
    }
    return true;
  }
  function duplicateSnapshotStylesUnchanged(snapshot, flowRoot){
    for (var i = 0; i < snapshot.length; i++) {
      var item = snapshot[i];
      if (duplicateComputedStyleSignature(item.el, flowRoot && item.el !== flowRoot && item.el.contains(flowRoot)) !== item.computed) return false;
    }
    return true;
  }
  function duplicateStylesMatchOriginal(original, root){
    var originals = duplicateElements(original);
    var duplicates = duplicateElements(root);
    if (originals.length !== duplicates.length) return false;
    for (var i = 0; i < originals.length; i++) {
      if (duplicateComputedStyleSignature(originals[i]) !== duplicateComputedStyleSignature(duplicates[i])
        || duplicatePseudoSignature(originals[i], '::before') !== duplicatePseudoSignature(duplicates[i], '::before')
        || duplicatePseudoSignature(originals[i], '::after') !== duplicatePseudoSignature(duplicates[i], '::after')) return false;
    }
    return true;
  }
  function duplicateRectFor(el){
    var rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  function duplicateCssOffset(original, originalRect, naturalRect){
    var scaleX = rectScaleAxis(originalRect.width, original.offsetWidth);
    var scaleY = rectScaleAxis(originalRect.height, original.offsetHeight);
    return {
      x: (originalRect.x - naturalRect.x) / scaleX,
      y: (originalRect.y - naturalRect.y) / scaleY
    };
  }
  function duplicateRectMatches(a, b){
    return closeEnough(a.x, b.x) && closeEnough(a.y, b.y)
      && closeEnough(a.width, b.width) && closeEnough(a.height, b.height);
  }
  function duplicateSizeMatches(a, b){
    return closeEnough(a.width, b.width) && closeEnough(a.height, b.height);
  }
  function duplicateHasActiveAnimation(root){
    var elements = duplicateElements(root);
    for (var i = 0; i < elements.length; i++) {
      var animationName = window.getComputedStyle(elements[i]).animationName || '';
      if (animationName.trim() && animationName.trim() !== 'none') return true;
    }
    return false;
  }
  function parseDuplicateTranslate(value){
    var text = typeof value === 'string' ? value.trim() : '';
    if (!text || text === 'none') return { x: 0, y: 0 };
    var tokens = text.split(/\\s+/);
    function parse(token){
      var match = /^(-?(?:\\d+|\\d*\\.\\d+))px$/.exec(token || '');
      if (!match) return null;
      var number = Number(match[1]);
      return isFinite(number) ? number : null;
    }
    var x = parse(tokens[0]);
    var y = tokens.length > 1 ? parse(tokens[1]) : 0;
    return x === null || y === null ? null : { x: x, y: y };
  }
  function setDuplicateTranslate(root, value, offset){
    var parsed = parseDuplicateTranslate(value);
    if (!parsed) return false;
    var x = parsed.x + (offset ? offset.x : 0);
    var y = parsed.y + (offset ? offset.y : 0);
    var serialized = (Math.abs(x) < 0.001 && Math.abs(y) < 0.001) ? '' : x + 'px ' + y + 'px';
    if (serialized) root.style.setProperty('translate', serialized);
    else root.style.removeProperty('translate');
    return true;
  }
  function markDuplicateTransient(root){
    root.setAttribute(transientAttr, 'true');
    root.setAttribute('aria-hidden', 'true');
    if (root.tabIndex >= 0) root.tabIndex = -1;
    root.style.setProperty('pointer-events', 'none', 'important');
    root.style.setProperty('animation', 'none', 'important');
    root.style.setProperty('transition', 'none', 'important');
    try { root.inert = true; } catch (e) {}
    var descendants = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < descendants.length; i++) {
      descendants[i].setAttribute('aria-hidden', 'true');
      descendants[i].style.setProperty('pointer-events', 'none', 'important');
      descendants[i].style.setProperty('animation', 'none', 'important');
      descendants[i].style.setProperty('transition', 'none', 'important');
      if (descendants[i].hasAttribute('contenteditable')) descendants[i].removeAttribute('contenteditable');
      if (descendants[i].tabIndex >= 0) descendants[i].tabIndex = -1;
    }
  }
  function removeDuplicateRoot(rootOverride){
    var root = rootOverride || (duplicateTransaction && duplicateTransaction.root);
    if (duplicateTransaction && (!rootOverride || duplicateTransaction.root === rootOverride)) duplicateTransaction = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
  }
  function postDuplicatePreview(command, ok, error, rect, naturalRect, placementOffset, sequence){
    var message = {
      type: 'readable-edit-duplicate-preview',
      transactionId: command.transactionId,
      ok: ok
    };
    if (error) message.error = error;
    if (rect) message.rect = rect;
    if (naturalRect) message.naturalRect = naturalRect;
    if (placementOffset) message.placementOffset = placementOffset;
    postManualMessage(message, sequence);
  }
  function postDuplicateRemoved(command, sequence){
    postManualMessage({ type: 'readable-edit-duplicate-removed', transactionId: command.transactionId }, sequence);
  }
  function rejectDuplicate(command, error, root){
    removeDuplicateRoot(root);
    postDuplicatePreview(command, false, error || 'Could not create duplicate.', null, null, null, command.sequence);
  }
  function duplicateIdsAreUnique(root){
    var existingManualIds = Object.create(null);
    var existingNativeIds = Object.create(null);
    var documentElements = document.querySelectorAll('*');
    for (var i = 0; i < documentElements.length; i++) {
      var existing = documentElements[i];
      if (isTransient(existing)) continue;
      var manualId = existing.getAttribute('data-readable-id');
      var nativeId = existing.getAttribute('id');
      if (manualId) existingManualIds[manualId] = existing;
      if (nativeId) existingNativeIds[nativeId] = existing;
    }
    var elements = duplicateElements(root);
    var ownManualIds = Object.create(null);
    var ownNativeIds = Object.create(null);
    for (var j = 0; j < elements.length; j++) {
      var el = elements[j];
      var manual = el.getAttribute('data-readable-id');
      var nativeIdValue = el.getAttribute('id');
      if (manual) {
        if (ownManualIds[manual] || existingManualIds[manual]) return false;
        ownManualIds[manual] = true;
      }
      if (nativeIdValue) {
        if (ownNativeIds[nativeIdValue] || existingNativeIds[nativeIdValue]) return false;
        ownNativeIds[nativeIdValue] = true;
      }
    }
    return true;
  }
  function createDuplicate(command){
    if (!enabled || documentEpoch === null || command.documentEpoch !== documentEpoch) return;
    if (!command.transactionId || !Number.isInteger(Number(command.sequence)) || !command.previewHtml) return;
    removeDuplicateRoot();
    var original = findById(command.originalId);
    if (!original || isTransient(original) || !original.parentNode) {
      rejectDuplicate(command, 'Original target is no longer available.');
      return;
    }
    // In ordinary document flow, inserting a paragraph necessarily pushes
    // later blocks down and grows its ancestors. That is not a failed copy.
    // Keep strict geometry for the original, horizontal allocation, and every
    // non-block layout; after insertion freeze a fresh snapshot for the drag.
    var flowRoot = original;
    for (var ancestor = original; ancestor; ancestor = ancestor.parentElement) {
      var flowStyle = window.getComputedStyle(ancestor);
      if (!/^(block|flow-root)$/.test(flowStyle.display) || /absolute|fixed/.test(flowStyle.position)
        || flowStyle.writingMode !== 'horizontal-tb') { flowRoot = null; break; }
    }
    var before = duplicateLayoutSnapshot(flowRoot);
    var template = document.createElement('template');
    template.innerHTML = String(command.previewHtml);
    var children = Array.prototype.slice.call(template.content.children);
    var hasUnexpectedTopLevelText = false;
    for (var childIndex = 0; childIndex < template.content.childNodes.length; childIndex++) {
      var childNode = template.content.childNodes[childIndex];
      if (childNode.nodeType === 3 && (childNode.textContent || '').trim()) {
        hasUnexpectedTopLevelText = true;
        break;
      }
    }
    if (children.length !== 1 || hasUnexpectedTopLevelText) {
      rejectDuplicate(command, 'Duplicate markup must contain one element.');
      return;
    }
    var root = children[0];
    var markupError = validateDuplicateMarkup(root);
    if (markupError || !duplicateIdsAreUnique(root)) {
      rejectDuplicate(command, markupError || 'Duplicate IDs are not unique.');
      return;
    }
    if (!command.duplicateRootId || stableId(root) !== command.duplicateRootId) {
      rejectDuplicate(command, 'Duplicate identity does not match the source plan.');
      return;
    }
    var originalRect = duplicateRectFor(original);
    if (duplicateHasActiveAnimation(original)) {
      rejectDuplicate(command, 'Animated duplicate content is unsupported.');
      return;
    }
    markDuplicateTransient(root);
    original.parentNode.insertBefore(root, original.nextSibling);
    var naturalRect = duplicateRectFor(root);
    if (!duplicateSnapshotUnchanged(before, flowRoot) || !duplicateSizeMatches(naturalRect, originalRect)) {
      rejectDuplicate(command, 'Duplicate changes existing layout.', root);
      return;
    }
    // The rects are in preview pixels while CSS translate is in the element's
    // untransformed coordinate space. Convert the insertion offset just like
    // ordinary movement converts its pointer delta.
    var placementOffset = duplicateCssOffset(original, originalRect, naturalRect);
    if (!setDuplicateTranslate(root, command.baselineTranslate, placementOffset)) {
      rejectDuplicate(command, 'Duplicate translate is not a static pixel value.', root);
      return;
    }
    if (!duplicateSnapshotStylesUnchanged(before, flowRoot) || !duplicateStylesMatchOriginal(original, root)) {
      rejectDuplicate(command, 'Duplicate changes authored or computed styles.', root);
      return;
    }
    var previewRect = duplicateRectFor(root);
    if (!duplicateRectMatches(previewRect, originalRect)) {
      rejectDuplicate(command, 'Duplicate cannot preserve the original geometry.', root);
      return;
    }
    duplicateTransaction = {
      transactionId: command.transactionId,
      root: root,
      lastSequence: Number(command.sequence),
      placementOffset: placementOffset,
      naturalRect: naturalRect,
      layoutSnapshot: duplicateLayoutSnapshot()
    };
    postDuplicatePreview(command, true, null, previewRect, naturalRect, placementOffset, command.sequence);
  }
  function updateDuplicate(command){
    var transaction = duplicateTransaction;
    if (!transaction || documentEpoch === null || command.documentEpoch !== documentEpoch
      || command.transactionId !== transaction.transactionId) return;
    var sequence = Number(command.sequence);
    if (!Number.isInteger(sequence) || sequence <= transaction.lastSequence) return;
    if (!duplicateSnapshotUnchanged(transaction.layoutSnapshot)) {
      removeDuplicateRoot();
      postDuplicatePreview(command, false, 'Duplicate layout changed during the drag.', null, null, null, sequence);
      return;
    }
    if (!duplicateSizeMatches(duplicateRectFor(transaction.root), transaction.naturalRect)) {
      removeDuplicateRoot();
      postDuplicatePreview(command, false, 'Duplicate geometry changed during the drag.', null, transaction.naturalRect, transaction.placementOffset, sequence);
      return;
    }
    transaction.lastSequence = sequence;
    if (!setDuplicateTranslate(transaction.root, command.translate, transaction.placementOffset)) {
      removeDuplicateRoot();
      postDuplicatePreview(command, false, 'Duplicate translate is not a static pixel value.', null, transaction.naturalRect, transaction.placementOffset, sequence);
      return;
    }
    postDuplicatePreview(command, true, null, duplicateRectFor(transaction.root), transaction.naturalRect, transaction.placementOffset, sequence);
  }
  function cancelDuplicate(command){
    var transaction = duplicateTransaction;
    if (!transaction || documentEpoch === null || command.documentEpoch !== documentEpoch
      || command.transactionId !== transaction.transactionId) return;
    var sequence = Number(command.sequence);
    if (!Number.isInteger(sequence) || sequence <= transaction.lastSequence) return;
    transaction.lastSequence = sequence;
    removeDuplicateRoot();
    postDuplicateRemoved(command, sequence);
  }
  var deferredOverlayClick = null;
  var hostSelectedTargetId = null;
  var hostRevision = 0;
  // Arrow keys currently held for a nudge burst. keyup does not cross the iframe
  // boundary, so the bridge tracks them here and posts readable-edit-nudge-commit once
  // the set empties, giving the host the burst-end signal it cannot observe.
  var heldNudgeKeys = {};
  // Arrow keys whose burst Escape cancelled while they were physically held.
  // Browser repeats of a still-held key must not reopen a burst: they are
  // swallowed (consumed, but never nudged) until the real keyup clears the latch.
  var cancelledNudgeKeys = {};
  function hasHeldNudgeKeys(){
    for (var key in heldNudgeKeys) { if (heldNudgeKeys.hasOwnProperty(key)) return true; }
    return false;
  }
  // Burst-end signals the iframe CAN observe when a keyup cannot arrive: window
  // blur and tab visibility loss strand physically held keys, so the held burst
  // finalizes there exactly once (the set clears; the late keyup then no-ops).
  function finalizeHeldNudgeBurst(){
    if (!hasHeldNudgeKeys()) return;
    heldNudgeKeys = {};
    window.parent.postMessage({ type: 'readable-edit-nudge-commit', targetId: hostSelectedTargetId, revision: hostRevision }, '*');
  }
  function clearDeferredOverlayClick(){
    if (deferredOverlayClick !== null) {
      window.clearTimeout(deferredOverlayClick);
      deferredOverlayClick = null;
    }
  }
  var nativeObjectClick = null;
  function requestTextEdit(el){
    if (!el) return false;
    var target = targetFrom(el, true, true);
    if (target.kind !== 'text' && target.kind !== 'link' && !target.textEditTargetId) return false;
    window.parent.postMessage({ type: 'readable-edit-select', target: target, beginTextEdit: true }, '*');
    return true;
  }
  function activateClickTarget(el, event, cycled, selectionAware){
    if (selectionAware) el = targetForSelection(el);
    var id = stableId(el);
    setSelectedTarget(id);
    hostSelectedTargetId = id;
    window.parent.postMessage({ type: 'readable-edit-select', target: targetFrom(el, true, true) }, '*');
    resolveHoverAtPoint(event.clientX, event.clientY, event.target);
    // Selection never opens a caret. Text entry is an explicit host command.
  }
  function handleClick(event, selectionAware){
    var result = clickTarget(event);
    var el = result.el;
    if (!el) {
      resetClickCycle();
      // Clicking empty canvas (no source-mapped ancestor) is the gesture for
      // page-level styles; the host decides whether to surface the card.
      window.parent.postMessage({ type: 'readable-edit-background' }, '*');
      return;
    }
    activateClickTarget(el, event, result.cycled, selectionAware !== false);
  }
  window.addEventListener('message', function(ev){
    if (!hasLiveLayoutDocument() || !ev.data) return;
    if (ev.data.type === 'readable-edit-mode') {
      var nextEnabled = !!ev.data.enabled;
      var nextEpoch = typeof ev.data.documentEpoch === 'string' ? ev.data.documentEpoch : null;
      if (documentEpoch !== nextEpoch || !nextEnabled) {
        if (resizeTransaction) restoreInline(resizeTransaction.el, resizeTransaction.inline);
        resizeTransaction = null;
        resizeClosedSequence = 0;
      }
      documentEpoch = nextEpoch;
      if (enabled !== nextEnabled) {
        resetClickCycle();
        clearDeferredOverlayClick();
      }
      enabled = nextEnabled;
      document.documentElement.toggleAttribute('data-readable-edit-mode', enabled);
      if (!enabled) {
        nativeObjectClick = null;
        removeDuplicateRoot();
        clearSelectedTarget();
        setHoveredTarget(null);
        lastHoverId = undefined;
        hostSelectedTargetId = null;
      }
      if (enabled) setTimeout(postTargets, 0);
      return;
    }
    if (ev.data.type === 'readable-edit-duplicate-create') {
      createDuplicate(ev.data);
      return;
    }
    if (ev.data.type === 'readable-edit-duplicate-update') {
      updateDuplicate(ev.data);
      return;
    }
    if (ev.data.type === 'readable-edit-duplicate-cancel') {
      cancelDuplicate(ev.data);
      return;
    }
    if (ev.data.type === 'readable-edit-click-cancel') {
      clearDeferredOverlayClick();
      return;
    }
    if (ev.data.type === 'readable-edit-click' || ev.data.type === 'readable-edit-alt-click') {
      var clickX = Number(ev.data.clientX);
      var clickY = Number(ev.data.clientY);
      if (!enabled || !isFinite(clickX) || !isFinite(clickY)) return;
      clearDeferredOverlayClick();
      var clickEl = document.elementFromPoint ? document.elementFromPoint(clickX, clickY) : null;
      var overlayEvent = { target: clickEl, altKey: ev.data.type === 'readable-edit-alt-click', clientX: clickX, clientY: clickY };
      // The first click can mount a host overlay before the second press. The
      // browser cannot emit dblclick across documents, so carry that one native
      // click into the overlay's existing text-entry path.
      var nativeClick = nativeObjectClick;
      nativeObjectClick = null;
      if (!overlayEvent.altKey && nativeClick && nativeClick.id === ev.data.selectedId
        && nativeClick.id === hostSelectedTargetId && Date.now() - nativeClick.time <= 350
        && Math.abs(nativeClick.x - clickX) <= clickCycleTolerance
        && Math.abs(nativeClick.y - clickY) <= clickCycleTolerance
        && requestTextEdit(findById(nativeClick.id))) {
        return;
      }
      if (overlayEvent.altKey) {
        handleClick(overlayEvent, false);
        return;
      }
      var topTarget = topTargetAtPoint(clickX, clickY, clickEl);
      var selectedId = typeof ev.data.selectedId === 'string' ? ev.data.selectedId : null;
      var selectedEl = selectedId && selectedId === hostSelectedTargetId ? findById(selectedId) : null;
      if (!topTarget || !selectedEl || topTarget !== selectedEl) {
        handleClick(overlayEvent, false);
        return;
      }
      var selectedKind = inferKind(selectedEl);
      if (selectedKind === 'text' || selectedKind === 'link') {
        activateClickTarget(selectedEl, overlayEvent, false, false);
        return;
      }
      if (selectedKind === 'container' && hasStructuredEditableText(selectedEl)) {
        deferredOverlayClick = window.setTimeout(function(){
          deferredOverlayClick = null;
          handleClick(overlayEvent, false);
        }, 350);
        return;
      }
      handleClick(overlayEvent, false);
      return;
    }
    if (ev.data.type === 'readable-edit-select-target') {
      if (!enabled) return;
      clearDeferredOverlayClick();
      var requestedEl = findById(ev.data.id);
      if (!requestedEl) return;
      requestedEl = targetForSelection(requestedEl);
      var selectTargetId = stableId(requestedEl);
      postHoverTarget(null);
      setSelectedTarget(selectTargetId);
      hostSelectedTargetId = selectTargetId;
      window.parent.postMessage({ type: 'readable-edit-select', target: targetFrom(requestedEl, true, true) }, '*');
      return;
    }
    if (ev.data.type === 'readable-edit-selected-target') {
      var nextSelectedTargetId = typeof ev.data.id === 'string' && ev.data.id ? ev.data.id : null;
      if (hostSelectedTargetId !== nextSelectedTargetId) clearDeferredOverlayClick();
      hostSelectedTargetId = nextSelectedTargetId;
      hostRevision = Number(ev.data.revision) || 0;
      if (!ev.data.id) resetClickCycle();
      setSelectedTarget(ev.data.id || null);
      return;
    }
    if (ev.data.type === 'readable-edit-hover-reset') {
      // Host signals the cursor truly left the canvas, so the next pointerover
      // re-announces the hovered element (defeats the per-element dedupe).
      setHoveredTarget(null);
      lastHoverId = undefined;
      return;
    }
    if (ev.data.type === 'readable-edit-hover-at') {
      var hoverX = Number(ev.data.clientX);
      var hoverY = Number(ev.data.clientY);
      if (!enabled || documentEpoch === null || ev.data.documentEpoch !== documentEpoch
        || typeof ev.data.selectedId !== 'string' || ev.data.selectedId !== hostSelectedTargetId
        || !isFinite(hoverX) || !isFinite(hoverY)) return;
      var hoverEl = document.elementFromPoint ? document.elementFromPoint(hoverX, hoverY) : null;
      resolveHoverAtPoint(hoverX, hoverY, hoverEl);
      return;
    }
    if (ev.data.type === 'readable-edit-preview-style') {
      applyPreviewStyles(ev.data.id, ev.data.styles || {}, ev.data.version, ev.data.includeAuthoredSize === true, ev.data.resize);
      return;
    }
    if (ev.data.type === 'readable-edit-rich-format') {
      applyRichFormat(ev.data.command);
      return;
    }
    if (ev.data.type === 'readable-edit-begin-text-edit') {
      if (!enabled) return;
      clearDeferredOverlayClick();
      var beginEl = findById(ev.data.id);
      if (beginEl && beginEl.getAttribute('data-readable-editing') !== 'true') makeEditable(beginEl);
      return;
    }
    if (ev.data.type === 'readable-edit-end-text-edit') {
      var endEl = document.querySelector('[data-readable-editing="true"]');
      finishActiveTextEdit();
      if (endEl && typeof endEl.blur === 'function') endEl.blur();
      if (typeof ev.data.requestId === 'number') {
        window.parent.postMessage({ type: 'readable-edit-text-flushed', requestId: ev.data.requestId }, '*');
      }
      return;
    }
  });
  document.addEventListener('click', function(ev){
    if (!enabled) return;
    clearDeferredOverlayClick();
    if (ev.target && ev.target.closest && ev.target.closest('[data-readable-editing="true"]')) return;
    ev.preventDefault();
    ev.stopPropagation();
    // The second click of a native double-click must not cycle to the object
    // behind the first click's target before dblclick arrives.
    if (ev.detail > 1 && !ev.altKey) return;
    handleClick(ev);
    nativeObjectClick = !ev.altKey && hostSelectedTargetId
      ? { id: hostSelectedTargetId, x: ev.clientX, y: ev.clientY, time: Date.now() } : null;
  }, true);
  document.addEventListener('dblclick', function(ev){
    if (!enabled || ev.altKey || (ev.target && ev.target.closest && ev.target.closest('[data-readable-editing="true"]'))) return;
    ev.preventDefault();
    ev.stopPropagation();
    clearDeferredOverlayClick();
    nativeObjectClick = null;
    requestTextEdit(findById(hostSelectedTargetId));
  }, true);
  document.addEventListener('pointerover', function(ev){
    if (!enabled) return;
    if (ev.target && ev.target.closest && ev.target.closest('[data-readable-editing="true"]')) {
      postHoverTarget(null);
      return;
    }
    resolveHoverAtPoint(ev.clientX, ev.clientY, ev.target);
  }, true);
  document.addEventListener('pointermove', function(ev){
    if (!enabled) return;
    if (ev.target && ev.target.closest && ev.target.closest('[data-readable-editing="true"]')) {
      postHoverTarget(null);
      return;
    }
    resolveHoverAtPoint(ev.clientX, ev.clientY, ev.target);
  }, true);
  function isNudgeBlocked(target, isComposing){
    if (isComposing) return true;
    if (!target || target.nodeType !== 1) return false;
    var el = target;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (typeof el.isContentEditable === 'boolean' && el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
    var blockedRoles = { slider:1, spinbutton:1, textbox:1, searchbox:1, scrollbar:1, listbox:1, option:1, combobox:1, menu:1, menubar:1, menuitem:1, menuitemcheckbox:1, menuitemradio:1, tree:1, treegrid:1, treeitem:1, grid:1, gridcell:1, columnheader:1, rowheader:1, row:1, tab:1, tablist:1, radiogroup:1 };
    var node = el;
    while (node && node !== document.body) {
      var role = node.getAttribute && node.getAttribute('role');
      if (role && blockedRoles[role.trim().toLowerCase()]) return true;
      node = node.parentElement;
    }
    return false;
  }
  // Keydown never bubbles out of this cross-document iframe to the host, so
  // forward history shortcuts and arrow nudges when an object is selected.
  // Inline text editing, native controls, ARIA widgets, and IME composition
  // keep the browser's native keyboard behavior.
  document.addEventListener('keydown', function(ev){
    if (!enabled) return;
    var nudgeDirections = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    var nudgeDirection = nudgeDirections[ev.key];
    // Synthetic arrow keys dispatched by the host-side deck bridge are wrapped
    // in the deck-synthetic flag: they are slide navigation, not user nudges,
    // so the edit bridge leaves them (and their keyups) completely untouched.
    if (nudgeDirection && window.__readableStudioDeckSynthetic) return;
    var selectedEl = document.querySelector('[data-readable-edit-selected]');
    var isEditing = !!document.querySelector('[data-readable-editing="true"]');
    // A key still latched from an Escape-cancelled burst: swallow its repeats
    // so artifact/deck handlers never see a half-owned key, but never nudge.
    if (nudgeDirection && cancelledNudgeKeys[ev.key] && !(ev.ctrlKey || ev.metaKey || ev.altKey)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (nudgeDirection && !(ev.ctrlKey || ev.metaKey || ev.altKey) && !isEditing && selectedEl && hostSelectedTargetId && !isNudgeBlocked(ev.target, ev.isComposing)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      heldNudgeKeys[ev.key] = 1;
      window.parent.postMessage({ type: 'readable-edit-nudge', direction: nudgeDirection, targetId: hostSelectedTargetId, revision: hostRevision }, '*');
      return;
    }
    // Escape owns the key ONLY while a nudge burst is physically held; with no
    // held burst it keeps its native meaning (and any artifact-side handler).
    if (ev.key === 'Escape' && selectedEl && !isEditing && !isNudgeBlocked(ev.target, ev.isComposing) && hasHeldNudgeKeys()) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      for (var held in heldNudgeKeys) { if (heldNudgeKeys.hasOwnProperty(held)) cancelledNudgeKeys[held] = 1; }
      heldNudgeKeys = {};
      window.parent.postMessage({ type: 'readable-edit-burst-cancel' }, '*');
      return;
    }
    if (isEditing) return;
    if (ev.key === 'Escape' && selectedEl && hostSelectedTargetId && !isNudgeBlocked(ev.target, ev.isComposing)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      window.parent.postMessage({ type: 'readable-edit-deselect', id: hostSelectedTargetId }, '*');
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    var key = (ev.key || '').toLowerCase();
    var isUndo = key === 'z' && !ev.shiftKey;
    var isRedo = (key === 'z' && ev.shiftKey) || (key === 'y' && !ev.shiftKey);
    if (!isUndo && !isRedo) return;
    ev.preventDefault();
    window.parent.postMessage({ type: 'readable-edit-undo', redo: isRedo }, '*');
  }, true);
  // Releasing the last held arrow key ends the burst; tell the host to commit.
  // A keyup the bridge never tracked (a host-origin keydown) is forwarded as
  // readable-edit-nudge-keyup instead, so a host-origin burst still ends when the
  // key physically comes up inside the iframe. Latched and synthetic keyups
  // go nowhere.
  document.addEventListener('keyup', function(ev){
    if (!enabled) return;
    var nudgeKeys = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
    if (!nudgeKeys[ev.key]) return;
    if (window.__readableStudioDeckSynthetic) return;
    if (heldNudgeKeys[ev.key]) {
      delete heldNudgeKeys[ev.key];
      for (var held in heldNudgeKeys) { if (heldNudgeKeys.hasOwnProperty(held)) return; }
      window.parent.postMessage({ type: 'readable-edit-nudge-commit', targetId: hostSelectedTargetId, revision: hostRevision }, '*');
      return;
    }
    if (cancelledNudgeKeys[ev.key]) {
      delete cancelledNudgeKeys[ev.key];
      return;
    }
    if (hostSelectedTargetId) {
      window.parent.postMessage({ type: 'readable-edit-nudge-keyup', key: ev.key, targetId: hostSelectedTargetId, revision: hostRevision }, '*');
    }
  }, true);
  window.addEventListener('blur', finalizeHeldNudgeBurst);
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') finalizeHeldNudgeBurst();
  });
  document.addEventListener('selectionchange', postSelectionState);
  window.addEventListener('resize', postTargets);
  // ponytail: no throttle -- postTargets is a cheap querySelectorAll + getBoundingClientRect
  // pass; add rAF/debounce here if a scroll-heavy preview page measurably regresses.
  document.addEventListener('scroll', postTargets, true);
  // Deck slide navigation, transition settle, media loads, and content growth
  // reflow the page without firing resize or scroll; without re-measurement the
  // host overlays (resize handles, inspector panel, hover icon) keep rendering
  // the stale click-time rect. Coalesce observed changes to one post per frame.
  var suppressObservedLayoutUntil = 0;
  var queuedTargetsPost = false;
  var targetsFrame = null;
  var targetsQuietTimer = null;
  var layoutMutationObserver = null;
  var layoutResizeObserver = null;
  var scheduleFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : function(cb){ return window.setTimeout(cb, 16); };
  var cancelFrame = window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : window.clearTimeout.bind(window);
  function stopObservingLayout(){
    layoutSuspended = true;
    if (layoutMutationObserver) layoutMutationObserver.disconnect();
    if (layoutResizeObserver) layoutResizeObserver.disconnect();
    if (targetsFrame !== null) cancelFrame(targetsFrame);
    if (targetsQuietTimer !== null) window.clearTimeout(targetsQuietTimer);
    targetsFrame = null;
    targetsQuietTimer = null;
    queuedTargetsPost = false;
    clearDeferredOverlayClick();
  }
  function hasLiveLayoutDocument(){
    // jsdom close() and document replacement can leave queued observer delivery
    // behind after the window has lost this document. Disconnect before querying.
    if (window.document !== bridgeDocument) stopObservingLayout();
    return !layoutSuspended;
  }
  function startObservingLayout(){
    if (window.document !== bridgeDocument) return;
    layoutSuspended = false;
    if (layoutMutationObserver) layoutMutationObserver.observe(bridgeDocument.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
    if (layoutResizeObserver) {
      layoutResizeObserver.observe(bridgeDocument.documentElement);
      if (bridgeDocument.body) layoutResizeObserver.observe(bridgeDocument.body);
    }
  }
  function queuePostTargets(){
    if (!hasLiveLayoutDocument() || !enabled || queuedTargetsPost) return;
    queuedTargetsPost = true;
    flushTargetsWhenQuiet();
  }
  function flushTargetsWhenQuiet(){
    targetsQuietTimer = null;
    if (!hasLiveLayoutDocument()) return;
    // Defer — never drop — echoes that land inside the preview mute window.
    // The last DOM mutation of a drag IS the final preview write; dropping its
    // echo would strand the host overlays on stale rects (no resize/scroll
    // event follows a pointerup to trigger another re-measure).
    var wait = suppressObservedLayoutUntil - Date.now();
    if (wait > 0) {
      targetsQuietTimer = window.setTimeout(flushTargetsWhenQuiet, wait + 8);
      return;
    }
    targetsFrame = scheduleFrame(function(){
      targetsFrame = null;
      queuedTargetsPost = false;
      postTargets();
    });
  }
  if (typeof MutationObserver === 'function') {
    layoutMutationObserver = new MutationObserver(function(records){
      if (!hasLiveLayoutDocument()) return;
      for (var i = 0; i < records.length; i++) {
        if (records[i].type === 'childList') setHoveredTarget(hoveredTarget);
        if (records[i].type !== 'attributes' || records[i].attributeName !== runtimeHoverAttr) {
          if (resizeTransaction && records[i].target !== resizeTransaction.el
            && !(records[i].target.hasAttribute && records[i].target.hasAttribute('data-readable-authored-size-probe-style'))
            && (records[i].type === 'attributes' || records[i].type === 'characterData')) resizeTransaction.provenance = {};
          queuePostTargets();
        }
      }
    });
  }
  if (typeof ResizeObserver === 'function') {
    layoutResizeObserver = new ResizeObserver(queuePostTargets);
  }
  startObservingLayout();
  window.addEventListener('pagehide', stopObservingLayout);
  window.addEventListener('pageshow', function(ev){
    if (!ev.persisted) return;
    startObservingLayout();
    queuePostTargets();
  });
  document.addEventListener('load', queuePostTargets, true);
  document.addEventListener('transitionend', queuePostTargets, true);
  document.addEventListener('animationend', queuePostTargets, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', postTargets);
  else setTimeout(postTargets, 0);
  document.documentElement.toggleAttribute('data-readable-edit-mode', enabled);
})();</script>`;
}

export function buildManualEditBridgeStyle(): string {
  return `<style data-readable-edit-bridge-style>
html[data-readable-edit-mode] body * { cursor: pointer !important; }
html[data-readable-edit-mode] [${MANUAL_EDIT_RUNTIME_HOVER_ATTR}]:not([data-readable-edit-selected]) { outline: 2px solid #2563eb; }
html[data-readable-edit-mode] [data-readable-edit-selected]:where([data-readable-editing="true"]) {
  outline: 2px solid #2563eb !important;
  outline-offset: 4px;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16);
}
html[data-readable-edit-mode] [data-readable-editing="true"] {
  outline: 2px solid #2563eb !important;
  outline-offset: 4px;
  cursor: text !important;
}
</style>`;
}
