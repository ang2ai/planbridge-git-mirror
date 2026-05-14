# PlanBridge 시스템 아키텍처 (최종)

> 크롬 익스텐션(요소 선택) + 웹 SaaS(정책 관리/기획) + Git Mirror + Agent SDK(AI 분석)

---

## 1. 전체 시스템 구성도

```
                                        ┌──────────────────┐
                                        │  GitHub / GitLab │
                                        │  사내 Git 서버   │
                                        └────────┬─────────┘
                                                 │
                                          Webhook │ push 이벤트
                                                 │
┌─────────────┐        ┌─────────────────────────┼──────────────────────────────┐
│             │        │          PlanBridge 서버 │                              │
│  기획자     │        │                         │                              │
│  브라우저   │        │  ┌──────────────────┐   │                              │
│             │        │  │                  │   │                              │
│ ┌─────────┐│  REST   │  │   SaaS Web       │   ▼                              │
│ │ Chrome  ││  API    │  │   (React)       │  ┌────────────────────┐           │
│ │Extension├┼────────▶│  │                 │  │  Git Mirror        │           │
│ │ (선택)  ││        │  │   정책 관리     │  │  Daemon             │           │
│ └─────────┘│        │  │   변경 요청     │  │                    │           │
│             │        │  │   TODO 대시보드 │  │  /repos/           │           │
│ ┌─────────┐│        │  │   신규 화면기획 │  │   ├─ proj-a/       │           │
│ │ SaaS    ││◀──────▶│  │   정책 검색     │  │   ├─ proj-b/       │           │
│ │ Web UI  ││        │  │                 │  │   └─ proj-c/       │           │
│ └─────────┘│        │  └────────┬─────────┘  └──────────┬─────────┘           │
│             │        │           │                       │                     │
└─────────────┘        │           ▼                       │ 소스 파일 읽기      │
                       │  ┌──────────────────┐             │                     │
                       │  │                  │             │                     │
                       │  │  SaaS API        │             │                     │
                       │  │  (Spring Boot)   │             │                     │
                       │  │                  │             │                     │
                       │  │  - 정책 CRUD     │             │                     │
                       │  │  - 컴포넌트 관리 │             │                     │
                       │  │  - 변경 요청     │             │                     │
                       │  │  - 분석 요청     │             │                     │
                       │  │                  │             │                     │
                       │  └──┬───────────┬───┘             │                     │
                       │     │           │                 │                     │
                       │     │           │  분석 작업 위임 │                     │
                       │     │           ▼                 │                     │
                       │     │  ┌──────────────────┐       │                     │
                       │     │  │                  │       │                     │
                       │     │  │  분석 워커       │───────┘                     │
                       │     │  │  (Agent SDK)     │                             │
                       │     │  │                  │                             │
                       │     │  │  - 소스 분석     │                             │
                       │     │  │  - TODO 생성     │                             │
                       │     │  │  - 충돌 감지     │                             │
                       │     │  │  - 기획서 생성   │                             │
                       │     │  │                  │                             │
                       │     │  └────────┬─────────┘                             │
                       │     │           │                                       │
                       │     ▼           ▼                                       │
                       │  ┌──────────────────┐                                   │
                       │  │                  │                                   │
                       │  │  Oracle DB       │                                   │
                       │  │                  │                                   │
                       │  │  PB_PROJECT      │                                   │
                       │  │  PB_PAGE         │                                   │
                       │  │  PB_COMPONENT    │                                   │
                       │  │  PB_POLICY       │                                   │
                       │  │  PB_CHANGE_REQ   │                                   │
                       │  │  PB_TODO_ITEM    │                                   │
                       │  │  ...             │                                   │
                       │  └──────────────────┘                                   │
                       │                                                         │
                       └─────────────────────────────────────────────────────────┘
```

---

## 2. 각 모듈의 역할과 경계

### 2.1 크롬 익스텐션 (경량 — 선택만 담당)

