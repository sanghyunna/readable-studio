import type { ProjectFile } from '../../src/types';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';

export const linkedHtml = '<!doctype html><html><head><link rel="stylesheet" href="assets/css/site.css"></head>'
  + '<body><div data-readable-id="hero" class="pattern">Linked hero</div>'
  + '<img data-readable-id="photo" src="assets/images/photo.svg" alt="Fixture photo">'
  + '<p data-readable-id="sibling">Retained sibling</p></body></html>';
export const linkedCss = '.pattern{width:160px;height:80px;color:rgb(18,52,86);background-image:url("../images/pattern.svg")}';
export const linkedInlinedCss = linkedCss.replace('../images/pattern.svg', 'http://localhost:3000/api/projects/linked/raw/assets/images/pattern.svg');
export const linkedPatternSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#123456"/></svg>';
export const linkedPhotoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="#ef4444"/></svg>';
export const linkedFile: ProjectFile = {
  name: 'preview.html', path: 'preview.html', type: 'file', size: linkedHtml.length,
  mtime: 1, mime: 'text/html', kind: 'html',
};
export const linkedTarget: ManualEditTarget = {
  id: 'hero', kind: 'container', label: 'Linked hero', tagName: 'div', className: 'pattern',
  text: 'Linked hero', rect: { x: 0, y: 0, width: 160, height: 80 }, fields: {}, attributes: {},
  styles: emptyManualEditStyles(), isLayoutContainer: false,
  outerHtml: '<div data-readable-id="hero" class="pattern">Linked hero</div>',
};

// Host fetch is intentionally separate from browser resource loading. The
// component environment does not load iframe images or CSS URLs itself.
export function linkedAssetRequests(css = linkedCss) {
  let phase = 'before-entry';
  const timeline: Array<{ phase: string; kind: string; url: string }> = [];
  const pending: Array<{ resolve: (response: Response) => void; url: string; completed: boolean }> = [];
  const writes: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') {
      writes.push(String(init.body));
      timeline.push({ phase, kind: 'document-write', url });
      return new Response(JSON.stringify({ file: linkedFile }));
    }
    if (url.includes('/raw/assets/css/site.css')) {
      timeline.push({ phase, kind: 'inliner-fetch', url });
      return new Promise<Response>((resolve) => { pending.push({ resolve, url, completed: false }); });
    }
    if (url.includes('/raw/preview.html')) {
      timeline.push({ phase, kind: 'document-read', url });
      return new Response(linkedHtml);
    }
    if (url.includes('/raw/assets/images/')) {
      timeline.push({ phase, kind: 'browser-asset-load', url });
      return new Response(url.includes('pattern.svg') ? linkedPatternSvg : linkedPhotoSvg, {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    }
    return new Response(JSON.stringify({ deployments: [] }));
  };
  return {
    fetch, timeline, pending, writes,
    boundary(value: string) { phase = value; },
    resolve(index: number, status = 200) {
      const request = pending[index];
      if (!request || request.completed) throw new Error(`No pending stylesheet request ${index}`);
      request.completed = true;
      timeline.push({ phase, kind: 'inliner-response', url: request.url });
      request.resolve(new Response(status === 200 ? css : '', { status }));
    },
  };
}
