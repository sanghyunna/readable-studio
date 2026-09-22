import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';

const splashSource = readFileSync(new URL('../../assets/splash.html', import.meta.url), 'utf8');

const MEDIA_DURATION = 6.6;

type SplashApi = { setProgress: (text: unknown) => string };

type SplashHarness = {
  api: SplashApi;
  media: { currentTime: number; paused: boolean; playCalls: number };
  root: HTMLElement;
  strip: HTMLElement;
  label: HTMLElement;
  video: HTMLVideoElement;
};

function loadSplash(options: { reducedMotion?: boolean } = {}): SplashHarness {
  const media = { currentTime: 0, paused: true, playCalls: 0 };
  const dom = new JSDOM(splashSource, {
    runScripts: 'dangerously',
    beforeParse(window) {
      // jsdom does not implement media playback; give the asset a deterministic
      // stand-in so its script can drive the same properties Chromium exposes.
      Object.defineProperties(window.HTMLMediaElement.prototype, {
        duration: { configurable: true, get: () => MEDIA_DURATION },
        currentTime: {
          configurable: true,
          get: () => media.currentTime,
          set: (value: number) => {
            media.currentTime = value;
          },
        },
        play: {
          configurable: true,
          value: () => {
            media.playCalls += 1;
            media.paused = false;
            return Promise.resolve();
          },
        },
        pause: {
          configurable: true,
          value: () => {
            media.paused = true;
          },
        },
      });
      window.matchMedia = ((query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)' && options.reducedMotion === true,
          media: query,
        }) as MediaQueryList) as typeof window.matchMedia;
    },
  });
  const { document } = dom.window;
  const video = document.getElementById('splash') as HTMLVideoElement;
  const strip = document.getElementById('progress') as HTMLElement;
  const label = document.getElementById('progress-text') as HTMLElement;
  const api = (dom.window as unknown as { __readableSplash: SplashApi }).__readableSplash;
  return { api, media, root: document.documentElement, strip, label, video };
}

describe('splash asset media contract', () => {
  test('the video no longer loops, so the final frame holds', () => {
    const { video } = loadSplash();

    expect(video.hasAttribute('loop')).toBe(false);
    expect(video.loop).toBe(false);
    expect(video.getAttribute('src')).toBe('splash.mp4');
    for (const attribute of ['autoplay', 'muted', 'playsinline']) {
      expect(video.hasAttribute(attribute)).toBe(true);
    }
  });

  test('marks the document finished and reveals the strip once the media ends', () => {
    const { root, strip, video } = loadSplash();

    expect(root.getAttribute('data-readable-splash-finished')).toBeNull();
    expect(strip.getAttribute('data-state')).toBe('pending');

    video.dispatchEvent(new video.ownerDocument.defaultView!.Event('ended'));

    expect(root.getAttribute('data-readable-splash-finished')).toBe('1');
    expect(strip.getAttribute('data-state')).toBe('active');
  });

  test('keeps readiness closed during the final fraction of playback', () => {
    // Given the first pass approaching its final frame.
    const { media, root, video } = loadSplash();
    media.currentTime = MEDIA_DURATION - 0.1;
    const update = video.ownerDocument.createEvent('Event');
    update.initEvent('timeupdate', false, false);
    // When the browser reports progress before ended.
    video.dispatchEvent(update);
    // Then the host cannot cut off the animation.
    expect(root.getAttribute('data-readable-splash-finished')).toBeNull();
  });

  test('a media error still finishes the splash instead of leaving it stuck', () => {
    const { root, strip, video } = loadSplash();

    video.dispatchEvent(new video.ownerDocument.defaultView!.Event('error'));

    expect(root.getAttribute('data-readable-splash-finished')).toBe('1');
    expect(strip.getAttribute('data-state')).toBe('active');
  });
});

