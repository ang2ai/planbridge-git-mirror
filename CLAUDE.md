# PlanBridge Git Mirror (소스코드 동기화 데몬)

## 역할
- 고객사 Git 저장소를 서버 로컬에 항상 최신 상태로 유지
- Webhook 수신 → 즉시 git fetch
- 5분마다 전체 저장소 백업 폴링

## 기술 스택
- Node.js + TypeScript
- simple-git 라이브러리
- Oracle DB 연동 (PB_PROJECT 조회)

## 환경변수
- ORACLE_URL / ORACLE_USER / ORACLE_PASSWORD
- REPOS_BASE_PATH: 소스 저장 경로 (기본 /repos)
- WEBHOOK_SECRET: GitHub Webhook 시크릿
- POLL_INTERVAL_MS: 백업 폴링 간격 (기본 300000 = 5분)

## 실행
```bash
npm install
npm run start
```

## 설계 문서 (우선순위 순)
@docs/planbridge-final-architecture.md
@docs/planbridge-mapping-design.md

## 문서 우선순위 규칙
- Git Mirror 상세 설계 → planbridge-final-architecture.md 섹션 2.4 기준
- 문서 간 충돌 시 → planbridge-final-architecture.md 최종 기준

## 개발 원칙
- /repos/ 디렉토리는 git fetch만 수행 (push 금지)
- Git 토큰은 환경변수로만 관리
- PB_GIT_SYNC_LOG 테이블에 동기화 이력 기록