```
역할: 웹 페이지에서 요소를 선택하고 식별 정보를 SaaS로 전달
기술: Chrome Extension Manifest V3
크기: 파일 5~6개, 50KB 미만

하는 일:
  ✓ 요소 하이라이트 + 클릭 선택
  ✓ data-pb-id 감지
  ✓ React Fiber에서 컴포넌트명/계층 추출
  ✓ CSS Selector 생성
  ✓ Next.js 라우트 정보 추출
  ✓ 선택 결과를 SaaS 웹 페이지로 전달 (URL 파라미터 or postMessage)

하지 않는 일:
  ✗ 정책 관리 UI (→ SaaS 웹)
  ✗ AI 분석 (→ 분석 워커)
  ✗ 데이터 저장 (→ Oracle DB)
```

**익스텐션 → SaaS 연동 방식:**

```
방식 A: URL 파라미터 (단순)
─────────────────────────
요소 선택 시 새 탭으로 SaaS 페이지 열기:
https://planbridge.example.com/component?
  projectId=freshmart
  &pbId=ProductCard.AddToCartButton
  &componentName=AddToCartButton
  &pageRoute=/products
  &cssSelector=main>div:nth-child(3)>button

방식 B: postMessage (SaaS가 이미 열려 있을 때)
─────────────────────────
익스텐션이 SaaS 탭을 찾아서 메시지 전송:
chrome.tabs.sendMessage(saasTabId, {
  type: 'ELEMENT_SELECTED',
  data: { pbId, componentName, pageRoute, ... }
});
SaaS 웹이 메시지를 받아서 해당 컴포넌트 패널로 이동
```

### 2.2 SaaS 웹 프론트엔드

```
역할: 기획자/개발자의 모든 작업 화면
기술: React + TypeScript + Next.js (or Vite)
     Tailwind CSS + shadcn/ui

주요 화면:
  /dashboard              프로젝트 개요, 최근 변경, 통계
  /projects/:id           프로젝트 상세 (컴포넌트 트리)
  /component?pbId=...     컴포넌트 상세 (익스텐션에서 진입)
  /policies               정책 검색/관리
  /change-requests        변경 요청 목록
  /todos                  TODO 칸반 보드
  /plans/new              신규 화면 기획
  /plans/:id              기획서 상세

특징:
  - 익스텐션에서 파라미터를 받아 해당 컴포넌트 화면으로 바로 진입
  - 정책 편집, 변경 요청 작성, AI 분석 결과 확인 모두 여기서
  - 실시간 알림 (변경 요청 상태 변경, 분석 완료 등)
```

### 2.3 SaaS API (Spring Boot)

```
역할: 비즈니스 로직 + Oracle DB CRUD + 분석 워커 조율
기술: Spring Boot 3.x + Java 17
     JPA (Oracle CRUD)
     Spring Async (비동기 분석 작업)

API 그룹:

  [프로젝트 관리]
  POST   /api/projects                    프로젝트 등록 (Git URL 포함)
  GET    /api/projects/:id                프로젝트 상세
  PUT    /api/projects/:id                프로젝트 수정
  POST   /api/projects/:id/sync           Git 수동 동기화 트리거

  [컴포넌트]
  GET    /api/projects/:id/components     컴포넌트 트리 조회
  GET    /api/components/:id              컴포넌트 상세
  POST   /api/components/resolve          익스텐션 fingerprint → 컴포넌트 매핑
  POST   /api/projects/:id/scan           페이지 스캔 결과 수신 (익스텐션에서)

  [정책]
  GET    /api/components/:id/policies     컴포넌트에 적용된 정책 (직접+상속)
  POST   /api/policies                    정책 생성
  PUT    /api/policies/:id                정책 수정 (자동 버전 관리)
  DELETE /api/policies/:id                정책 삭제 (soft delete)
  GET    /api/policies/search?q=          정책 전문 검색
  GET    /api/policies/:id/history        정책 버전 이력

  [변경 요청]
  POST   /api/change-requests             변경 요청 생성
  PUT    /api/change-requests/:id         상태 변경
  POST   /api/change-requests/:id/analyze AI 분석 요청 (→ 분석 워커로 위임)
  GET    /api/change-requests/:id/status  분석 진행 상태 (polling or SSE)

  [TODO]
  GET    /api/todos                       TODO 목록 (필터: 상태, 프로젝트)
  PUT    /api/todos/:id                   TODO 상태 변경
  GET    /api/todos/:id/prompt            Claude Code용 프롬프트 조회
  POST   /api/todos/export                선택 TODO 일괄 내보내기

  [신규 화면 기획]
  POST   /api/plans                       기획 시작
  POST   /api/plans/:id/analyze           AI 유사 분석 요청
  POST   /api/plans/:id/validate          정책 충돌 검증 요청
  POST   /api/plans/:id/generate          기획서 + TODO 자동 생성

  [Git 연동]
  POST   /api/webhook/git                 Git push Webhook 수신
```

