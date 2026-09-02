// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryModelInline } from '../../src/components/MemoryModelInline';
import { MemorySection } from '../../src/components/MemorySection';
import { I18nProvider } from '../../src/i18n';

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

class StubEventSource {
  addEventListener(): void {}
  close(): void {}
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installMemoryFetch(options: {
  readonly entries?: readonly Record<string, unknown>[];
  readonly extractions?: readonly Record<string, unknown>[];
  readonly tree?: readonly Record<string, unknown>[];
  readonly chatExtractionEnabled?: boolean;
} = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === '/api/memory') {
      return json({
        enabled: true,
        chatExtractionEnabled: options.chatExtractionEnabled ?? true,
        rootDir: 'C:/Users/test/.readable-studio/memory',
        index: '# Memory',
        entries: options.entries ?? [],
        extraction: null,
      });
    }
    if (url === '/api/memory/tree') return json({ tree: options.tree ?? [] });
    if (url === '/api/memory/extractions') {
      return json({ extractions: options.extractions ?? [] });
    }
    return new Response(null, { status: 404 });
  }));
}

function renderKoreanMemory(): void {
  render(
    <I18nProvider initial="ko">
      <MemorySection />
    </I18nProvider>,
  );
}

describe('Korean Memory localization', () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (originalEventSource) globalThis.EventSource = originalEventSource;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('localizes tabs, tooltips, chat-off state, empty copy, and advanced controls', async () => {
    vi.stubGlobal('EventSource', StubEventSource);
    installMemoryFetch({ chatExtractionEnabled: false });

    renderKoreanMemory();

    expect(await screen.findByRole('tab', { name: '직접 추가' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '대화에서 학습' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: '메모리 영역' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '메모리 저장 경로 — 클릭하여 복사' })).toBeTruthy();
    expect(screen.getByText('아직 메모리가 없습니다.')).toBeTruthy();
    expect(screen.getByText('저는 다크 모드를 선호합니다')).toBeTruthy();
    expect(screen.getByText('고급')).toBeTruthy();
    expect(screen.getByText('기본 메모리 색인을 확인하거나 편집합니다.')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '대화에서 학습' }));
    expect(screen.getByText('꺼짐')).toBeTruthy();
    const chatSwitch = screen.getByRole('switch', { name: '대화 내용에서 학습' });
    expect(chatSwitch.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: '메모리 주입 활성화' }).getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).not.toMatch(/Add manually|Learn from chats|Saved memory|Memory tree|Advanced|\bOff\b/);
  });

  it('localizes counts and relative time while preserving raw and technical content', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-02T12:00:00Z').getTime());
    vi.stubGlobal('EventSource', StubEventSource);
    installMemoryFetch({
      entries: [{
        id: 'project_readable',
        name: 'Readable Studio',
        description: 'raw API content',
        type: 'project',
        updatedAt: Date.now(),
      }],
      extractions: [{
        id: 'ex-rate',
        phase: 'failed',
        kind: 'llm',
        startedAt: Date.now() - 300_000,
        finishedAt: Date.now() - 297_500,
        userMessagePreview: 'raw user content',
        error: 'provider returned 429 quota exceeded',
      }],
    });

    renderKoreanMemory();

    expect(await screen.findByText('raw user content')).toBeTruthy();
    expect(screen.getByText('메모리 모델 할당량 또는 요청 한도 초과')).toBeTruthy();
    expect(screen.getByText('나중에 다시 시도하거나 메모리 추출 모델을 변경하세요.')).toBeTruthy();
    expect(screen.getByText(/5분 전/)).toBeTruthy();
    expect(screen.getByText(/소요 시간 2\.5s/)).toBeTruthy();
    expect(screen.getByText('1개 저장됨')).toBeTruthy();
    expect(screen.getByText('1개 추출')).toBeTruthy();
    expect(screen.getByText('Readable Studio')).toBeTruthy();
    expect(screen.getByText('raw API content')).toBeTruthy();
    expect(document.body.textContent).not.toContain('provider returned 429 quota exceeded');
  });

  it('localizes tree counts and classified Local CLI failures without translating provider names', async () => {
    vi.stubGlobal('EventSource', StubEventSource);
    installMemoryFetch({
      tree: [{ id: 'folder:project', parentId: null, path: '/project', name: 'Project', kind: 'folder' }],
      extractions: [
        {
          id: 'ex-auth',
          phase: 'failed',
          kind: 'llm',
          startedAt: Date.now(),
          userMessagePreview: 'raw preview',
          error: '401 authentication token has expired',
          provider: { kind: 'openai', credentialSource: 'chat-cli' },
        },
        {
          id: 'ex-network',
          phase: 'failed',
          kind: 'llm',
          startedAt: Date.now(),
          userMessagePreview: 'network preview',
          error: 'fetch failed: ECONNRESET',
          provider: { kind: 'google', credentialSource: 'override' },
        },
        {
          id: 'ex-chat-off',
          phase: 'skipped',
          reason: 'chat-disabled',
          kind: 'heuristic',
          startedAt: Date.now(),
          userMessagePreview: 'chat-off preview',
        },
        {
          id: 'ex-raw',
          phase: 'failed',
          kind: 'llm',
          startedAt: Date.now(),
          userMessagePreview: 'fallback preview',
          error: '{"error":{"message":"raw provider detail"}}',
          provider: { kind: 'anthropic', credentialSource: 'override' },
        },
      ],
    });

    renderKoreanMemory();

    const tree = (await screen.findByText('메모리 트리')).closest('details');
    if (!tree) throw new TypeError('Expected Memory tree details');
    expect(within(tree).getByText('노드 0개')).toBeTruthy();
    expect(screen.getByText('Local CLI 인증 만료')).toBeTruthy();
    expect(screen.getByText('선택한 Local CLI에 로그인하거나 다른 메모리 모델을 선택하세요.')).toBeTruthy();
    expect(screen.getByText('Google Gemini 요청 실패')).toBeTruthy();
    expect(screen.getByText('모델 제공자 연결을 확인한 후 다시 시도하세요.')).toBeTruthy();
    expect(screen.getByText('raw provider detail')).toBeTruthy();
    expect(screen.getByText('대화 내용 학습이 꺼져 있습니다.')).toBeTruthy();
  });

  it('localizes the inline model picker while preserving provider and model values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      enabled: true,
      rootDir: '',
      index: '',
      entries: [],
      extraction: null,
    })));

    render(
      <I18nProvider initial="ko">
        <MemoryModelInline
          mode="daemon"
          apiProtocol="openai"
          chatApiKey=""
          chatBaseUrl=""
          chatApiVersion=""
          chatModel="claude-sonnet-4-6"
          cliAgentId="claude"
          cliModelOptions={['claude-sonnet-4-6']}
        />
      </I18nProvider>,
    );

    const picker = await screen.findByRole('combobox', { name: '메모리 모델' });
    expect(picker.textContent).toBe('대화와 동일 (Claude Code)');
    expect(screen.getByText(/선택한 Local CLI를 사용/)).toBeTruthy();
    expect(screen.queryByText('Memory model')).toBeNull();
    expect(screen.queryByText(/Same as chat|Optional\./)).toBeNull();
  });
});
