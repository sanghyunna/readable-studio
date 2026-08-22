# Readable Studio VDI Optimization Plan

이 문서는 사내 VDI 환경에서 Readable Studio fork의 초기 부팅 비용과 런타임 부담을 줄이기 위한 1차 최적화 계획이다. 범위는 두 가지다.

1. 기본 agent 탐색 범위를 `codex`, `cursor-agent`로 축소하고, 나머지 agent는 Settings에서 활성화했을 때만 탐색한다.
2. UI locale과 built-in localized content를 한국어/영어만 남긴다.

## 1. Agent 탐색 기본값 축소

### 목표

- 기본 cold start에서는 `codex`, `cursor-agent`만 probe한다.
- `cursor-agent`는 `agent` 실행 파일 alias도 인식한다.
- `claude`, `gemini`, `opencode`, `qwen` 등 나머지 agent는 Settings에서 켠 뒤에만 `/api/agents` 탐색 대상이 된다.
- 전체 agent registry는 유지해서 사용자가 나중에 다시 활성화할 수 있게 한다.

### 설계

현재 daemon은 `AGENT_DEFS` 전체를 대상으로 `detectAgents()` / `detectAgentsStream()`을 수행한다. 이 구조는 유지하되, 실제 probe 대상만 app config의 enabled set으로 제한한다.

기본 enabled set:

```ts
['codex', 'cursor-agent']
```

저장 값에는 alias를 canonical id로 normalize한다.

```ts
agent -> cursor-agent
cursor -> cursor-agent
cursor-agent -> cursor-agent
```

### 변경 대상

- `packages/contracts/src/api/app-config.ts`
  - `AppConfigPrefs`에 `enabledAgentIds?: string[]` 추가.
- `apps/daemon/src/app-config.ts`
  - `AppConfigPrefs`에 `enabledAgentIds?: string[]` 추가.
  - `ALLOWED_KEYS`에 `enabledAgentIds` 추가.
  - `validateEnabledAgentIds()` 추가.
  - 기본값은 저장하지 않아도 읽을 때 `['codex', 'cursor-agent']`로 해석.
- `apps/web/src/types.ts`
  - `AppConfig`에 `enabledAgentIds?: string[]` 추가.
- `apps/web/src/state/config.ts`
  - `DEFAULT_CONFIG.enabledAgentIds` 추가.
  - `mergeDaemonConfig()` / `syncConfigToDaemon()` / localStorage save-load 경로에 반영.
- `apps/daemon/src/runtimes/detection.ts`
  - `detectAgents(configuredEnvByAgent, options)` 형태로 확장.
  - `options.enabledAgentIds`가 있으면 `AGENT_DEFS`를 probe 전에 필터링.
  - `detectAgentsStream()`도 동일하게 필터링.
- `apps/daemon/src/routes/static-resource.ts`
  - `/api/agents`에서 `readAppConfig()` 결과의 `enabledAgentIds`를 detection에 전달.
  - `GET /api/agents/catalog` 추가 검토: 전체 registry metadata를 probe 없이 반환.
- `apps/daemon/src/server.ts`
  - startup warm probe와 내부 `detectAgents(...)` 호출이 enabled set을 사용하도록 정리.
- `apps/daemon/src/runtimes/defs/cursor-agent.ts`
  - `fallbackBins: ['agent']` 추가.
- `apps/web/src/components/SettingsDialog.tsx`
  - Code Agent 섹션에 disabled adapter 목록과 enable/disable 컨트롤 추가.
  - enable 변경 시 config 저장, daemon sync, agent refresh 실행.
  - 현재 선택된 agent를 disable하면 `codex`, `cursor-agent`, 첫 available agent 순으로 fallback.
- `apps/daemon/src/cli.ts`
  - 최소: `readable config set enabledAgentIds --value-json '["codex","cursor-agent"]'`가 동작하도록 계약 반영.
  - 권장: `readable agent list|enable|disable|reset --json` 추가.

### UI 동작

Settings의 Code Agent 영역은 다음처럼 나눈다.

- Enabled and installed
- Enabled but unavailable
- Disabled adapters