### 2.4 Git Mirror Daemon

```
역할: 대상 프로젝트의 Git 저장소를 서버 로컬에 항상 최신 상태로 유지
기술: 쉘 스크립트 + systemd (or Spring Scheduler)

동작:
  1. 프로젝트 등록 시 → git clone --mirror /repos/{projectId}/
  2. Webhook 수신 시 → git fetch --all (해당 프로젝트만)
  3. 백업: 5분마다 전체 repos에 대해 git fetch (Webhook 누락 대비)

디렉토리 구조:
  /repos/
    ├── freshmart-admin/          ← bare mirror or working tree
    │   ├── src/
    │   ├── package.json
    │   └── ...
    ├── customer-b-erp/
    └── customer-c-backoffice/

Oracle 매핑:
  PB_PROJECT.REPO_URL        = https://github.com/company/freshmart-admin.git
  PB_PROJECT.REPO_LOCAL_PATH = /repos/freshmart-admin
  PB_PROJECT.REPO_BRANCH     = main
  PB_PROJECT.LAST_SYNCED_AT  = 2025-03-31T14:30:00

보안:
  - Git 토큰은 암호화해서 Oracle에 저장 (또는 Vault)
  - /repos/ 디렉토리는 분석 워커만 읽기 접근
  - 파일 쓰기 권한 없음 (git fetch만)
```

### 2.5 분석 워커 (Agent SDK)

```
역할: AI 기반 소스 분석, TODO 생성, 충돌 감지, 기획서 생성
기술: Node.js (or Python) + Claude Agent SDK
     비동기 작업 큐 (Redis Queue or DB 기반)

동작 원리:
  1. SaaS API가 분석 작업을 큐에 등록
  2. 워커가 큐에서 작업을 가져옴
  3. 해당 프로젝트의 /repos/{projectId}/ 를 working directory로 설정
  4. Oracle에서 관련 정책/컴포넌트 정보 조회
  5. Agent SDK 호출 (소스 읽기 + 분석)
  6. 결과를 Oracle에 저장
  7. SaaS API에 완료 알림 (→ 프론트에 실시간 전달)

핵심 제약:
  - allowed_tools: ["Read", "Glob", "Bash"]만 허용
  - Edit, Write는 절대 허용하지 않음 (Git mirror 보호)
  - Bash도 읽기 전용 명령만 (grep, find, cat, wc 등)
  - 시스템 프롬프트에서 "파일 수정 금지" 명시
```

---

## 3. 분석 워커 상세 설계

### 3.1 분석 유형별 동작

