import oracledb from 'oracledb';
import config from './config';
import logger from './logger';

export interface ProjectRow {
  projectId: string;
  repoUrl: string;
  repoLocalPath: string;
  repoBranch: string;
  repoToken: string | null;
  syncStatus: string;
}

export interface SyncLogInput {
  projectId: string;
  triggerType: 'WEBHOOK' | 'SCHEDULED' | 'MANUAL';
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  filesChanged?: number;
  status: 'SUCCESS' | 'ERROR';
  errorMessage?: string;
}

let pool: oracledb.Pool | null = null;
let dbAvailable = false;

/**
 * Oracle 커넥션 풀 초기화
 * DB 없이도 서버가 실행될 수 있도록 실패 시 graceful 처리
 */
export async function initDb(): Promise<void> {
  if (!config.oracle.url || !config.oracle.user || !config.oracle.password) {
    logger.warn('Oracle DB 접속 정보가 없습니다. DB 기능을 비활성화합니다.');
    dbAvailable = false;
    return;
  }

  try {
    // Oracle Thin 드라이버 사용 (Oracle 클라이언트 설치 불필요)
    oracledb.initOracleClient(); // thick 모드 시도, 실패 시 thin 모드로 폴백
  } catch {
    // thin 모드로 계속 진행 (Oracle Instant Client 없는 환경)
    logger.info('Oracle Thick 클라이언트를 사용할 수 없습니다. Thin 모드로 진행합니다.');
  }

  try {
    pool = await oracledb.createPool({
      connectString: config.oracle.url,
      user: config.oracle.user,
      password: config.oracle.password,
      poolMin: 1,
      poolMax: 5,
      poolIncrement: 1,
      poolTimeout: 60,
    });

    // 연결 테스트
    const conn = await pool.getConnection();
    await conn.close();

    dbAvailable = true;
    logger.info('Oracle DB 연결 풀이 초기화되었습니다.', {
      connectString: config.oracle.url,
    });
  } catch (err) {
    dbAvailable = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Oracle DB 연결 실패. DB 기능 없이 실행됩니다.', { error: message });
  }
}

export function isDbAvailable(): boolean {
  return dbAvailable;
}

/**
 * DB 풀에서 커넥션을 가져와 쿼리를 실행
 * DB 비활성 시 null 반환
 */
async function getConnection(): Promise<oracledb.Connection | null> {
  if (!dbAvailable || !pool) return null;
  try {
    return await pool.getConnection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Oracle DB 커넥션 획득 실패', { error: message });
    return null;
  }
}

/**
 * Oracle PB_PROJECT 테이블에서 동기화 대상 프로젝트 목록 조회
 * REPO_URL과 REPO_LOCAL_PATH가 설정된 프로젝트만 반환
 */
