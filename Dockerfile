FROM node:20-slim

# git 설치 (simple-git 의존성)
RUN apt-get update && apt-get install -y git openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm ci --only=production

# 빌드 결과물 복사
COPY dist/ ./dist/

# 로그 및 저장소 디렉토리 생성
RUN mkdir -p /repos /app/logs

# 환경변수 기본값
ENV NODE_ENV=production \
    PORT=3001 \
    REPOS_BASE_PATH=/repos \
    POLL_INTERVAL_MS=300000 \
    LOG_LEVEL=info

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
