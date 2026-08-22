# Readable Studio 기여 가이드

Readable Studio는 원문을 AI로 생성하고 PowerPoint처럼 직접 편집해 독립 실행형 HTML로 완성하는 Windows용 로컬 문서 스튜디오입니다. 변경 사항은 이 흐름과 기존 UI/CLI/API/MCP/플러그인 기능을 보존해야 합니다.

## 개발 환경

지원 제품은 Windows 10/11 x64 휴대용 ZIP입니다. 개발에는 Node.js 24, pnpm 10.33.2, Python 3, Visual Studio Build Tools 2022 이상이 필요합니다.

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev
```

## 변경 원칙

- 루트와 해당 디렉터리의 `AGENTS.md`를 먼저 읽습니다.
- 사용자 기능은 web UI와 `readable` CLI에서 같은 daemon HTTP 계약을 사용합니다.
- CLI 자동화 출력은 `--json`, 긴 입력은 `--prompt-file <path|->`를 지원합니다.
- 플러그인 사이드카는 `readable-studio.json`, 메타데이터는 `readable.*`를 사용합니다.
- 소스 모드 데이터는 `.readable-studio`, 휴대용 데이터는 `ReadableStudioData\namespaces\<namespace>`에 둡니다.
- 제품 웹사이트, 업데이터, 설치 프로그램, macOS/Linux/Nix 제품 패키징을 추가하지 않습니다.
- 라이선스, 변경 이력, `specs/change/**`, 제3자 출처와 원본 추적 데이터는 사실 그대로 보존합니다.
- 순수 문구를 정확히 고정하는 테스트를 만들지 않습니다. 기계 계약과 동작을 테스트합니다.

## 플러그인 변경

```powershell
readable plugin validate .\my-plugin --json
pnpm --filter @readable-studio/plugin-runtime typecheck
```

플러그인, 스킬, 디자인 시스템, 템플릿의 기존 개수와 기능을 이름 변경 과정에서 삭제하지 마세요.

## 검증

변경 영역의 패키지 테스트와 타입 검사를 실행한 뒤 다음을 실행합니다.

```powershell
pnpm guard
pnpm typecheck
```

Windows 휴대용 제품 변경은 다음 진입점으로 검증합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

커밋에는 공동 작성자 트레일러를 추가하지 마세요. `.readable-studio/`, `.tmp/`, 휴대용 런타임 데이터, 자격 증명, 테스트 보고서를 커밋하지 않습니다.
