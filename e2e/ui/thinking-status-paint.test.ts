import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

// Keep the real stylesheet order: the initial footer combines both shimmer
// classes, whose specificity must survive the reduced-motion override.
const css = ['tokens.css', 'viewer/code.css', 'viewer/viewer-shared.css', 'viewer/routines.css']
  .map(file => readFileSync(new URL(`../../apps/web/src/styles/${file}`, import.meta.url), 'utf8'))
  .join('\n');

test('[P2] initial assistant status paints readable text without a box in reduced motion', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<html lang="ko" data-theme="light" data-theme-scheme="light"><head><style>${css}</style></head>
    <body style="background:var(--bg-panel);padding:24px"><div class="app"><div class="msg assistant"><div class="assistant-flow">
    <div class="assistant-completion-row"><div class="assistant-footer" data-streaming="true" data-last="true">
    <span class="dot" data-active="true"></span><span class="assistant-label shimmer-text shimmer-prepare">준비 중...</span><span class="assistant-stats">0.0s</span>
    </div></div></div></div></div></body></html>`);
  const label = page.locator('.assistant-label');
  const paint = await label.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, fill: style.webkitTextFillColor, animation: style.animationName };
  });
  const image = await label.screenshot();
  await testInfo.attach('initial-status', { body: image, contentType: 'image/png' });
  expect(paint.background).toBe('none');
  expect(paint.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(paint.animation).toBe('none');
  const png = PNG.sync.read(image);
  let inkPixels = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if ([0, 1, 2].some(channel => Math.abs(png.data[offset + channel]! - png.data[channel]!) > 16)) inkPixels++;
  }
  expect(inkPixels, 'the unselected label must paint visible glyphs').toBeGreaterThan(20);
});