Disabled adapter는 "not installed"로 표시하지 않는다. 사용자가 "Enable scan"을 눌렀을 때만 다음 refresh부터 probe한다.

### 테스트

- daemon
  - 기본 `detectAgents()`가 `codex`, `cursor-agent`만 probe하는지.
  - PATH에 `agent`만 있어도 `cursor-agent`가 available로 표시되는지.
  - `enabledAgentIds: ['codex', 'claude']`면 `claude`도 probe되는지.
  - unknown id, duplicate id, alias id가 sanitize되는지.
- web
  - `enabledAgentIds`가 load/save/merge/sync 경로에서 유지되는지.
  - Settings에서 disabled agent enable 후 `refreshAgents()`가 호출되는지.
  - 선택된 agent를 disable하면 fallback 선택이 일어나는지.
- existing tests
  - "모든 AGENT_DEFS가 `/api/agents`에 나온다" 성격의 테스트는 `/api/agents/catalog` 기준으로 이전한다.

## 2. Locale을 한국어/영어만 유지

### 목표

- UI locale은 `en`, `ko`만 지원한다.
- 나머지 locale dictionary와 localized content bundle을 제거한다.
- 초기 client bundle의 JS parse/compile 비용과 메모리 사용량을 줄인다.

### 변경 대상

- `apps/web/src/i18n/types.ts`
  - `Locale = 'en' | 'ko'`
  - `LOCALES = ['en', 'ko']`
  - `LOCALE_LABEL`은 English / 한국어만 유지.
- `apps/web/src/i18n/index.tsx`
  - `en`, `ko`만 import.
  - `DICTS`도 두 locale만 유지.
  - `RTL_LOCALES` 제거 또는 빈 배열 처리.
  - `resolveSystemLocale()`의 zh/pt/es 특수 처리 제거.
  - unsupported stored locale은 기존처럼 무시하고 browser/host locale 또는 `en`으로 fallback.
- `apps/web/src/i18n/content.ts`
  - `content.ko.ts`만 import.
  - `LOCALIZED_CONTENT`는 `{ ko: ... }`만 유지.
  - `zh-TW -> zh-CN` fallback 제거.
  - `FRENCH_CONTENT_IDS`, `GERMAN_CONTENT_IDS`, `RUSSIAN_CONTENT_IDS` export 제거 또는 테스트 의존 제거.
- 삭제 대상
  - `apps/web/src/i18n/locales/{ar,de,es-ES,fa,fr,hu,id,it,ja,pl,pt-BR,ru,th,tr,uk,zh-CN,zh-TW}.ts`
  - `apps/web/src/i18n/content.{ar,es-ES,fa,fr,hu,id,it,ja,pl,pt-BR,ru,th,tr,uk,zh-CN}.ts`
  - 유지: `locales/en.ts`, `locales/ko.ts`, `content.ko.ts`, `content.ts`.

### 후속 정리

- `HomeHero`, `plugins-home/presetSeedPrompt.ts` 등에서 `zh`, `ja` 전용 분기를 제거한다.
- 한국어 전용 프롬프트 처리가 필요하면 `ko` 분기만 유지한다.
- locale file을 직접 import하는 테스트는 `en`, `ko`만 보도록 축소한다.

### 테스트

- `apps/web/tests/i18n/locales.test.ts`
  - `EXPECTED_LOCALES`를 `['en', 'ko']`로 변경.
  - 중국어/일본어/인도네시아어 parity lock 테스트 제거.
  - dictionary alignment와 placeholder 검증은 `en`, `ko`에 대해서만 유지.
- `apps/web/tests/i18n/content.test.ts`
  - "모든 non-English locale에 content bundle이 있다" 검증을 `ko` 기준으로 단순화.
  - French/German/Russian content id 테스트 제거.
- `apps/web/tests/i18n/design-files-*.test.ts`
  - 직접 import하는 locale 목록을 `en`, `ko`로 축소.

## 검증 순서

```bash
pnpm --filter @readable-studio/contracts typecheck
pnpm --filter @readable-studio/daemon test
pnpm --filter @readable-studio/web test
pnpm guard
pnpm typecheck
```

## 측정 포인트

