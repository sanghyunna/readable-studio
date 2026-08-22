# Readable Studio

Readable Studio는 원문을 AI로 문서화하고, PowerPoint처럼 직접 편집한 뒤, 독립 실행형 HTML로 완성하는 Windows용 로컬 문서 스튜디오입니다.

## 핵심 흐름

1. 원문, 메모, 요구사항을 프로젝트에 넣습니다.
2. 로컬 코드 에이전트가 스킬, 템플릿, 디자인 시스템을 사용해 HTML 문서를 생성합니다.
3. 미리보기에서 텍스트, 색상, 크기, 위치, 레이아웃을 직접 수정합니다.
4. 저장 후 브라우저에서 열 수 있는 독립 실행형 HTML을 내보냅니다.

플러그인, 자동화, MCP, HTTP API, `readable` CLI, PDF/PPTX/ZIP/Markdown 보조 내보내기 기능도 유지됩니다.

## 지원 환경

제품 배포 대상은 **Windows 10/11 x64 휴대용 ZIP**뿐입니다. 설치 프로그램, 자동 업데이트, 제품 웹사이트, macOS/Linux 패키지는 제공하지 않습니다.

[GitHub Releases](https://github.com/sanghyunna/readable-studio/releases)에서 ZIP을 내려받아 압축을 풀고 `Readable Studio.exe`를 실행하세요. 사용자 데이터는 실행 파일 옆의 `ReadableStudioData\namespaces\<namespace>` 아래에 저장됩니다. 레지스트리나 `%APPDATA%` 설치 상태에 의존하지 않습니다.

## 소스에서 실행

필수 도구:

- Node.js 24
- pnpm 10.33.2
- Python 3
- Visual Studio Build Tools 2022 이상

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev
```

소스 모드의 기본 데이터 경로는 `<project-root>\.readable-studio`입니다. 전체 데이터 루트는 `READABLE_DATA_DIR`, 미디어 자격 증명 파일 위치만은 `READABLE_MEDIA_CONFIG_DIR`로 바꿀 수 있습니다.

## CLI와 MCP

```powershell
readable --help
readable status --json
readable mcp
```

CLI 명령은 `--json`을 지원하고, 긴 프롬프트를 받는 명령은 `--prompt-file <path|->`를 지원합니다. MCP 클라이언트 설정의 서버 키는 `readable-studio`입니다.

## 플러그인과 리소스

플러그인 사이드카 파일은 `readable-studio.json`이며 제품 메타데이터는 `readable.*` 네임스페이스를 사용합니다. 기본 제공 플러그인, 스킬, 템플릿, 디자인 시스템은 저장소 안에서 함께 배포됩니다.

- [빠른 시작](QUICKSTART.ko.md)
- [기여 가이드](CONTRIBUTING.ko.md)
- [아키텍처](../architecture.md)
- [플러그인 사양](../plugins-spec.md)

## 검증

```powershell
pnpm guard
pnpm typecheck
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

라이선스와 기존 프로젝트의 사실적인 이력 및 제3자 출처는 원문 그대로 보존됩니다.
