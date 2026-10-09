import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';

describe('Korean artifact wrapping independent of UI locale', () => {
  it.each([undefined, 'en', 'ko', 'ja', 'zh-CN'])('ships the Korean CSS policy with UI locale %s', (locale) => {
    const prompt = composeSystemPrompt({ locale });
    const policy = JSON.parse(prompt.match(/<readable-korean-wrap-policy>(.*?)<\/readable-korean-wrap-policy>/s)![1]!);
    expect(policy).toEqual({ language: 'ko', wordBreak: 'keep-all', overflowWrap: 'anywhere', scope: ['body', 'heading', 'label'], codeBlocks: false });
  });
});
