# PlanBridge 정책 관리 & 화면 기획 시스템 설계서

---

## 1. 시스템이 해결하는 문제

```
현재 기획 현실:
─────────────
- 정책이 기획서(PPT/Figma), 메신저, 개발자 머릿속에 흩어져 있음
- "이 버튼 왜 이렇게 동작해?" → 아무도 모름
- 신규 화면 기획 시 기존 정책과 충돌 → 개발 후에야 발견
- 유효성 검증 규칙이 화면마다 제각각 → QA에서 반복 지적

PlanBridge가 만드는 상태:
──────────────────────
- 모든 정책이 컴포넌트에 귀속되어 자동 축적
- "이 버튼 왜 이렇게?" → 클릭 한 번으로 전체 이력 확인
- 신규 화면 기획 시 → 기존 정책/컴포넌트를 검색하고 재사용
- 유효성 검증 규칙 → 중앙 관리, 일관성 자동 검증
```

---

## 2. 정책 체계 설계

### 2.1 정책의 6가지 유형

```
┌─────────────────────────────────────────────────────────────┐
│                     정책 분류 체계                           │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  UI_SPEC     │  화면에 보이는 것 자체의 정의                │
│              │  예: "상품명은 최대 2줄, 초과 시 말줄임"     │
│              │  예: "가격은 천단위 콤마 + '원' 접미사"      │
│              │                                              │
│  INTERACTION │  사용자 조작에 대한 반응                      │
│              │  예: "장바구니 버튼 클릭 → 토스트 3초 노출"  │
│              │  예: "삭제 버튼 → 확인 모달 선행"            │
│              │                                              │
│  VALIDATION  │  입력값 검증 규칙                             │
│              │  예: "이메일: RFC 5322 형식, 최대 254자"     │
│              │  예: "비밀번호: 8자 이상, 영문+숫자+특수문자"│
│              │                                              │
│  BIZ_RULE    │  비즈니스 로직/조건                           │
│              │  예: "미성년자는 주류 카테고리 접근 불가"     │
│              │  예: "할인율 최대 70%, 관리자만 80%까지"     │
│              │                                              │
│  DATA_SPEC   │  API/데이터 연동 스펙                        │
│              │  예: "GET /api/products, 페이징 20건 단위"   │
│              │  예: "정렬 기본값: 최신순, 옵션: 가격순"     │
│              │                                              │
│  PERMISSION  │  권한/접근 제어                               │
│              │  예: "일반 관리자: 조회만, 슈퍼관리자: CRUD" │
│              │  예: "비회원: 장바구니 세션저장, 결제 불가"   │
│              │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

### 2.2 정책의 적용 범위 (Scope)

정책은 특정 컴포넌트에만 적용되기도 하고, 전체 시스템에 걸쳐 적용되기도 합니다.

```
GLOBAL        시스템 전체에 적용
              예: "모든 금액 표시는 천단위 콤마 필수"
              예: "API 에러 시 공통 에러 모달 표시"
                │
PAGE          특정 페이지에 적용
              예: "상품 목록 페이지는 무한스크롤"
              예: "주문 페이지는 뒤로가기 시 확인 모달"
                │
COMPONENT     특정 컴포넌트에 적용
              예: "DatePicker는 과거 날짜 선택 불가"
              예: "ProductCard 가격은 소수점 버림"
                │
ELEMENT       특정 요소에 적용
              예: "이 버튼은 disabled 시 툴팁 표시"
