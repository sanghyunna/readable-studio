import { finalGenContrastHtml } from './helpers/final-gen-contrast-html.js';
import { expect, it } from 'vitest';
import { lintDocumentContrast } from '../src/document-contrast.js';
import { composeSystemPrompt } from '../src/prompts/system.js';

it('flags the captured FGEN4-001 inherited white card values', () => {
  const issues = lintDocumentContrast(finalGenContrastHtml['weekly-1-index.html.log']!);
  expect(issues.map(issue => issue.text)).toEqual(['없음', '주민 누구나']);
  expect(issues.every(issue => issue.ratio === 1 && issue.selector.includes('.value'))).toBe(true);
});
it.each(Object.keys(finalGenContrastHtml).filter(name => name !== 'weekly-1-index.html.log'))('does not flag captured correct output %s', name => {
  expect(lintDocumentContrast(finalGenContrastHtml[name]!)).toEqual([]);
});
it('resolves inheritance, specificity, inline styles and variables', () => {
  const html = '<style>:root{--paper:#fff}.dark{color:white;background:black}.card{background:var(--paper)}.card .fixed{color:#222}</style><div class="dark"><div class="card"><span>lost</span><span class="fixed">safe</span><span style="color:black">safe too</span></div></div>';
  expect(lintDocumentContrast(html).map(issue => issue.text)).toEqual(['lost']);
});
it('ignores hidden text and unknown backgrounds rather than guessing', () => {
  expect(lintDocumentContrast('<style>p{color:white;background:white} .hidden{display:none}</style><p class="hidden">hidden</p><p style="background:linear-gradient(black,white)">unknown</p>')).toEqual([]);
});
it('preserves computed inherited variables and inline/important precedence', () => {
  const html = '<style>:root{--text:black}body{color:var(--text)}#card{background:white;color:white} .safe{color:black!important}</style><div id="card" style="color:black;--text:white">safe<span class="safe" style="color:white">safe important</span></div>';
  expect(lintDocumentContrast(html)).toEqual([]);
  expect(lintDocumentContrast('<style>:root{--text:white}body{color:var(--text);background:black}div{--text:black;background:white}</style><div>inherited white</div>').map(issue => issue.text)).toEqual(['inherited white']);
});
it('does not infer contrast over separate background images', () => {
  expect(lintDocumentContrast('<div style="background-color:white;background-image:url(image.png);color:white">unknown</div>')).toEqual([]);
});
it('ships the machine-consumed contrast contract sentinel', () => {
  for (const locale of ['ko', 'en']) {
    const sentinel = composeSystemPrompt({ locale }).match(/<readable-contrast-contract>(.*?)<\/readable-contrast-contract>/s);
    expect(JSON.parse(sentinel?.[1] ?? '{}')).toEqual({ ownBackground: 'explicit-text-color', minimumContrast: 4.5, largeTextMinimumContrast: 3, inheritedCardColor: false });
  }
});
