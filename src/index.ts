import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import config from './config';
import logger from './logger';
import { initDb, closeDb, isDbAvailable } from './db';
import { ensureReposDirectory, syncAllProjects } from './git-mirror';
import { createApp } from './webhook';
import { startScheduler, stopScheduler } from './scheduler';

// 로그 디렉토리 생성
function ensureLogDirectory(): void {
  const logDir = 'logs';
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * 시작 배너 출력
 */
function printBanner(): void {
  logger.info('==============================================');
  logger.info('  PlanBridge Git Mirror Daemon');
  logger.info('==============================================');
  logger.info('설정 정보', {
    port: config.port,
    reposBasePath: config.reposBasePath,
    pollIntervalMs: config.pollIntervalMs,
    nodeEnv: config.nodeEnv,
    dbAvailable: config.oracle.url ? '연결 시도 중...' : '비활성화',
  });
}

/**
 * Graceful Shutdown 처리
 */
function setupGracefulShutdown(server: http.Server): void {
  const shutdown = async (signal: string) => {
    logger.info(`${signal} 수신 — 서버 종료 중...`);

    // 스케줄러 중지
    stopScheduler();
    logger.info('스케줄러 중지 완료');

    // HTTP 서버 종료
    server.close(() => {
      logger.info('HTTP 서버 종료 완료');
    });

    // DB 연결 풀 종료
    await closeDb();

    logger.info('서버 정상 종료 완료');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 처리되지 않은 Promise rejection 로깅
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error('처리되지 않은 Promise rejection', { reason: message });
  });

  // 처리되지 않은 예외 로깅
  process.on('uncaughtException', (err) => {
    logger.error('처리되지 않은 예외 발생', {
      error: err.message,
      stack: err.stack,
    });
    // 치명적 오류이므로 종료
    process.exit(1);
  });
}

/**
 * 애플리케이션 시작
 */
async function main(): Promise<void> {
  ensureLogDirectory();
  printBanner();

  // REPOS_BASE_PATH 디렉토리 생성
  ensureReposDirectory();

  // Oracle DB 초기화 (실패해도 서버 계속 실행)
  await initDb();

  if (isDbAvailable()) {
    logger.info('Oracle DB 연결 성공');
    // 시작 시 즉시 한 번 전체 동기화 실행
    logger.info('시작 시 초기 동기화 실행...');
    try {
      await syncAllProjects('MANUAL');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('초기 동기화 실패', { error: message });
      // 초기 동기화 실패는 치명적이지 않으므로 계속 진행
    }
  } else {
    logger.warn('DB 없이 실행됩니다. Webhook 수신은 가능하지만 자동 동기화는 비활성화됩니다.');
  }

  // Express 앱 생성 및 HTTP 서버 시작
  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.port, () => {
    logger.info(`HTTP 서버 시작됨`, {
      port: config.port,
      endpoints: [
        `GET  http://localhost:${config.port}/health`,
        `POST http://localhost:${config.port}/webhook/github`,
        `POST http://localhost:${config.port}/webhook/gitlab`,
        `POST http://localhost:${config.port}/webhook/sync/:projectId`,
      ],
    });
  });

  // 스케줄러 시작 (DB 사용 가능할 때만 의미 있지만, DB 없어도 등록)
  startScheduler();

  // Graceful Shutdown 설정
  setupGracefulShutdown(server);
}

// 애플리케이션 실행
main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('애플리케이션 시작 실패:', message);
  process.exit(1);
});
