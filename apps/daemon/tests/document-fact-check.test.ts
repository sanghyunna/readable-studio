import { expect, it } from 'vitest';
import { documentFactRequest, missingDocumentYears } from '../src/document-fact-check.js';
import { finalGenContrastHtml } from './helpers/final-gen-contrast-html.js';
import { missingYearHtml } from './helpers/final-gen-year-html.js';

it('uses only marked user content or the saved legacy suffix', () => {
  expect(documentFactRequest('Template 2024 <readable-user-content-source/>User 2025', 0)).toBe('User 2025');
  expect(documentFactRequest('Template 2024 User 2025', 14)).toBe('User 2025');
  expect(documentFactRequest('User 2025')).toBe('User 2025');
  expect(documentFactRequest('User 2025', 500)).toBe('User 2025');
});

const request = "우리 동네 도서관 10월 독서모임 안내: 2025-10-18 토 오후 2시, 3층 세미나실, 선정 도서 '소년이 온다', 참가비 없음, 주민 누구나, 사전 신청 없이 방문";
it('flags captured FGEN5-001 as missing 2025', () => {
  expect(missingDocumentYears(request, missingYearHtml)).toEqual(['2025']);
});
it.each(Object.keys(finalGenContrastHtml))('accepts captured correct output %s', name => {
  expect(missingDocumentYears(request, finalGenContrastHtml[name]!)).toEqual([]);
});
it('never flags a request without years', () => {
  expect(missingDocumentYears('Make an October reading club notice', missingYearHtml)).toEqual([]);
});
it('deduplicates years and excludes scripts, styles, attributes and head text', () => {
  expect(missingDocumentYears('1999 2025 2025 2026 12025 2100', '<title>1999</title><style>2025</style><script>2026</script><p data-year="2025">1999</p>')).toEqual(['2025', '2026']);
});
it('reads decoded visible text across tags without accepting a longer number', () => {
  expect(missingDocumentYears('2025 2026', '<p>20<b>25</b>년 &#50;026</p>')).toEqual([]);
  expect(missingDocumentYears('2025', '<p>12025</p>')).toEqual(['2025']);
});