```

---

## 3. Oracle DB 스키마 (정책 관리 중심)

### 3.1 이전 설계에서 추가/변경되는 테이블

```sql
------------------------------------------------------
-- 1. 정책 마스터 (이전 PB_POLICY_LOG를 대체)
--    정책의 "현재 유효한 버전"을 관리
------------------------------------------------------
CREATE TABLE PB_POLICY (
    POLICY_ID       VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    
    -- 적용 대상 (범위에 따라 선택적 입력)
    SCOPE           VARCHAR2(20)   NOT NULL,  -- GLOBAL, PAGE, COMPONENT, ELEMENT
    PAGE_ID         VARCHAR2(36)   REFERENCES PB_PAGE(PAGE_ID),
    COMPONENT_ID    VARCHAR2(36)   REFERENCES PB_COMPONENT(COMPONENT_ID),
    
    -- 정책 내용
    POLICY_TYPE     VARCHAR2(30)   NOT NULL,
    -- UI_SPEC, INTERACTION, VALIDATION, BIZ_RULE, DATA_SPEC, PERMISSION
    POLICY_TITLE    VARCHAR2(500)  NOT NULL,   -- 한 줄 요약
    POLICY_CONTENT  CLOB           NOT NULL,   -- 상세 내용 (마크다운)
    
    -- 구조화된 정책 데이터 (AI가 활용)
    POLICY_SCHEMA   CLOB,          -- JSON: 정형화된 정책 (아래 3.2 참조)
    
    -- 태그 (검색/재사용용)
    TAGS            VARCHAR2(2000),  -- 콤마 구분: "결제,금액,포맷,공통"
    
    -- 상태 관리
    CURRENT_VERSION NUMBER(5)      DEFAULT 1,
    STATUS          VARCHAR2(20)   DEFAULT 'ACTIVE',
    -- ACTIVE, DEPRECATED, DRAFT, ARCHIVED
    
    CREATED_BY      VARCHAR2(100)  NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_BY      VARCHAR2(100),
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

CREATE INDEX IDX_PB_POLICY_SCOPE   ON PB_POLICY(SCOPE, STATUS);
CREATE INDEX IDX_PB_POLICY_TYPE    ON PB_POLICY(POLICY_TYPE);
CREATE INDEX IDX_PB_POLICY_COMP    ON PB_POLICY(COMPONENT_ID);
CREATE INDEX IDX_PB_POLICY_PAGE    ON PB_POLICY(PAGE_ID);
CREATE INDEX IDX_PB_POLICY_PROJECT ON PB_POLICY(PROJECT_ID, STATUS);

-- 전문 검색 인덱스 (정책 내용 검색용)
CREATE INDEX IDX_PB_POLICY_CONTENT ON PB_POLICY(POLICY_CONTENT)
    INDEXTYPE IS CTXSYS.CONTEXT
    PARAMETERS ('SYNC (ON COMMIT)');

------------------------------------------------------
-- 2. 정책 버전 이력
------------------------------------------------------
CREATE TABLE PB_POLICY_VERSION (
    VERSION_ID      VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    POLICY_ID       VARCHAR2(36)   NOT NULL REFERENCES PB_POLICY(POLICY_ID),
    VERSION_NO      NUMBER(5)      NOT NULL,
    
    POLICY_CONTENT  CLOB           NOT NULL,
    POLICY_SCHEMA   CLOB,
    
    -- 변경 사유
    CHANGE_REASON   VARCHAR2(2000),
    REQUEST_ID      VARCHAR2(36)   REFERENCES PB_CHANGE_REQUEST(REQUEST_ID),
    
    CREATED_BY      VARCHAR2(100)  NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    
    CONSTRAINT UK_PB_POLICY_VER UNIQUE (POLICY_ID, VERSION_NO)
);

------------------------------------------------------
-- 3. 정책 연결 관계 (다대다)
--    하나의 정책이 여러 컴포넌트에, 
--    하나의 컴포넌트에 여러 정책이 적용 가능
------------------------------------------------------
CREATE TABLE PB_POLICY_LINK (
    LINK_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    POLICY_ID       VARCHAR2(36)   NOT NULL REFERENCES PB_POLICY(POLICY_ID),
    COMPONENT_ID    VARCHAR2(36)   NOT NULL REFERENCES PB_COMPONENT(COMPONENT_ID),
    
    LINK_TYPE       VARCHAR2(30)   DEFAULT 'APPLIED',
    -- APPLIED: 직접 적용
    -- INHERITED: 상위에서 상속
    -- REFERENCED: 참조 관계 (직접 적용은 아니지만 관련)
    
    OVERRIDE_CONTENT CLOB,          -- 상속받되 이 컴포넌트에서 재정의한 내용
    
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    
    CONSTRAINT UK_PB_POLICY_LINK UNIQUE (POLICY_ID, COMPONENT_ID)
);

------------------------------------------------------
-- 4. 유효성 검증 규칙 (VALIDATION 정책의 구조화 버전)
------------------------------------------------------
CREATE TABLE PB_VALIDATION_RULE (
    RULE_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    POLICY_ID       VARCHAR2(36)   NOT NULL REFERENCES PB_POLICY(POLICY_ID),
    
    FIELD_NAME      VARCHAR2(200)  NOT NULL,   -- 대상 필드명
    RULE_TYPE       VARCHAR2(50)   NOT NULL,
    -- REQUIRED, MIN_LENGTH, MAX_LENGTH, PATTERN, RANGE, 
    -- CUSTOM, CONDITIONAL, CROSS_FIELD, ASYNC
    
    RULE_PARAMS     CLOB           NOT NULL,   -- JSON (아래 3.3 참조)
    ERROR_MESSAGE   VARCHAR2(1000) NOT NULL,   -- 검증 실패 메시지
    ERROR_MESSAGE_EN VARCHAR2(1000),           -- 영문 메시지 (optional)
    
    PRIORITY        NUMBER(3)      DEFAULT 1,  -- 검증 순서
    IS_ACTIVE       CHAR(1)        DEFAULT 'Y',
    
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 5. 화면 기획서 (신규 화면 기획용)
------------------------------------------------------
CREATE TABLE PB_SCREEN_PLAN (
    PLAN_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    
    -- 기본 정보
    PLAN_TITLE      VARCHAR2(500)  NOT NULL,
    ROUTE_PATH      VARCHAR2(500),              -- 계획된 라우트
    DESCRIPTION     CLOB,                       -- 화면 개요
    
    -- 기획 내용
    WIREFRAME_JSON  CLOB,          -- 와이어프레임 구조 (JSON)
    FULL_SPEC       CLOB,          -- 전체 기획 스펙 (마크다운)
    
    -- AI 생성 결과
    AI_SUGGESTION   CLOB,          -- AI가 제안한 구조/정책 (JSON)
    
    -- 상태
    STATUS          VARCHAR2(20)   DEFAULT 'DRAFT',
    -- DRAFT → REVIEW → APPROVED → DEVELOPMENT → COMPLETED
    
    -- 연결
    PAGE_ID         VARCHAR2(36)   REFERENCES PB_PAGE(PAGE_ID),  -- 개발 완료 후 연결
    
    CREATED_BY      VARCHAR2(100)  NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 6. 화면 기획서 ↔ 정책 연결 (재사용)
------------------------------------------------------
CREATE TABLE PB_PLAN_POLICY (
    ID              VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PLAN_ID         VARCHAR2(36)   NOT NULL REFERENCES PB_SCREEN_PLAN(PLAN_ID),
    POLICY_ID       VARCHAR2(36)   NOT NULL REFERENCES PB_POLICY(POLICY_ID),
    
    USAGE_TYPE      VARCHAR2(30)   NOT NULL,
    -- REUSE: 기존 정책 그대로 적용
    -- MODIFY: 기존 정책 기반 수정 적용
    -- REFERENCE: 참고만 함
    
    MODIFIED_CONTENT CLOB,          -- MODIFY인 경우 수정 내용
    NOTES           VARCHAR2(2000), -- 기획자 메모
    
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 7. 컴포넌트 템플릿 (재사용 가능한 패턴)
------------------------------------------------------
CREATE TABLE PB_COMPONENT_TEMPLATE (
    TEMPLATE_ID     VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    
    TEMPLATE_NAME   VARCHAR2(200)  NOT NULL,
    TEMPLATE_DESC   VARCHAR2(2000),
    CATEGORY        VARCHAR2(100),  -- FORM, TABLE, CARD, MODAL, NAV, ...
    
    -- 템플릿 구조
    STRUCTURE_JSON  CLOB           NOT NULL,  -- 컴포넌트 트리 구조
    DEFAULT_POLICIES CLOB,          -- 기본 적용되는 정책 ID 목록 (JSON)
    
    -- 원본 참조
    SOURCE_COMPONENT_ID VARCHAR2(36) REFERENCES PB_COMPONENT(COMPONENT_ID),
    
    USAGE_COUNT     NUMBER(5)      DEFAULT 0,
    TAGS            VARCHAR2(2000),
    
    CREATED_BY      VARCHAR2(100)  NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);
```

### 3.2 POLICY_SCHEMA 구조 (정형화된 정책)

기획자가 자연어로 입력하면 AI가 구조화합니다.

```json
// UI_SPEC 예시
{
  "type": "UI_SPEC",
  "rules": [
    {
      "target": "text",
      "property": "maxLines",
      "value": 2,
      "overflow": "ellipsis"
    },
    {
      "target": "price",
      "property": "format",
      "value": "###,###원",
      "decimalHandling": "floor"
    }
  ]
}

// VALIDATION 예시
{
  "type": "VALIDATION",
  "fields": [
    {
      "name": "email",
      "rules": [
        { "type": "REQUIRED", "message": "이메일을 입력해주세요" },
        { "type": "PATTERN", "value": "^[\\w.-]+@[\\w.-]+\\.\\w+$", "message": "이메일 형식이 올바르지 않습니다" },
        { "type": "MAX_LENGTH", "value": 254, "message": "이메일은 254자 이내로 입력해주세요" }
      ]
    }
  ]
}

// BIZ_RULE 예시
{
  "type": "BIZ_RULE",
  "conditions": [
    {
      "when": "user.age < 19",
      "then": "block_access",
      "target": "alcohol_category",
      "message": "미성년자는 주류 카테고리에 접근할 수 없습니다"
    }
  ]
}

// PERMISSION 예시
{
  "type": "PERMISSION",
  "matrix": [
    { "role": "VIEWER",      "actions": ["READ"] },
    { "role": "ADMIN",       "actions": ["READ", "CREATE", "UPDATE"] },
    { "role": "SUPER_ADMIN", "actions": ["READ", "CREATE", "UPDATE", "DELETE"] }
  ]
}
```

### 3.3 VALIDATION RULE_PARAMS 구조

```json
// REQUIRED
{ "allowEmpty": false, "allowWhitespace": false }

// MIN_LENGTH / MAX_LENGTH
{ "value": 8, "countType": "character" }  // character | byte

// PATTERN (정규식)
{ "pattern": "^\\d{3}-\\d{4}-\\d{4}$", "flags": "" }

// RANGE (숫자 범위)
{ "min": 1, "max": 100, "inclusive": true }

// CONDITIONAL (조건부 검증)
{
  "condition": { "field": "paymentType", "equals": "CARD" },
  "thenRules": [
    { "type": "REQUIRED" },
    { "type": "PATTERN", "pattern": "^\\d{16}$" }
  ]
}

// CROSS_FIELD (필드 간 검증)
{
  "compareField": "passwordConfirm",
  "operator": "EQUALS",
  "message": "비밀번호가 일치하지 않습니다"
}

// ASYNC (서버 검증)
{
  "endpoint": "/api/check-duplicate-email",
  "method": "POST",
  "debounceMs": 500,
  "message": "이미 사용 중인 이메일입니다"
}
```

---

## 4. 기획자 워크플로우

### 4.1 기존 화면 정책 관리

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  기획자가 크롬 익스텐션에서 요소 선택                       │
│                 │                                           │
│                 ▼                                           │
│  ┌─────────────────────────────────────┐                    │
│  │      Side Panel: 정책 관리 뷰       │                    │
│  │                                     │                    │
│  │  선택된 요소: [ProductCard.Price]    │                    │
│  │  컴포넌트: ProductCard              │                    │
│  │  페이지: /products                  │                    │
│  │                                     │                    │
│  │  ┌─── 탭 ───────────────────────┐   │                    │
│  │  │ 적용 정책 │ 상속 정책 │ 이력  │   │                    │
│  │  └───────────────────────────────┘   │                    │
│  │                                     │                    │
│  │  ◆ 직접 적용된 정책 (3건)          │                    │
│  │  ┌───────────────────────────────┐  │                    │
│  │  │ [UI_SPEC] 가격 표시 포맷       │  │                    │
│  │  │ 천단위 콤마 + '원' 접미사      │  │                    │
│  │  │ 소수점 이하 버림               │  │                    │
│  │  │ v3 │ 2024.12.15 수정          │  │                    │
│  │  │        [수정] [이력] [삭제]    │  │                    │
│  │  └───────────────────────────────┘  │                    │
│  │  ┌───────────────────────────────┐  │                    │
│  │  │ [BIZ_RULE] 할인가 표시 조건    │  │                    │
│  │  │ 할인율 5% 이상일 때만 표시     │  │                    │
│  │  │ 원가에 취소선 + 할인가 빨간색  │  │                    │
│  │  │ v1 │ 2024.11.02 생성          │  │                    │
│  │  │        [수정] [이력] [삭제]    │  │                    │
│  │  └───────────────────────────────┘  │                    │
│  │  ┌───────────────────────────────┐  │                    │
│  │  │ [VALIDATION] 수량 입력 검증    │  │                    │
│  │  │ 1~999 정수만 허용              │  │                    │
│  │  │ v2 │ 2024.12.20 수정          │  │                    │
│  │  │        [수정] [이력] [삭제]    │  │                    │
│  │  └───────────────────────────────┘  │                    │
│  │                                     │                    │
│  │  ◇ 상속된 정책 (2건)              │                    │
│  │  ┌───────────────────────────────┐  │                    │
│  │  │ [UI_SPEC] 공통 폰트 규칙  🔗  │  │                    │
│  │  │ 적용 범위: GLOBAL              │  │                    │
│  │  │ 본문 14px, 가격 16px bold     │  │                    │
│  │  │       [이 컴포넌트에서 재정의] │  │                    │
│  │  └───────────────────────────────┘  │                    │
│  │  ┌───────────────────────────────┐  │                    │
│  │  │ [PERMISSION] 상품 접근 권한 🔗│  │                    │
│  │  │ 적용 범위: PAGE /products     │  │                    │
│  │  │ 비회원도 조회 가능             │  │                    │
│  │  └───────────────────────────────┘  │                    │
│  │                                     │                    │
│  │  [+ 새 정책 추가]                  │                    │
│  │                                     │                    │
│  └─────────────────────────────────────┘                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 정책 생성/수정 플로우

```
기획자가 [+ 새 정책 추가] 또는 [수정] 클릭
              │
              ▼
┌──────────────────────────────────────────────────┐
│           정책 편집 모달                          │
│                                                  │
│  정책 유형:  [UI_SPEC ▼]                         │
│                                                  │
│  적용 범위:  ● 이 요소만  ○ 이 컴포넌트 전체    │
│              ○ 이 페이지 전체  ○ 전역(GLOBAL)    │
│                                                  │
│  제목:                                           │
│  ┌────────────────────────────────────────────┐  │
│  │ 할인가 뱃지 표시 규칙                      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  내용: (자연어로 자유롭게 작성)                  │
│  ┌────────────────────────────────────────────┐  │
│  │ 할인율이 10% 이상일 때 빨간색 뱃지로       │  │
│  │ "N% OFF"를 상품 이미지 좌측 상단에 표시.   │  │
│  │ 뱃지는 라운드 처리하고, 50% 이상이면       │  │
│  │ "MEGA SALE"로 텍스트 변경.                 │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  태그: [할인] [뱃지] [상품카드] [+]              │
│                                                  │
│  ──── AI 구조화 미리보기 ────                    │
│  (자동 생성, 수정 가능)                          │
│  ┌────────────────────────────────────────────┐  │
│  │ {                                          │  │
│  │   "type": "UI_SPEC",                      │  │
│  │   "rules": [                              │  │
│  │     {                                     │  │
│  │       "condition": "discountRate >= 10",  │  │
│  │       "display": "badge",                 │  │
│  │       "position": "top-left",             │  │
│  │       "text": "{discountRate}% OFF",      │  │
│  │       "style": { "color": "red",          │  │
│  │                   "borderRadius": "4px" }  │  │
│  │     },                                    │  │
│  │     {                                     │  │
│  │       "condition": "discountRate >= 50",  │  │
│  │       "override": "text",                 │  │
│  │       "text": "MEGA SALE"                 │  │
│  │     }                                     │  │
│  │   ]                                       │  │
│  │ }                                         │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  변경 사유: (수정 시)                            │
│  ┌────────────────────────────────────────────┐  │
│  │ 마케팅팀 요청으로 50% 이상 MEGA SALE 추가  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│            [임시저장]  [저장]  [취소]             │
│                                                  │
└──────────────────────────────────────────────────┘

              │ 저장 시
              ▼

1. PB_POLICY 테이블에 INSERT 또는 UPDATE
2. 수정이면 PB_POLICY_VERSION에 이전 버전 기록
3. AI가 자연어 → POLICY_SCHEMA 자동 변환
4. VALIDATION 타입이면 PB_VALIDATION_RULE에도 구조화 저장
5. PB_POLICY_LINK로 컴포넌트 연결
```

### 4.3 정책 상속 & 재정의

```
                 GLOBAL 정책
                 "금액은 천단위 콤마"
                       │
                       │ 상속 (자동)
                       ▼
              PAGE: /products 정책
              "상품 가격은 '원' 접미사"
                       │
                       │ 상속 (자동)
                       ▼
           COMPONENT: ProductCard 정책
           (상속 그대로 사용)
                       │
                       │ 상속 + 재정의
                       ▼
           ELEMENT: ProductCard.Price
           재정의: "할인가는 빨간색, 원가는 회색 취소선"
           (금액 포맷은 상속, 색상만 재정의)
```

```sql
-- 특정 컴포넌트에 적용되는 모든 정책 조회 (직접 + 상속)
-- Oracle 계층 쿼리 활용
WITH component_ancestors AS (
    -- 선택된 컴포넌트부터 루트까지의 모든 조상
    SELECT COMPONENT_ID, PARENT_ID, PAGE_ID, DEPTH_LEVEL
    FROM PB_COMPONENT
    START WITH COMPONENT_ID = :selected_component_id
    CONNECT BY PRIOR PARENT_ID = COMPONENT_ID
),
effective_policies AS (
    -- 1. 직접 적용된 정책
    SELECT p.*, 'APPLIED' AS LINK_TYPE, 1 AS PRIORITY_ORDER
    FROM PB_POLICY p
    JOIN PB_POLICY_LINK pl ON p.POLICY_ID = pl.POLICY_ID
    WHERE pl.COMPONENT_ID = :selected_component_id
      AND p.STATUS = 'ACTIVE'
    
    UNION ALL
    
    -- 2. 상위 컴포넌트에서 상속된 정책
    SELECT p.*, 'INHERITED' AS LINK_TYPE, 2 AS PRIORITY_ORDER
    FROM PB_POLICY p
    JOIN PB_POLICY_LINK pl ON p.POLICY_ID = pl.POLICY_ID
    JOIN component_ancestors ca ON pl.COMPONENT_ID = ca.COMPONENT_ID
    WHERE p.STATUS = 'ACTIVE'
      AND ca.COMPONENT_ID != :selected_component_id
    
    UNION ALL
    
    -- 3. 페이지 레벨 정책
    SELECT p.*, 'INHERITED' AS LINK_TYPE, 3 AS PRIORITY_ORDER
    FROM PB_POLICY p
    WHERE p.SCOPE = 'PAGE'
      AND p.PAGE_ID = (SELECT PAGE_ID FROM PB_COMPONENT 
                       WHERE COMPONENT_ID = :selected_component_id)
      AND p.STATUS = 'ACTIVE'
    
    UNION ALL
    
    -- 4. 글로벌 정책
    SELECT p.*, 'INHERITED' AS LINK_TYPE, 4 AS PRIORITY_ORDER
    FROM PB_POLICY p
    WHERE p.SCOPE = 'GLOBAL'
      AND p.PROJECT_ID = :project_id
      AND p.STATUS = 'ACTIVE'
)
SELECT * FROM effective_policies
ORDER BY PRIORITY_ORDER, POLICY_TYPE;
```

---

## 5. 신규 화면 기획 시스템

### 5.1 신규 화면 기획 플로우

```
기획자: "신규 화면 기획" 시작
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Step 1: 기본 정보 입력                                   │
│                                                          │
│  화면 제목: [주문 상세 페이지          ]                  │
│  라우트:    [/orders/[id]              ]                  │
│  설명:                                                   │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 주문 번호를 기반으로 주문 상세 정보를 보여주는     │  │
│  │ 페이지. 주문 상태, 상품 목록, 배송 정보, 결제      │  │
│  │ 정보를 포함. 관리자는 주문 상태를 변경할 수 있음.  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                               [다음 →]                   │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Step 2: AI가 기존 정책/컴포넌트 기반으로 제안            │
│                                                          │
│  ──── 유사 화면 분석 결과 ────                           │
│                                                          │
│  📄 기존 유사 페이지 발견:                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ /orders (주문 목록)  - 유사도 85%                  │  │
│  │ 공유 가능 정책 12건, 재사용 컴포넌트 5개           │  │
│  │                                   [상세보기] [적용]│  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ /products/[id] (상품 상세) - 유사도 62%            │  │
│  │ 공유 가능 정책 4건, 재사용 컴포넌트 2개            │  │
│  │                                   [상세보기] [적용]│  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  🧩 추천 컴포넌트 템플릿:                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ □ DataTable (범용 테이블) - 8회 사용               │  │
│  │ □ StatusBadge (상태 뱃지) - 12회 사용              │  │
│  │ □ DetailInfoCard (정보 카드) - 6회 사용            │  │
│  │ □ ActionButtonGroup (액션 버튼 그룹) - 5회 사용    │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  📋 자동 적용할 정책:                                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ✓ [GLOBAL] 공통 폰트 규칙                         │  │
│  │ ✓ [GLOBAL] API 에러 처리 정책                     │  │
│  │ ✓ [GLOBAL] 금액 표시 포맷                         │  │
│  │ ✓ [BIZ_RULE] 주문 상태 전이 규칙 (주문 목록에서)  │  │
│  │ □ [PERMISSION] 주문 관리 권한 (주문 목록에서)      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                          [← 이전]  [다음 →]              │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Step 3: 화면 구조 설계                                   │
│                                                          │
│  드래그&드롭으로 화면 구조를 구성합니다.                  │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────────────────┐  │
│  │ 컴포넌트 팔레트  │  │     화면 구조 캔버스          │  │
│  │                  │  │                              │  │
│  │ ◆ 추천 템플릿   │  │  ┌─ PageRoot ──────────────┐ │  │
│  │   DataTable      │  │  │                         │ │  │
│  │   StatusBadge    │  │  │ ┌─ Header Section ────┐ │ │  │
│  │   DetailInfoCard │  │  │ │ 주문번호 + 상태뱃지 │ │ │  │
│  │   ActionButtons  │  │  │ └─────────────────────┘ │ │  │
│  │                  │  │  │                         │ │  │
│  │ ◆ 기본 요소    │  │  │ ┌─ 상품 목록 ──────────┐│ │  │
│  │   Section        │  │  │ │  DataTable            ││ │  │
│  │   Card           │  │  │ │  (주문 목록에서 가져옴)│ │  │
│  │   Form           │  │  │ └───────────────────────┘│ │  │
│  │   Table          │  │  │                         │ │  │
│  │   Button         │  │  │ ┌─ 배송 정보 ──────────┐│ │  │
│  │   Input          │  │  │ │  DetailInfoCard       ││ │  │
│  │   Modal          │  │  │ └───────────────────────┘│ │  │
│  │                  │  │  │                         │ │  │
│  │ ◆ 기존 복제    │  │  │ ┌─ 액션 ────────────────┐│ │  │
│  │   (다른 페이지   │  │  │ │  ActionButtonGroup   ││ │  │
│  │    에서 가져오기) │  │  │ └───────────────────────┘│ │  │
│  │                  │  │  └─────────────────────────┘ │  │
│  └──────────────────┘  └──────────────────────────────┘  │
│                                                          │
│  각 컴포넌트 클릭 시 → 우측에 정책 편집 패널 표시        │
│                                                          │
│                          [← 이전]  [다음 →]              │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Step 4: 정책 검토 & 충돌 확인                            │
│                                                          │
│  AI가 전체 정책 일관성을 검증합니다.                     │
│                                                          │
│  ✅ 검증 통과 (14건)                                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ✓ 금액 표시 포맷 일관성 확인                       │  │
│  │ ✓ 권한 정책 - 기존 주문 관리 권한과 호환           │  │
│  │ ✓ API 스펙 - 기존 주문 API와 정합성 확인           │  │
│  │ ...                                                │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ⚠️ 충돌 감지 (2건)                                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⚠ 주문 상태 뱃지 색상                              │  │
│  │   주문 목록: "배송중" = 파란색                      │  │
│  │   이 화면: "배송중" = 녹색 (DetailInfoCard 기본값) │  │
│  │   → [주문 목록 기준 통일] [이 화면만 다르게] [무시]│  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⚠ 취소 버튼 정책 누락                              │  │
│  │   주문 취소 가능 조건이 정의되지 않았습니다         │  │
│  │   기존 정책: "결제 후 24시간 이내만 취소 가능"     │  │
│  │   → [기존 정책 적용] [새로 정의] [해당없음]        │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                [← 이전]  [기획서 생성]                    │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│  Step 5: 기획서 자동 생성                                 │
│                                                          │
│  AI가 입력된 모든 정보를 종합하여 기획서를 생성합니다.   │
│                                                          │
│  생성 항목:                                              │
│  ┌────────────────────────────────────────────────────┐  │
│  │ 📄 화면 기획서 (마크다운)                          │  │
│  │    - 화면 개요                                     │  │
│  │    - 컴포넌트 구조도                               │  │
│  │    - 컴포넌트별 상세 스펙                          │  │
│  │    - 적용 정책 목록                                │  │
│  │    - 유효성 검증 규칙                              │  │
│  │    - 권한 매트릭스                                 │  │
│  │    - API 연동 스펙                                 │  │
│  │                                                    │  │
│  │ 📋 개발 TODO 목록 (AI 프롬프트 포함)               │  │
│  │    - 페이지 생성                                   │  │
│  │    - 컴포넌트 구현 (순서대로)                      │  │
│  │    - API 연동                                      │  │
│  │    - 유효성 검증 적용                              │  │
│  │    - 권한 처리 적용                                │  │
│  │                                                    │  │
│  │ ✅ 테스트 체크리스트                               │  │
│  │    - 정책 기반 자동 생성                           │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│         [기획서 보기]  [TODO 생성]  [내보내기]            │
└──────────────────────────────────────────────────────────┘
```

### 5.2 AI 유사 화면 분석 로직

```sql
-- 신규 화면과 기존 화면의 유사도 계산
-- 키워드 + 정책 유형 + 컴포넌트 패턴 기반

WITH new_screen_keywords AS (
    -- 기획자가 입력한 설명에서 키워드 추출 (AI 전처리)
    SELECT :keyword AS KEYWORD FROM DUAL
    -- 예: '주문', '상세', '상태', '배송', '결제'
),
page_scores AS (
    SELECT 
        p.PAGE_ID,
        p.ROUTE_PATH,
        p.PAGE_TITLE,
        
        -- 1. 정책 키워드 매칭 점수
        (SELECT COUNT(*) 
         FROM PB_POLICY pol 
         WHERE pol.PAGE_ID = p.PAGE_ID 
           AND pol.STATUS = 'ACTIVE'
           AND CONTAINS(pol.POLICY_CONTENT, :search_keywords) > 0
        ) AS policy_match_score,
        
        -- 2. 컴포넌트 구조 유사도 (같은 타입 컴포넌트 수)
        (SELECT COUNT(*) 
         FROM PB_COMPONENT c 
         WHERE c.PAGE_ID = p.PAGE_ID
           AND c.COMPONENT_TYPE IN (:required_types)
        ) AS structure_score,
        
        -- 3. 태그 매칭
        (SELECT COUNT(*)
         FROM PB_POLICY pol
         WHERE pol.PAGE_ID = p.PAGE_ID
           AND pol.STATUS = 'ACTIVE'
           AND (pol.TAGS LIKE '%주문%' OR pol.TAGS LIKE '%상태%')
        ) AS tag_score
        
    FROM PB_PAGE p
    WHERE p.PROJECT_ID = :project_id
)
SELECT 
    PAGE_ID, ROUTE_PATH, PAGE_TITLE,
    (policy_match_score * 3 + structure_score * 2 + tag_score * 1) AS similarity_score
FROM page_scores
WHERE (policy_match_score + structure_score + tag_score) > 0
ORDER BY similarity_score DESC
FETCH FIRST 5 ROWS ONLY;
```

### 5.3 정책 충돌 감지 로직

```
AI 분석 시스템 프롬프트:
─────────────────────

너는 기획 정책 일관성 검증 전문가야.
신규 화면에 적용될 정책 목록과 기존 시스템의 정책을 비교해서 
충돌이나 누락을 찾아줘.

[검증 항목]
1. 같은 UI 요소에 대한 상반된 스타일 정책
   예: 같은 상태값인데 색상이 다름
2. 비즈니스 규칙 간 모순
   예: A 화면에서는 허용하는 걸 B 화면에서 금지
3. 유효성 검증 규칙 불일치
   예: 같은 필드인데 검증 기준이 다름
4. 권한 정책 누락
   예: CRUD 중 일부 권한만 정의됨
5. API 스펙 불일치
   예: 같은 데이터인데 다른 엔드포인트/포맷

[입력]
- 신규 화면 정책: {new_policies}
- 기존 관련 정책: {existing_policies}
- 글로벌 정책: {global_policies}

[출력 형식]
{
  "passed": [...],     // 검증 통과 항목
  "conflicts": [...],  // 충돌 감지
  "missing": [...],    // 누락 정책
  "suggestions": [...]  // AI 제안
}
```

---

## 6. 정책 기반 자동 테스트 체크리스트

```
정책으로부터 테스트 항목이 자동 생성됩니다.

정책: [VALIDATION] 이메일 입력 검증
  → □ 빈 값 입력 시 "이메일을 입력해주세요" 노출 확인
  → □ "abc" 입력 시 "이메일 형식이 올바르지 않습니다" 노출 확인
  → □ 정상 이메일 입력 시 에러 미노출 확인
  → □ 255자 초과 입력 시 "254자 이내로 입력해주세요" 노출 확인

정책: [BIZ_RULE] 주문 취소 조건
  → □ 결제 후 24시간 이내 취소 버튼 활성화 확인
  → □ 결제 후 24시간 초과 취소 버튼 비활성화 확인
  → □ 비로그인 상태에서 취소 버튼 미노출 확인

정책: [PERMISSION] 주문 관리 권한
  → □ VIEWER 역할: 조회만 가능, 수정 버튼 미노출 확인
  → □ ADMIN 역할: 상태 변경 버튼 노출 확인
  → □ SUPER_ADMIN 역할: 삭제 버튼 노출 확인
```

---

## 7. 전체 데이터 흐름 요약

```
┌──────────────────────────────────────────────────────────────┐
│                    기존 화면 정책 관리                        │
│                                                              │
│  요소 선택 → 정책 조회 → 기획자 수정/추가 → AI 구조화 →    │
│  Oracle 저장 → 버전 이력 자동 기록                           │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                    정책이 축적됨
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    신규 화면 기획                             │
│                                                              │
│  화면 설명 입력 → AI가 유사 화면/정책 검색 →                │
│  재사용할 정책/컴포넌트 선택 → 화면 구조 설계 →             │
│  AI 충돌 검증 → 기획서 자동 생성 → TODO 생성                │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                    TODO가 생성됨
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    개발 & 테스트                              │
│                                                              │
│  Claude Code로 TODO 실행 → 자동 테스트 → 기획자 수기 검증 → │
│  운영 반영 → 정책 확정 → 다시 정책 DB로 축적                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                           │
                    순환 구조: 
                    기획 → 정책 축적 → 다음 기획에 활용
```
