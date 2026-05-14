import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import fs from 'fs';
import path from 'path';
import config from './config';
import logger from './logger';
import {
  getProjectsFromDb,
  getProjectById,
  updateProjectSyncStatus,
  insertSyncLog,
  isDbAvailable,
} from './db';

export interface SyncResult {
  projectId: string;
  success: boolean;
  commitHash?: string;
  commitMessage?: string;
  branch?: string;
  filesChanged?: number;
  error?: string;
}

/**
 * Git URL에 토큰을 삽입하여 인증 URL 생성
 * https://token@github.com/org/repo.git 형식
 */
function buildAuthUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = token;
    url.password = '';
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * SimpleGit 인스턴스 생성 (타임아웃 포함)
 */
function createGit(baseDir: string): SimpleGit {
  const options: Partial<SimpleGitOptions> = {
    baseDir,
    binary: 'git',
    maxConcurrentProcesses: 2,
    trimmed: true,
  };
  return simpleGit(options);
}

/**
 * 디렉토리가 유효한 git 저장소인지 확인
 */
async function isGitRepo(localPath: string): Promise<boolean> {
  if (!fs.existsSync(localPath)) return false;
  try {
    const git = createGit(localPath);
    await git.status();
    return true;
  } catch {
    return false;
  }
}

/**
 * 프로젝트 최초 클론
 * - 디렉토리가 이미 존재하고 git 저장소면 스킵
 * - REPOS_BASE_PATH 하위에 로컬 경로 생성
 */
