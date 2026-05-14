# PlanBridge 크롬 익스텐션 — 요소 식별 & 메타데이터 매핑 설계서

---

## 1. 풀어야 할 핵심 문제

기획자가 웹 페이지에서 특정 영역을 클릭했을 때, AI에게 **"이건 `ProductCard` 컴포넌트 안의 `AddToCartButton`이고, 현재 props는 이러하며, 페이지 구조상 이 위치에 있다"**라고 정확히 전달해야 합니다.

이를 위해 두 가지가 필요합니다:

```
① 사전 등록: 페이지의 컴포넌트 구조를 미리 스캔해서 Oracle DB에 저장
② 런타임 매핑: 기획자가 클릭한 DOM 요소 → DB의 메타데이터로 즉시 연결
```

---

## 2. 요소 식별 전략 (3-Layer Fingerprint)

하나의 식별자만으로는 불안정합니다. DOM은 동적이니까요.
**3겹 식별자를 조합**해서 안정적으로 매핑합니다.

```
┌─────────────────────────────────────────────────────┐
│              3-Layer Fingerprint                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Layer 1: data-pb-id (확정적 식별자)                │
│  ─────────────────────────────────────              │
│  빌드 타임에 컴포넌트에 주입하는 커스텀 속성        │
│  예: <button data-pb-id="ProductCard.AddToCart">    │
│  → 가장 정확하고 안정적                             │
│  → Next.js Babel/SWC 플러그인으로 자동 주입         │
│                                                     │
│  Layer 2: React Fiber 역추적 (런타임 식별자)        │
│  ─────────────────────────────────────              │
│  DOM 요소 → __reactFiber$ → 컴포넌트 트리 순회     │
│  → data-pb-id가 없는 요소도 컴포넌트명 추출 가능   │
│  → 동적 렌더링된 요소 대응                          │
│                                                     │
│  Layer 3: 구조적 CSS Selector (폴백)                │
│  ─────────────────────────────────────              │
│  예: main > div:nth-child(2) > button.btn-primary   │
│  → Layer 1,2가 모두 실패할 때의 최후 수단           │
│  → DOM 구조 변경에 취약하지만 없는 것보다 나음      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 우선순위 로직

```
클릭 발생
  → data-pb-id 있음? → 바로 DB 매핑 (99% 정확)
  → 없음 → React Fiber에서 컴포넌트명 추출
         → DB에서 컴포넌트명 + 페이지 경로로 검색 (90% 정확)
  → 그래도 없음 → CSS Selector로 가장 가까운 등록 요소 탐색 (70% 정확)
  → 전부 실패 → "미등록 요소"로 표시, 신규 등록 제안
```

---

## 3. data-pb-id 자동 주입 (Next.js 빌드 플러그인)

### 3.1 ID 규칙

```
형식: {PageRoute}.{ComponentName}.{ElementRole}
예시:
  /products      → "products"
  ProductCard    → "products.ProductCard"
  AddToCart 버튼 → "products.ProductCard.AddToCartButton"
```

### 3.2 Next.js SWC 플러그인 (next.config.js)

개발/스테이징 빌드에서만 활성화합니다. 프로덕션에는 포함하지 않습니다.

```javascript
// next.config.js
module.exports = {
  compiler: {
    reactRemoveProperties: process.env.NODE_ENV === 'production'
      ? { properties: ['^data-pb-'] }  // 프로덕션에서 제거
      : false
  },
  // 커스텀 Babel 플러그인 (개발/스테이징용)
  webpack(config, { dev }) {
    if (dev || process.env.PLANBRIDGE_ENABLED === 'true') {
      config.module.rules.push({
        test: /\.(tsx|jsx)$/,
        use: [{
          loader: 'planbridge-id-loader',
          options: { prefix: 'pb' }
        }]
      });
    }
    return config;
  }
};
```

### 3.3 Babel 플러그인 동작 원리

```
입력 (개발자가 작성한 코드):
──────────────────────────────
export default function ProductCard({ product }) {
  return (
    <div className="card">
      <h3>{product.name}</h3>
      <button onClick={handleAddToCart}>
        담기
      </button>
    </div>
  );
}