describe('splash asset progress strip', () => {
  test('rotates at one third of the previous 800ms angular speed', () => {
    // Given the shipped spinner rule and its previous revolution duration.
    const previousDurationMs = 800;
    const spinnerRule = /\.progress__spinner\s*\{([^}]+)\}/.exec(splashSource)?.[1] ?? '';

    // When reading the machine-consumed animation duration.
    const durationMs = Number(/animation:\s*splash-spin\s+(\d+)ms/.exec(spinnerRule)?.[1]);

    // Then a revolution takes exactly three times as long.
    expect(durationMs).toBe(previousDurationMs * 3);
  });

  test('is a polite live region with a decorative spinner and a non-empty default label', () => {
    const { label, strip } = loadSplash();
    const spinner = strip.querySelector('.progress__spinner');

    expect(strip.getAttribute('role')).toBe('status');
    expect(strip.getAttribute('aria-live')).toBe('polite');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(label.textContent).toBe('Starting Readable Studio');
  });

  test('window.__readableSplash.setProgress updates the visible label before and after the media ends', () => {
    const { api, label, strip, video } = loadSplash();

    expect(typeof api.setProgress).toBe('function');
    expect(api.setProgress('Checking Codex CLI')).toBe('Checking Codex CLI');
    expect(label.textContent).toBe('Checking Codex CLI');
    expect(strip.getAttribute('data-state')).toBe('pending');

    video.dispatchEvent(new video.ownerDocument.defaultView!.Event('ended'));
    expect(strip.getAttribute('data-state')).toBe('active');
    expect(label.textContent).toBe('Checking Codex CLI');

    expect(api.setProgress('Checking Claude Code')).toBe('Checking Claude Code');
    expect(label.textContent).toBe('Checking Claude Code');
    expect(api.setProgress('Checking Gemini CLI')).toBe('Checking Gemini CLI');
    expect(label.textContent).toBe('Checking Gemini CLI');
  });

  test('empty, blank, and non-string values restore the default label so the strip is never blank', () => {
    const { api, label } = loadSplash();

    api.setProgress('Checking Codex CLI');
    for (const value of ['', '   ', null, undefined, 42]) {
      expect(api.setProgress(value)).toBe('Starting Readable Studio');
      expect(label.textContent).toBe('Starting Readable Studio');
    }
  });
});

describe('splash asset reduced motion', () => {
  test('keeps progress pending when reduced-motion metadata starts an undecoded seek', () => {
    // Given a reduced-motion splash whose metadata has not decoded a frame.
    const { root, strip, video } = loadSplash({ reducedMotion: true });

    // When metadata starts the final-frame seek.
    const metadata = video.ownerDocument.createEvent('Event');
    metadata.initEvent('loadedmetadata', false, false);
    video.dispatchEvent(metadata);

    // Then readiness and progress cannot race ahead of the decoded frame.
    expect(root.getAttribute('data-readable-splash-finished')).toBeNull();
    expect(strip.getAttribute('data-state')).toBe('pending');
  });

  test('parks the media on its last frame and finishes when the seek completes', () => {
    const { media, root, strip, video } = loadSplash({ reducedMotion: true });
    const window = video.ownerDocument.defaultView!;

    expect(root.getAttribute('data-readable-splash-motion')).toBe('reduced');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(media.playCalls).toBe(0);

    video.dispatchEvent(new window.Event('loadedmetadata'));

    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(MEDIA_DURATION);
    video.dispatchEvent(new window.Event('seeked'));
    expect(root.getAttribute('data-readable-splash-finished')).toBe('1');
    expect(strip.getAttribute('data-state')).toBe('active');

    video.dispatchEvent(new window.Event('loadeddata'));
    expect(media.playCalls).toBe(0);
  });

  test('does not run the reduced path when motion is allowed', () => {
    const { media, root, video } = loadSplash();
    const window = video.ownerDocument.defaultView!;

    expect(root.getAttribute('data-readable-splash-motion')).toBeNull();
    expect(media.playCalls).toBe(1);

    video.dispatchEvent(new window.Event('loadedmetadata'));
    expect(media.currentTime).toBe(0);
    expect(root.getAttribute('data-readable-splash-finished')).toBeNull();
  });

  test('the stylesheet disables the spinner animation under prefers-reduced-motion', () => {
    const reducedBlock =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n {6}\}/.exec(splashSource)?.[1] ?? '';

    expect(reducedBlock).toContain('.progress__spinner');
    expect(reducedBlock).toContain('animation: none;');
    expect(splashSource).toContain('@media (prefers-reduced-transparency: reduce)');
  });
});