```
┌──────────────────────────────────────────────────────────────┐
│  분석 유형 1: 변경 요청 분석 (→ TODO 생성)                   │
│                                                              │
│  입력:                                                       │
│    - 컴포넌트 정보 (Oracle: PB_COMPONENT)                    │
│    - 적용 정책 목록 (Oracle: PB_POLICY + 상속)               │
│    - 기획자 변경 요청 (Oracle: PB_CHANGE_REQUEST)            │
│    - 프로젝트 소스 (/repos/{projectId}/)                     │
│                                                              │
│  Agent SDK 프롬프트:                                         │
│    "프로젝트 디렉토리에서 {componentName} 컴포넌트를 찾아    │
│     분석하고, 다음 변경 요청에 대한 TODO를 생성해줘.         │
│                                                              │
│     [컴포넌트 정보]                                          │
│     {Oracle에서 조회한 컴포넌트 메타데이터}                  │
│                                                              │
│     [현재 적용 정책]                                         │
│     {Oracle에서 조회한 정책 목록}                            │
│                                                              │
│     [변경 요청]                                              │
│     {기획자가 작성한 내용}                                   │
│                                                              │
│     실제 소스를 읽고 다음을 확인해:                          │
│     1. 해당 컴포넌트의 현재 구현 (파일, 함수, props)         │
│     2. import 관계와 의존 컴포넌트                           │
│     3. 관련 API 호출 부분                                    │
│     4. 기존 테스트 파일                                      │
│                                                              │
│     JSON으로 출력: {todos, policyUpdates, impact}"           │
│                                                              │
│  Agent SDK 동작:                                             │
│    1. glob "**/*ProductCard*" → 파일 목록 발견               │
│    2. Read src/components/ProductCard.tsx → 코드 확인         │
│    3. Read src/hooks/useCart.ts → import 추적                 │
│    4. Bash "grep -r 'AddToCartButton' src/" → 사용처 검색    │
│    5. Read __tests__/ProductCard.test.tsx → 기존 테스트 확인  │
│    6. 종합 분석 → JSON 결과 생성                             │
│                                                              │
│  출력 (Oracle 저장):                                         │
│    - PB_TODO_ITEM × N건 (구체적 프롬프트 포함)               │
│    - PB_POLICY 업데이트 제안                                 │
│    - PB_CHANGE_REQUEST.STATUS → READY                        │
│    - PB_CHANGE_REQUEST.AI_ANALYSIS → 분석 요약               │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  분석 유형 2: 신규 화면 기획 지원                             │
│                                                              │
│  입력:                                                       │
│    - 기획자가 입력한 화면 설명                               │
│    - 기존 정책 전체 (Oracle)                                 │
│    - 기존 컴포넌트 목록 (Oracle)                             │
│    - 프로젝트 소스 (/repos/{projectId}/)                     │
│                                                              │
│  Agent SDK 동작:                                             │
│    1. 기존 페이지 구조 파악 (app/ 디렉토리 스캔)             │
│    2. 재사용 가능한 컴포넌트 탐색 (components/ 디렉토리)     │
│    3. 기존 정책과 비교하여 재사용/충돌 분석                  │
│    4. 화면 구조 제안 + 필요한 신규 정책 제안                 │
│    5. 기획서 초안 생성                                       │
│                                                              │
│  출력:                                                       │
│    - 추천 컴포넌트 구조 (JSON)                               │
│    - 재사용 정책 목록                                        │
│    - 충돌/누락 정책                                          │
│    - 기획서 마크다운                                         │
│    - 개발 TODO 목록                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  분석 유형 3: 정책 충돌 감지                                  │
│                                                              │
│  입력:                                                       │
│    - 수정하려는 정책 (기존 + 변경 내용)                      │
│    - 해당 정책이 연결된 모든 컴포넌트                        │
│    - 관련 소스 코드                                          │
│                                                              │
│  Agent SDK 동작:                                             │
│    1. 영향받는 컴포넌트의 소스 코드 확인                     │
│    2. 정책 변경이 실제 코드에 미치는 영향 분석               │
│    3. 다른 정책과의 충돌 여부 확인                           │
│                                                              │
│  출력:                                                       │
│    - 영향 범위 (컴포넌트 목록 + 구체적 코드 위치)            │
│    - 충돌 목록                                               │
│    - 수정 권장 사항                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 분석 워커 작업 큐

```
┌─────────────────────────────────────────────────────────┐
│                     작업 큐 흐름                         │
│                                                         │
│  SaaS API                                               │
│    │                                                    │
│    │  POST /api/change-requests/:id/analyze             │
│    ▼                                                    │
│  ┌────────────────────┐                                 │
│  │ PB_ANALYSIS_QUEUE  │  Oracle 테이블 기반 큐          │
│  │                    │  (or Redis Queue)               │
│  │ QUEUE_ID           │                                 │
│  │ PROJECT_ID         │                                 │
│  │ ANALYSIS_TYPE      │  CHANGE_REQUEST / NEW_PLAN /    │
│  │                    │  CONFLICT_CHECK                  │
│  │ REQUEST_PAYLOAD    │  JSON (분석에 필요한 입력)       │
│  │ STATUS             │  QUEUED → PROCESSING →          │
│  │                    │  COMPLETED / FAILED              │
│  │ WORKER_ID          │  작업 중인 워커 식별자           │
│  │ RESULT             │  JSON (분석 결과)                │
│  │ STARTED_AT         │                                 │
│  │ COMPLETED_AT       │                                 │
│  │ ERROR_MESSAGE      │                                 │
│  └────────┬───────────┘                                 │
│           │                                             │
│           │  워커가 5초 간격으로 폴링                    │
│           │  (or Redis pub/sub으로 즉시 알림)            │
│           ▼                                             │
│  ┌────────────────────┐                                 │
│  │  분석 워커 프로세스 │                                 │
│  │                    │                                 │
│  │  1. 큐에서 작업 가져오기                             │
│  │  2. STATUS → PROCESSING                              │
│  │  3. Oracle에서 컨텍스트 조회                         │
│  │  4. Agent SDK 호출                                   │
│  │     (cwd: /repos/{projectId})                        │
│  │  5. 결과 파싱 → Oracle 저장                          │
│  │  6. STATUS → COMPLETED                               │
│  │  7. SSE or WebSocket으로 프론트에 알림               │
│  │                                                      │
│  │  에러 시:                                            │
│  │  - 최대 3회 재시도                                   │
│  │  - STATUS → FAILED, ERROR_MESSAGE 기록               │
│  │  - 관리자에게 알림                                   │
│  └────────────────────┘                                 │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.3 워커 스케일링