출력 (빌드 후):
──────────────────────────────
export default function ProductCard({ product }) {
  return (
    <div className="card" data-pb-id="ProductCard" data-pb-type="component">
      <h3 data-pb-id="ProductCard.title" data-pb-type="element">{product.name}</h3>
      <button data-pb-id="ProductCard.button_0" data-pb-type="element"
              onClick={handleAddToCart}>
        담기
      </button>
    </div>
  );
}
```

---

## 4. React Fiber 역추적 (Layer 2 상세)

Content Script에서 직접 접근 불가 → **페이지에 스크립트를 주입**해서 처리합니다.

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Content Script  │────▶│  Injected Script │────▶│  React Fiber     │
│  (격리된 환경)   │ msg │  (페이지 context) │     │  (내부 속성)     │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

### Fiber에서 추출하는 정보

```javascript
// injected-script.js (페이지 context에서 실행)
function extractReactInfo(domElement) {
  // React 18 Fiber 접근
  const fiberKey = Object.keys(domElement).find(
    key => key.startsWith('__reactFiber$')
  );
  if (!fiberKey) return null;

  const fiber = domElement[fiberKey];
  
  // 컴포넌트 트리를 위로 순회하며 정보 수집
  const hierarchy = [];
  let current = fiber;
  while (current) {
    if (typeof current.type === 'function' || typeof current.type === 'object') {
      hierarchy.unshift({
        name: current.type.displayName || current.type.name || 'Anonymous',
        props: sanitizeProps(current.memoizedProps),  // 함수/순환참조 제거
        key: current.key
      });
    }
    current = current.return;
  }

  return {
    componentName: hierarchy[hierarchy.length - 1]?.name,
    hierarchy: hierarchy,                    // 전체 컴포넌트 경로
    props: fiber.memoizedProps,
    stateKeys: extractStateKeys(fiber),      // useState 키 힌트
  };
}

function sanitizeProps(props) {
  if (!props) return {};
  const safe = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') safe[key] = `[Function: ${key}]`;
    else if (typeof value === 'object' && value !== null) {
      try { JSON.stringify(value); safe[key] = value; }
      catch { safe[key] = '[Complex Object]'; }
    }
    else safe[key] = value;
  }
  return safe;
}
```

---

## 5. Oracle DB 스키마

### 5.1 ERD 개요

```
PB_PROJECT (프로젝트)
    │
    ├── PB_PAGE (페이지/라우트)
    │       │
    │       └── PB_COMPONENT (컴포넌트 — 자기참조 계층)
    │               │
    │               ├── PB_COMPONENT_SNAPSHOT (스캔 시점 스냅샷)
    │               │
    │               ├── PB_CHANGE_REQUEST (변경 요청)
    │               │       │
    │               │       ├── PB_TODO_ITEM (AI 생성 태스크)
    │               │       │
    │               │       └── PB_TEST_CHECKLIST (테스트 항목)
    │               │
    │               └── PB_POLICY_LOG (정책 이력)
    │
    └── PB_SCAN_HISTORY (스캔 이력)
