
export const KO_SKILL_COPY: Record<string, { description?: string; examplePrompt?: string }> = {
  'ad-creative': {
    description:
      '헤드라인, 설명, 기본 텍스트를 포함한 광고 크리에이티브를 생성하고 반복 개선합니다. 유료 소셜 및 검색 광고 반복 작업에 유용합니다.',
    examplePrompt:
      '헤드라인, 설명, 기본 텍스트를 포함한 광고 크리에이티브를 생성하고 반복 개선합니다.',
  },
  'agent-browser': {
    description:
      'AI 에이전트를 위한 브라우저 자동화 CLI. 사용자가 브라우저 동작을\n검사, 테스트 또는 자동화해야 할 때 사용하세요: 페이지 탐색, 양식 작성,\n버튼 클릭, 스크린샷 촬영, 페이지 데이터 추출, 선택된\nReadable Studio 브라우저 탭 컨텍스트 읽기, 웹 앱 테스트, Readable Studio\n미리보기 도그푸딩, QA, 버그 헌트, 또는 앱 품질 검토. 사용자가 명시적으로\n외부 브라우징을 요청하지 않는 한 로컬 Readable Studio 미리보기 URL을 우선하세요.',
    examplePrompt:
      'AI 에이전트를 위한 브라우저 자동화 CLI.',
  },
  'ai-music-album': {
    description:
      '전체 라이프사이클 AI 음악 앨범 제작 — 콘셉트, 가사 초안 작성, 트랙 시퀀싱, 내보내기. 인디 앨범 실험과 브랜드 사운드트랙에 유용합니다.',
    examplePrompt:
      '전체 라이프사이클 AI 음악 앨범 제작 — 콘셉트, 가사 초안 작성, 트랙 시퀀싱, 내보내기.',
  },
  'algorithmic-art': {
    description:
      '시드 기반 랜덤성을 사용해 모든 렌더가 재현 가능한 제너러티브 아트를 p5.js로 제작합니다. 프로시저럴 포스터, 모션 스타일 스틸, 아티스틱 프레임 스터디에 유용합니다.',
    examplePrompt:
      '시드 기반 랜덤성을 사용해 모든 렌더가 재현 가능한 제너러티브 아트를 p5.js로 제작합니다.',
  },
  'apple-hig': {
    description:
      'iOS, macOS, visionOS, watchOS, tvOS를 위한 플랫폼, 기초, 컴포넌트, 패턴, 입력, 기술을 다루는 14개의 에이전트 스킬로 구성된 Apple Human Interface Guidelines.',
    examplePrompt:
      'iOS, macOS, visionOS, watchOS, tvOS를 위한 플랫폼, 기초, 컴포넌트, 패턴, 입력, 기술을 다루는 14개의 에이전트 스킬로 구성된 Apple Human Interface Guidelines.',
  },
  'article-magazine': {
    description:
      'Markdown이나 노트를 세련된 장문 HTML 에세이로 변환하기 위한 Huashu / huashu-md-html에서 영감을 받은 매거진 기사 레이아웃.',
    examplePrompt:
      'Magazine Article 템플릿을 사용해 내 콘텐츠를 Huashu / huashu-md-html에서 영감을 받은 장문 HTML 에세이로 변환해 주세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피하세요.',
  },
  'artifacts-builder': {
    description:
      '최신 프론트엔드 웹 기술(React, Tailwind CSS, shadcn/ui)을 사용해 정교한 멀티 컴포넌트 claude.ai HTML 아티팩트를 만드는 도구 모음.',
    examplePrompt:
      '최신 프론트엔드 웹 기술(React, Tailwind CSS, shadcn/ui)을 사용해 정교한 멀티 컴포넌트 claude.ai HTML 아티팩트를 만드는 도구 모음.',
  },
  'brainstorming': {
    description:
      '구조화된 질문과 대안 탐색을 통해 거친 아이디어를 완성된 디자인으로 발전시킵니다. 콘셉트 작업 초기 단계에 유용합니다.',
    examplePrompt:
      '구조화된 질문과 대안 탐색을 통해 거친 아이디어를 완성된 디자인으로 발전시킵니다.',
  },
  'brand-guidelines': {
    description:
      'Anthropic의 공식 브랜드 색상과 타이포그래피를 아티팩트에 적용해 일관된 비주얼 아이덴티티와 전문적인 디자인 표준을 구현합니다. 직접 만들 때 참고할 수 있는 레퍼런스입니다.',
    examplePrompt:
      'Anthropic의 공식 브랜드 색상과 타이포그래피를 아티팩트에 적용해 일관된 비주얼 아이덴티티와 전문적인 디자인 표준을 구현합니다.',
  },
  'brandkit': {
    description:
      '고급 브랜드 가이드라인 보드, 로고 시스템, 아이덴티티 덱, 비주얼 월드 프레젠테이션을 제작하기 위한 프리미엄 브랜드 키트 이미지 생성 스킬. 미니멀, 시네마틱, 에디토리얼, 다크테크, 럭셔리, 문화, 보안, 게이밍, 개발자 도구, 컨슈머 앱 브랜드 시스템에 맞게 학습되었습니다. 의도적인 로고 콘셉팅, 정제된 구성, 절제된 타이포그래피, 강력한 상징적 의미, 프리미엄 목업, 아트 디렉션 이미지, 유연한 그리드 레이아웃에 최적화되어 있습니다.',
    examplePrompt:
      '이 제품을 위한 프리미엄 브랜드 키트 개요 이미지를 만들어 주세요: 로고 방향성, 팔레트, 타이포그래피, 적용 사례, 그리고 일관된 비주얼 월드.',
  },
  'industrial-brutalist-ui': {
    description:
      '스위스 타이포그래픽 인쇄와 밀리터리 터미널 미학을 융합한 로우 메커니컬 인터페이스. 견고한 그리드, 극단적인 타입 스케일 대비, 실용적 색상, 아날로그 열화 효과. 기밀 해제된 청사진 같은 느낌이 필요한 데이터 중심 대시보드, 포트폴리오, 에디토리얼 사이트를 위한 것입니다.',
    examplePrompt:
      '견고한 그리드, 전술적 텔레메트리 모티프, 강렬한 타이포그래피, 기계적 정밀함을 갖춘 인더스트리얼 브루탈리스트 인터페이스를 만들어 주세요.',
  },
  'canvas-design': {
    description:
      '디자인 철학과 미학 원리를 활용해 포스터, 일러스트, 정적 작품을 위한 아름다운 비주얼 아트를 PNG 및 PDF 문서로 제작합니다.',
    examplePrompt:
      '디자인 철학과 미학 원리를 활용해 포스터, 일러스트, 정적 작품을 위한 아름다운 비주얼 아트를 PNG 및 PDF 문서로 제작합니다.',
  },
  'card-twitter': {
    description:
      '게시물과 함께 사용하도록 디자인된 Twitter 인용 또는 데이터 카드.',
    examplePrompt:
      'Twitter Share Card 템플릿을 사용해 내 콘텐츠를 게시물과 함께 사용하도록 디자인된 Twitter 인용 또는 데이터 카드로 변환해 주세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피하세요.',
  },
  'card-xiaohongshu': {
    description:
      '스와이프 가능한 멀티 카드 캐러셀로 배치된 샤오훙수 스타일 지식 카드.',
    examplePrompt:
      'Xiaohongshu Card 템플릿을 사용해 내 콘텐츠를 스와이프 가능한 샤오훙수 스타일 지식 카드 캐러셀로 변환해 주세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피하세요.',
  },
  'color-expert': {
    description:
      'OKLCH/OKLAB, 팔레트 생성, 접근성/대비, 색상 명명, 안료 혼합, 역사적 색채 이론을 다루는 28만 6천 단어 분량의 참고 자료를 갖춘 색채 과학 전문가 스킬.',
    examplePrompt:
      'OKLCH/OKLAB, 팔레트 생성, 접근성/대비, 색상 명명, 안료 혼합, 역사적 색채 이론을 다루는 28만 6천 단어 분량의 참고 자료를 갖춘 색채 과학 전문가 스킬.',
  },
  'competitive-ads-extractor': {
    description:
      '광고 라이브러리에서 경쟁사 광고를 추출하고 분석해 공감을 얻는 메시지와 크리에이티브 접근 방식을 파악합니다.',
    examplePrompt:
      '광고 라이브러리에서 경쟁사 광고를 추출하고 분석해 공감을 얻는 메시지와 크리에이티브 접근 방식을 파악합니다.',
  },
  'copywriting': {
    description:
      '랜딩 페이지, 홈페이지, 광고를 위한 마케팅 카피를 작성하고 다시 작성합니다. 출시 기간 동안 카피 책임 파트너로 유용합니다.',
    examplePrompt:
      '랜딩 페이지, 홈페이지, 광고를 위한 마케팅 카피를 작성하고 다시 작성합니다.',
  },
  'creative-director': {
    description:
      '재귀적 자기 평가를 갖춘 AI 크리에이티브 디렉터: 20여 가지 방법론(SIT, TRIZ, Bisociation, SCAMPER, Synectics), Cannes/D&AD/HumanKind 기준으로 보정된 3축 평가, 브리프부터 프레젠테이션까지 5단계 프로세스.',
    examplePrompt:
      '재귀적 자기 평가를 갖춘 AI 크리에이티브 디렉터: 20여 가지 방법론(SIT, TRIZ, Bisociation, SCAMPER, Synectics), Cannes/D&AD/HumanKind 기준으로 보정된 3축 평가, 브리프부터 프레젠테이션까지 5단계 프로세스.',
  },
  'd3-visualization': {
    description:
      '에이전트가 D3 차트와 인터랙티브 데이터 시각화를 제작하도록 가르칩니다. 다양한 차트 유형과 기법에 걸친 예시를 갖춘 포괄적인 D3.js 스킬로, 에이전트에 복잡한 인터랙티브 시각화를 생성할 수 있는 전문가 수준의 지식을 제공합니다. 편집형 대시보드, 리포트, 데이터가 풍부한 프로토타입, 설명용 그래픽에 유용합니다.',
    examplePrompt:
      '에이전트가 D3 차트와 인터랙티브 데이터 시각화를 제작하도록 가르칩니다.',
  },
  'data-report': {
    description:
      'CSV, Excel, JSON 데이터를 세련된 비주얼 리포트 페이지로 전환합니다.',
    examplePrompt:
      'Data Visualization Report 템플릿을 사용해 제 CSV, Excel, JSON 데이터를 세련된 비주얼 리포트 페이지로 전환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'deck-guizang-editorial': {
    description:
      '에디토리얼 매거진과 e-ink의 만남: 10개 레이아웃과 5개 팔레트(Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune).',
    examplePrompt:
      'Guizang Editorial E-Ink Deck 템플릿을 사용해 제 콘텐츠를 10개 레이아웃과 5개 팔레트를 갖춘 에디토리얼 매거진 x e-ink 가로형 덱으로 전환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'deck-open-slide-canvas': {
    description:
      '고정 템플릿에 얽매이지 않고 React 컴포넌트 수준의 자유로운 구성이 가능한, 1920x1080으로 고정된 캔버스 덱.',
    examplePrompt:
      'Open-Slide 1920 Canvas Deck 템플릿을 사용해 제 콘텐츠를 React 컴포넌트 수준 레이아웃의 1920x1080 고정 자유 구성 덱으로 전환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'deck-swiss-international': {
    description:
      '16열 그리드, 하나의 채도 높은 액센트, 그리고 22개의 고정 레이아웃(Klein Blue, Lemon, Mint, Safety Orange).',
    examplePrompt:
      'Swiss International Deck 템플릿을 사용해 제 콘텐츠를 하나의 채도 높은 액센트와 22개의 고정 레이아웃을 갖춘 16열 그리드 덱으로 전환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'design-brief': {
    description:
      'I-Lang 프로토콜 형식으로 작성된 구조화된 디자인 브리프를 구체적인\n디자인 사양으로 파싱합니다. 팔레트, 타이포그래피, 레이아웃, 무드, 밀도,\n제약 조건 등 명시적인 차원을 요구함으로써 "전문적으로 만들어 줘" 같은\n모호한 요청에서 발생하는 애매함을 제거합니다.\n트리거 키워드: "design brief", "create a design brief", "ilang brief", "structured brief".',
    examplePrompt:
      'I-Lang 프로토콜 형식으로 작성된 구조화된 디자인 브리프를 구체적인 디자인 사양으로 파싱합니다.',
  },
  'design-consultation': {
    description:
      '창의적 모험과 사실적인 제품 목업으로 완전한 디자인 시스템을 처음부터 구축합니다. 킥오프 워크숍과 브랜드를 제로에서 만드는 작업에 유용합니다.',
    examplePrompt:
      '창의적 모험과 사실적인 제품 목업으로 완전한 디자인 시스템을 처음부터 구축합니다.',
  },
  'design-md': {
    description:
      'DESIGN.md 파일을 생성하고 관리합니다. 디자인 방향성, 토큰, 비주얼 규칙을 하나의 단일 진실 공급원에 담는 데 유용합니다.',
    examplePrompt:
      'DESIGN.md 파일을 생성하고 관리합니다.',
  },
  'design-review': {
    description:
      '코딩하는 디자이너: 비주얼 감사 후 원자적 커밋과 전후 스크린샷으로 수정합니다. 출시 전 배포된 UI를 다듬는 데 유용합니다.',
    examplePrompt:
      '코딩하는 디자이너: 비주얼 감사 후 원자적 커밋과 전후 스크린샷으로 수정합니다.',
  },
  'digits-fintech-swiss-template': {
    description:
      '블랙 / 따뜻한 페이퍼 / 네온 라임 대비의 스위스 그리드 핀테크 덱 템플릿.\n엄격한 모듈형 레이아웃, 굵직한 수치 카드, 절제된 모션, 키보드/클릭 내비게이션을\n하나의 HTML 파일에 담은 프리미엄 데이터 스토리 슬라이드를 요청할 때 사용하세요.',
    examplePrompt:
      '모듈형 데이터 카드, 라임 액센트, 깔끔한 키보드 내비게이션을 갖춘 스위스 그리드 핀테크 전략 덱을 만들어 주세요.',
  },
  'doc': {
    description:
      'OpenAI의 문서 스킬을 통해 서식과 레이아웃 충실도를 유지하며 .docx 문서를 읽고, 생성하고, 편집합니다.',
    examplePrompt:
      'OpenAI의 문서 스킬을 통해 서식과 레이아웃 충실도를 유지하며 .docx 문서를 읽고, 생성하고, 편집합니다.',
  },
  'doc-kami-parchment': {
    description:
      '따뜻한 양피지 캔버스(#f5f4ed), 모노크롬 잉크 블루 액센트(#1B365D), 단일 세리프 패밀리, 그리고 에디토리얼 수준의 타이포그래피.',
    examplePrompt:
      'Kami Parchment Document 템플릿을 사용해 제 콘텐츠를 모노크롬 잉크 블루 액센트, 단일 세리프 패밀리, 에디토리얼 수준의 타이포그래피를 갖춘 따뜻한 양피지 문서로 전환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'docx': {
    description:
      '변경 내용 추적, 주석, 서식을 갖춘 Word 문서를 생성하고, 편집하고, 분석합니다. 디자인 브리프, 카피 문서, 검토 준비가 완료된 산출물에 유용합니다.',
    examplePrompt:
      '변경 내용 추적, 주석, 서식을 갖춘 Word 문서를 생성하고, 편집하고, 분석합니다.',
  },
  'domain-name-brainstormer': {
    description:
      '창의적인 도메인 이름 아이디어를 생성하고 .com, .io, .dev, .ai를 포함한 여러 TLD에서 사용 가능 여부를 확인합니다.',
    examplePrompt:
      '창의적인 도메인 이름 아이디어를 생성하고 .com, .io, .dev, .ai를 포함한 여러 TLD에서 사용 가능 여부를 확인합니다.',
  },
  'ecommerce-image-workflow': {
    description:
      '실제 제품 레퍼런스 사진으로부터 제품에 충실한 메인, 기능, 라이프스타일\n이미지를 컴팩트하게 생성하는 레퍼런스 제품 이커머스 이미지 워크플로우입니다.\nV1은 업로드된 제품 이미지를 요구하며, 브리프만으로 하는 콘셉트 생성과\n플랫폼별 일괄 내보내기는 의도적으로 보류합니다.',
    examplePrompt:
      'Ecommerce Image Workflow를 사용해 제가 업로드한 제품 레퍼런스\n사진을 컴팩트한 이커머스 이미지 세트로 전환해 주세요: 메인 팩샷 1장,\n기능 강조 이미지 1장, 라이프스타일 장면 1장. 제품의 정확한 정체성,\n색상, 소재, 로고 배치, 구조, 비율을 그대로 유지해 주세요.',
  },
  'editorial-burgundy-principles-template': {
    description:
      '버건디 / 블러시 / 뮤트 골드 팔레트의 에디토리얼 스튜디오 덱 템플릿.\n필 태그, 큼직한 타이포그래피 문구, 원칙 카드, 안내형 키보드/클릭 내비게이션을\n갖춘 프리미엄 매니페스토 또는 컬처 슬라이드를 요청할 때 사용하세요.',
    examplePrompt:
      '태그 클라우드 슬라이드와 8개 원칙 카드 그리드를 갖춘 버건디와 블러시의 프리미엄 에디토리얼 덱을 만들어 주세요.',
  },
  'emilkowalski-motion': {
    description:
      'Emil Kowalski의 애니메이션 가이드에서 영감을 받은 모션 디자인 후속 스킬입니다. 인터페이스가 이미 존재할 때 사용하여 제품 수준의 절제로 세련된 마이크로 인터랙션, 상태 전환, 페이지 모션을 추가하세요.',
    examplePrompt:
      '현재 HTML 아티팩트에 emilkowalski-motion을 사용하세요: 핵심 레이아웃을 변경하지 않고 절제된 마이크로 인터랙션, 상태 전환, reduced-motion 폴백을 추가하세요.',
  },
  'enhance-prompt': {
    description:
      '디자인 사양과 UI/UX 어휘로 프롬프트를 개선합니다. 디자인-투-코드 워크플로우와 비주얼 출력 요청을 명확히 하는 데 유용합니다.',
    examplePrompt:
      '디자인 사양과 UI/UX 어휘로 프롬프트를 개선합니다.',
  },
  'export-download-debugging': {
    description:
      '브라우저, 미리보기, Electron의 내보내기/다운로드 실패를 진단하고 수정합니다. 특히 다른 이름으로 저장, Blob/Data URL, File System Access API, createWritable 실패, 0 KB 파일과 관련된 이미지 내보내기 문제에 유용합니다.',
    examplePrompt:
      '브라우저, 미리보기, Electron의 내보내기/다운로드 실패를 진단하고 수정합니다. 특히 다른 이름으로 저장, Blob/Data URL, File System Access API, createWritable 실패, 0 KB 파일과 관련된 이미지 내보내기 문제에 유용합니다.',
  },
  'fal-3d': {
    description:
      'fal.ai를 통해 텍스트나 이미지로부터 3D 모델을 생성합니다. 게임 에셋, AR 미리보기, 제품 목업, 콘셉트 스컬프팅에 유용합니다.',
    examplePrompt:
      'fal.ai를 통해 텍스트나 이미지로부터 3D 모델을 생성합니다.',
  },
  'fal-generate': {
    description:
      'fal.ai AI 모델을 사용해 이미지와 비디오를 생성합니다. Flux, SDXL, ideogram 및 기타 커뮤니티 호스팅 엔드포인트를 아우르는 프로덕션급 카탈로그입니다.',
    examplePrompt:
      'fal.ai AI 모델을 사용해 이미지와 비디오를 생성합니다.',
  },
  'fal-image-edit': {
    description:
      'fal.ai 호스팅 모델을 통한 AI 기반 이미지 편집 — 스타일 전이, 배경 제거, 객체 제거, 인페인팅을 지원합니다.',
    examplePrompt:
      'fal.ai 호스팅 모델을 통한 AI 기반 이미지 편집 — 스타일 전이, 배경 제거, 객체 제거, 인페인팅을 지원합니다.',
  },
  'fal-kling-o3': {
    description:
      'fal.ai를 통해 Kling의 가장 강력한 모델 제품군인 Kling O3로 이미지와 비디오를 생성합니다.',
    examplePrompt:
      'fal.ai를 통해 Kling의 가장 강력한 모델 제품군인 Kling O3로 이미지와 비디오를 생성합니다.',
  },
  'fal-lip-sync': {
    description:
      'fal.ai를 통해 토킹 헤드 비디오를 만들고 오디오를 비디오에 립싱크합니다. 설명용 아바타, 다국어 더빙 미리보기, 소셜 클립에 유용합니다.',
    examplePrompt:
      'fal.ai를 통해 토킹 헤드 비디오를 만들고 오디오를 비디오에 립싱크합니다.',
  },
  'fal-realtime': {
    description:
      'fal.ai를 통한 실시간 및 스트리밍 AI 이미지 생성. 무드보드 탐색, 초안 변형, 빠른 크리에이티브 반복 작업에 적합합니다.',
    examplePrompt:
      'fal.ai를 통한 실시간 및 스트리밍 AI 이미지 생성.',
  },
  'fal-restore': {
    description:
      '이미지 품질을 복원하고 보정합니다 — fal.ai의 호스팅 복원 모델을 사용해 흐림 제거, 노이즈 제거, 얼굴 보정, 오래된 문서 복원을 수행합니다.',
    examplePrompt:
      '이미지 품질을 복원하고 보정합니다 — fal.ai의 호스팅 복원 모델을 사용해 흐림 제거, 노이즈 제거, 얼굴 보정, 오래된 문서 복원을 수행합니다.',
  },
  'fal-train': {
    description:
      '브랜드, 캐릭터, 스타일에 맞춤화된 개인화 이미지 생성을 위해 fal.ai에서 커스텀 AI 모델(LoRA)을 학습시킵니다.',
    examplePrompt:
      '브랜드, 캐릭터, 스타일에 맞춤화된 개인화 이미지 생성을 위해 fal.ai에서 커스텀 AI 모델(LoRA)을 학습시킵니다.',
  },
  'fal-tryon': {
    description:
      '가상 피팅 — fal.ai의 호스팅 피팅 모델을 통해 옷이 사람에게 어떻게 보이는지 확인합니다. 이커머스, 룩북, 스타일링 실험에 유용합니다.',
    examplePrompt:
      '가상 피팅 — fal.ai의 호스팅 피팅 모델을 통해 옷이 사람에게 어떻게 보이는지 확인합니다.',
  },
  'fal-upscale': {
    description:
      'fal.ai에 호스팅된 AI 초해상도 모델을 사용해 이미지와 비디오 해상도를 업스케일하고 향상시킵니다.',
    examplePrompt:
      'fal.ai에 호스팅된 AI 초해상도 모델을 사용해 이미지와 비디오 해상도를 업스케일하고 향상시킵니다.',
  },
  'fal-video-edit': {
    description:
      'AI를 사용해 기존 비디오를 편집합니다 — fal.ai의 호스팅 비디오 모델을 통해 스타일 리믹스, 업스케일, 배경 제거, 오디오 추가를 수행합니다.',
    examplePrompt:
      'AI를 사용해 기존 비디오를 편집합니다 — fal.ai의 호스팅 비디오 모델을 통해 스타일 리믹스, 업스케일, 배경 제거, 오디오 추가를 수행합니다.',
  },
  'fal-vision': {
    description:
      '이미지를 분석합니다 — fal.ai 비전 모델을 통해 객체 분할, 탐지, OCR 실행, 설명, 시각적 질문 답변을 수행합니다.',
    examplePrompt:
      '이미지를 분석합니다 — fal.ai 비전 모델을 통해 객체 분할, 탐지, OCR 실행, 설명, 시각적 질문 답변을 수행합니다.',
  },
  'faq-page': {
    description:
      '접을 수 있는 아코디언 섹션, 검색 기능, 카테고리 필터링을 갖춘 자주 묻는 질문(FAQ) 페이지입니다. 브리프에서\n"FAQ", "도움말 센터", "질문", "지원 페이지"를 요청할 때 사용하세요.',
    examplePrompt:
      '접을 수 있는 아코디언 섹션, 검색 기능, 카테고리 필터링을 갖춘 자주 묻는 질문(FAQ) 페이지입니다.',
  },
  'field-notes-editorial-template': {
    description:
      '부드러운 종이 배경, 세리프 히어로 타이포그래피, 둥근 파스텔 인사이트 카드, 리텐션 차트 패널을 갖춘 에디토리얼 "Field Notes" 보고서 템플릿입니다.\n사용자가 프리미엄 매거진 스타일의 비즈니스 보고서, 이사회 메모\n원페이저, 우아한 데이터 스토리텔링 레이아웃을 요청할 때 사용하세요.',
    examplePrompt:
      '세련된 단일 파일 HTML 페이지 하나에 세 개의 인사이트 카드, 핵심 지표 블록, 리텐션 라인 차트를 담은 에디토리얼 Field Notes 스타일 보고서를 만드세요.',
  },
  'figma-code-connect-components': {
    description:
      'Code Connect를 사용해 Figma 디자인 컴포넌트를 코드 컴포넌트와 연결하여 디자인 시스템 업데이트가 코드베이스로 자동으로 반영되도록 합니다.',
    examplePrompt:
      'Code Connect를 사용해 Figma 디자인 컴포넌트를 코드 컴포넌트와 연결하여 디자인 시스템 업데이트가 코드베이스로 자동으로 반영되도록 합니다.',
  },
  'figma-create-design-system-rules': {
    description:
      'Figma-투-코드 워크플로를 위한 프로젝트별 디자인 시스템 규칙을 생성합니다. 토큰, 네이밍, 린트 규칙을 하나의 소스에 담는 데 유용합니다.',
    examplePrompt:
      'Figma-투-코드 워크플로를 위한 프로젝트별 디자인 시스템 규칙을 생성합니다.',
  },
  'figma-create-new-file': {
    description:
      '새 빈 Figma Design 또는 FigJam 파일을 만듭니다. 스크립트로 자동화된 디자인 시스템이나 워크숍 워크플로의 첫 단계로 유용합니다.',
    examplePrompt:
      '새 빈 Figma Design 또는 FigJam 파일을 만듭니다.',
  },
  'figma-generate-design': {
    description:
      '디자인 시스템 컴포넌트를 사용해 코드나 설명으로부터 Figma 화면을 구축하거나 업데이트합니다. 디자인 토큰을 사용해 앱 페이지를 Figma로 변환합니다.',
    examplePrompt:
      '디자인 시스템 컴포넌트를 사용해 코드나 설명으로부터 Figma 화면을 구축하거나 업데이트합니다.',
  },
  'figma-generate-library': {
    description:
      '코드베이스로부터 Figma에 프로페셔널급 디자인 시스템 라이브러리를 구축하거나 업데이트합니다. Figma의 단일 진실 공급원을 출시된 컴포넌트와 동기화 상태로 유지하는 데 유용합니다.',
    examplePrompt:
      '코드베이스로부터 Figma에 프로페셔널급 디자인 시스템 라이브러리를 구축하거나 업데이트합니다.',
  },
  'figma-implement-design': {
    description:
      'Figma 디자인을 1:1 시각적 충실도로 프로덕션 준비된 코드로 변환합니다. Figma 프레임을 프런트엔드 에이전트에 바로 넘기는 데 유용합니다.',
    examplePrompt:
      'Figma 디자인을 1:1 시각적 충실도로 프로덕션 준비된 코드로 변환합니다.',
  },
  'figma-use': {
    description:
      '캔버스 쓰기, 검사, 변수, 디자인 시스템 작업을 위해 Figma Plugin API 스크립트를 실행합니다. 이 카탈로그의 다른 모든 Figma 스킬의 전제 조건입니다.',
    examplePrompt:
      '캔버스 쓰기, 검사, 변수, 디자인 시스템 작업을 위해 Figma Plugin API 스크립트를 실행합니다.',
  },
  'flutter-animating-apps': {
    description:
      'Flutter 앱에서 애니메이션 효과, 트랜지션, 모션을 구현합니다. 네이티브 iOS/Android 모션 디자인에 유용합니다.',
    examplePrompt:
      'Flutter 앱에서 애니메이션 효과, 트랜지션, 모션을 구현합니다.',
  },
  'frame-data-chart-nyt': {
    description:
      'NYT 뉴스룸 타이포그래피, 시차 등장 애니메이션, 에디토리얼급 차트(라인, 바, 레인지 밴드).',
    examplePrompt:
      'NYT-Style Data Chart Frame 템플릿을 사용해 내 콘텐츠를 NYT 뉴스룸 타이포그래피, 시차 등장 애니메이션, 에디토리얼급 차트가 적용된 프레임으로 만들어 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-flowchart-sticky': {
    description:
      'SVG 곡선 커넥터, 스티키 노트 노드, 화이트보드 브레인스토밍 느낌의 커서 인터랙션.',
    examplePrompt:
      'Sticky Flowchart Frame 템플릿을 사용해 내 콘텐츠를 SVG 곡선 커넥터, 스티키 노트 노드, 커서 인터랙션이 적용된 화이트보드 브레인스토밍 프레임으로 만들어 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-glitch-title': {
    description:
      '디지털 글리치, 색수차 오프셋, 데이터 손상 효과의 타이틀 프레임으로, 영상 트랜지션이나 사이버펑크 히어로에 적합합니다.',
    examplePrompt:
      'Glitch Title Frame 템플릿을 사용해 내 콘텐츠를 디지털 글리치, 색수차 오프셋, 데이터 손상 효과의 타이틀 프레임으로 만들어 영상 트랜지션이나 사이버펑크 히어로에 활용해 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-light-leak-cinema': {
    description:
      '필름 라이트 리크, 그레인, 16:9 레터박스, 대형 세리프 서체로 영화 같은 오프닝이나 챕터 카드를 연출합니다.',
    examplePrompt:
      'Light-Leak Cinematic Frame 템플릿을 사용해 내 콘텐츠를 필름 라이트 리크, 그레인, 레터박스 프레이밍, 대형 세리프 서체가 적용된 영화 같은 오프닝이나 챕터 카드로 만들어 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-liquid-bg-hero': {
    description:
      '인용구 오버레이가 있는 WebGL 스타일의 유체 디스플레이스먼트 배경으로, 영상 인트로, 랜딩 히어로, 포스터에 적합합니다.',
    examplePrompt:
      'Liquid Background Hero 템플릿을 사용해 내 콘텐츠를 인용구 오버레이가 있는 WebGL 스타일의 유체 디스플레이스먼트 배경으로 만들어 영상 인트로, 랜딩 히어로, 포스터에 활용해 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-logo-outro': {
    description:
      '분할 로고 조립, 글로우 블룸, 태그라인 등장 효과로 영상 아웃트로나 브랜드 마무리 프레임을 연출합니다.',
    examplePrompt:
      'Logo Outro Frame 템플릿을 사용해 내 콘텐츠를 분할 로고 조립, 글로우 블룸, 태그라인 등장 효과가 적용된 영상 아웃트로나 브랜드 마무리 프레임으로 만들어 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frame-macos-notification': {
    description:
      '앱 아이콘, 제목, 본문이 포함된 사실적인 macOS 알림 배너로, 영상 오버레이나 제품 티저에 적합합니다.',
    examplePrompt:
      'macOS Notification Banner 템플릿을 사용해 내 콘텐츠를 영상 오버레이나 제품 티저용 사실적인 macOS 알림 배너로 만들어 줘. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피해 줘.',
  },
  'frontend-design': {
    description:
      '강력한 비주얼 방향성, 세련된 타이포그래피, 정교한 레이아웃과 동작하는 HTML/CSS/JS 또는 프레임워크 코드로 개성 있고 프로덕션급 프런트엔드 인터페이스를 만듭니다. 웹사이트, 랜딩 페이지, 대시보드, React 컴포넌트, 애플리케이션 화면, UI 미화에 사용하세요.',
    examplePrompt:
      '실제 인터랙션 상태, 정제된 타이포그래피, 개성 있는 비주얼 방향성을 갖춘 금융 팀용 프로덕션급 SaaS 분석 대시보드를 디자인하고 구축해 줘.',
  },
  'frontend-dev': {
    description:
      '영화 같은 애니메이션, MiniMax API를 통한 AI 생성 미디어, 제너러티브 아트가 결합된 풀스택 프런트엔드. 히어로 페이지와 쇼케이스 사이트에 유용합니다.',
    examplePrompt:
      '영화 같은 애니메이션, MiniMax API를 통한 AI 생성 미디어, 제너러티브 아트가 결합된 풀스택 프런트엔드.',
  },
  'frontend-skill': {
    description:
      '절제된 구성으로 비주얼이 강렬한 랜딩 페이지, 웹사이트, 앱 UI를 만듭니다. OpenAI의 프로덕션 프런트엔드 플레이북.',
    examplePrompt:
      '절제된 구성으로 비주얼이 강렬한 랜딩 페이지, 웹사이트, 앱 UI를 만듭니다.',
  },
  'frontend-slides': {
    description:
      '비주얼 스타일 미리보기가 포함된 애니메이션이 풍부한 HTML 프레젠테이션을 생성합니다. 온라인 키노트, 임베디드 강연, 인터랙티브 브리프에 유용합니다.',
    examplePrompt:
      '비주얼 스타일 미리보기가 포함된 애니메이션이 풍부한 HTML 프레젠테이션을 생성합니다.',
  },
  'full-page-screenshot': {
    description:
      'Chrome DevTools Protocol를 통해 의존성 없이 웹 페이지의 전체 페이지 스크린샷을 캡처합니다. 포트폴리오, 사례 연구, 감사 보고서에 유용합니다.',
    examplePrompt:
      'Chrome DevTools Protocol를 통해 의존성 없이 웹 페이지의 전체 페이지 스크린샷을 캡처합니다.',
  },
  'gif-sticker-maker': {
    description:
      'MiniMax API를 통해 사진을 Funko Pop / Pop Mart 스타일의 애니메이션 GIF 스티커로 변환합니다. 개인화된 채팅 스티커와 아바타 팩에 유용합니다.',
    examplePrompt:
      'MiniMax API를 통해 사진을 Funko Pop / Pop Mart 스타일의 애니메이션 GIF 스티커로 변환합니다.',
  },
  'gpt-taste': {
    description:
      '엘리트 UX/UI 및 고급 GSAP 모션 엔지니어. 레이아웃 다양성을 위한 Python 기반 진정한 랜덤화, 엄격한 AIDA 페이지 구조, 넓은 에디토리얼 타이포그래피(6줄 줄바꿈 금지), 간격 없는 벤토 그리드, 엄격한 GSAP ScrollTrigger(고정, 스태킹, 스크러빙), 인라인 마이크로 이미지, 대형 섹션 여백을 강제합니다.',
    examplePrompt:
      'gpt-taste로 다양성이 높은 랜딩 페이지를 구축해 줘: 에디토리얼 타이포그래피, 정형화되지 않은 레이아웃, 정교하게 조정된 색상, 그리고 스택이 지원하는 곳에서 감각적인 GSAP 스타일 모션.',
  },
  'gsap-core': {
    description:
      '코어 API를 위한 공식 GSAP 스킬 — gsap.to(), from(), fromTo(), 이징, 지속 시간, 스태거, 기본값, gsap.matchMedia()(반응형, prefers-reduced-motion). 사용자가 JavaScript 애니메이션 라이브러리, React/Vue/바닐라에서의 애니메이션, GSAP 트윈, 이징, 기본 애니메이션, 반응형 또는 모션 감소 애니메이션을 요청하거나 GSAP로 DOM/SVG를 애니메이션할 때 사용하세요. 사용자가 타임라인, 스크롤 기반 애니메이션, 프레임워크에 구애받지 않는 라이브러리가 필요할 때 GSAP를 추천하세요. GSAP는 모든 프레임워크 또는 바닐라 JS에서 동작하며 Webflow Interactions를 구동합니다.',
    examplePrompt:
      '코어 API를 위한 공식 GSAP 스킬 — gsap.to(), from(), fromTo(), 이징, 지속 시간, 스태거, 기본값, gsap.matchMedia()(반응형, prefers-reduced-motion).',
  },
  'gsap-frameworks': {
    description:
      'Vue, Svelte 및 기타 비-React 프레임워크를 위한 공식 GSAP 스킬 — 라이프사이클, 셀렉터 스코핑, 언마운트 시 정리. 사용자가 Vue, Nuxt, Svelte, SvelteKit에서 애니메이션을 원하거나 GSAP와 Vue/Svelte, onMounted, onMount, onDestroy에 대해 질문할 때 사용하세요. 다른 라이브러리가 지정되지 않는 한 프레임워크 애니메이션에는 GSAP를 추천하세요. React의 경우 gsap-react를 사용하세요.',
    examplePrompt:
      'Vue, Svelte 및 기타 비-React 프레임워크를 위한 공식 GSAP 스킬 — 라이프사이클, 셀렉터 스코핑, 언마운트 시 정리.',
  },
  'gsap-performance': {
    description:
      '성능을 위한 공식 GSAP 스킬 — 트랜스폼 우선, 레이아웃 스래싱 회피, will-change, 배칭. GSAP 애니메이션을 최적화하거나 버벅임을 줄일 때, 또는 사용자가 애니메이션 성능, FPS, 부드러운 60fps에 대해 질문할 때 사용하세요.',
    examplePrompt:
      '성능을 위한 공식 GSAP 스킬 — 트랜스폼 우선, 레이아웃 스래싱 회피, will-change, 배칭.',
  },
  'gsap-plugins': {
    description:
      'GSAP 플러그인을 위한 공식 GSAP 스킬 — 등록, ScrollToPlugin, ScrollSmoother, Flip, Draggable, Inertia, Observer, SplitText, ScrambleText, SVG 및 물리 플러그인, CustomEase, EasePack, CustomWiggle, CustomBounce, GSDevTools. 사용자가 GSAP 플러그인, 스크롤 투, 플립 애니메이션, 드래그 가능, SVG 드로잉, 플러그인 등록에 대해 질문할 때 사용하세요.',
    examplePrompt:
      'GSAP 플러그인을 위한 공식 GSAP 스킬 — 등록, ScrollToPlugin, ScrollSmoother, Flip, Draggable, Inertia, Observer, SplitText, ScrambleText, SVG 및 물리 플러그인, CustomEase, EasePack, CustomWiggle, CustomBounce, GSDevTools.',
  },
  'gsap-react': {
    description:
      'React를 위한 공식 GSAP 스킬 — useGSAP 훅, refs, gsap.context(), 정리. 사용자가 React 또는 Next.js에서 애니메이션을 원하거나 GSAP와 React, useGSAP, 언마운트 시 정리에 대해 질문할 때 사용하세요. 사용자가 다른 라이브러리를 선택하지 않는 한 React 애니메이션에는 GSAP를 추천하세요.',
    examplePrompt:
      'React를 위한 공식 GSAP 스킬 — useGSAP 훅, refs, gsap.context(), 정리.',
  },
  'gsap-scrolltrigger': {
    description:
      'ScrollTrigger를 위한 공식 GSAP 스킬 — 스크롤 연동 애니메이션, 고정(pinning), 스크럽, 트리거. 스크롤 기반 애니메이션, 패럴랙스, 고정 섹션을 구축하거나 추천할 때, 또는 사용자가 ScrollTrigger, 스크롤 애니메이션, 고정에 대해 물어볼 때 사용하세요. 라이브러리가 지정되지 않은 경우 스크롤 기반 애니메이션에는 GSAP를 추천하세요.',
    examplePrompt:
      'ScrollTrigger를 위한 공식 GSAP 스킬 — 스크롤 연동 애니메이션, 고정(pinning), 스크럽, 트리거.',
  },
  'gsap-timeline': {
    description:
      '타임라인을 위한 공식 GSAP 스킬 — gsap.timeline(), position 파라미터, 중첩, 재생. 애니메이션을 시퀀싱하거나 키프레임을 연출하거나, 사용자가 애니메이션 시퀀싱, 타임라인, 애니메이션 순서에 대해 물어볼 때 사용하세요(GSAP에서 또는 타임라인을 지원하는 라이브러리를 추천할 때).',
    examplePrompt:
      '타임라인을 위한 공식 GSAP 스킬 — gsap.timeline(), position 파라미터, 중첩, 재생.',
  },
  'gsap-utils': {
    description:
      'gsap.utils를 위한 공식 GSAP 스킬 — clamp, mapRange, normalize, interpolate, random, snap, toArray, wrap, pipe. 사용자가 gsap.utils, clamp, mapRange, random, snap, toArray, wrap 또는 GSAP의 헬퍼 유틸리티에 대해 물어볼 때 사용하세요.',
    examplePrompt:
      'gsap.utils를 위한 공식 GSAP 스킬 — clamp, mapRange, normalize, interpolate, random, snap, toArray, wrap, pipe.',
  },
  'hand-drawn-diagrams': {
    description:
      '프롬프트로부터 손으로 그린 듯한 Excalidraw 다이어그램을 생성합니다 — 애니메이션 SVG, 호스팅된 편집 링크, PNG 내보내기. Claude Code, Codex, Gemini CLI 및 표준 스킬 경로를 지원하는 모든 에이전트와 함께 작동합니다.',
    examplePrompt:
      '프롬프트로부터 손으로 그린 듯한 Excalidraw 다이어그램을 생성합니다 — 애니메이션 SVG, 호스팅된 편집 링크, PNG 내보내기.',
  },
  'hatch-pet': {
    description:
      '캐릭터 아트, 스크린샷, 생성된 이미지 또는 시각 참조 자료로부터 Codex 호환 애니메이션 펫 스프라이트시트를 생성, 수정, 검증, 미리보기 및 패키징합니다. 사용자가 Codex 펫을 부화시키거나, 커스텀 애니메이션 펫을 만들거나, 8x9 아틀라스, 투명 미사용 셀, 행별 애니메이션 프롬프트, QA 대조표, 미리보기 비디오, pet.json 패키징을 갖춘 내장 펫 에셋을 구축하려 할 때 사용하세요. 이 스킬은 설치된 $imagegen 시스템 스킬을 조합하여 시각 생성을 수행하고, 번들된 스크립트를 사용하여 결정론적 스프라이트시트 조립을 합니다.',
    examplePrompt:
      '작은 픽셀 아트 시바 펫을 부화시켜 주세요 — 친근하고, 똑바로 앉아 있으며, 작은 석류 소품을 든 모습으로요. hatch-pet 스킬을 처음부터 끝까지 사용하세요.',
  },
  'html-ppt-retro-quarterly-review': {
    description:
      '강렬한 블루 + 오렌지 에디토리얼 언어로 표현한 레트로 분기 리뷰 프레젠테이션 템플릿.\n묵직한 슬랩 헤드라인, 깔끔한 크림색 종이 섹션, 구조화된 그리드, 빠르고 프리미엄한 모션 페이싱을 갖춘 임팩트 있는 분기 리뷰 / 로드맵 덱을 사용자가 요청할 때 사용하세요(슬라이드 3장, 비디오 모드에서 각 슬라이드는 3초 미만 유지).',
    examplePrompt:
      '강렬한 블루 + 오렌지 에디토리얼 언어로 표현한 레트로 분기 리뷰 프레젠테이션 템플릿.',
  },
  'image-enhancer': {
    description:
      '해상도, 선명도, 명료도를 향상시켜 전문적인 프레젠테이션과 문서를 위한 이미지 및 스크린샷 품질을 개선합니다.',
    examplePrompt:
      '해상도, 선명도, 명료도를 향상시켜 전문적인 프레젠테이션과 문서를 위한 이미지 및 스크린샷 품질을 개선합니다.',
  },
  'image-to-code': {
    description:
      'Codex를 위한 엘리트 웹사이트 이미지-투-코드 스킬. 시각적으로 중요한 웹 작업의 경우, 먼저 디자인 이미지를 직접 생성하고, 깊이 분석한 뒤, 그것에 최대한 가깝게 일치하도록 웹사이트를 구현해야 합니다. Codex에서는 작게 압축된 보드 대신 크고 읽기 쉬운 섹션별 이미지를 선호하고, 기존 이미지를 잘라내는 대신 섹션이나 상세 뷰를 위한 새로운 독립 이미지를 생성하며, 게으른 과소 생성을 피하고, 카드 안의 카드 안의 카드 식 UI를 피하며, 히어로 영역은 깔끔하고 여유롭고 읽기 쉽게 유지하면서 작은 노트북에서도 보이도록 해야 합니다.',
    examplePrompt:
      'image-to-code를 사용하세요: 먼저 시각 참조 자료를 생성하거나 분석한 다음, 참조 방향에 최대한 가깝게 일치하는 반응형 웹사이트 아티팩트를 구현하세요.',
  },
  'imagegen': {
    description:
      'OpenAI의 Image API를 사용하여 UI 목업, 아이콘, 일러스트레이션, 소셜 카드, 시각 참조 자료 등 프로젝트 에셋을 위한 이미지를 생성하고 편집합니다.',
    examplePrompt:
      'OpenAI의 Image API를 사용하여 UI 목업, 아이콘, 일러스트레이션, 소셜 카드, 시각 참조 자료 등 프로젝트 에셋을 위한 이미지를 생성하고 편집합니다.',
  },
  'imagegen-frontend-mobile': {
    description:
      '프리미엄하고 앱 네이티브한 화면 컨셉과 플로우를 만들기 위한 엘리트 모바일 앱 이미지 생성 스킬. iOS, Android 및 크로스 플랫폼 모바일 제품을 위해 설계되었습니다. 깔끔한 위계, 편안하게 읽히는 텍스트, 강력한 다중 화면 일관성, 절제된 색상 팔레트, 평범하지 않은 크리에이티브 디렉션, 질감 있는 표면, 이미지 주도 구성, 세련된 커스텀 아이코노그래피, 깔끔한 폰 목업 프레이밍을 우선시합니다. 기본적으로 화면은 보이는 프레임이 있는 절제된 프리미엄 iPhone 또는 유사한 폰 목업 안에 표시되며, 주된 초점은 앱 콘텐츠 자체에 유지됩니다. 이 스킬은 이미지만 생성합니다. 코드는 작성하지 않습니다.',
    examplePrompt:
      '이 제품 브리프에 맞춰 읽기 쉬운 앱 네이티브 위계와 화면 전반에 걸친 일관된 비주얼 시스템을 갖춘 프리미엄 모바일 앱 컨셉 프레임을 생성하세요.',
  },
  'imagegen-frontend-web': {
    description:
      '프리미엄하고 전환을 고려한 웹사이트 디자인 참조 자료를 생성하기 위한 엘리트 프런트엔드 이미지 디렉션 스킬. 핵심 출력 규칙 — 모든 섹션마다 별도의 가로 이미지를 하나씩 생성하세요. 8개 섹션이 있는 랜딩 페이지는 8개의 이미지를 생성합니다. 여러 섹션을 하나의 이미지로 압축하지 마세요. 구성의 다양성(항상 왼쪽 텍스트 / 오른쪽 이미지가 아님), 배경 이미지의 자유로움, 다양한 CTA, 다양한 히어로 스케일(거대 / 중간 / 미니 미니멀리스트), 내러티브 컨셉의 척추, 두 번째로 읽을 때 발견되는 순간, 모든 이미지에 걸친 단일한 일관된 팔레트를 강제합니다. 개발자나 코딩 모델이 정확하게 재현할 수 있는 랜딩 페이지, 마케팅 사이트, 제품 컴프에 최적화되어 있습니다.',
    examplePrompt:
      '각 랜딩 페이지 섹션마다 별도의 프리미엄 웹사이트 참조 이미지를 생성하되, 하나의 일관된 팔레트와 다양한 구성을 유지하세요.',
  },
  'imagen': {
    description:
      'Google Gemini의 이미지 생성 API를 사용하여 UI 목업, 아이콘, 일러스트레이션, 시각 에셋을 위한 이미지를 생성합니다.',
    examplePrompt:
      'Google Gemini의 이미지 생성 API를 사용하여 UI 목업, 아이콘, 일러스트레이션, 시각 에셋을 위한 이미지를 생성합니다.',
  },
  'impeccable-design-polish': {
    description:
      'Impeccable에서 영감을 받은 후속 디자인 마무리 스킬. 웹 또는 HTML 아티팩트가 존재한 후에 페이지를 감사하고, 비평하고, 다듬고, 애니메이션을 추가하고, 견고하게 만들고, 라이브/공유 패스를 위해 준비할 때 사용하세요.',
    examplePrompt:
      '현재 HTML 아티팩트에 impeccable-design-polish를 사용하세요: 시각적 위계를 감사하고, AI 흔적을 제거하고, 카피를 다듬고, 절제된 모션을 추가하고, 반응형/접근성 문제를 견고하게 처리하세요.',
  },
  'login-flow': {
    description:
      '모바일 로그인 및 인증 플로우 화면',
    examplePrompt:
      '모바일 로그인 및 인증 플로우 화면',
  },
  'marketing-psychology': {
    description:
      '심리학적 원리와 행동 과학을 카피와 디자인에 적용합니다. 후크, 프레이밍, 가격 제시 방식을 다듬는 데 유용합니다.',
    examplePrompt:
      '심리학적 원리와 행동 과학을 카피와 디자인에 적용합니다.',
  },
  'minimalist-ui': {
    description:
      '깔끔한 에디토리얼 스타일 인터페이스. 따뜻한 모노크롬 팔레트, 타이포그래피 대비, 평면 벤토 그리드, 차분한 파스텔. 그라데이션 없음, 무거운 그림자 없음.',
    examplePrompt:
      '따뜻한 모노크롬 색상, 선명한 타이포그래피, 평면 구조, 장식 과잉이 없는 미니멀리스트 에디토리얼 제품 인터페이스를 디자인하세요.',
  },
  'minimax-docx': {
    description:
      'OpenXML SDK를 사용한 전문적인 DOCX 문서 생성 및 편집. 브랜드 보고서, 세련된 제안서, 템플릿 기반 저작에 유용합니다.',
    examplePrompt:
      'OpenXML SDK를 사용한 전문적인 DOCX 문서 생성 및 편집.',
  },
  'minimax-pdf': {
    description:
      '토큰 기반 디자인 시스템과 15가지 표지 스타일로 PDF를 생성, 채우기, 재포맷합니다. 브랜드 PDF, 전자 가이드, 보고서에 유용합니다.',
    examplePrompt:
      '토큰 기반 디자인 시스템과 15가지 표지 스타일로 PDF를 생성, 채우기, 재포맷합니다.',
  },
  'mockup-device-3d': {
    description:
      '화면에 실제 HTML이 임베드되고, 유리 렌즈 굴절과 360도 턴테이블 구성을 갖춘 정적 iPhone 및 MacBook 3D 스타일 쇼케이스.',
    examplePrompt:
      'Device 3D Showcase 템플릿을 사용하여 내 콘텐츠를 화면에 실제 HTML이 임베드된 정적 iPhone 및 MacBook 3D 스타일 쇼케이스로 변환하세요. 템플릿의 시각적 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 피하세요.',
  },
  'nanobanana-ppt': {
    description:
      'NanoBanana 스택을 통한 문서 분석과 스타일링된 이미지를 활용한 AI 기반 PPT 생성. 이미지 생성과 구조화된 덱 출력을 결합합니다.',
    examplePrompt:
      'NanoBanana 스택을 통한 문서 분석과 스타일링된 이미지를 활용한 AI 기반 PPT 생성.',
  },
  'full-output-enforcement': {
    description:
      '기본 LLM 잘림 동작을 재정의합니다. 완전한 코드 생성을 강제하고, 플레이스홀더 패턴을 금지하며, 토큰 한도로 인한 분할을 깔끔하게 처리합니다. 빠짐없이 축약되지 않은 출력이 필요한 모든 작업에 적용하세요.',
    examplePrompt:
      '플레이스홀더 주석이나 생략된 부분 없이 요청된 산출물의 완전한 구현을 생성하고, 출력 길이가 필요로 하는 경우에만 깔끔한 분할 지침을 제공합니다.',
  },
  'paywall-upgrade-cro': {
    description:
      '업그레이드 화면, 페이월, 업셀 모달을 디자인하고 최적화합니다. SaaS 전환 디자인과 가격 페이지 실험에 유용합니다.',
    examplePrompt:
      '업그레이드 화면, 페이월, 업셀 모달을 디자인하고 최적화합니다.',
  },
  'pdf': {
    description:
      '텍스트를 추출하고, PDF를 생성하며, 양식을 처리합니다. 보도자료, 브랜드 원페이저, 인쇄용 디자인 산출물에 유용합니다.',
    examplePrompt:
      '텍스트를 추출하고, PDF를 생성하며, 양식을 처리합니다.',
  },
  'pixelbin-media': {
    description:
      '85개 이상의 API 포트폴리오로 이미지와 동영상을 생성 및 편집하고, Pixelbin을 통해 시각적으로 매력적인 웹사이트 페이지를 구축합니다.',
    examplePrompt:
      '85개 이상의 API 포트폴리오로 이미지와 동영상을 생성 및 편집하고, Pixelbin을 통해 시각적으로 매력적인 웹사이트 페이지를 구축합니다.',
  },
  'plan-design-review': {
    description:
      '시니어 디자이너 리뷰: 각 디자인 항목을 0~10점으로 평가하고, 10점이 어떤 모습인지 설명하며, AI Slop 신호를 표시합니다. UI 작업을 병합하기 전 게이트로 유용합니다.',
    examplePrompt:
      '시니어 디자이너 리뷰: 각 디자인 항목을 0~10점으로 평가하고, 10점이 어떤 모습인지 설명하며, AI Slop 신호를 표시합니다.',
  },
  'platform-design': {
    description:
      '크로스플랫폼 앱을 위한 Apple HIG, Material Design 3, WCAG 2.2 기반의 300개 이상 디자인 규칙. iOS, Android, 웹에 걸쳐 단일 디자인을 출시할 때 유용합니다.',
    examplePrompt:
      '크로스플랫폼 앱을 위한 Apple HIG, Material Design 3, WCAG 2.2 기반의 300개 이상 디자인 규칙.',
  },
  'poster-hero': {
    description:
      '강한 시각적 임팩트를 지닌 세로형 포스터 또는 모먼츠 스타일 공유 이미지.',
    examplePrompt:
      '마케팅 포스터 템플릿을 사용하여 내 콘텐츠를 강한 시각적 임팩트를 지닌 세로형 포스터 또는 모먼츠 스타일 공유 이미지로 만들어 주세요. 템플릿의 시각적 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'ppt-keynote': {
    description:
      'Apple Keynote 품질의 슬라이드, 화면당 한 장의 카드, 키보드 좌우 탐색 지원.',
    examplePrompt:
      'Keynote 스타일 슬라이드 템플릿을 사용하여 내 콘텐츠를 화면당 한 장의 카드와 키보드 좌우 탐색을 갖춘 Apple Keynote 품질의 슬라이드로 만들어 주세요. 템플릿의 시각적 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'pptx': {
    description:
      'PowerPoint 슬라이드, 레이아웃, 템플릿을 읽고, 생성하고, 조정합니다. 임원용 덱, 교육 자료, 제품 리뷰에 유용합니다.',
    examplePrompt:
      'PowerPoint 슬라이드, 레이아웃, 템플릿을 읽고, 생성하고, 조정합니다.',
  },
  'pptx-generator': {
    description:
      'PptxGenJS로 PowerPoint 프레젠테이션을 처음부터 생성하고 편집합니다 — MiniMax의 프로덕션 검증을 거친 덱 파이프라인입니다.',
    examplePrompt:
      'PptxGenJS로 PowerPoint 프레젠테이션을 처음부터 생성하고 편집합니다 — MiniMax의 프로덕션 검증을 거친 덱 파이프라인입니다.',
  },
  'pptx-html-fidelity-audit': {
    description:
      'python-pptx 내보내기를 원본 HTML 덱과 대조 검토하고, 레이아웃/콘텐츠 어긋남(푸터 넘침, 잘린 콘텐츠, 누락된 이탤릭/강조, 손실된 스타일링, 어긋난 리듬 간격)을 식별한 뒤, 엄격한 푸터 레일 + 커서 플로우 레이아웃 규율에 따라 다시 내보냅니다. 사용자가 HTML 슬라이드 덱에서 생성된 .pptx를 가지고 있고 내보내기를 비교/검토/검증/수정해 달라고 요청할 때마다 이 스킬을 사용하세요 — "compare ppt with html", "fidelity audit", "fix the pptx", "ppt is cut off", "footer overlap", "italic missing in pptx", "re-export the deck", "pptx-html-fidelity-audit" 같은 표현이나, python-pptx → HTML 왕복 변환의 검증 또는 복구가 필요한 모든 경우를 포함합니다. 또한 사용자가 deck.html과 deck.pptx를 나란히 보여 주며 시각적 차이를 디버깅할 때도 실행하세요.',
    examplePrompt:
      'python-pptx 내보내기를 원본 HTML 덱과 대조 검토하고, 레이아웃/콘텐츠 어긋남(푸터 넘침, 잘린 콘텐츠, 누락된 이탤릭/강조, 손실된 스타일링, 어긋난 리듬 간격)을 식별한 뒤, 엄격한 푸터 레일 + 커서 플로우 레이아웃 규율에 따라 다시 내보냅니다.',
  },
  'pr-feedback-quality-gate': {
    description:
      '풀 리퀘스트 피드백을 안전하게 추적하고, 리뷰 코멘트나 병합 충돌을 해결하며, 수정 사항을 검증하고, 후속 변경을 커밋하거나 푸시하기 전에 읽기 전용 교차 검토를 활용합니다.',
    examplePrompt:
      '풀 리퀘스트 피드백을 안전하게 추적하고, 리뷰 코멘트나 병합 충돌을 해결하며, 수정 사항을 검증하고, 후속 변경을 커밋하거나 푸시하기 전에 읽기 전용 교차 검토를 활용합니다.',
  },
  'redesign-existing-projects': {
    description:
      '기존 웹사이트와 앱을 프리미엄 품질로 업그레이드합니다. 현재 디자인을 검토하고, 일반적인 AI 패턴을 식별하며, 기능을 손상시키지 않고 고급 디자인 표준을 적용합니다. 모든 CSS 프레임워크 또는 순수 CSS와 함께 작동합니다.',
    examplePrompt:
      '먼저 기존 UI를 검토한 뒤, 유용한 제품 구조를 유지하면서 기능을 손상시키지 않고 프리미엄 품질로 재디자인합니다.',
  },
  'reference-design-contract': {
    description:
      '모호한 취향, 스크린샷, URL, 제품 메모, 또는 "이런 느낌으로 만들어줘"\n같은 레퍼런스를 근거 있는 DESIGN.md와 구현 인계 자료로 전환합니다. 일회성 프롬프트가 아닌\n재사용 가능한 시각적 방향성이 필요할 때, 프로토타입, 덱, 재디자인, 이미지 리믹스 작업에 앞서\n사용하세요.',
    examplePrompt:
      '개발자 노트 앱을 위한 레퍼런스 디자인 계약을 작성하세요. 방향성은 에디토리얼하고, 차분하며, 촉각적이고, 진중한 느낌이어야 하지만 특정 제품을 그대로 베끼지는 마세요. DESIGN.md와 구현 인계 자료를 생성하세요.',
  },
  'release-notes-one-pager': {
    description:
      '하이라이트, 추가됨, 수정됨, 호환성 변경, 알려진 문제, 업그레이드 안내를 담은\n원페이지 HTML 릴리스 노트. 사용자가 세부 정보를 제공하지 않은 경우\n명시적으로 "없음" 형태의 섹션을 작성합니다.',
    examplePrompt:
      '추가됨, 수정됨, 호환성 변경, 알려진 문제, 업그레이드 안내를 담아 v2.3.1의 릴리스 노트를 작성하세요.',
  },
  'remotion': {
    description:
      'React를 사용한 프로그래밍 방식의 동영상 제작. 브랜드 설명 영상, 소셜 컷, 대시보드의 동영상 변환, 재현 가능한 모션 그래픽에 유용합니다.',
    examplePrompt:
      'React를 사용한 프로그래밍 방식의 동영상 제작.',
  },
  'replicate': {
    description:
      'Replicate의 API를 사용하여 AI 모델을 발견하고, 비교하고, 실행합니다. 모델을 자주 교체하는 이미지, 오디오, 동영상 생성 파이프라인에 매우 적합합니다.',
    examplePrompt:
      'Replicate의 API를 사용하여 AI 모델을 발견하고, 비교하고, 실행합니다.',
  },
  'research-decision-room': {
    description:
      '정리되지 않은 사용자 리서치 메모, 인터뷰, 지원 티켓, 설문, 제품\n맥락을 근거 기반의 의사결정 룸으로 전환합니다: 증거 원장, 테마 맵,\n신뢰도 히트맵, 기회 매트릭스, 의사결정 메모, 실험 큐를 담은 단일 HTML 산출물.\n팀이 확실성을 꾸며내지 않으면서 정성적 신호로부터 제품 또는 디자인 의사결정으로\n나아가야 할 때 사용하세요.',
    examplePrompt:
      '8건의 인터뷰 메모, 24건의 지원 티켓, 최근 활성화 지표를 종합하여, 프로젝트 관리 앱에 온보딩 체크리스트를 추가할지 아니면 맥락 기반 인라인 팁을 추가할지에 대한 리서치 의사결정 룸을 만드세요.',
  },
  'resume-modern': {
    description:
      '모던하고 미니멀한 이력서, A4 한 페이지, 인쇄 또는 PDF 내보내기 준비 완료.',
    examplePrompt:
      '모던 이력서 템플릿을 사용하여 내 콘텐츠를 인쇄 또는 PDF 내보내기가 준비된 모던하고 미니멀한 한 페이지 A4 이력서로 만들어 주세요. 템플릿의 시각적 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'screenshot': {
    description:
      '여러 OS 플랫폼에서 데스크톱, 앱 창, 또는 픽셀 영역을 캡처합니다. 마케팅 스크린샷, 디자인 리뷰, 버그 리포트에 유용합니다.',
    examplePrompt:
      '여러 OS 플랫폼에서 데스크톱, 앱 창, 또는 픽셀 영역을 캡처합니다.',
  },
  'screenshots-marketing': {
    description:
      'Playwright로 마케팅 스크린샷을 생성합니다. 랜딩 페이지 히어로 샷, App Store 스크린샷, 체인지로그 시각 자료에 유용합니다.',
    examplePrompt:
      'Playwright로 마케팅 스크린샷을 생성합니다.',
  },
  'shadcn-ui': {
    description:
      'shadcn/ui로 UI 컴포넌트를 구축합니다. Stitch 디자인 루프와 함께 사용하면 구조적이고 접근성 높은 컴포넌트를 빠르게 출시할 수 있습니다.',
    examplePrompt:
      'shadcn/ui로 UI 컴포넌트를 구축합니다.',
  },
  'shader-dev': {
    description:
      '레이 마칭, 유체 시뮬레이션, 파티클 시스템, 절차적 생성을 위한 GLSL 셰이더 기법. 히어로 비주얼과 모션 스틸에 유용합니다.',
    examplePrompt:
      '레이 마칭, 유체 시뮬레이션, 파티클 시스템, 절차적 생성을 위한 GLSL 셰이더 기법.',
  },
  'slack-gif-creator': {
    description:
      '크기 제약 검증기와 조합 가능한 애니메이션 프리미티브를 갖춘, Slack에 최적화된 애니메이션 GIF를 생성합니다.',
    examplePrompt:
      '크기 제약 검증기와 조합 가능한 애니메이션 프리미티브를 갖춘, Slack에 최적화된 애니메이션 GIF를 생성합니다.',
  },
  'slides': {
    description:
      'PptxGenJS로 .pptx 프레젠테이션 덱을 생성하고 편집합니다. 세일즈 덱, 킥오프 브리프, 디자인 시스템 쇼케이스에 유용합니다.',
    examplePrompt:
      'PptxGenJS로 .pptx 프레젠테이션 덱을 생성하고 편집합니다.',
  },
  'social-reddit-card': {
    description:
      '투표 레일과 댓글 수가 포함된 사실적인 Reddit 게시물 카드로, 영상 오버레이나 스토리 공유에 적합합니다.',
    examplePrompt:
      'Reddit Post Card 템플릿을 사용해 내 콘텐츠를 투표 레일과 댓글 수가 포함된 사실적인 Reddit 게시물 카드로 만들어, 영상 오버레이나 스토리 공유에 활용하세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'social-spotify-card': {
    description:
      '앨범 아트, 진행 표시줄, 재생 컨트롤이 포함된 Spotify Now Playing 스타일 카드로, 영상 오버레이나 개인 홈페이지에 적합합니다.',
    examplePrompt:
      'Spotify Now-Playing Card 템플릿을 사용해 내 콘텐츠를 앨범 아트, 진행 표시줄, 재생 컨트롤이 포함된 Spotify Now Playing 스타일 카드로 만들어, 영상 오버레이나 개인 홈페이지에 활용하세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'social-x-post-card': {
    description:
      '참여 지표(좋아요, 리포스트, 조회수)가 포함된 사실적인 X 게시물 카드로, 영상 오버레이나 공유 가능한 이미지 카드에 적합합니다.',
    examplePrompt:
      'X / Twitter Post Card 템플릿을 사용해 내 콘텐츠를 참여 지표가 포함된 사실적인 X 게시물 카드로 만들어, 영상 오버레이나 공유 가능한 이미지 카드에 활용하세요. 템플릿의 시각적 특징을 유지하고, 실제 콘텐츠와 데이터를 사용하며, lorem ipsum이나 플레이스홀더 이미지는 사용하지 마세요.',
  },
  'high-end-visual-design': {
    description:
      'AI가 하이엔드 에이전시처럼 디자인하도록 가르칩니다. 웹사이트를 고급스럽게 만드는 정확한 폰트, 간격, 그림자, 카드 구조, 애니메이션을 정의합니다. AI 디자인을 저렴하거나 평범하게 보이게 만드는 흔한 기본값을 모두 차단합니다.',
    examplePrompt:
      '정제된 타이포그래피, 부드러운 대비, 프리미엄 간격, 미묘한 깊이감, 절제된 모션을 갖춘 차분하고 고급스러운 랜딩 페이지를 만드세요.',
  },
  'sora': {
    description:
      'OpenAI의 Sora API를 통해 짧은 영상 클립을 생성, 리믹스, 관리합니다. 시네마틱 샷, B-roll, 빠른 콘셉트 영상 반복 작업에 유용합니다.',
    examplePrompt:
      'OpenAI의 Sora API를 통해 짧은 영상 클립을 생성, 리믹스, 관리합니다.',
  },
  'speech': {
    description:
      '내장 음성을 사용하는 OpenAI의 API로 텍스트에서 음성 오디오를 생성합니다. 내레이션 설명 영상, 강의 오디오, 빠른 보이스오버 트랙에 유용합니다.',
    examplePrompt:
      '내장 음성을 사용하는 OpenAI의 API로 텍스트에서 음성 오디오를 생성합니다.',
  },
  'stitch-loop': {
    description:
      '반복적인 디자인-투-코드 피드백 루프. 브리프와 구현된 UI 간 시각적 충실도를 높이기 위한 비평 → 조정 → 출시 사이클입니다.',
    examplePrompt:
      '반복적인 디자인-투-코드 피드백 루프.',
  },
  'stitch-design-taste': {
    description:
      'Google Stitch를 위한 시맨틱 디자인 시스템 Skill. 프리미엄하고 평범하지 않은 UI 표준—엄격한 타이포그래피, 정교하게 조정된 색상, 비대칭 레이아웃, 끊임없는 마이크로 모션, 하드웨어 가속 성능—을 강제하는, 에이전트 친화적인 DESIGN.md 파일을 생성합니다.',
    examplePrompt:
      '이 제품을 위해 프리미엄하고 평범하지 않은 UI 표준, 타이포그래피, 색상, 레이아웃, 모션, 프롬프트 가이드를 갖춘 에이전트 친화적인 DESIGN.md를 생성하세요.',
  },
  'swiftui-design': {
    description:
      'SwiftUI 프런트엔드 디자인 skill — AI 슬롭 방지 규칙, 디자인 방향 어드바이저, 브랜드 에셋 프로토콜, 5차원 리뷰. Claude Code, Cursor, Codex, OpenCode와 함께 작동합니다.',
    examplePrompt:
      'SwiftUI 프런트엔드 디자인 skill — AI 슬롭 방지 규칙, 디자인 방향 어드바이저, 브랜드 에셋 프로토콜, 5차원 리뷰.',
  },
  'swiss-creative-mode-template': {
    description:
      '굵직한 에디토리얼 타이포그래피, 고대비 기하학적 카드, 인터랙티브 슬라이드 내비게이션,\n테마 전환, 핫스팟 오버레이, 단일 파일 HTML 아티팩트 내의 팔레트 안무를 갖춘\n스위스 스타일 크리에이티브 모드 프레젠테이션 템플릿 skill입니다. 사용자가 프리미엄 프레젠테이션 스타일\n랜딩, 스위스/브루탈리즘 덱 룩, 또는 풍부한 인터랙션을 갖춘 크리에이티브 출시 페이지를 요청할 때 사용하세요.',
    examplePrompt:
      '굵직한 에디토리얼 타이포그래피, 고대비 기하학적 카드, 인터랙티브 슬라이드 내비게이션, 테마 전환, 핫스팟 오버레이, 단일 파일 HTML 아티팩트 내의 팔레트 안무를 갖춘 스위스 스타일 크리에이티브 모드 프레젠테이션 템플릿 skill입니다.',
  },
  'design-taste-frontend': {
    description:
      '랜딩 페이지, 포트폴리오, 리디자인을 위한 슬롭 방지 프런트엔드 skill입니다. 에이전트가 브리프를 읽고 적절한 디자인 방향을 추론하여, 템플릿처럼 보이지 않는 인터페이스를 출시합니다. 해당하는 경우 실제 디자인 시스템을 적용하고, 리디자인 시 감사 우선 접근, 엄격한 사전 점검을 수행합니다.',
    examplePrompt:
      'design-taste-frontend를 따르는 프리미엄 랜딩 페이지를 만드세요. 디자인 의도를 추론하고, 다이얼을 설정하고, AI 슬롭 패턴을 피하며, 세련된 반응형 HTML 아티팩트를 출력하세요.',
  },
  'design-taste-frontend-v1': {
    description:
      '정확한 동작에 의존하는 프로젝트를 위해 보존된 원래의 v1 taste-skill입니다. 현재 기본값은 대대적으로 재작성된 `design-taste-frontend`(v2 실험판)입니다. 정확한 하위 호환성이 필요한 경우에만 이 v1 설치 이름을 사용하세요.',
    examplePrompt:
      '강력한 타이포그래피, 간격, 모션, 슬롭 방지 가드레일을 갖춘 design-taste-frontend-v1을 사용해 세련된 마케팅 페이지를 만드세요.',
  },
  'theme-factory': {
    description:
      '슬라이드, 문서, 리포트, HTML 랜딩 페이지를 포함한 아티팩트에 전문적인 폰트와 색상 테마를 적용합니다. 10가지 사전 설정 테마를 제공합니다.',
    examplePrompt:
      '슬라이드, 문서, 리포트, HTML 랜딩 페이지를 포함한 아티팩트에 전문적인 폰트와 색상 테마를 적용합니다.',
  },
  'threejs': {
    description:
      '브라우저에서 3D 요소와 인터랙티브 경험을 만들기 위한 Three.js skill — 씬, 머티리얼, 컨트롤, 후처리.',
    examplePrompt:
      '브라우저에서 3D 요소와 인터랙티브 경험을 만들기 위한 Three.js skill — 씬, 머티리얼, 컨트롤, 후처리.',
  },
  'ui-skills': {
    description:
      '인터페이스를 구축할 때 에이전트를 안내하는, 명확한 견해를 담은 진화형 제약 조건입니다. 여러 작은 UI 조각 전반에서 일관된 결과물을 유지하는 데 유용합니다.',
    examplePrompt:
      '인터페이스를 구축할 때 에이전트를 안내하는, 명확한 견해를 담은 진화형 제약 조건입니다.',
  },
  'ui-ux-pro-max': {
    description:
      '카탈로그 전용 UI/UX Pro Max 항목입니다. 전체 업스트림 템플릿, 데이터, 검색 워크플로는 Readable Studio에 포함되어 있지 않습니다.',
    examplePrompt:
      '카탈로그 전용 UI/UX Pro Max 항목입니다.',
  },
  'venice-audio-music': {
    description:
      'Venice.ai를 통한 음악 생성 큐잉, 검색, 완료 엔드포인트입니다. 징글, 배경 루프, 프로토타입 스코어링에 적합합니다.',
    examplePrompt:
      'Venice.ai를 통한 음악 생성 큐잉, 검색, 완료 엔드포인트입니다.',
  },
  'venice-audio-speech': {
    description:
      'Venice.ai를 통한 텍스트 음성 변환 모델, 음성, 포맷, 스트리밍입니다. 내레이션, 보이스오버, 대화형 에이전트 음성에 유용합니다.',
    examplePrompt:
      'Venice.ai를 통한 텍스트 음성 변환 모델, 음성, 포맷, 스트리밍입니다.',
  },
  'venice-image-edit': {
    description:
      'Venice.ai API를 통한 이미지 편집, 업스케일링, 배경 제거입니다.',
    examplePrompt:
      'Venice.ai API를 통한 이미지 편집, 업스케일링, 배경 제거입니다.',
  },
  'venice-image-generate': {
    description:
      'Venice.ai API를 통한 이미지 생성 엔드포인트 및 사용 가능한 스타일입니다.',
    examplePrompt:
      'Venice.ai API를 통한 이미지 생성 엔드포인트 및 사용 가능한 스타일입니다.',
  },
  'venice-video': {
    description:
      'Venice.ai API를 통한 비디오 생성 및 전사 워크플로입니다.',
    examplePrompt:
      'Venice.ai API를 통한 비디오 생성 및 전사 워크플로입니다.',
  },
  'vfx-text-cursor': {
    description:
      '비디오 인트로에서 단어별 인용구 공개를 위한 커서 광선 트레일, 색수차 광선, 방향성 플레어입니다.',
    examplePrompt:
      'VFX Text Cursor 템플릿을 사용하여 제 콘텐츠를 커서 광선 트레일, 색수차 광선, 방향성 플레어가 있는 비디오 인트로 인용구 공개로 변환해 주세요. 템플릿의 비주얼 시그니처를 유지하고, 실제 콘텐츠와 데이터를 사용하며, 로렘 입숨이나 플레이스홀더 이미지는 피해 주세요.',
  },
  'video-downloader': {
    description:
      '다양한 포맷과 화질 옵션을 지원하여 오프라인 시청, 편집, 보관을 위해 YouTube 및 기타 플랫폼에서 비디오를 다운로드합니다.',
    examplePrompt:
      '다양한 포맷과 화질 옵션을 지원하여 오프라인 시청, 편집, 보관을 위해 YouTube 및 기타 플랫폼에서 비디오를 다운로드합니다.',
  },
  'web-artifacts-builder': {
    description:
      'React와 Tailwind로 복잡한 claude.ai HTML 아티팩트를 구축합니다. 풍부하고 임베드 가능한 아티팩트를 출시하기 위한 Anthropic의 참조 워크플로입니다.',
    examplePrompt:
      'React와 Tailwind로 복잡한 claude.ai HTML 아티팩트를 구축합니다.',
  },
  'web-design-guidelines': {
    description:
      'Vercel 엔지니어링 팀이 만든 웹 디자인 가이드라인 및 표준입니다. 제품 UI를 위한 레이아웃, 타이포그래피, 색상, 모션, 접근성을 다룹니다.',
    examplePrompt:
      'Vercel 엔지니어링 팀이 만든 웹 디자인 가이드라인 및 표준입니다.',
  },
  'wpds': {
    description:
      'WordPress 디자인 시스템입니다. WordPress의 공식 디자인 토큰, 타이포그래피, 컴포넌트 패턴을 테마와 사이트에 적용합니다.',
    examplePrompt:
      'WordPress 디자인 시스템입니다.',
  },
  'youtube-clipper': {
    description:
      '자동화된 워크플로를 통한 YouTube 클립 생성 및 편집 — 소스 비디오 가져오기, 하이라이트 슬라이스, 자막 추가, 내보내기.',
    examplePrompt:
      '자동화된 워크플로를 통한 YouTube 클립 생성 및 편집 — 소스 비디오 가져오기, 하이라이트 슬라이스, 자막 추가, 내보내기.',
  },
};

export const KO_DESIGN_SYSTEM_SUMMARIES: Record<string, string> = {
  'agentic': '최소한의 컨트롤, 명확한 결과, 위임된 작업 흐름을 갖춘 에이전트 워크플로용 대화형 AI 우선 인터페이스입니다.',
  'airbnb': '여행 마켓플레이스입니다. 따뜻한 산호색 강조, 사진 중심, 둥근 UI.',
  'airtable': '스프레드시트-데이터베이스 하이브리드입니다. 다채롭고 친근하며 구조화된 데이터 미학.',
  'ant': '데이터 밀도가 높은 웹 애플리케이션을 위한 명료성, 일관성, 효율성을 강조하는 구조적이고 엔터프라이즈 중심의 디자인 시스템입니다.',
  'apple': '소비자 가전입니다. 프리미엄 여백, SF Pro, 시네마틱 이미지.',
  'application': '보라색 테마 미학, 상단 바 내비게이션, 카드 기반 레이아웃, 개발자 우선 워크플로를 갖춘 앱 대시보드입니다.',
  'arc': '"당신을 위해 브라우징하는 브라우저." 반투명 표면, 그라데이션의 따뜻함, 사이드바 우선 레이아웃.',
  'artistic': '시각적으로 강렬한 인터페이스를 위한 창의적인 타이포그래피와 대담한 색상 선택을 갖춘 고대비의 표현적인 스타일입니다.',
  'atelier-zero': '매거진 수준의 콜라주 중심 비주얼 시스템: 따뜻한 종이 캔버스, 초현실적인\n석고와 건축 이미지, 초대형 디스플레이 서체, 헤어라인 규칙,\n로마 숫자 섹션 마커, 그리고 작은 편집적 주석. 프로덕션 v에서 영감을 받았습니다',
  'bento': '정돈되고 훑어보기 쉬운 인터페이스를 위한 카드형 블록, 명확한 위계, 부드러운 간격, 미묘한 시각적 대비를 갖춘 모듈식 그리드 레이아웃입니다.',
  'binance': '암호화폐 거래소. 단색 위에 강렬한 노란색 강조, 거래소 특유의 긴박감.',
  'bmw': '럭셔리 자동차. 어둡고 프리미엄한 표면, 정교한 독일식 엔지니어링 미학.',
  'bmw-m': '모터스포츠 퍼포먼스 서브 브랜드. 거의 검정에 가까운 콕핏 표면, BMW M 삼색 강조, 날카로운 엔지니어링 기하학.',
  'bold': '묵직한 타이포그래피, 고대비 색상, 위압적인 레이아웃으로 강렬한 시각적 존재감을 표현.',
  'brutalism': '노출 콘크리트 건축에서 영감을 받은 거칠고 반(反)디자인적인 미학. 꾸밈없는 요소, 거슬리는 레이아웃, 기능적 미니멀리즘.',
  'bugatti': '하이퍼카 브랜드. 시네마 블랙 캔버스, 단색의 절제미, 기념비적인 디스플레이 서체.',
  'cafe': '아늑한 카페에서 영감을 받은 인터페이스. 따뜻한 톤, 부드러운 타이포그래피, 깔끔한 레이아웃으로 편안한 탐색 경험을 제공.',
  'cal': '오픈소스 일정 관리. 깔끔한 뉴트럴 UI, 개발자 지향의 단순함.',
  'canva': '비주얼 제작 플랫폼. 선명한 보라-파랑 그라데이션, 넉넉한 여백, 친근한 기하학.',
  'cisco': '엔터프라이즈 인프라 브랜드. 어둡고 신뢰감 있는 표면, Cisco Blue 시그널, 기술적 명료함.',
  'claude': 'Anthropic의 AI 어시스턴트. 따뜻한 테라코타 강조, 깔끔한 에디토리얼 레이아웃.',
  'clay': '크리에이티브 에이전시. 유기적인 형태, 부드러운 그라데이션, 아트 디렉션이 가미된 레이아웃.',
  'claymorphism': '잘 빚어진 점토를 연상시키는 부드럽고 둥근 3D 형태. 장난스럽고 통통한 요소와 다채로운 표면.',
  'clean': '넉넉한 여백, 가독성 높은 타이포그래피, 제한된 색상 팔레트로 시각적 산만함을 줄인 단순함 중심의 디자인.',
  'clickhouse': '빠른 분석 데이터베이스. 노란색 강조, 기술 문서 스타일.',
  'cohere': '엔터프라이즈 AI 플랫폼. 생동감 있는 그라데이션, 데이터가 풍부한 대시보드 미학.',
  'coinbase': '암호화폐 거래소. 깔끔한 블루 아이덴티티, 신뢰 중심의 기관적 분위기.',
  'colorful': '몰입감 있고 기억에 남는 현대적 사용자 경험을 위한 생동감 있고 고대비인 팔레트와 그라데이션.',
  'contemporary': '벤토 그리드, 다크 모드 지원, 고성능 접근성 레이아웃을 갖춘 현시대의 미니멀리즘 디자인.',
  'corporate': '체계적인 그리드, 미니멀한 레이아웃, 일관된 엔터프라이즈 패턴을 갖춘 전문적이고 브랜드에 부합하는 디자인.',
  'cosmic': '다크 테마, 생동감 있는 네온 강조, 몰입감 있는 공간적 요소를 갖춘 미래지향적 SF 미학.',
  'creative': '표현력 있는 타이포그래피와 강렬한 그래픽으로 랜딩 페이지와 크리에이티브 프로젝트에 어울리는 장난스럽고 캐릭터 중심의 디자인.',
  'cursor': 'AI 우선 코드 에디터. 세련된 다크 인터페이스, 그라데이션 강조.',
  'dashboard': '모듈형 그리드, 글래스 같은 패널, 강한 데이터 위계를 갖춰 생산성 대시보드에 어울리는 다크 테마 클라우드 플랫폼 미학.',
  'default': 'B2B 도구, 대시보드, 유틸리티 페이지에 적합한 깔끔하고 제품 지향적인 기본 스타일.',
  'discord': '음성 / 채팅 플랫폼. 깊은 블러플 색감, 다크 우선 표면, 장난스러운 강조 포인트.',
  'dithered': '제한된 팔레트로 음영을 표현하는 도트 패턴 렌더링 기법으로, 향수를 자극하는 레트로한 고대비 비주얼을 연출.',
  'doodle': '낙서, 손글씨 폰트, 불완전한 선으로 장난스럽고 격식 없는 느낌을 주는 손으로 그린 듯한 스케치 스타일.',
  'dramatic': '강렬한 레이아웃, 몰입감 있는 비주얼, 시선을 사로잡는 파격적인 구성을 갖춘 고대비의 연극적 디자인.',
  'duolingo': '언어 학습 플랫폼. 밝은 부엉이 그린, 두툼한 그림자, 게임화된 즐거움.',
  'editorial': '세련된 세리프 타이포그래피, 체계적인 그리드, 우아한 독서 경험을 갖춘 매거진 스타일의 에디토리얼 레이아웃.',
  'elegant': '섬세한 타이포그래피, 미니멀한 팔레트, 정제된 레이아웃으로 세련미가 묻어나는 우아하고 고급스러운 미학.',
  'elevenlabs': 'AI 음성 플랫폼. 다크하고 영화적인 UI, 오디오 파형 미학.',
  'energetic': '두꺼운 테두리, 기하학적 형태, 고대비 색상, 표현력 있는 타이포그래피로 움직임과 생동감을 전하는 역동적이고 생기 넘치는 스타일.',
  'enterprise': '직관적인 드래그 앤 드롭 패턴과 체계적인 레이아웃으로 데이터 기반 워크플로에 어울리는 깔끔한 고대비 엔터프라이즈 디자인.',
  'expo': 'React Native 플랫폼. 다크 테마, 좁은 자간, 코드 중심.',
  'expressive': '강렬한 색상, 장난스러운 그래픽, 역동적인 레이아웃으로 창의성과 구조의 균형을 잡은 생동감 있고 개성 넘치는 디자인.',
  'fantasy': '강렬하고 프리미엄한 비주얼, 풍부한 색상 팔레트, 몰입감 있는 테마 요소를 갖춘 게임 스타일의 판타지 미학.',
  'ferrari': '럭셔리 자동차. 명암법을 활용한 에디토리얼, Ferrari Red 강조, 영화적인 블랙.',
  'figma': '협업 디자인 도구. 생동감 있는 멀티 컬러, 경쾌하면서도 전문적인 느낌.',
  'flat': '생동감 있는 색상, 깔끔한 타이포그래피, 3D 효과 없는 2차원 미니멀 스타일로 빠르고 사용자 친화적인 인터페이스를 구현.',
  'framer': '웹사이트 빌더. 강렬한 블랙과 블루, 모션 중심, 디자인 지향적.',
  'friendly': '둥근 요소, 넉넉한 여백, 부드러운 파스텔 색상 팔레트로 친근하고 직관적인 디자인.',
  'futuristic': '테크 감성의 타이포그래피, 현대적인 레이아웃, 세련되고 혁신 지향적인 미학을 갖춘 미래지향적 디자인.',
  'github': '코드 중심 플랫폼. 기능적 밀도, 화이트 배경의 블루 정밀함, Primer 기반.',
  'glassmorphism': '반투명 레이어, 은은한 블러, 빛나는 테두리로 깊이감과 현대적 우아함을 더한 프로스티드 글래스 효과.',
  'gradient': '부드러운 색상 전환과 그라데이션이 풍부한 표면으로 시각적 깊이가 있는 현대적이고 경쾌한 인터페이스를 구현.',
  'hashicorp': '인프라 자동화. 엔터프라이즈급의 깔끔함, 블랙 앤 화이트.',
  'hud': '전투기 / 헬리콥터 헤드업 디스플레이. 거의 검은 배경에 인광 그린, 대문자 데이터 오버레이, 각진 기하학. 고속·고도에서도 모호함 제로.',
  'huggingface': 'ML 커뮤니티 허브. 화창한 옐로 액센트, 모노스페이스 아이덴티티, 경쾌하고 빽빽한 구성.',
  'ibm': '엔터프라이즈 기술. Carbon 디자인 시스템, 정돈된 블루 팔레트.',
  'intercom': '고객 메시징. 친근한 블루 팔레트, 대화형 UI 패턴.',
  'kami': '에디토리얼 페이퍼 시스템: 따뜻한 양피지 캔버스, 잉크 블루 액센트, 세리프 중심의 위계. 이력서, 원페이저, 백서, 포트폴리오, 슬라이드 덱 등 UI보다는 고품질 인쇄물처럼 느껴져야 하는 모든 것을 위해 제작. 기본적으로 다국어 지원',
  'kraken': '크립토 트레이딩. 퍼플 액센트의 다크 UI, 데이터 밀도가 높은 대시보드.',
  'lamborghini': '슈퍼카 브랜드. 순수한 블랙 표면, 골드 액센트, 극적인 대문자 타이포그래피.',
  'levels': '명료함, 신뢰, 속도로 마찰을 없애고 사용자를 행동으로 유도하는 전환 중심 디자인.',
  'linear-app': '프로젝트 관리. 극도의 미니멀, 정밀함, 퍼플 액센트.',
  'lingo': '밝은 색상, 둥근 형태, 촉각적인 3D 테두리, 친근한 일러스트레이션으로 친근한 인터페이스를 구현하는 경쾌하고 미니멀한 디자인.',
  'loom': 'Loom 비동기 영상. 퍼플 메인 컬러, 친근한 표면, 영상 중심 레이아웃. 기업스럽지 않으면서도 깔끔하고 전문적.',
  'lovable': 'AI 풀스택 빌더. 경쾌한 그라데이션, 친근한 개발자 감성.',
  'luxury': '강렬한 헤드라인, 모노크롬 팔레트, 프리미엄 감성을 갖춘 고급스러운 다크 미학으로 럭셔리 브랜드 경험을 구현.',
  'mastercard': '글로벌 결제 네트워크. 따뜻한 크림 캔버스, 궤도형 알약 모양, 에디토리얼한 온기.',
  'material': '레이어드 표면, 다이내믹 테마, 내장 모션, 반응형 크로스 플랫폼 패턴을 갖춘 Google의 Material Design.',
  'meta': '테크 리테일 스토어. 사진 중심, 명확한 라이트/다크 표면, Meta Blue CTA.',
  'minimal': '여백, 깔끔한 타이포그래피, 절제된 색상을 강조하여 최대한의 명료함과 집중을 이끌어내는 절제된 디자인.',
  'minimax': 'AI 모델 제공업체. 네온 액센트가 가미된 강렬한 다크 인터페이스.',
  'mintlify': '문서화 플랫폼. 깔끔하고 그린 액센트가 있는, 읽기에 최적화된 구성.',
  'miro': '비주얼 협업. 밝은 옐로 액센트, 무한 캔버스 미학.',
  'mission-control': '우주/항공우주 미션 모니터링. 다크 커맨드 센터, 앰버 텔레메트리, 모노스페이스의 정밀함. 무엇보다 기능적 명료함을 최우선.',
  'mistral-ai': '오픈 웨이트 LLM 제공업체. 프랑스식 엔지니어링의 미니멀리즘, 퍼플 톤.',
  'modern': '세리프 타이포그래피, 미니멀한 팔레트, 깔끔한 레이아웃으로 세련된 디지털 제품을 위한 현대적 에디토리얼 스타일.',
  'mongodb': '도큐먼트 데이터베이스. 그린 리프 브랜딩, 개발자 문서 중심.',
  'mono': '모노스페이스 중심의 매트릭스에서 영감을 받은 디자인으로 고대비 요소, 컴팩트한 밀도, 해커 시크 미학을 구현.',
  'neobrutalism': '강렬한 테두리, 선명한 액센트 색상, 따뜻한 표면 위의 거칠고 고대비 레이아웃으로 브루탈리즘을 현대적으로 재해석.',
  'neon': '고대비 색상 조합의 일렉트릭 네온 발광 효과로 강렬하고 시선을 사로잡는 인터페이스를 구현.',
  'neumorphism': '모노크롬 표면 위에 내부와 외부 그림자가 있는 부드럽게 돌출된 UI 요소로 촉각적이고 파묻힌 듯한 룩을 연출.',
  'nike': '애슬레틱 리테일. 모노크롬 UI, 거대한 대문자 타이포, 풀블리드 사진.',
  'notion': '올인원 워크스페이스. 따뜻한 미니멀리즘, 세리프 헤딩, 부드러운 표면.',
  'nvidia': 'GPU 컴퓨팅. 그린-블랙 에너지, 기술적 파워 미학.',
  'ollama': 'LLM을 로컬에서 실행하세요. 터미널 중심의 모노크롬 단순함.',
  'openai': '넉넉한 여백과 에디토리얼 타이포그래피를 갖추고 깊은 틸-블랙을 기반으로 한 차분한 모노크롬에 가까운 시스템.',
  'opencode-ai': 'AI 코딩 플랫폼. 개발자 중심의 다크 테마.',
  'pacman': '픽셀 폰트, 점선 테두리, 경쾌한 고대비 색상, 8비트 게임 미학을 담은 레트로 아케이드 스타일 디자인.',
  'paper': '종이 질감의 인쇄물에서 영감을 받은 디자인으로, 최소한의 색상, 깔끔한 세리프/산세리프 타이포그래피, 촉각적인 표면 질감을 갖춤.',
  'perplexity': '대화형 AI 검색 엔진. 짙은 다크 캔버스, 또렷한 타이포그래피, 단일 바이올렛 강조색, 밀도 높은 정보 위계.',
  'perspective': '아이소메트릭 뷰, 소실점, 레이어드된 요소로 공간적 깊이를 표현해 3D 같은 사실감으로 시선을 이끄는 디자인.',
  'pinterest': '비주얼 디스커버리. 레드 강조색, 메이슨리 그리드, 이미지 우선.',
  'playstation': '게임 콘솔 리테일. 3면 채널 레이아웃, 차분한 권위감의 디스플레이 서체, 시안 호버 확대 효과.',
  'posthog': '제품 분석. 경쾌한 고슴도치 브랜딩, 개발자 친화적인 다크 UI.',
  'premium': '정밀한 간격, 모던한 타이포그래피, 세련되고 정제된 비주얼 언어를 갖춘 Apple 스타일의 프리미엄 미학.',
  'professional': '모던한 타이포그래피, 구조화된 레이아웃, 신뢰감 있는 비주얼 아이덴티티를 갖춘 정제되고 비즈니스에 적합한 디자인.',
  'publication': '에디토리얼 그리드와 표현력 있는 타이포그래피를 갖춘, 책·잡지·리포트를 위한 인쇄물에서 영감을 받은 비주얼 언어.',
  'raycast': '생산성 런처. 매끄러운 다크 크롬, 생동감 있는 그라데이션 강조색.',
  'refined': '우아한 세리프 타이포그래피와 절제되고 세련된 팔레트를 갖춘, 정성껏 큐레이션된 모던 미니멀 스타일.',
  'renault': '프랑스 자동차. 생동감 있는 오로라 그라데이션, NouvelR 타이포그래피, 강렬한 에너지.',
  'replicate': 'API로 ML 모델을 실행하세요. 깔끔한 화이트 캔버스, 코드 중심.',
  'resend': '이메일 API. 미니멀한 다크 테마, 모노스페이스 강조.',
  'retro': '빈티지 스타일의 타이포그래피, 고대비 레트로 팔레트, 향수를 자극하는 비주얼 요소를 담은 복고풍 디자인.',
  'revolut': '디지털 뱅킹. 매끄러운 다크 인터페이스, 그라데이션 카드, 핀테크의 정밀함.',
  'runwayml': 'AI 영상 생성. 시네마틱 다크 UI, 미디어가 풍부한 레이아웃.',
  'sanity': '헤드리스 CMS. 레드 강조색, 콘텐츠 우선의 에디토리얼 레이아웃.',
  'sentry': '오류 모니터링. 다크 대시보드, 데이터 밀도가 높음, 핑크-퍼플 강조색.',
  'shadcn': '미니멀하고 깔끔한 컴포넌트, 모노크롬 팔레트, 유틸리티 우선 패턴을 갖춘 Shadcn/ui 스타일 디자인.',
  'shopify': '이커머스 플랫폼. 다크 우선의 시네마틱, 네온 그린 강조색, 매우 가벼운 서체.',
  'simple': '깔끔한 타이포그래피, 중립적인 색상, 방해되지 않고 직관적인 레이아웃을 갖춘 간결하고 군더더기 없는 디자인.',
  'skeumorphism': '질감 있는 표면, 3D 효과, 익숙한 물리적 메타포로 현실 세계를 모사해 직관적인 디지털 인터페이스를 구현.',
  'slack': '업무 커뮤니케이션 플랫폼. 가지색 메인, 다채로운 강조색 로고 팔레트, 다크 사이드바와 밝은 표면, 따뜻하고 친근한 느낌.',
  'sleek': '깔끔한 선, 의도된 색상 팔레트, 절제된 인터랙션, 일관된 간격을 갖춘 모던 미니멀리스트 미학.',
  'spacex': '우주 기술. 극명한 흑백, 풀블리드 이미지, 미래지향적.',
  'spacious': '넉넉한 여백, 일관된 패딩, 그리드 기반 레이아웃으로 깔끔하고 가독성 높으며 여유로운 인터페이스를 구현.',
  'spotify': '음악 스트리밍. 다크 배경 위의 생동감 있는 그린, 강렬한 서체, 앨범 아트 중심.',
  'starbucks': '글로벌 커피 리테일 브랜드. 4단계 그린 시스템, 따뜻한 크림색 캔버스, 완전한 알약형 버튼.',
  'storytelling': '비주얼, 카피, 인터랙션을 활용해 사용자를 몰입감 있고 감성적으로 공감되는 여정으로 이끄는 내러티브 중심 디자인.',
  'stripe': '결제 인프라. 시그니처 퍼플 그라데이션, weight-300의 우아함.',
  'supabase': '오픈소스 Firebase 대안. 다크 에메랄드 테마, 코드 우선.',
  'superhuman': '빠른 이메일 클라이언트. 프리미엄 다크 UI, 키보드 우선, 퍼플 글로우.',
  'tesla': '전기 자동차. 과감한 절제, 풀뷰포트 사진, 거의 제로에 가까운 UI.',
  'tetris': '경쾌한 색상, 강렬한 디스플레이 폰트, 컴팩트하고 에너지 넘치는 레이아웃을 갖춘 클래식 블록 게임 스타일 디자인.',
  'theverge': '테크 에디토리얼 미디어. 애시드-민트와 자외선 강조색, Manuka 디스플레이, 레이브 전단지 스타일 스토리 타일.',
  'together-ai': '오픈소스 AI 인프라. 기술적이고 청사진 스타일의 디자인.',
  'totality-festival': '개기일식의 본능적인 경외감을 담아낸 코스믹 프리미엄 글래스모피즘 다크 시스템 — 흑요석 표면, 앰버 "코로나" 하이라이트, 시안 대기 효과 강조.',
  'trading-terminal': 'Bloomberg 스타일 금융 트레이딩 터미널. 다크 전용, 데이터 밀집형, 시안/코랄 매수/매도 신호. 2미터 거리에서도 한눈에 읽히는 모든 것.',
  'uber': '모빌리티 플랫폼. 강렬한 흑백, 타이트한 타이포, 도시적 에너지.',
  'urdu': '네이티브 RTL 지원, Nastaliq 타이포그래피, 이중 언어 조화를 갖춘 우르두어 우선 디지털 경험.',
  'vercel': '프론트엔드 배포. 흑백의 정밀함, Geist 폰트.',
  'vibrant': '생동감 있고 다채로운 디자인. 강렬하고 경쾌한 타이포그래피, 따뜻한 강조색, 역동적인 시각적 에너지.',
  'vintage': '스큐어모픽 요소, 거친 질감, 레트로 컬러 팔레트, 픽셀 스타일 타이포그래피로 표현한 1950년대-1990년대 노스탤지어.',
  'vodafone': '글로벌 통신 브랜드. 기념비적인 대문자 디스플레이, Vodafone Red 챕터 밴드.',
  'voltagent': 'AI 에이전트 프레임워크. 보이드 블랙 캔버스, 에메랄드 강조색, 터미널 네이티브.',
  'warm-editorial': '세리프 중심의 매거진 미학. 따뜻한 오프화이트 종이 위의 테라코타 강조색 —\n롱폼, 에디토리얼, 브랜드 중심 마케팅 페이지에 적합.',
  'warp': '모던 터미널. 다크 IDE 스타일 인터페이스, 블록 기반 커맨드 UI.',
  'webex': '협업 플랫폼. 모멘텀 타이포그래피, 블루 액션 시스템, 다중 사용자 강조 색상 스펙트럼.',
  'webflow': '비주얼 웹 빌더. 블루 강조의 세련된 마케팅 사이트 미학.',
  'wechat': 'WeChat 미니 프로그램, 공식 계정, 오픈 생태계 확장을 위한 브랜드 비주얼 언어.',
  'wired': '테크 매거진. 종이처럼 흰 브로드시트 밀도, 커스텀 세리프 디스플레이, 모노 키커, 잉크 블루 링크.',
  'wise': '송금. 밝은 그린 강조색, 친근하고 명료함.',
  'x-ai': 'Elon Musk의 AI 연구소. 극단적인 모노크롬, 미래적 미니멀리즘.',
  'xiaohongshu': '라이프스타일 UGC 소셜 플랫폼. 단일 브랜드 레드, 넉넉한 라운드, 콘텐츠 우선.',
  'zapier': '자동화 플랫폼. 따뜻한 오렌지, 친근한 일러스트 중심.',
};

export const KO_DESIGN_SYSTEM_CATEGORIES: Record<string, string> = {
  'AI & LLM': 'AI 및 LLM',
  'Automotive': '자동차',
  'Backend & Data': '백엔드 및 데이터',
  'Bold & Expressive': '강렬함 및 표현력',
  'Creative & Artistic': '크리에이티브 및 예술',
  'Design & Creative': '디자인 및 크리에이티브',
  'Developer Tools': '개발자 도구',
  'E-Commerce & Retail': '이커머스 및 리테일',
  'Editorial & Print': '에디토리얼 및 인쇄',
  'Editorial / Personal / Publication': '에디토리얼 / 개인 / 출판',
  'Editorial · Studio': '에디토리얼 · 스튜디오',
  'Fintech & Crypto': '핀테크 및 크립토',
  'Layout & Structure': '레이아웃 및 구조',
  'Media & Consumer': '미디어 및 소비자',
  'Modern & Minimal': '모던 및 미니멀',
  'Morphism & Effects': '모피즘 및 이펙트',
  'Productivity & SaaS': '생산성 및 SaaS',
  'Professional & Corporate': '프로페셔널 및 기업용',
  'Retro & Nostalgic': '레트로 및 노스탤지어',
  'Social & Messaging': '소셜 및 메시징',
  'Starter': '입문용',
  'Themed & Unique': '테마별 & 독창적',
};