```
소규모 (1~5 프로젝트):
  워커 1대, 순차 처리
  분석 요청이 많지 않으므로 충분

중규모 (5~20 프로젝트):
  워커 2~3대, 프로젝트별 분산
  큐에서 PROJECT_ID 기준으로 워커 할당

대규모 (20+ 프로젝트):
  워커 풀 + 오토스케일링
  Kubernetes Job or AWS ECS Task로 동적 확장
```

---

## 4. 데이터 흐름 시나리오

### 4.1 기획자가 정책을 확인/수정하는 경우 (AI 불필요)

```
기획자 브라우저                  SaaS 서버
     │                              │
     │  ① 익스텐션으로 요소 선택    │
     │  pbId, componentName 추출    │
     │                              │
     │  ② SaaS 웹 열림 (파라미터)  │
     │  /component?pbId=xxx         │
     │                              │
     │  ③ API 호출                  │
     │ ───────────────────────────▶ │
     │  GET /api/components/resolve │
     │  { pbId, pageRoute }         │
     │                              │  Oracle 조회
     │                              │  PB_COMPONENT → 컴포넌트 정보
     │                              │  PB_POLICY → 적용+상속 정책
     │                              │  PB_POLICY_VERSION → 이력
     │                              │
     │  ④ 결과 반환                 │
     │ ◀─────────────────────────── │
     │  { component, policies,      │
     │    hierarchy, history }      │
     │                              │
     │  ⑤ 기획자가 정책 수정       │
     │ ───────────────────────────▶ │
     │  PUT /api/policies/:id       │
     │  { content, changeReason }   │
     │                              │  Oracle 업데이트
     │                              │  PB_POLICY → 내용 수정
     │                              │  PB_POLICY_VERSION → 이전 버전 보관
     │                              │
     │  ⑥ 완료                      │
     │ ◀─────────────────────────── │
     │                              │

→ Git Mirror, Agent SDK 관여 없음
→ 단순 CRUD로 빠르게 처리
```

### 4.2 기획자가 변경 요청 + AI 분석을 하는 경우

