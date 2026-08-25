import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { writeEvidence } from '../scripts/portable-qa-support.ts';

const resizeMarker = '__readablePortableQaNativeResize';
const compactNativeState = { contentHeight: 680, contentWidth: 900, zoomFactor: 2 } as const;

type Rectangle = { readonly height: number; readonly width: number; readonly x: number; readonly y: number };
type NativeState = {
  readonly contentBounds: Rectangle;
  readonly contentHeight: number;
  readonly contentWidth: number;
  readonly windowBounds: Rectangle;
  readonly zoomFactor: number;
};
type ObservedNativeState = Pick<NativeState, 'contentHeight' | 'contentWidth' | 'zoomFactor'>;
type NativeImage = { getSize(): { readonly height: number; readonly width: number }; toPNG(): Buffer };
type NativeBrowserWindow = {
  readonly webContents: {
    capturePage(): Promise<NativeImage>;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
  };
  getBounds(): Rectangle;
  getContentBounds(): Rectangle;
  getContentSize(): number[];
  setContentSize(width: number, height: number, animate: boolean): void;
};
type NativeCapture = {
  readonly base64: string;
  readonly nativeImageHeight: number;
  readonly nativeImageWidth: number;
};

function readNativeState(window: NativeBrowserWindow): NativeState {
  const [contentWidth = -1, contentHeight = -1] = window.getContentSize();
  return {
    contentBounds: window.getContentBounds(), contentHeight, contentWidth,
    windowBounds: window.getBounds(), zoomFactor: window.webContents.getZoomFactor(),
  };
}

function setNativeState(window: NativeBrowserWindow, state: ObservedNativeState): ObservedNativeState {
  window.webContents.setZoomFactor(state.zoomFactor);
  window.setContentSize(state.contentWidth, state.contentHeight, false);
  const [contentWidth = -1, contentHeight = -1] = window.getContentSize();
  return { contentHeight, contentWidth, zoomFactor: window.webContents.getZoomFactor() };
}

async function captureNativeRenderer(window: NativeBrowserWindow): Promise<NativeCapture> {
  const image = await window.webContents.capturePage();
  const { height, width } = image.getSize();
  return { base64: image.toPNG().toString('base64'), nativeImageHeight: height, nativeImageWidth: width };
}

const armResizeExpression = `(() => {
  const marker = '${resizeMarker}';
  globalThis[marker] = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for native Electron resize')), 30000);
    addEventListener('resize', () => {
      clearTimeout(timeout);
      resolve(true);
    }, { once: true });
  });
  return true;
})()`;

const awaitResizeAndRenderExpression = `(async () => {
  const marker = '${resizeMarker}';
  const resize = globalThis[marker];
  if (!(resize instanceof Promise)) throw new Error('native Electron resize signal was not armed');
  try {
    await resize;
  } finally {
    delete globalThis[marker];
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { devicePixelRatio, innerHeight, innerWidth };
})()`;

const awaitRenderExpression = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;

