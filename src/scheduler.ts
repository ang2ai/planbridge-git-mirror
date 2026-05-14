import cron from 'node-cron';
import config from './config';
import logger from './logger';
import { syncAllProjects } from './git-mirror';

let scheduledTask: cron.ScheduledTask | null = null;
let isRunning = false;

/**
 * 폴링 주기(ms)를 cron 표현식으로 변환
 * 지원 주기: 1분(60000), 5분(300000), 10분(600000), 30분(1800000), 1시간(3600000)
 */
function msToCronExpression(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));

  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }

  const hours = Math.round(minutes / 60);
  return `0 */${hours} * * *`;
}

/**
 * 주기적 동기화 스케줄러 시작
 * POLL_INTERVAL_MS 환경변수 기준으로 node-cron 스케줄 등록
 * 중복 실행 방지: 이전 실행이 완료되지 않으면 다음 실행 스킵
 */
export function startScheduler(): void {
  if (scheduledTask) {
    logger.warn('스케줄러가 이미 실행 중입니다.');
    return;
  }

  const intervalMs = config.pollIntervalMs;
  const cronExpr = msToCronExpression(intervalMs);
  const intervalMinutes = Math.round(intervalMs / 60000);

  logger.info('스케줄러 시작', {
    intervalMs,
    intervalMinutes,
    cronExpression: cronExpr,
  });

  scheduledTask = cron.schedule(cronExpr, async () => {
    if (isRunning) {
      logger.warn('이전 동기화가 아직 실행 중입니다. 이번 주기를 건너뜁니다.');
      return;
    }

    isRunning = true;
    const startTime = Date.now();

    logger.info('스케줄된 전체 동기화 시작');

    try {
      const results = await syncAllProjects('SCHEDULED');
      const elapsed = Date.now() - startTime;
      const successCount = results.filter((r) => r.success).length;
      const failCount = results.length - successCount;

      logger.info('스케줄된 전체 동기화 완료', {
        total: results.length,
        success: successCount,
        failed: failCount,
        elapsedMs: elapsed,
      });

      // 실패한 프로젝트 로깅
      for (const result of results) {
        if (!result.success) {
          logger.warn('프로젝트 동기화 실패 (스케줄)', {
            projectId: result.projectId,
            error: result.error,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('스케줄된 동기화 중 예외 발생', { error: message });
    } finally {
      isRunning = false;
    }
  });

  logger.info(`스케줄러 등록 완료 — ${intervalMinutes}분마다 전체 동기화 실행`);
}

/**
 * 스케줄러 중지 (graceful shutdown)
 */
export function stopScheduler(): void {
  if (!scheduledTask) {
    logger.warn('중지할 스케줄러가 없습니다.');
    return;
  }

  scheduledTask.stop();
  scheduledTask = null;
  logger.info('스케줄러 중지 완료');
}

/**
 * 현재 스케줄러 실행 상태 반환
 */
export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}