```
기획자 브라우저            SaaS API               분석 워커              Git Mirror
     │                       │                       │                     │
     │ ① 변경 요청 작성     │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │ POST /change-requests │                       │                     │
     │ {componentId, desc}   │                       │                     │
     │                       │  Oracle INSERT        │                     │
     │                       │  PB_CHANGE_REQUEST    │                     │
     │                       │                       │                     │
     │ ② "AI 분석" 클릭     │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │ POST /analyze         │                       │                     │
     │                       │  큐에 작업 등록       │                     │
     │                       │  PB_ANALYSIS_QUEUE    │                     │
     │                       │                       │                     │
     │ ③ "분석 중" 상태 반환│                       │                     │
     │ ◀─────────────────────│                       │                     │
     │                       │                       │                     │
     │  (프론트: 로딩 표시)  │                       │                     │
     │                       │  ④ 워커가 큐에서 가져옴                    │
     │                       │                       │                     │
     │                       │  Oracle 조회:         │                     │
     │                       │  컴포넌트 + 정책      │                     │
     │                       │  ─────────────────────▶                     │
     │                       │                       │                     │
     │                       │                       │  ⑤ Agent SDK 호출  │
     │                       │                       │  cwd: /repos/proj/  │
     │                       │                       │ ───────────────────▶│
     │                       │                       │  Read 소스 파일     │
     │                       │                       │  Glob 관련 파일 검색│
     │                       │                       │  Bash grep 사용처   │
     │                       │                       │ ◀────────────────── │
     │                       │                       │                     │
     │                       │                       │  ⑥ 분석 결과 생성  │
     │                       │                       │  TODO + 정책제안    │
     │                       │                       │                     │
     │                       │  ⑦ Oracle 저장:       │                     │
     │                       │  PB_TODO_ITEM × N건   │                     │
     │                       │  PB_CHANGE_REQUEST    │                     │
     │                       │    .STATUS → READY    │                     │
     │                       │  ◀─────────────────── │                     │
     │                       │                       │                     │
     │ ⑧ SSE/WebSocket      │                       │                     │
     │   "분석 완료" 알림    │                       │                     │
     │ ◀─────────────────────│                       │                     │
     │                       │                       │                     │
     │ ⑨ 결과 조회          │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │ GET /change-req/:id   │  Oracle 조회          │                     │
     │                       │                       │                     │
     │ ⑩ 분석 결과 + TODO   │                       │                     │
     │ ◀─────────────────────│                       │                     │
     │                       │                       │                     │
```

### 4.3 신규 화면 기획

```
기획자 브라우저            SaaS API               분석 워커              Git Mirror
     │                       │                       │                     │
     │ ① 화면 설명 입력     │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │ POST /plans           │                       │                     │
     │ {title, route, desc}  │                       │                     │
     │                       │                       │                     │
     │ ② "AI 분석" 클릭     │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │                       │  큐 등록              │                     │
     │                       │  (type: NEW_PLAN)     │                     │
     │                       │                       │                     │
     │                       │                       │  ③ Agent SDK가     │
     │                       │                       │  app/ 디렉토리 스캔│
     │                       │                       │  components/ 분석  │
     │                       │                       │  기존 정책과 비교  │
     │                       │                       │                     │
     │ ④ 결과 수신          │                       │                     │
     │ ◀─────────────────────│                       │                     │
     │                       │                       │                     │
     │  - 유사 화면 목록     │                       │                     │
     │  - 추천 컴포넌트 구조 │                       │                     │
     │  - 재사용 가능 정책   │                       │                     │
     │  - 충돌/누락 경고     │                       │                     │
     │                       │                       │                     │
     │ ⑤ 기획자가 검토/수정 │                       │                     │
     │                       │                       │                     │
     │ ⑥ "기획서 생성" 클릭 │                       │                     │
     │ ─────────────────────▶│                       │                     │
     │                       │  큐 등록              │                     │
     │                       │  (type: GENERATE_SPEC)│                     │
     │                       │                       │                     │
     │ ⑦ 기획서 + TODO 수신 │                       │                     │
     │ ◀─────────────────────│                       │                     │
     │                       │                       │                     │
```

---

## 5. Oracle DB 스키마 (추가분)

이전 설계에서 추가/변경되는 부분만:

```sql
------------------------------------------------------
-- PB_PROJECT에 Git 관련 컬럼 추가
------------------------------------------------------
ALTER TABLE PB_PROJECT ADD (
    REPO_URL         VARCHAR2(500),          -- Git 저장소 URL
    REPO_LOCAL_PATH  VARCHAR2(500),          -- 서버 로컬 경로 (/repos/xxx)
    REPO_BRANCH      VARCHAR2(100) DEFAULT 'main',
    REPO_TOKEN       VARCHAR2(500),          -- 암호화된 Git 토큰
    LAST_SYNCED_AT   TIMESTAMP,
    SYNC_STATUS      VARCHAR2(20) DEFAULT 'IDLE'
    -- IDLE, SYNCING, ERROR
);

------------------------------------------------------
-- 분석 작업 큐
------------------------------------------------------
CREATE TABLE PB_ANALYSIS_QUEUE (
    QUEUE_ID        VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    
    ANALYSIS_TYPE   VARCHAR2(30)   NOT NULL,
    -- CHANGE_REQUEST: 변경 요청 → TODO 생성
    -- NEW_PLAN: 신규 화면 기획 지원
    -- CONFLICT_CHECK: 정책 충돌 감지
    -- GENERATE_SPEC: 기획서 생성
    
    REQUEST_ID      VARCHAR2(36),   -- FK: PB_CHANGE_REQUEST or PB_SCREEN_PLAN
    REQUEST_PAYLOAD CLOB NOT NULL,  -- JSON: 분석에 필요한 입력 데이터
    
    STATUS          VARCHAR2(20)   DEFAULT 'QUEUED',
    -- QUEUED → PROCESSING → COMPLETED / FAILED
    
    WORKER_ID       VARCHAR2(100),  -- 처리 중인 워커 식별자
    RESULT          CLOB,           -- JSON: 분석 결과
    ERROR_MESSAGE   VARCHAR2(4000),
    RETRY_COUNT     NUMBER(2)      DEFAULT 0,
    MAX_RETRIES     NUMBER(2)      DEFAULT 3,
    
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    STARTED_AT      TIMESTAMP,
    COMPLETED_AT    TIMESTAMP
);

CREATE INDEX IDX_PB_QUEUE_STATUS ON PB_ANALYSIS_QUEUE(STATUS, CREATED_AT);

------------------------------------------------------
-- Git 동기화 이력
------------------------------------------------------
CREATE TABLE PB_GIT_SYNC_LOG (
    SYNC_LOG_ID     VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    
    TRIGGER_TYPE    VARCHAR2(20)   NOT NULL,
    -- WEBHOOK, SCHEDULED, MANUAL
    
    COMMIT_HASH     VARCHAR2(40),   -- 동기화 후 HEAD commit
    COMMIT_MESSAGE  VARCHAR2(1000),
    BRANCH          VARCHAR2(100),
    
    FILES_CHANGED   NUMBER(5),
    STATUS          VARCHAR2(20)   DEFAULT 'SUCCESS',
    ERROR_MESSAGE   VARCHAR2(4000),
    
    SYNCED_AT       TIMESTAMP      DEFAULT SYSTIMESTAMP
);
```

---

## 6. 기술 스택 정리

```
┌──────────────────────────────────────────────────────────┐
│  모듈               기술                                  │
├──────────────────────────────────────────────────────────┤
│  크롬 익스텐션      Manifest V3, Content Script, JS       │
│                     (빌드 도구 없이 순수 JS)              │
│                                                          │
│  SaaS 프론트엔드    Next.js 14+ / React / TypeScript     │
│                     Tailwind CSS / shadcn/ui              │
│                     Zustand (상태관리)                    │
│                                                          │
│  SaaS 백엔드        Spring Boot 3.x / Java 17            │
│                     JPA (Oracle CRUD)                     │
│                     Spring Async (비동기 처리)            │
│                     SSE or WebSocket (실시간 알림)        │
│                                                          │
│  분석 워커          Node.js + Claude Agent SDK            │
│                     (or Python + claude_agent_sdk)        │
│                     독립 프로세스로 실행                  │
│                                                          │
│  Git Mirror         git CLI + systemd (데몬)              │
│                     Spring Scheduler (백업 폴링)          │
│                                                          │
│  데이터베이스       Oracle (기존 인프라)                   │
│                     Oracle Text (전문 검색)               │
│                                                          │
│  빌드 플러그인      Next.js SWC/Babel 플러그인            │
│                     (대상 프로젝트에 설치)                │
│                     data-pb-id 자동 주입                  │
│                                                          │
│  인프라             사내 서버 or AWS (고객사 환경에 따라) │
│                     Docker Compose (개발/소규모)          │
│                     Kubernetes (대규모)                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

---

## 7. 배포 구성

### 7.1 Docker Compose (소규모/개발)

```yaml
# docker-compose.yml

