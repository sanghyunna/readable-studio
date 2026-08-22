// Plugin URL helpers retain local/self-hosted detail paths while canonical
// share links target the Readable Studio GitHub repository.

import { describe, expect, it } from 'vitest';
import {
  READABLE_STUDIO_REPOSITORY_URL,
  pluginSlug,
  pluginSlugSegment,
  pluginDetailSlug,
  pluginDetailPath,
  pluginPreviewPath,
  pluginShareUrl,
} from '../src/plugins/plugin-url.js';

describe('pluginSlugSegment', () => {
  it('lowercases, collapses unsafe runs, trims dashes', () => {
    expect(pluginSlugSegment('Hero Deck')).toBe('hero-deck');
    expect(pluginSlugSegment('  Wild!!Name  ')).toBe('wild-name');
  });
  it('keeps url-safe punctuation and falls back to "plugin"', () => {
    expect(pluginSlugSegment('keep.dots_and-dashes')).toBe('keep.dots_and-dashes');
    expect(pluginSlugSegment('!!!')).toBe('plugin');
  });
});

describe('pluginDetailSlug (single segment = last id segment)', () => {
  it('takes the slugified last segment, dropping any namespace', () => {
    expect(pluginDetailSlug('readable-studio/Hero Deck')).toBe('hero-deck');
    expect(pluginDetailSlug('community/registry-starter')).toBe('registry-starter');
    expect(pluginDetailSlug('live-dashboard')).toBe('live-dashboard');
  });
});

describe('pluginSlug (multi-segment, namespace preserved)', () => {
  it('slugifies each segment and keeps / as a separator', () => {
    expect(pluginSlug('readable-studio/Hero Deck')).toBe('readable-studio/hero-deck');
  });
});

describe('pluginDetailPath / pluginPreviewPath', () => {
  it('detail path is single-segment with trailing slash', () => {
    expect(pluginDetailPath('readable-studio/Hero Deck')).toBe('/plugins/hero-deck/');
    expect(pluginDetailPath('live-dashboard')).toBe('/plugins/live-dashboard/');
  });
  it('preview path keeps the namespace', () => {
    expect(pluginPreviewPath('readable-studio/Hero Deck')).toBe(
      '/plugins/previews/readable-studio/hero-deck/',
    );
  });
});

describe('pluginShareUrl', () => {
  it('defaults to a repository code search instead of a product website', () => {
    expect(READABLE_STUDIO_REPOSITORY_URL).toBe('https://github.com/sanghyunna/readable-studio');
    expect(pluginShareUrl('readable-studio/live-dashboard')).toBe(
      'https://github.com/sanghyunna/readable-studio/search?q=path%3Aplugins%20readable-studio%2Flive-dashboard&type=code',
    );
  });
  it('honours an explicit origin and trims a trailing slash on it', () => {
    expect(pluginShareUrl('x', 'https://self.host')).toBe('https://self.host/plugins/x/');
    expect(pluginShareUrl('x', 'https://self.host/')).toBe('https://self.host/plugins/x/');
  });
});
