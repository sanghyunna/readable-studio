# Readable Studio 빠른 시작

## 휴대용 앱 실행

Readable Studio의 제품 배포 대상은 Windows 10/11 x64 휴대용 ZIP입니다.

1. [GitHub Releases](https://github.com/sanghyunna/readable-studio/releases)에서 ZIP을 받습니다.
2. 쓰기 가능한 폴더에 압축을 풉니다.
3. `Readable Studio.exe`를 실행합니다.

앱 데이터, 로그, 캐시, Chromium 프로필은 실행 파일 옆의 `ReadableStudioData\namespaces\<namespace>`에 저장됩니다. 설치 프로그램, 레지스트리 등록, 자동 업데이트, 제품 웹사이트는 없습니다.

## 소스에서 실행

필수 도구는 Node.js 24, pnpm 10.33.2, Python 3, Visual Studio Build Tools 2022 이상입니다.

```powershell
git clone https://github.com/sanghyunna/readable-studio.git
cd readable-studio
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev
```

`pnpm tools-dev`가 daemon, web, desktop 수명 주기를 관리합니다. 루트 `dev`, `start`, `build`, `test` 별칭을 추가하지 마세요.

## 첫 문서 만들기

1. 새 프로젝트를 만들고 원문이나 요구사항을 입력합니다.
2. 에이전트, 스킬, 디자인 시스템을 선택해 HTML을 생성합니다.
3. 미리보기에서 텍스트, 스타일, 크기, 위치를 직접 편집합니다.
4. 저장하고 독립 실행형 HTML로 내보냅니다.

## CLI 확인

```powershell
readable --help
readable status --json
readable skills list --json
readable design-systems list --json
```

긴 입력은 지원되는 명령에서 `--prompt-file <path|->`로 전달합니다.

## 데이터 경로

소스 모드 기본값은 `<project-root>\.readable-studio`입니다.

```powershell
$env:READABLE_DATA_DIR = "D:\ReadableStudioData"
$env:READABLE_MEDIA_CONFIG_DIR = "D:\ReadableStudioSecrets"
```

기존 제품의 데이터 경로나 환경 변수는 읽지 않습니다.

## 휴대용 ZIP 빌드

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

자세한 내용은 [한국어 README](README.ko.md)와 [기여 가이드](CONTRIBUTING.ko.md)를 참고하세요.