services:
  # SaaS 프론트엔드
  web:
    build: ./packages/web
    ports: ["3000:3000"]
    environment:
      - API_URL=http://api:8080

  # SaaS API (Spring Boot)
  api:
    build: ./packages/api
    ports: ["8080:8080"]
    environment:
      - SPRING_DATASOURCE_URL=jdbc:oracle:thin:@oracle:1521/XEPDB1
      - REPOS_BASE_PATH=/repos
    volumes:
      - git-repos:/repos  # Git Mirror 공유 볼륨

  # 분석 워커 (Agent SDK)
  worker:
    build: ./packages/worker
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - ORACLE_URL=jdbc:oracle:thin:@oracle:1521/XEPDB1
      - REPOS_BASE_PATH=/repos
    volumes:
      - git-repos:/repos:ro  # 읽기 전용!

  # Git Mirror Daemon
  git-mirror:
    build: ./packages/git-mirror
    environment:
      - ORACLE_URL=jdbc:oracle:thin:@oracle:1521/XEPDB1
    volumes:
      - git-repos:/repos

volumes:
  git-repos:  # 공유 볼륨: git-mirror가 쓰고, worker가 읽음
```

### 7.2 핵심 포인트

```
git-repos 볼륨:
  - git-mirror 서비스: 읽기/쓰기 (git fetch)
  - worker 서비스: 읽기 전용 (:ro)
  - api 서비스: 접근 불필요 (Oracle만 사용)
  - web 서비스: 접근 불필요

이 구조로:
  ✓ Git Mirror가 소스를 항상 최신으로 유지
  ✓ 분석 워커는 소스를 읽기만 함 (수정 불가)
  ✓ SaaS API/Web은 소스에 직접 접근하지 않음 (Oracle 경유)
  ✓ 모듈 간 역할이 명확히 분리됨
```

---

## 8. 보안 고려사항

```
┌─────────────────────────────────────────────────────────┐
│  영역            보안 조치                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Git 토큰        Oracle에 암호화 저장                    │
│                  (or HashiCorp Vault)                    │
│                  최소 권한: read-only 토큰               │
│                                                         │
│  Git Mirror      서버 디렉토리 퍼미션 제한               │
│                  분석 워커만 읽기 접근                   │
│                  파일 시스템 수준에서 쓰기 차단           │
│                                                         │
│  Agent SDK       allowed_tools: Read, Glob, Bash만      │
│                  시스템 프롬프트에 쓰기 금지 명시         │
│                  Docker 볼륨 :ro (읽기 전용 마운트)      │
│                                                         │
│  SaaS API        JWT 인증 + RBAC                        │
│                  기획자/개발자/관리자 역할 분리           │
│                  API Rate Limiting                       │
│                                                         │
│  Oracle DB       기존 사내 보안 정책 적용                │
│                  CLOB 내 소스코드 저장하지 않음           │
│                  (소스는 Git Mirror에만 존재)            │
│                                                         │
│  Anthropic API   API Key는 환경변수로만 전달             │
│                  소스 코드가 AI로 전송됨                  │
│                  → 고객사에 Anthropic 데이터 정책 공유   │
│                  → 민감 코드 제외 옵션 제공               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 9. 개발 우선순위 로드맵

```
Phase 1 (MVP — 4주)
━━━━━━━━━━━━━━━━━━
  ✓ 크롬 익스텐션 (요소 선택 + SaaS 연동)
  ✓ SaaS 웹 기본 화면 (컴포넌트 뷰, 정책 CRUD)
  ✓ Spring Boot API (정책/컴포넌트 CRUD)
  ✓ Oracle 스키마 생성 + seed 데이터
  ✓ 수동 정책 등록/수정/검색

Phase 2 (Git + AI — 3주)
━━━━━━━━━━━━━━━━━━━━━━
  ✓ Git Mirror Daemon (clone + webhook + 주기적 fetch)
  ✓ 분석 워커 기본 (Agent SDK 연동)
  ✓ 변경 요청 → AI 분석 → TODO 생성 파이프라인
  ✓ 분석 작업 큐 (Oracle 기반)

Phase 3 (기획 지원 — 3주)
━━━━━━━━━━━━━━━━━━━━━━━
  ✓ 정책 상속/충돌 감지
  ✓ 신규 화면 기획 워크플로우
  ✓ AI 유사 화면 분석
  ✓ 기획서 자동 생성

Phase 4 (완성도 — 2주)
━━━━━━━━━━━━━━━━━━━━━
  ✓ TODO 칸반 보드 + 프롬프트 내보내기
  ✓ 테스트 체크리스트 자동 생성
  ✓ data-pb-id 빌드 플러그인 (Next.js)
  ✓ 실시간 알림 (SSE)
  ✓ UI 다듬기 + 문서화
```