```

### 5.2 DDL

```sql
------------------------------------------------------
-- 1. 프로젝트
------------------------------------------------------
CREATE TABLE PB_PROJECT (
    PROJECT_ID      VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_NAME    VARCHAR2(200)  NOT NULL,
    PROJECT_DESC    VARCHAR2(4000),
    REPO_URL        VARCHAR2(500),
    BASE_URL        VARCHAR2(500),          -- 대상 사이트 기본 URL
    FRAMEWORK       VARCHAR2(50)   DEFAULT 'NEXTJS',  -- NEXTJS, REACT, VUE
    STATUS          VARCHAR2(20)   DEFAULT 'ACTIVE',
    CREATED_BY      VARCHAR2(100)  NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 2. 페이지 (Next.js 라우트 단위)
------------------------------------------------------
CREATE TABLE PB_PAGE (
    PAGE_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    ROUTE_PATH      VARCHAR2(500)  NOT NULL,   -- /products, /products/[id]
    PAGE_TITLE      VARCHAR2(200),
    FILE_PATH       VARCHAR2(500),              -- app/products/page.tsx
    LAYOUT_PATH     VARCHAR2(500),              -- app/products/layout.tsx
    STATUS          VARCHAR2(20)   DEFAULT 'ACTIVE',
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    CONSTRAINT UK_PB_PAGE UNIQUE (PROJECT_ID, ROUTE_PATH)
);

------------------------------------------------------
-- 3. 컴포넌트 (핵심 — 자기참조 계층 구조)
------------------------------------------------------
CREATE TABLE PB_COMPONENT (
    COMPONENT_ID    VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PAGE_ID         VARCHAR2(36)   NOT NULL REFERENCES PB_PAGE(PAGE_ID),
    PARENT_ID       VARCHAR2(36)   REFERENCES PB_COMPONENT(COMPONENT_ID),
    
    -- 3-Layer Fingerprint
    PB_ID           VARCHAR2(500)  NOT NULL,    -- data-pb-id 값 (Layer 1)
    COMPONENT_NAME  VARCHAR2(200)  NOT NULL,    -- React 컴포넌트명 (Layer 2)
    CSS_SELECTOR    VARCHAR2(2000),             -- 구조적 CSS 셀렉터 (Layer 3)
    
    -- 컴포넌트 메타데이터
    COMPONENT_TYPE  VARCHAR2(30)   NOT NULL,    -- PAGE_ROOT, LAYOUT, SECTION, COMPONENT, ELEMENT
    ELEMENT_TAG     VARCHAR2(50),               -- div, button, input, a ...
    ELEMENT_ROLE    VARCHAR2(100),              -- navigation, form, list, card, modal ...
    
    -- 현재 상태 정보
    CURRENT_PROPS   CLOB,                       -- JSON: 현재 props 스냅샷
    CURRENT_TEXT    VARCHAR2(4000),              -- 표시 텍스트
    CURRENT_SPEC    CLOB,                       -- 현재 기획 스펙 (마크다운)
    
    -- 위치/구조 정보
    DEPTH_LEVEL     NUMBER(3)      DEFAULT 0,   -- 트리 깊이
    SORT_ORDER      NUMBER(5)      DEFAULT 0,
    TREE_PATH       VARCHAR2(2000),             -- /root/Header/Nav/MenuButton (빠른 조회용)
    
    -- React 컴포넌트 경로 (hierarchy)
    REACT_HIERARCHY CLOB,                       -- JSON: ["App","Layout","Header","NavButton"]
    
    STATUS          VARCHAR2(20)   DEFAULT 'ACTIVE',
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    
    CONSTRAINT UK_PB_COMPONENT UNIQUE (PAGE_ID, PB_ID)
);

-- 계층 조회 성능을 위한 인덱스
CREATE INDEX IDX_PB_COMP_PARENT  ON PB_COMPONENT(PARENT_ID);
CREATE INDEX IDX_PB_COMP_PAGE    ON PB_COMPONENT(PAGE_ID);
CREATE INDEX IDX_PB_COMP_PBID    ON PB_COMPONENT(PB_ID);
CREATE INDEX IDX_PB_COMP_NAME    ON PB_COMPONENT(COMPONENT_NAME);
CREATE INDEX IDX_PB_COMP_TREE    ON PB_COMPONENT(TREE_PATH);

------------------------------------------------------
-- 4. 컴포넌트 스냅샷 (스캔할 때마다 저장)
------------------------------------------------------
CREATE TABLE PB_COMPONENT_SNAPSHOT (
    SNAPSHOT_ID     VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    COMPONENT_ID    VARCHAR2(36)   NOT NULL REFERENCES PB_COMPONENT(COMPONENT_ID),
    SCAN_ID         VARCHAR2(36)   NOT NULL,    -- PB_SCAN_HISTORY FK
    
    PROPS_JSON      CLOB,                       -- 해당 시점의 props
    CHILDREN_COUNT  NUMBER(5),
    COMPUTED_STYLES CLOB,                       -- 주요 CSS 속성 (JSON)
    BOUNDING_RECT   VARCHAR2(200),              -- x,y,width,height
    SCREENSHOT_URL  VARCHAR2(500),              -- 요소 캡처 이미지 URL (optional)
    INNER_TEXT      CLOB,
    
    SCANNED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 5. 스캔 이력
------------------------------------------------------
CREATE TABLE PB_SCAN_HISTORY (
    SCAN_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    PROJECT_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_PROJECT(PROJECT_ID),
    PAGE_ID         VARCHAR2(36)   REFERENCES PB_PAGE(PAGE_ID),
    SCAN_TYPE       VARCHAR2(30)   NOT NULL,    -- FULL_SCAN, PAGE_SCAN, PARTIAL_SCAN
    COMPONENT_COUNT NUMBER(7),
    NEW_COUNT       NUMBER(7)      DEFAULT 0,   -- 신규 발견
    CHANGED_COUNT   NUMBER(7)      DEFAULT 0,   -- 변경 감지
    REMOVED_COUNT   NUMBER(7)      DEFAULT 0,   -- 삭제 감지
    STATUS          VARCHAR2(20)   DEFAULT 'COMPLETED',
    SCANNED_BY      VARCHAR2(100),
    SCANNED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 6. 변경 요청
------------------------------------------------------
CREATE TABLE PB_CHANGE_REQUEST (
    REQUEST_ID      VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    COMPONENT_ID    VARCHAR2(36)   NOT NULL REFERENCES PB_COMPONENT(COMPONENT_ID),
    REQUESTED_BY    VARCHAR2(100)  NOT NULL,
    TITLE           VARCHAR2(500)  NOT NULL,
    DESCRIPTION     CLOB           NOT NULL,    -- 기획자 자연어 요청
    CURRENT_STATE   CLOB,                       -- 변경 전 상태
    DESIRED_STATE   CLOB,                       -- 원하는 결과
    AI_ANALYSIS     CLOB,                       -- AI 분석 결과 (JSON)
    PRIORITY        VARCHAR2(20)   DEFAULT 'MEDIUM',
    STATUS          VARCHAR2(20)   DEFAULT 'DRAFT',
    -- DRAFT → AI_PROCESSING → READY → IN_PROGRESS → TESTING → DONE / REJECTED
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP,
    UPDATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 7. TODO 아이템 (AI 생성)
------------------------------------------------------
CREATE TABLE PB_TODO_ITEM (
    TODO_ID         VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    REQUEST_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_CHANGE_REQUEST(REQUEST_ID),
    TITLE           VARCHAR2(500)  NOT NULL,
    PROMPT          CLOB           NOT NULL,    -- Claude Code에 전달할 프롬프트
    TARGET_FILES    CLOB,                       -- JSON array
    COMPLEXITY      VARCHAR2(20)   DEFAULT 'MODERATE',
    SORT_ORDER      NUMBER(3)      DEFAULT 0,
    DEPENDENCIES    VARCHAR2(500),              -- 선행 TODO_ID 목록 (comma-separated)
    STATUS          VARCHAR2(20)   DEFAULT 'PENDING',
    TEST_RESULT     CLOB,
    COMPLETED_BY    VARCHAR2(100),
    COMPLETED_AT    TIMESTAMP,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

------------------------------------------------------
-- 8. 정책 이력
------------------------------------------------------
CREATE TABLE PB_POLICY_LOG (
    POLICY_ID       VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    COMPONENT_ID    VARCHAR2(36)   NOT NULL REFERENCES PB_COMPONENT(COMPONENT_ID),
    REQUEST_ID      VARCHAR2(36)   REFERENCES PB_CHANGE_REQUEST(REQUEST_ID),
    POLICY_TYPE     VARCHAR2(30)   NOT NULL,
    -- BUSINESS_RULE, UI_SPEC, INTERACTION, VALIDATION, TEXT_CONTENT, API_SPEC
    CONTENT         CLOB           NOT NULL,
    VERSION_NO      NUMBER(5)      NOT NULL,
    CREATED_AT      TIMESTAMP      DEFAULT SYSTIMESTAMP
);

-- 버전 자동 채번
CREATE OR REPLACE TRIGGER TRG_PB_POLICY_VERSION
BEFORE INSERT ON PB_POLICY_LOG
FOR EACH ROW
DECLARE
    v_max_ver NUMBER;
BEGIN
    SELECT NVL(MAX(VERSION_NO), 0) + 1
    INTO v_max_ver
    FROM PB_POLICY_LOG
    WHERE COMPONENT_ID = :NEW.COMPONENT_ID
      AND POLICY_TYPE  = :NEW.POLICY_TYPE;
    :NEW.VERSION_NO := v_max_ver;
END;
/

------------------------------------------------------
-- 9. 테스트 체크리스트
------------------------------------------------------
CREATE TABLE PB_TEST_CHECKLIST (
    CHECKLIST_ID    VARCHAR2(36)   DEFAULT SYS_GUID() PRIMARY KEY,
    REQUEST_ID      VARCHAR2(36)   NOT NULL REFERENCES PB_CHANGE_REQUEST(REQUEST_ID),
    ITEM_TEXT       VARCHAR2(2000) NOT NULL,
    IS_CHECKED      CHAR(1)        DEFAULT 'N',
    CHECKED_BY      VARCHAR2(100),
    CHECKED_AT      TIMESTAMP,
    SORT_ORDER      NUMBER(3)      DEFAULT 0
);
```

---

## 6. 매핑 플로우 (전체 흐름)

### 6.1 사전 스캔 (페이지 메타데이터 수집)

```
개발자가 "PlanBridge 스캔" 실행
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension → Content Script                          │
│                                                             │
│  1. 현재 페이지 URL에서 라우트 추출                         │
│     window.location.pathname → "/products"                  │
│                                                             │
│  2. Next.js 라우트 메타 추출                                │
│     window.__NEXT_DATA__ → { page, query, buildId, ... }   │
│                                                             │
│  3. DOM 전체 순회하며 컴포넌트 트리 구성                    │
│     ┌──────────────────────────────────────────┐            │
│     │ document.querySelectorAll('[data-pb-id]')│            │
│     │         +                                │            │
│     │ Fiber 역추적으로 나머지 컴포넌트 수집    │            │
│     └──────────────────────────────────────────┘            │
│                                                             │
│  4. 각 요소에서 추출:                                       │
│     {                                                       │
│       pbId: "ProductCard.AddToCartButton",                  │
│       componentName: "AddToCartButton",                     │
│       cssSelector: "main > .product-grid > div:nth(3) > …",│
│       tag: "button",                                        │
│       role: "action",                                       │
│       props: { variant: "primary", disabled: false },       │
│       text: "장바구니 담기",                                │
│       rect: { x: 120, y: 450, w: 160, h: 40 },            │
│       reactHierarchy: ["App","Layout","ProductPage",        │
│                         "ProductGrid","ProductCard",        │
│                         "AddToCartButton"],                  │
│       parentPbId: "ProductCard",                            │
│       children: ["AddToCartButton.Icon","AddToCartButton.…"]│
│     }                                                       │
│                                                             │
│  5. 수집 데이터 → API 서버 → Oracle DB (MERGE INTO)        │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 기획자 클릭 → DB 매핑 (런타임)

```
기획자가 익스텐션 "선택 모드" 켜고 요소 클릭
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: DOM에서 정보 추출 (즉시, 클라이언트)               │
│  ──────────────────────────────────────────                  │
│  clickedElement에서:                                        │
│    → data-pb-id 확인 (있으면 바로 사용)                     │
│    → 없으면 가장 가까운 data-pb-id 가진 조상 요소 탐색     │
│    → Fiber에서 componentName 추출                           │
│    → CSS Selector 생성                                      │
│                                                             │
│  결과: fingerprint = {                                      │
│    pbId: "ProductCard.AddToCartButton",   // Layer 1        │
│    componentName: "AddToCartButton",       // Layer 2        │
│    cssSelector: "main > div:nth(3) > ...", // Layer 3        │
│    pageRoute: "/products"                                   │
│  }                                                          │
│                                                             │
│  Step 2: Oracle DB 조회 (API 호출)                          │
│  ──────────────────────────────────────────                  │
│                                                             │
│  -- 우선순위 매핑 쿼리                                      │
│  SELECT c.*, p.ROUTE_PATH, p.PAGE_TITLE                     │
│  FROM PB_COMPONENT c                                        │
│  JOIN PB_PAGE p ON c.PAGE_ID = p.PAGE_ID                    │
│  WHERE p.ROUTE_PATH = :pageRoute                            │
│    AND (                                                    │
│      c.PB_ID = :pbId                          -- 1순위      │
│      OR (c.COMPONENT_NAME = :componentName    -- 2순위      │
│          AND c.TREE_PATH LIKE '%' || :componentName)        │
│      OR c.CSS_SELECTOR = :cssSelector         -- 3순위      │
│    )                                                        │
│  ORDER BY                                                   │
│    CASE                                                     │
│      WHEN c.PB_ID = :pbId THEN 1                           │
│      WHEN c.COMPONENT_NAME = :componentName THEN 2          │
│      ELSE 3                                                 │
│    END                                                      │
│  FETCH FIRST 1 ROW ONLY;                                   │
│                                                             │
│  Step 3: AI 컨텍스트 구성                                   │
│  ──────────────────────────────────────────                  │
│  매핑된 컴포넌트 + 상위 계층 + 정책 이력을 묶어서          │
│  AI 컨텍스트로 전달                                         │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 AI에 전달되는 최종 컨텍스트

```json
{
  "selectedComponent": {
    "pbId": "ProductCard.AddToCartButton",
    "componentName": "AddToCartButton",
    "type": "ELEMENT",
    "tag": "button",
    "currentProps": { "variant": "primary", "disabled": false },
    "currentText": "장바구니 담기",
    "currentSpec": "상품 상세에서 장바구니에 추가하는 버튼. 비회원도 클릭 가능, 재고 없으면 disabled."
  },
  "hierarchy": [
    { "name": "ProductPage",  "type": "PAGE_ROOT", "route": "/products" },
    { "name": "ProductGrid",  "type": "SECTION" },
    { "name": "ProductCard",  "type": "COMPONENT" },
    { "name": "AddToCartButton", "type": "ELEMENT" }  // ← 선택된 요소
  ],
  "policyHistory": [
    { "version": 1, "type": "BUSINESS_RULE", "content": "비회원 장바구니는 세션 스토리지에 저장" },
    { "version": 2, "type": "INTERACTION",   "content": "클릭 시 토스트 메시지 '장바구니에 담겼습니다' 표시" }
  ],
  "plannerRequest": {
    "title": "장바구니 버튼에 수량 선택 추가",
    "description": "장바구니 담기 버튼 클릭 전에 수량을 선택할 수 있게 해주세요. 1~10개 범위로."
  }
}
```

---

## 7. 스캔 데이터 동기화 전략

### 문제
Next.js 앱은 코드가 바뀌면 DOM 구조도 바뀝니다. DB의 메타데이터가 실제와 불일치할 수 있습니다.

### 해결: MERGE + diff 전략

```sql
-- 스캔 시 MERGE INTO로 upsert
MERGE INTO PB_COMPONENT target
USING (
    SELECT :page_id     AS PAGE_ID,
           :pb_id       AS PB_ID,
           :comp_name   AS COMPONENT_NAME,
           :css_sel     AS CSS_SELECTOR,
           :comp_type   AS COMPONENT_TYPE,
           :tag         AS ELEMENT_TAG,
           :props       AS CURRENT_PROPS,
           :text        AS CURRENT_TEXT,
           :hierarchy   AS REACT_HIERARCHY,
           :tree_path   AS TREE_PATH,
           :parent_id   AS PARENT_ID,
           :depth       AS DEPTH_LEVEL,
           :sort_order  AS SORT_ORDER
    FROM DUAL
) source
ON (target.PAGE_ID = source.PAGE_ID AND target.PB_ID = source.PB_ID)
WHEN MATCHED THEN UPDATE SET
    target.COMPONENT_NAME  = source.COMPONENT_NAME,
    target.CSS_SELECTOR    = source.CSS_SELECTOR,
    target.CURRENT_PROPS   = source.CURRENT_PROPS,
    target.CURRENT_TEXT    = source.CURRENT_TEXT,
    target.REACT_HIERARCHY = source.REACT_HIERARCHY,
    target.TREE_PATH       = source.TREE_PATH,
    target.UPDATED_AT      = SYSTIMESTAMP
WHEN NOT MATCHED THEN INSERT (
    PAGE_ID, PB_ID, COMPONENT_NAME, CSS_SELECTOR,
    COMPONENT_TYPE, ELEMENT_TAG, CURRENT_PROPS, CURRENT_TEXT,
    REACT_HIERARCHY, TREE_PATH, PARENT_ID, DEPTH_LEVEL, SORT_ORDER
) VALUES (
    source.PAGE_ID, source.PB_ID, source.COMPONENT_NAME, source.CSS_SELECTOR,
    source.COMPONENT_TYPE, source.ELEMENT_TAG, source.CURRENT_PROPS, source.CURRENT_TEXT,
    source.REACT_HIERARCHY, source.TREE_PATH, source.PARENT_ID, source.DEPTH_LEVEL, source.SORT_ORDER
);
```

### 스캔 주기 가이드

```
코드 배포 후       → 자동 전체 스캔 (CI/CD 연동)
기획자 진입 시     → 해당 페이지만 경량 스캔 (변경 감지)
수동 트리거        → 개발자/기획자가 익스텐션에서 "재스캔" 클릭
```

---

## 8. 크롬 익스텐션 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                 Chrome Extension                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Background  │  │   Content    │  │  Side      │ │
│  │  Service     │  │   Script     │  │  Panel     │ │
│  │  Worker      │  │              │  │  (React)   │ │
│  │             │  │  - DOM 감시   │  │            │ │
│  │  - API 통신 │  │  - 오버레이  │  │  - 트리 뷰 │ │
│  │  - 상태관리 │  │  - 클릭 캡처 │  │  - 변경요청│ │
│  │  - 인증     │  │  - Fiber접근 │  │  - TODO    │ │
│  │             │  │              │  │  - 정책    │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                │         │
│         └────── Message Passing ──────────┘         │
│                          │                          │
├──────────────────────────┼──────────────────────────┤
│                          │                          │
│              ┌───────────▼───────────┐              │
│              │     Injected Script   │              │
│              │   (페이지 JS context) │              │
│              │                       │              │
│              │  - React Fiber 접근   │              │
│              │  - __NEXT_DATA__ 읽기 │              │
│              │  - 컴포넌트 트리 순회 │              │
│              └───────────────────────┘              │
│                                                     │
└──────────────────────┬──────────────────────────────┘
                       │ REST API
                       ▼
              ┌─────────────────┐
              │   API Server    │
              │  (Spring Boot)  │
              │                 │
              │  - 매핑 로직    │
              │  - AI 분석      │
              │  - CRUD         │
              └────────┬────────┘
                       │ JDBC
                       ▼
              ┌─────────────────┐
              │   Oracle DB     │
              │                 │
              │  PB_PROJECT     │
              │  PB_PAGE        │
              │  PB_COMPONENT   │
              │  PB_CHANGE_REQ  │
              │  PB_TODO_ITEM   │
              │  PB_POLICY_LOG  │
              └─────────────────┘
```

---

## 9. 매핑 정확도를 높이는 핵심 포인트

### 9.1 data-pb-id가 시스템의 성패를 좌우

```
data-pb-id 있는 요소  → 99% 정확한 매핑  (1:1 대응)
React Fiber만 있는 요소 → 90% 정확        (동명 컴포넌트 충돌 가능)
CSS Selector만 있는 요소 → 70% 정확        (DOM 변경에 취약)
아무것도 없는 요소     → 매핑 불가         (신규 등록 필요)
```

따라서 **빌드 플러그인(data-pb-id 자동 주입)의 도입이 필수**입니다.
플러그인 없이 Fiber만으로 운영하면, 같은 이름의 컴포넌트가 여러 곳에 쓰일 때 구분이 안 됩니다.

### 9.2 Dynamic Route 처리

Next.js의 `/products/[id]` 같은 동적 라우트:

```
실제 URL:  /products/123
정규화:    /products/[id]    ← 이걸로 DB 매핑

window.__NEXT_DATA__.page → "/products/[id]" (Next.js가 자동 제공)
```

### 9.3 동적 컴포넌트 (조건부 렌더링) 처리

```
{isLoggedIn ? <UserMenu /> : <LoginButton />}
```

이런 경우 두 컴포넌트 모두 DB에 등록하되, `CURRENT_PROPS`에 렌더링 조건을 기록:

```json
{
  "renderCondition": "isLoggedIn === true",
  "conditionalPair": "LoginButton"
}
```

---

## 10. 요약: 이게 되면 뒤는 문제없다

```
기획자 클릭
  → data-pb-id로 DOM 요소 특정
  → Oracle DB에서 해당 컴포넌트의 모든 맥락 로드
    (이름, 계층, props, 기존 정책, 변경 이력)
  → AI에게 정확한 컨텍스트와 함께 변경 요청 전달
  → AI가 "ProductCard.tsx의 AddToCartButton에 수량 선택 dropdown 추가"
     같은 구체적 프롬프트 생성
```

이 매핑 파이프라인이 정확하게 동작하면, 
이후의 AI 분석 → TODO 생성 → 개발 실행 → 테스트 → 정책 축적은 
이전에 설계한 그대로 붙이면 됩니다.