- `/api/agents?stream=1` cold response time.
- daemon startup 후 첫 agent warm probe 완료 시간.
- `.next/static/chunks` 총 크기와 가장 큰 client chunk 크기.
- 첫 화면 로딩 시 JS parse/compile 시간.
- Settings에서 disabled agent를 enable한 뒤 추가 probe가 정상 실행되는지.

## 예상 효과

- agent probe 축소는 VDI에서 가장 즉시 체감될 가능성이 높다. PATH 탐색, process spawn, auth/model probe가 기본 2개 agent로 제한되기 때문이다.
- locale 축소는 초기 client bundle과 memory footprint를 줄인다. 현재 18개 이상의 dictionary/content bundle을 eager import하는 구조라 한국어/영어만 남기면 parse/compile 비용 감소가 확실하다.

---

## 2026-06-15 작업 handoff

### 중단 사유

- 현재 세션에서 subagent 호출이 여러 번 crash / background 전환 / tool interrupt를 반복했다.
- 사용자가 새 에이전트가 이어받을 수 있도록 이 파일 하단에 진행 상황 기록을 요청했다.
- 아직 "완료" 아님. Oracle 확인, portable build, 실제 최적화 측정 전이다.

### 최종 목표 / 완료 조건

- 이 계획의 원래 목표는 두 가지다.
  1. 기본 agent 탐색을 `codex`, `cursor-agent`로 제한하고 나머지는 Settings에서 켠 뒤에만 probe한다.
  2. web locale / built-in localized content를 `en`, `ko`만 남긴다.
- 사용자의 강한 완료 조건: **built portable program이 실제 최적화됐다고 Oracle이 확신하기 전에는 성공 선언 금지.**
- 남은 완료 조건:
  - `pnpm --filter @readable-studio/contracts typecheck`
  - `pnpm --filter @readable-studio/daemon test`
  - `pnpm --filter @readable-studio/web test`
  - `pnpm guard`
  - `pnpm typecheck`
  - `pnpm --filter @readable-studio/web build`
  - `pnpm tools-pack win build --to zip`
  - built portable 산출물 기준 크기/부팅/probe 측정
  - Oracle에게 diff + 측정값 제출 후 승인

### 확인된 완료 작업

#### Agent 탐색 기본값 축소

- `packages/contracts/src/api/app-config.ts`
  - `AppConfigPrefs.enabledAgentIds?: string[]` 추가됨.
- `apps/daemon/src/app-config.ts`
  - `DEFAULT_ENABLED_AGENT_IDS` 추가됨.
  - `validateEnabledAgentIds()` 추가됨.
  - alias normalize 포함됨: `agent` / `cursor` -> `cursor-agent`.
  - `enabledAgentIds` app config key 처리 추가됨.
- `apps/daemon/src/runtimes/detection.ts`
  - `detectAgents()` / `detectAgentsStream()`이 `options.enabledAgentIds`를 받아 `AGENT_DEFS`를 probe 전에 필터링하도록 변경됨.
- `apps/daemon/src/routes/static-resource.ts`
  - `/api/agents`가 `readAppConfig()` 결과에서 `enabledAgentIds`를 읽고 detection에 전달하도록 변경됨.
  - `DEFAULT_ENABLED_AGENT_IDS` import됨.
- `apps/daemon/src/server.ts`
  - 내부 `detectAgents(...)` 호출들이 enabled set을 사용하도록 일부/전체 정리됨. 다음 에이전트가 diff로 확인 필요.
- `apps/daemon/src/runtimes/defs/cursor-agent.ts`
  - `fallbackBins: ['agent']` 추가됨.
- `apps/daemon/src/cli.ts`
  - `readable agent list|enable|disable|reset --json` 구현된 상태로 보임.
  - 파일은 `@ts-nocheck`라 typecheck로 안전성 보장 안 됨. daemon tests로 확인 필요.
- 새 daemon test 파일이 생긴 상태:
  - `apps/daemon/tests/runtimes/detection.enabled-ids.test.ts`
  - `apps/daemon/tests/routes/` 아래 신규 테스트들
  - `apps/daemon/tests/cli/` 아래 신규 테스트들
  - 정확한 통과 여부 미확인. 이전 test command는 interrupt/abort됨.