export async function cloneProject(
  projectId: string,
  repoUrl: string,
  localPath: string,
  branch: string = 'main',
  token: string | null = null
): Promise<SyncResult> {
  logger.info('프로젝트 클론 시작', { projectId, repoUrl, localPath, branch });

  // 이미 클론된 경우 스킵
  if (await isGitRepo(localPath)) {
    logger.info('이미 클론된 저장소입니다. 클론을 건너뜁니다.', { projectId, localPath });
    return { projectId, success: true };
  }

  // 부모 디렉토리 생성
  const parentDir = path.dirname(localPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
    logger.info('디렉토리 생성', { path: parentDir });
  }

  const authUrl = buildAuthUrl(repoUrl, token);

  try {
    // REPOS_BASE_PATH 기준으로 git clone 실행
    const git = createGit(parentDir);
    await git.clone(authUrl, localPath, [
      '--branch', branch,
      '--single-branch',
    ]);

    const clonedGit = createGit(localPath);
    const log = await clonedGit.log({ maxCount: 1 });
    const latest = log.latest;

    await insertSyncLog({
      projectId,
      triggerType: 'MANUAL',
      commitHash: latest?.hash,
      commitMessage: latest?.message,
      branch,
      status: 'SUCCESS',
    });

    logger.info('프로젝트 클론 완료', {
      projectId,
      localPath,
      commitHash: latest?.hash,
    });

    return {
      projectId,
      success: true,
      commitHash: latest?.hash,
      commitMessage: latest?.message,
      branch,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('프로젝트 클론 실패', { projectId, repoUrl, error: message });

    await insertSyncLog({
      projectId,
      triggerType: 'MANUAL',
      branch,
      status: 'ERROR',
      errorMessage: message,
    });

    return { projectId, success: false, error: message };
  }
}

/**
 * 단일 프로젝트 동기화 (git fetch --all + reset to remote branch)
 * @param projectId - Oracle PB_PROJECT.PROJECT_ID
 * @param triggerType - 동기화 트리거 유형
 */
export async function syncProject(
  projectId: string,
  triggerType: 'WEBHOOK' | 'SCHEDULED' | 'MANUAL' = 'MANUAL'
): Promise<SyncResult> {
  logger.info('프로젝트 동기화 시작', { projectId, triggerType });

  // DB에서 프로젝트 정보 조회
  let projectInfo: { repoUrl: string; localPath: string; branch: string; token: string | null } | null = null;

  if (isDbAvailable()) {
    const row = await getProjectById(projectId);
    if (!row) {
      logger.warn('프로젝트를 DB에서 찾을 수 없습니다.', { projectId });
      return { projectId, success: false, error: '프로젝트를 찾을 수 없습니다.' };
    }
    projectInfo = {
      repoUrl: row.repoUrl,
      localPath: row.repoLocalPath,
      branch: row.repoBranch,
      token: row.repoToken,
    };
  }

  if (!projectInfo) {
    logger.warn('DB를 사용할 수 없어 프로젝트 정보를 조회할 수 없습니다.', { projectId });
    return { projectId, success: false, error: 'DB 연결 없음' };
  }

  const { repoUrl, localPath, branch, token } = projectInfo;

  // 저장소가 없으면 먼저 클론
  if (!(await isGitRepo(localPath))) {
    logger.info('로컬 저장소가 없습니다. 클론을 시도합니다.', { projectId, localPath });
    return cloneProject(projectId, repoUrl, localPath, branch, token);
  }

  // SYNCING 상태로 업데이트
  await updateProjectSyncStatus(projectId, 'SYNCING');

  const git = createGit(localPath);

  try {
    // 원격 URL 갱신 (토큰 변경 반영)
    if (token) {
      const authUrl = buildAuthUrl(repoUrl, token);
      await git.remote(['set-url', 'origin', authUrl]);
    }

    // fetch --all (모든 브랜치/태그 갱신)
    await git.fetch(['--all', '--prune']);

    // 현재 브랜치를 원격으로 리셋 (fast-forward 방식)
    await git.reset(['--hard', `origin/${branch}`]);

    // 최신 커밋 정보 조회
    const log = await git.log({ maxCount: 1 });
    const latest = log.latest;

    // IDLE 상태로 복원
    await updateProjectSyncStatus(projectId, 'IDLE');

    await insertSyncLog({
      projectId,
      triggerType,
      commitHash: latest?.hash,
      commitMessage: latest?.message,
      branch,
      status: 'SUCCESS',
    });

    logger.info('프로젝트 동기화 완료', {
      projectId,
      triggerType,
      commitHash: latest?.hash,
      branch,
    });

    return {
      projectId,
      success: true,
      commitHash: latest?.hash,
      commitMessage: latest?.message,
      branch,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('프로젝트 동기화 실패', { projectId, error: message });

    await updateProjectSyncStatus(projectId, 'ERROR');
    await insertSyncLog({
      projectId,
      triggerType,
      branch,
      status: 'ERROR',
      errorMessage: message,
    });

    return { projectId, success: false, error: message };
  }
}

/**
 * 전체 프로젝트 동기화
 * Oracle DB에서 프로젝트 목록을 조회하여 순차적으로 동기화
 */
export async function syncAllProjects(
  triggerType: 'WEBHOOK' | 'SCHEDULED' | 'MANUAL' = 'SCHEDULED'
): Promise<SyncResult[]> {
  logger.info('전체 프로젝트 동기화 시작', { triggerType });

  const projects = await getProjectsFromDb();

  if (projects.length === 0) {
    logger.info('동기화할 프로젝트가 없습니다.');
    return [];
  }

  logger.info(`${projects.length}개 프로젝트 동기화 예정`, {
    projectIds: projects.map((p) => p.projectId),
  });

  const results: SyncResult[] = [];

  for (const project of projects) {
    try {
      const localPath = project.repoLocalPath;

      // 저장소 클론 또는 동기화
      if (!(await isGitRepo(localPath))) {
        const cloneResult = await cloneProject(
          project.projectId,
          project.repoUrl,
          localPath,
          project.repoBranch,
          project.repoToken
        );
        results.push(cloneResult);
      } else {
        const syncResult = await syncProject(project.projectId, triggerType);
        results.push(syncResult);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('프로젝트 동기화 중 예기치 않은 오류', {
        projectId: project.projectId,
        error: message,
      });
      results.push({
        projectId: project.projectId,
        success: false,
        error: message,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  logger.info('전체 프로젝트 동기화 완료', {
    total: results.length,
    success: successCount,
    failed: failCount,
  });

  return results;
}

/**
 * REPOS_BASE_PATH 디렉토리 생성 (시작 시 호출)
 */
export function ensureReposDirectory(): void {
  const reposPath = config.reposBasePath;
  if (!fs.existsSync(reposPath)) {
    fs.mkdirSync(reposPath, { recursive: true });
    logger.info('REPOS_BASE_PATH 디렉토리 생성', { path: reposPath });
  } else {
    logger.debug('REPOS_BASE_PATH 디렉토리 확인', { path: reposPath });
  }
}
