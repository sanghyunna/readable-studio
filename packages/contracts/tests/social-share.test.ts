import { describe, expect, it } from 'vitest';

import {
  buildSocialSharePayload,
  READABLE_GITHUB_REPO_URL,
} from '../src/api/social-share';

describe('social-share contract', () => {
  it('builds Readable Studio repository share targets', () => {
    const payload = buildSocialSharePayload({
      kind: 'readable-studio-repo',
      locale: 'zh-CN',
      title: 'Readable Studio GitHub',
      text: '推荐 Readable Studio',
    });

    expect(payload.url).toBe(READABLE_GITHUB_REPO_URL);
    expect(payload.locale).toBe('zh-CN');
    expect(payload.platforms.some((target) => target.platform === 'x' && target.shareUrl?.includes('twitter.com/intent/tweet'))).toBe(true);
    expect(payload.platforms.some((target) => target.platform === 'xiaohongshu' && target.mode === 'copy-open')).toBe(true);
  });

  it('keeps deployed project links and the repo recommendation together', () => {
    const payload = buildSocialSharePayload({
      kind: 'project-html',
      locale: 'en',
      url: 'https://example.com/readable-studio-demo',
      title: 'Demo',
      text: `Built with Readable Studio. Repo: ${READABLE_GITHUB_REPO_URL}`,
      copyText: `Demo\nhttps://example.com/readable-studio-demo\n${READABLE_GITHUB_REPO_URL}`,
    });

    expect(payload.url).toBe('https://example.com/readable-studio-demo');
    expect(payload.githubRepoUrl).toBe(READABLE_GITHUB_REPO_URL);
    expect(payload.copyText).toContain(READABLE_GITHUB_REPO_URL);
    expect(payload.platforms.find((target) => target.platform === 'telegram')?.shareUrl)
      .toContain('https%3A%2F%2Fexample.com%2Freadable-studio-demo');
  });
});