const measureFooterExpression = `(async () => {
  const inspector = document.querySelector('.manual-edit-left-inspector');
  const footer = document.querySelector('.manual-edit-left-inspector-footer');
  const discard = document.querySelector('.manual-edit-discard-btn');
  const save = document.querySelector('.manual-edit-save-btn');
  if (!(inspector instanceof HTMLElement) || !(footer instanceof HTMLElement)
    || !(discard instanceof HTMLButtonElement) || !(save instanceof HTMLButtonElement)) {
    throw new Error('manual edit compact geometry elements are unavailable');
  }
  const scrollRegion = footer.previousElementSibling;
  if (!(scrollRegion instanceof HTMLElement)) throw new Error('manual edit scroll region is unavailable');
  scrollRegion.scrollTop = 0;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const footerTopBeforeScroll = footer.getBoundingClientRect().top;
  if (scrollRegion.scrollHeight > scrollRegion.clientHeight) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for inspector tool scroll')), 30000);
      scrollRegion.addEventListener('scroll', () => {
        clearTimeout(timeout);
        resolve(true);
      }, { once: true });
      scrollRegion.scrollTop = scrollRegion.scrollHeight;
    });
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const inspectorRect = inspector.getBoundingClientRect();
  const scrollRect = scrollRegion.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  const discardRect = discard.getBoundingClientRect();
  const saveRect = save.getBoundingClientRect();
  const rectangle = rect => ({
    bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right,
    top: rect.top, width: rect.width, x: rect.x, y: rect.y,
  });
  const button = (element, rect) => {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    const style = getComputedStyle(element);
    return {
      centerHit: hit === element || (hit instanceof Node && element.contains(hit)),
      containedByFooter: rect.left >= footerRect.left - 1 && rect.right <= footerRect.right + 1
        && rect.top >= footerRect.top - 1 && rect.bottom <= footerRect.bottom + 1,
      containedByInspector: rect.left >= inspectorRect.left - 1 && rect.right <= inspectorRect.right + 1
        && rect.top >= inspectorRect.top - 1 && rect.bottom <= inspectorRect.bottom + 1,
      enabled: !element.disabled,
      fullyVisible: style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth
        && rect.top >= 0 && rect.bottom <= innerHeight
        && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      label: (element.textContent ?? '').trim(),
      rect: rectangle(rect),
    };
  };
  return {
    buttons: { discard: button(discard, discardRect), save: button(save, saveRect) },
    documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    footerContainsButtons: footer.contains(discard) && footer.contains(save),
    footerHorizontalOverflow: footer.scrollWidth > footer.clientWidth,
    footerIsScrollRegionSibling: footer.parentElement === inspector && scrollRegion.parentElement === inspector
      && footer.previousElementSibling === scrollRegion,
    footerRect: rectangle(footerRect),
    footerTopAfterScroll: footer.getBoundingClientRect().top,
    footerTopBeforeScroll,
    footerTopDelta: Math.abs(footer.getBoundingClientRect().top - footerTopBeforeScroll),
    inspectorContainsFooter: inspector.contains(footer),
    inspectorHorizontalOverflow: inspector.scrollWidth > inspector.clientWidth,
    inspectorRect: rectangle(inspectorRect),
    scrollRegion: {
      clientHeight: scrollRegion.clientHeight,
      clientWidth: scrollRegion.clientWidth,
      horizontalOverflow: scrollRegion.scrollWidth > scrollRegion.clientWidth,
      rect: rectangle(scrollRect),
      scrollHeight: scrollRegion.scrollHeight,
      scrollLeft: scrollRegion.scrollLeft,
      scrollTop: scrollRegion.scrollTop,
      scrollWidth: scrollRegion.scrollWidth,
    },
  };
})()`;

type ButtonGeometry = {
  readonly centerHit: boolean;
  readonly containedByFooter: boolean;
  readonly containedByInspector: boolean;
  readonly enabled: boolean;
  readonly fullyVisible: boolean;
  readonly label: string;
};

type FooterGeometry = {
  readonly buttons: { readonly discard: ButtonGeometry; readonly save: ButtonGeometry };
  readonly documentHorizontalOverflow: boolean;
  readonly footerContainsButtons: boolean;
  readonly footerHorizontalOverflow: boolean;
  readonly footerIsScrollRegionSibling: boolean;
  readonly footerTopDelta: number;
  readonly inspectorContainsFooter: boolean;
  readonly inspectorHorizontalOverflow: boolean;
  readonly scrollRegion: { readonly horizontalOverflow: boolean };
};

type CompactGeometryEvidence = FooterGeometry & {
  readonly native: { readonly original: NativeState; readonly observed: ObservedNativeState; readonly target: typeof compactNativeState };
  readonly renderer: { readonly devicePixelRatio: number; readonly innerHeight: number; readonly innerWidth: number };
  readonly screenshot: { readonly coversRendererViewport: boolean; readonly height: number; readonly width: number;
    readonly nativeImageHeight: number; readonly nativeImageWidth: number };
  readonly serializationSafe: boolean;
};