#### Locale `en`/`ko` 축소

- `apps/web/src/i18n/types.ts`
  - `Locale` / `LOCALES` / `LOCALE_LABEL`이 `en`, `ko` 중심으로 축소된 상태.
- `apps/web/src/i18n/index.tsx`
  - locale import가 `en`, `ko`로 축소된 상태.
  - `resolveSystemLocale()` 특수 처리도 축소된 것으로 보임. diff 확인 필요.
- `apps/web/src/i18n/content.ts`
  - `content.ko.ts`만 import하고 `LOCALIZED_CONTENT`는 `ko`만 유지.
  - `KOREAN_CONTENT_IDS` export 존재.
- 다음 locale/content 파일들이 삭제된 상태:
  - `apps/web/src/i18n/locales/{ar,de,es-ES,fa,fr,hu,id,it,ja,pl,pt-BR,ru,th,tr,uk,zh-CN,zh-TW}.ts`
  - `apps/web/src/i18n/content.{ar,es-ES,fa,fr,hu,id,it,ja,pl,pt-BR,ru,th,tr,uk,zh-CN}.ts`
- `apps/web/src/components/HomeHero.tsx`
  - `zh`/`ja` prompt branch 제거됨.
  - `HOME_PROMPT_EXAMPLES`를 script로 `en`, `ko`만 남기도록 정리함.
  - 삭제 script 위치: `C:\Users\User\AppData\Local\Temp\opencode\trim-home-hero.js` (임시 파일, repo 밖).
- `apps/web/src/components/plugins-home/presetSeedPrompt.ts`
  - `PromptLocaleKind`를 `en`만 반환하도록 축소.
  - `zh` description-first 특수 분기 제거됨.
- `apps/web/src/components/SettingsDialog.tsx`
  - `codexPathStrings()`에서 `zh-CN`/`zh-TW`/`ja` 분기 제거됨.

#### Web tests locale cleanup

- `apps/web/tests/i18n/content.test.ts`
  - French content tests 제거/ko 기준 테스트로 변경됨.
- `apps/web/tests/i18n/locales.test.ts`
  - expected locales를 `['en', 'ko']`로 축소.
  - zh-CN/ja/id parity lock 테스트 제거.
- `apps/web/tests/i18n/design-files-agent-copy.test.ts`
  - 직접 import locale 목록을 `en`, `ko`로 축소.
- `apps/web/tests/i18n/design-files-dropzone-copy.test.ts`
  - 직접 import locale 목록을 `en`, `ko`로 축소.
- `apps/web/tests/components/**`
  - 대부분의 `'zh-CN'` / `"zh-CN"` locale prop을 `en`으로 교체.
  - `DesignSystemPicker.test.tsx`의 `'fr'` locale 사용을 `en`으로 교체.
  - 중복 object key가 생긴 두 테스트를 ko 기반으로 수정:
    - `apps/web/tests/components/plugins-home-section.test.tsx`
    - `apps/web/tests/components/SkillsSection.test.tsx`
  - `apps/web/tests/components/preset-seed-prompt.test.ts`의 zh-specific test를 일반 description-first test로 변경.
- 확인됨: `pnpm --filter @readable-studio/web typecheck`는 이 cleanup 직후 통과했다.
  - 출력은 `tsc -b --noEmit` 후 error 없이 종료.
  - 이후 subagent/background 작업이 파일을 더 건드렸을 수 있으니 반드시 재실행 필요.

### 현재 git status 기준 주요 변경 파일

`git status --short` 기준으로 확인된 변경:

- Agent/config/daemon:
  - `apps/daemon/src/app-config.ts`
  - `apps/daemon/src/cli.ts`
  - `apps/daemon/src/routes/static-resource.ts`
  - `apps/daemon/src/runtimes/defs/cursor-agent.ts`
  - `apps/daemon/src/runtimes/detection.ts`
  - `apps/daemon/src/server.ts`
  - `packages/contracts/src/api/app-config.ts`
  - `packages/contracts/src/api/registry.ts`
  - `packages/contracts/src/analytics/events.ts`
