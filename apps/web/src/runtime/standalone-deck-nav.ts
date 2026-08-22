const MARKER = 'data-readable-standalone-deck-nav-dedupe';

export function injectStandaloneDeckKeyDedupe(html: string): string {
  if (!shouldInject(html)) return html;
  return injectBeforeFirstScript(html, script());
}

function shouldInject(html: string): boolean {
  if (html.includes(MARKER)) return false;
  if (!/\b(?:class\s*=\s*["'][^"']*\bslide\b|data-screen-label\b)/i.test(html)) return false;
  if (!/\bwindow\s*\.\s*addEventListener\s*\(\s*["']keydown["']/i.test(html)) return false;
  if (!/\bdocument\s*\.\s*addEventListener\s*\(\s*["']keydown["']/i.test(html)) return false;
  return /["'](?:ArrowRight|ArrowLeft|PageDown|PageUp|Home|End| )["']/.test(html);
}

function injectBeforeFirstScript(html: string, snippet: string): string {
  const firstScript = html.search(/<script\b/i);
  return firstScript < 0 ? html : `${html.slice(0, firstScript)}${snippet}${html.slice(firstScript)}`;
}

function script(): string {
  return `<script ${MARKER}>(function(){
  if (window.__readableStudioStandaloneDeckNavDedupe) return;
  if (typeof WeakMap !== 'function' || typeof WeakSet !== 'function') return;
  window.__readableStudioStandaloneDeckNavDedupe = true;
  var keys = { ArrowRight:1, ArrowLeft:1, PageDown:1, PageUp:1, Home:1, End:1, " ":1 };
  var seenByEvent = new WeakMap();
  function shouldSkip(event, listener){
    if (!event || !keys[event.key]) return false;
    var seen = seenByEvent.get(event);
    if (!seen) {
      seen = new WeakSet();
      seenByEvent.set(event, seen);
    }
    if (seen.has(listener)) return true;
    seen.add(listener);
    return false;
  }
  function wrapTarget(target){
    var add = target.addEventListener && target.addEventListener.bind(target);
    var remove = target.removeEventListener && target.removeEventListener.bind(target);
    if (!add || !remove) return;
    var wrapped = new WeakMap();
    target.addEventListener = function(type, listener, options){
      if (type !== 'keydown' || !listener) return add(type, listener, options);
      var proxy = wrapped.get(listener);
      if (!proxy) {
        proxy = function(event){
          if (shouldSkip(event, listener)) return;
          if (typeof listener === 'function') return listener.call(this, event);
          if (listener && typeof listener.handleEvent === 'function') return listener.handleEvent(event);
        };
        wrapped.set(listener, proxy);
      }
      return add(type, proxy, options);
    };
    target.removeEventListener = function(type, listener, options){
      if (type !== 'keydown') return remove(type, listener, options);
      return remove(type, wrapped.get(listener) || listener, options);
    };
  }
  wrapTarget(window);
  wrapTarget(document);
})();</script>`;
}