export async function captureCompactFooterGeometry(input: {
  readonly electronApp: ElectronApplication;
  readonly evidenceRoot: string;
  readonly page: Page;
}): Promise<CompactGeometryEvidence> {
  const { electronApp, evidenceRoot, page } = input;
  const nativeWindow = await electronApp.browserWindow(page);
  const callbackSources = [captureNativeRenderer.toString(), readNativeState.toString(), setNativeState.toString()];
  const serializationSafe = [...callbackSources, armResizeExpression, awaitResizeAndRenderExpression,
    awaitRenderExpression, measureFooterExpression].every((source) => !source.includes('__name'));
  assert.equal(serializationSafe, true, 'serialized evaluation source contains a tsx __name helper');
  const original = await nativeWindow.evaluate<NativeState, NativeBrowserWindow>(readNativeState);
  let evidence: CompactGeometryEvidence | null = null;
  try {
    await page.evaluate<boolean>(armResizeExpression);
    await nativeWindow.evaluate<ObservedNativeState, typeof compactNativeState, NativeBrowserWindow>(setNativeState, compactNativeState);
    const renderer = await page.evaluate<CompactGeometryEvidence['renderer']>(awaitResizeAndRenderExpression);
    const observed = await nativeWindow.evaluate<NativeState, NativeBrowserWindow>(readNativeState);
    const footer = await page.evaluate<FooterGeometry>(measureFooterExpression);
    await page.evaluate<void>(awaitRenderExpression);
    const capture = await nativeWindow.evaluate<NativeCapture, NativeBrowserWindow>(captureNativeRenderer);
    const png = Buffer.from(capture.base64, 'base64');
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'native renderer capture is not a PNG');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const coversRendererViewport = width >= renderer.innerWidth * renderer.devicePixelRatio
      && height >= renderer.innerHeight * renderer.devicePixelRatio;
    const screenshot = { coversRendererViewport, height, nativeImageHeight: capture.nativeImageHeight,
      nativeImageWidth: capture.nativeImageWidth, width };
    evidence = { ...footer, native: { observed, original, target: compactNativeState }, renderer, screenshot, serializationSafe };
    await writeFile(join(evidenceRoot, 'dirty-footer-compact-native.png'), png);
    await writeEvidence(evidenceRoot, 'geometry.json', evidence);
  } finally {
    const current = await nativeWindow.evaluate<NativeState, NativeBrowserWindow>(readNativeState);
    const sizeChanged = current.contentWidth !== original.contentWidth || current.contentHeight !== original.contentHeight;
    if (sizeChanged) await page.evaluate<boolean>(armResizeExpression);
    await nativeWindow.evaluate<ObservedNativeState, ObservedNativeState, NativeBrowserWindow>(setNativeState, original);
    if (sizeChanged) await page.evaluate<CompactGeometryEvidence['renderer']>(awaitResizeAndRenderExpression);
    else await page.evaluate<void>(awaitRenderExpression);
    await nativeWindow.dispose();
  }
  assert.ok(evidence, 'compact footer geometry was not captured');
  assert.equal(evidence.serializationSafe, true, 'serialized evaluation source contains a tsx __name helper');
  assert.equal(evidence.native.observed.contentWidth, compactNativeState.contentWidth, 'native Electron content width is not 900');
  assert.equal(evidence.native.observed.contentHeight, compactNativeState.contentHeight, 'native Electron content height is not 680');
  assert.equal(evidence.native.observed.zoomFactor, compactNativeState.zoomFactor, 'native Electron zoom factor is not 2');
  assert.equal(evidence.screenshot.width, evidence.screenshot.nativeImageWidth, 'PNG width differs from native capture width');
  assert.equal(evidence.screenshot.height, evidence.screenshot.nativeImageHeight, 'PNG height differs from native capture height');
  assert.equal(evidence.screenshot.coversRendererViewport, true, 'native screenshot does not cover the renderer viewport');
  assert.equal(evidence.footerIsScrollRegionSibling, true, 'footer is not the inspector scroll-region sibling');
  assert.ok(evidence.footerTopDelta <= 1, `footer moved ${evidence.footerTopDelta}px with the tool scroll`);
  assert.equal(evidence.inspectorContainsFooter, true, 'inspector does not contain the footer');
  assert.equal(evidence.footerContainsButtons, true, 'footer does not contain both transaction buttons');
  assert.equal(evidence.inspectorHorizontalOverflow, false, 'inspector has horizontal overflow');
  assert.equal(evidence.scrollRegion.horizontalOverflow, false, 'inspector tool region has horizontal overflow');
  assert.equal(evidence.footerHorizontalOverflow, false, 'footer has horizontal overflow');
  assert.equal(evidence.documentHorizontalOverflow, false, 'document has horizontal overflow');
  assert.deepEqual([evidence.buttons.discard.label, evidence.buttons.save.label], ['저장 안함', '저장하기']);
  for (const button of [evidence.buttons.discard, evidence.buttons.save]) {
    assert.equal(button.enabled, true, `${button.label} is disabled`);
    assert.equal(button.fullyVisible, true, `${button.label} is clipped or outside the compact viewport`);
    assert.equal(button.containedByInspector, true, `${button.label} is outside the inspector`);
    assert.equal(button.containedByFooter, true, `${button.label} is outside the footer`);
    assert.equal(button.centerHit, true, `${button.label} center point is not clickable`);
  }
  return evidence;
}