- Web config/UI/i18n:
  - `apps/web/src/types.ts`
  - `apps/web/src/state/config.ts`
  - `apps/web/src/components/HomeHero.tsx`
  - `apps/web/src/components/SettingsDialog.tsx`
  - `apps/web/src/components/SettingsDialog.module.css` (untracked; 아마 background UI agent가 만들었을 수 있음)
  - `apps/web/src/components/plugins-home/presetSeedPrompt.ts`
  - `apps/web/src/i18n/content.ts`
  - `apps/web/src/i18n/index.tsx`
  - `apps/web/src/i18n/types.ts`
  - `apps/web/src/i18n/locales/en.ts`
  - `apps/web/src/i18n/locales/ko.ts`
- Web tests:
  - `apps/web/tests/components/*` 다수
  - `apps/web/tests/i18n/*`
- Untracked/scratch:
  - `$null`
  - `.omo/`
  - `.tmp_diff_detection.txt`
  - `.tmp_diff_static.txt`
  - `Optimization_plan.md`
  - `apps/daemon/tests/cli/`
  - `apps/daemon/tests/routes/`
  - `apps/daemon/tests/runtimes/detection.enabled-ids.test.ts`

주의: `packages/contracts/src/analytics/events.ts`, `packages/contracts/src/api/registry.ts`, `apps/web/src/components/SettingsDialog.module.css`, `apps/web/src/i18n/locales/en.ts`, `apps/web/src/i18n/locales/ko.ts`는 background UI/API agent가 부분 수정했을 가능성이 있다. 다음 에이전트는 `git diff`로 실제 내용을 확인해야 한다.

### 미완료 / 다음 작업

#### 1. `/api/agents/catalog` 완성 여부 확인

- 계획상 필요:
  - `packages/contracts/src/api/agent-catalog.ts` 또는 기존 api type에 `AgentCatalogResponse` 추가.
  - `apps/daemon/src/routes/static-resource.ts`에 `GET /api/agents/catalog` 추가.
  - `AGENT_DEFS` 전체를 probe 없이 반환.
  - `/api/agents`는 계속 enabled/probed subset만 반환.
- 내가 직접 완성 확인 못 함.
- background agent `bg_eb835c0a`를 띄웠으나, 이후 사용자가 중단 요청. `background_cancel` 시점에는 task not found라고 나왔거나 tool interrupt 상태였음. 결과 수집 안 됨.
- 다음 에이전트는 먼저 확인:
  - `rg "agents/catalog|AgentCatalog" apps/daemon packages/contracts apps/web`
  - `git diff apps/daemon/src/routes/static-resource.ts packages/contracts/src/api/registry.ts packages/contracts/src/analytics/events.ts`

#### 2. SettingsDialog Code Agents UI 완성 여부 확인

- 계획상 필요:
  - Settings에 Code Agents 섹션.
  - `/api/agents/catalog` fetch.
  - `enabledAgentIds` checkbox/toggle.
  - reset defaults = `['codex', 'cursor-agent']`.
  - toggle 시 config 저장 + daemon sync.
  - 현재 선택 agent disable 시 fallback 선택 처리.
- 내가 직접 완성 못 함.
- background agent `bg_38b7e338`를 띄웠고, 이후 `apps/web/src/components/SettingsDialog.module.css`가 untracked로 보인다. UI agent가 일부 작업했을 가능성이 있다.
- 다음 에이전트는 먼저 확인:
  - `git diff apps/web/src/components/SettingsDialog.tsx apps/web/src/components/SettingsDialog.module.css apps/web/src/i18n/types.ts apps/web/src/i18n/locales/en.ts apps/web/src/i18n/locales/ko.ts`
  - `rg "codeAgents|enabledAgentIds|agents/catalog" apps/web/src/components/SettingsDialog.tsx apps/web/src/i18n`

#### 3. Verification 재실행

- 마지막으로 내가 확실히 본 green:
  - `pnpm --filter @readable-studio/web typecheck` 통과.
- interrupt/미확인:
  - `pnpm --filter @readable-studio/daemon test`는 여러 번 interrupt/abort됨.
  - `pnpm --filter @readable-studio/web test` interrupt됨.
  - `pnpm guard` interrupt됨.