export async function getProjectsFromDb(): Promise<ProjectRow[]> {
  const conn = await getConnection();
  if (!conn) return [];

  const sql = `
    SELECT
      PROJECT_ID,
      REPO_URL,
      REPO_LOCAL_PATH,
      REPO_BRANCH,
      REPO_TOKEN,
      SYNC_STATUS
    FROM PB_PROJECT
    WHERE REPO_URL IS NOT NULL
      AND REPO_LOCAL_PATH IS NOT NULL
    ORDER BY PROJECT_ID
  `;

  try {
    const result = await conn.execute<[string, string, string, string, string | null, string]>(
      sql,
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );

    const rows = (result.rows ?? []) as Array<[string, string, string, string, string | null, string]>;
    return rows.map(([projectId, repoUrl, repoLocalPath, repoBranch, repoToken, syncStatus]) => ({
      projectId,
      repoUrl,
      repoLocalPath,
      repoBranch: repoBranch ?? 'main',
      repoToken: repoToken ?? null,
      syncStatus: syncStatus ?? 'IDLE',
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('PB_PROJECT 조회 실패', { error: message });
    return [];
  } finally {
    await conn.close();
  }
}

/**
 * 프로젝트 ID로 단일 프로젝트 조회
 */
export async function getProjectById(projectId: string): Promise<ProjectRow | null> {
  const conn = await getConnection();
  if (!conn) return null;

  const sql = `
    SELECT
      PROJECT_ID,
      REPO_URL,
      REPO_LOCAL_PATH,
      REPO_BRANCH,
      REPO_TOKEN,
      SYNC_STATUS
    FROM PB_PROJECT
    WHERE PROJECT_ID = :projectId
      AND REPO_URL IS NOT NULL
  `;

  try {
    const result = await conn.execute<[string, string, string, string, string | null, string]>(
      sql,
      { projectId },
      { outFormat: oracledb.OUT_FORMAT_ARRAY }
    );

    const rows = (result.rows ?? []) as Array<[string, string, string, string, string | null, string]>;
    if (rows.length === 0) return null;

    const [pId, repoUrl, repoLocalPath, repoBranch, repoToken, syncStatus] = rows[0];
    return {
      projectId: pId,
      repoUrl,
      repoLocalPath,
      repoBranch: repoBranch ?? 'main',
      repoToken: repoToken ?? null,
      syncStatus: syncStatus ?? 'IDLE',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('PB_PROJECT 단건 조회 실패', { projectId, error: message });
    return null;
  } finally {
    await conn.close();
  }
}

/**
 * PB_PROJECT의 SYNC_STATUS 및 LAST_SYNCED_AT 업데이트
 */
export async function updateProjectSyncStatus(
  projectId: string,
  status: 'IDLE' | 'SYNCING' | 'ERROR'
): Promise<void> {
  const conn = await getConnection();
  if (!conn) return;

  const sql = `
    UPDATE PB_PROJECT
    SET SYNC_STATUS = :status,
        LAST_SYNCED_AT = CASE WHEN :status2 = 'IDLE' THEN SYSTIMESTAMP ELSE LAST_SYNCED_AT END
    WHERE PROJECT_ID = :projectId
  `;

  try {
    await conn.execute(sql, { status, status2: status, projectId });
    await conn.commit();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('SYNC_STATUS 업데이트 실패', { projectId, status, error: message });
  } finally {
    await conn.close();
  }
}

/**
 * PB_GIT_SYNC_LOG에 동기화 이력 기록
 */
export async function insertSyncLog(input: SyncLogInput): Promise<void> {
  const conn = await getConnection();
  if (!conn) return;

  const sql = `
    INSERT INTO PB_GIT_SYNC_LOG (
      PROJECT_ID,
      TRIGGER_TYPE,
      COMMIT_HASH,
      COMMIT_MESSAGE,
      BRANCH,
      FILES_CHANGED,
      STATUS,
      ERROR_MESSAGE
    ) VALUES (
      :projectId,
      :triggerType,
      :commitHash,
      :commitMessage,
      :branch,
      :filesChanged,
      :status,
      :errorMessage
    )
  `;

  try {
    await conn.execute(sql, {
      projectId: input.projectId,
      triggerType: input.triggerType,
      commitHash: input.commitHash ?? null,
      commitMessage: input.commitMessage
        ? input.commitMessage.substring(0, 1000)
        : null,
      branch: input.branch ?? null,
      filesChanged: input.filesChanged ?? null,
      status: input.status,
      errorMessage: input.errorMessage
        ? input.errorMessage.substring(0, 4000)
        : null,
    });
    await conn.commit();
    logger.debug('동기화 이력 기록 완료', {
      projectId: input.projectId,
      triggerType: input.triggerType,
      status: input.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('PB_GIT_SYNC_LOG 삽입 실패', { error: message });
  } finally {
    await conn.close();
  }
}

/**
 * DB 연결 풀 종료 (graceful shutdown)
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    try {
      await pool.close(10);
      logger.info('Oracle DB 연결 풀이 종료되었습니다.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Oracle DB 연결 풀 종료 실패', { error: message });
    }
  }
}
