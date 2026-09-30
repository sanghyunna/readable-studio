/* Static browser-layout inputs; no editor implementation is reproduced here. */
export const widthResizeFixtures = {
  padded: `<div class="q3-parent"><p id="target" style="width:200px;max-width:30ch">Q3 lede</p></div>`,
  contentBox: `<div class="parent"><div id="target" class="content-edges">Content box</div></div>`,
  borderBox: `<div class="parent"><div id="target" class="border-edges">Border box</div></div>`,
  scaled: `<div class="parent"><div style="transform:scale(.75);transform-origin:top left"><div id="target" class="content-edges">Scaled</div></div></div>`,
  zoomed: `<div class="parent" style="zoom:1.25"><div id="target" class="content-edges">Zoomed</div></div>`,
  percentageCap: `<div class="parent"><p id="target" style="max-width:50%">Percentage cap</p></div>`,
  importantCap: `<div class="parent"><p id="target" class="important-cap">Important cap</p></div>`,
  mediaCap: `<div class="parent"><p id="target" class="media-cap">Media cap</p></div>`,
  containerCap: `<div class="query-container"><p id="target" class="container-cap">Container cap</p></div>`,
  inline: `<div class="parent"><span id="target">Independently selected inline</span></div>`,
  flexOverflow: `<div class="flex-parent"><div id="target" style="flex:1 1 0;width:711px;flex-shrink:0">Flex target</div><div style="width:120px;flex-shrink:0">Sibling</div></div>`,
  gridAdjacent: `<div class="grid-parent"><div id="target">Grid target</div><div>Adjacent fixed cell</div></div>`,
} as const;

export const widthResizeCss = `
.q3-parent { box-sizing:border-box;width:920px;padding-inline:64px; }
.parent { box-sizing:border-box;width:920px;padding-inline:64px; }
.content-edges { box-sizing:content-box;padding-inline:20px;border:2px solid; }
.border-edges { box-sizing:border-box;padding-inline:20px;border:2px solid; }
.important-cap { max-width:200px !important; }
.query-container { container-type:inline-size;width:600px; }
@media (max-width:1000px) { .media-cap { max-width:200px; } }
@container (max-width:700px) { .container-cap { max-width:200px; } }
.flex-parent { display:flex;width:600px;gap:8px; }
.grid-parent { display:grid;grid-template-columns:280px 280px;gap:16px; }
`;