- 다음 에이전트 실행 순서 권장:
  1. `pnpm --filter @readable-studio/web typecheck`
  2. `pnpm --filter @readable-studio/contracts typecheck`
  3. `pnpm --filter @readable-studio/daemon test`
  4. `pnpm --filter @readable-studio/web test`
  5. `pnpm guard`
  6. `pnpm typecheck`

#### 4. Portable build + 실제 측정

- 아직 시작 안 함.
- root AGENTS 지침상 packaged updater/installer 관련 작업 전에 `tools/pack/AGENTS.md`의 packaged auto-update architecture/harness section 읽기.
- 목표 command:
  - `pnpm --filter @readable-studio/web build`
  - `pnpm tools-pack win build --to zip`
- 측정 필요:
  - `/api/agents?stream=1` cold response time.
  - daemon startup 후 warm probe 완료 시간.
  - `.next/static/chunks` 총 크기 / largest chunk.
  - portable zip / unpacked size.
  - 가능하면 변경 전 baseline과 비교. baseline 없으면 현재 branch 측정값만으로 Oracle에게 충분한지 물어볼 것.

#### 5. Oracle review

- 아직 안 함.
- Oracle에게 줄 자료:
  - `git diff --stat`
  - agent probe 관련 diff
  - locale deletion diff
  - verification outputs
  - portable build artifact path
  - before/after 또는 at least current measured sizes/timings
- Oracle 질문은 명확히:
  - "이 built portable program이 실제 VDI optimization을 보여준다고 확신할 수 있는가? 부족한 근거가 무엇인가?"

### 주의 / 위험

- `apps/web/src/i18n/types.ts` 관련 root AGENTS 문서에는 아직 18 locale을 전부 요구한다고 되어 있지만, 이번 계획은 의도적으로 `en`/`ko`만 남기는 fork 최적화다. 다음 에이전트는 이 충돌을 인지하고 `Optimization_plan.md`를 현재 작업 spec으로 삼아야 한다.
- `SettingsDialog.tsx`는 매우 큰 파일이다. broad refactor 금지. 최소 diff로 section 추가/수정.
- `apps/web/src/index.css`는 import-only. 새 CSS 추가 시 component module 사용. 이미 `SettingsDialog.module.css`가 생긴 상태라 내용 검토 필요.
- `apps/daemon/src/server.ts`, `apps/daemon/src/cli.ts`는 `@ts-nocheck`일 수 있다. typecheck green만 믿지 말고 daemon tests/CLI manual check 필요.
- scratch 파일 `$null`, `.tmp_diff_detection.txt`, `.tmp_diff_static.txt`는 작업 중 생긴 임시 파일로 보인다. 다음 에이전트가 내용 확인 후 삭제 여부 결정.
- `.omo/`는 runtime/local data일 수 있다. 삭제 전 확인.

### 추천 스킬 / agent 운영

- `diagnose`: daemon/web test failure 재현/수정 시.
- `frontend-ui-ux` 또는 `visual-qa`: SettingsDialog Code Agents UI를 실제 화면으로 확인할 때.
- `playwright`: Settings UI manual QA용. Settings 열기 -> Code Agents toggle -> reload/daemon sync 확인.
- `git-master`: commit/PR 작업이 필요할 때만.
- `review-work`: 구현 완료 후 최종 self-review.

### 즉시 이어받기 checklist

1. `git diff --stat`와 `git diff --name-only` 확인.
2. `rg "agents/catalog|AgentCatalog|codeAgents|enabledAgentIds" apps packages` 실행.
3. background agent가 남긴 partial changes 확인 (`SettingsDialog.module.css`, contracts registry/events 등).
4. `/api/agents/catalog` 없으면 먼저 backend endpoint + contract + test 추가.
5. SettingsDialog UI 없거나 partial이면 최소 구현 완료.
6. `pnpm --filter @readable-studio/web typecheck` 재실행.
7. daemon/web tests, guard/typecheck 실행.
8. portable build + 측정.
9. Oracle review 전까지 성공 선언 금지.
