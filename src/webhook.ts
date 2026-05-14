import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from './config';
import logger from './logger';
import { syncProject } from './git-mirror';

// GitHub Webhook push 이벤트 페이로드 타입 (필요한 필드만 정의)
interface GitHubPushPayload {
  ref?: string;
  after?: string;
  repository?: {
    id?: number;
    full_name?: string;
    clone_url?: string;
    ssh_url?: string;
  };
  head_commit?: {
    id?: string;
    message?: string;
  };
}

// GitLab Webhook push 이벤트 페이로드 타입
interface GitLabPushPayload {
  ref?: string;
  after?: string;
  project?: {
    id?: number;
    path_with_namespace?: string;
    http_url?: string;
  };
  commits?: Array<{
    id?: string;
    message?: string;
  }>;
}

/**
 * GitHub X-Hub-Signature-256 검증
 * WEBHOOK_SECRET이 설정되지 않으면 검증 스킵
 */
function verifyGitHubSignature(req: Request, body: Buffer): boolean {
  if (!config.webhookSecret) {
    logger.warn('WEBHOOK_SECRET이 설정되지 않아 서명 검증을 건너뜁니다.');
    return true;
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature) {
    logger.warn('X-Hub-Signature-256 헤더가 없습니다.');
    return false;
  }

  const expectedSig =
    'sha256=' +
    crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');

  // timing-safe 비교
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

/**
 * GitLab webhook secret 토큰 검증
 */
function verifyGitLabToken(req: Request): boolean {
  if (!config.webhookSecret) {
    logger.warn('WEBHOOK_SECRET이 설정되지 않아 서명 검증을 건너뜁니다.');
    return true;
  }

  const token = req.headers['x-gitlab-token'] as string | undefined;
  if (!token) {
    logger.warn('X-Gitlab-Token 헤더가 없습니다.');
    return false;
  }

  // timing-safe 비교
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(config.webhookSecret)
    );
  } catch {
    return false;
  }
}

/**
 * 리포지토리 URL에서 프로젝트 ID 추출을 위한 임시 매핑
 * 실제 운영에서는 DB 조회로 대체
 */
async function findProjectIdByRepoUrl(_repoUrl: string): Promise<string | null> {
  // TODO: DB에서 REPO_URL 기준으로 PROJECT_ID 조회
  // 현재는 DB 조회 함수가 단건 ID 기반이므로 추후 확장
  // 임시로 null 반환 (webhook body에 project_id가 있는 경우 처리)
  return null;
}

/**
 * Express Webhook 라우터 생성
 */
export function createWebhookRouter(): express.Router {
  const router = express.Router();

  // raw body 파싱 미들웨어 (서명 검증에 필요)
  router.use(
    express.raw({
      type: ['application/json', 'application/x-www-form-urlencoded'],
      limit: '10mb',
    })
  );

  /**
   * POST /webhook/github
   * GitHub push 이벤트 수신 및 처리
   *
   * Headers:
   *   X-GitHub-Event: push
   *   X-Hub-Signature-256: sha256=...
   *   X-PlanBridge-Project-Id: {projectId}  (선택적, 없으면 repo URL로 매핑)
   */
  router.post('/github', async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;

    // 서명 검증
    if (!verifyGitHubSignature(req, rawBody)) {
      logger.warn('GitHub Webhook 서명 검증 실패', {
        ip: req.ip,
        event: req.headers['x-github-event'],
      });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.headers['x-github-event'] as string | undefined;
    logger.info('GitHub Webhook 수신', { event });

    // push 이벤트만 처리
    if (event !== 'push') {
      res.status(200).json({ message: `Event '${event}' ignored` });
      return;
    }

    let payload: GitHubPushPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as GitHubPushPayload;
    } catch (err) {
      logger.error('GitHub Webhook 페이로드 파싱 실패');
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    // 브랜치 추출 (refs/heads/main → main)
    const ref = payload.ref ?? '';
    const branch = ref.replace('refs/heads/', '');
    const repoFullName = payload.repository?.full_name ?? 'unknown';
    const repoUrl = payload.repository?.clone_url ?? '';

    logger.info('GitHub push 이벤트 처리', {
      repo: repoFullName,
      branch,
      commit: payload.after,
    });

    // 프로젝트 ID 결정 (헤더 우선, 없으면 repo URL로 매핑)
    const projectIdFromHeader = req.headers['x-planbridge-project-id'] as string | undefined;
    const projectId = projectIdFromHeader ?? (await findProjectIdByRepoUrl(repoUrl));

    if (!projectId) {
      logger.warn('프로젝트 ID를 확인할 수 없습니다.', { repoFullName, repoUrl });
      // 202 반환 (수신은 했으나 처리 불가)
      res.status(202).json({ message: 'Received but project not found' });
      return;
    }

    // 즉시 응답 후 비동기로 동기화 실행
    res.status(200).json({ message: 'Sync triggered', projectId });

    // 비동기 동기화 (응답 후 실행)
    setImmediate(async () => {
      try {
        const result = await syncProject(projectId, 'WEBHOOK');
        if (result.success) {
          logger.info('Webhook 트리거 동기화 성공', {
            projectId,
            commitHash: result.commitHash,
          });
        } else {
          logger.error('Webhook 트리거 동기화 실패', {
            projectId,
            error: result.error,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Webhook 동기화 처리 중 예외 발생', { projectId, error: message });
      }
    });
  });

  /**
   * POST /webhook/gitlab
   * GitLab push 이벤트 수신 및 처리
   *
   * Headers:
   *   X-Gitlab-Event: Push Hook
   *   X-Gitlab-Token: {secret}
   *   X-PlanBridge-Project-Id: {projectId}
   */
  router.post('/gitlab', async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;

    // 서명 검증
    if (!verifyGitLabToken(req)) {
      logger.warn('GitLab Webhook 토큰 검증 실패', { ip: req.ip });
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const event = req.headers['x-gitlab-event'] as string | undefined;
    logger.info('GitLab Webhook 수신', { event });

    // Push Hook만 처리
    if (event !== 'Push Hook') {
      res.status(200).json({ message: `Event '${event}' ignored` });
      return;
    }

    let payload: GitLabPushPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as GitLabPushPayload;
    } catch {
      res.status(400).json({ error: 'Invalid JSON payload' });
      return;
    }

    const ref = payload.ref ?? '';
    const branch = ref.replace('refs/heads/', '');
    const projectPath = payload.project?.path_with_namespace ?? 'unknown';
    const repoUrl = payload.project?.http_url ?? '';

    logger.info('GitLab push 이벤트 처리', {
      project: projectPath,
      branch,
      commit: payload.after,
    });

    const projectIdFromHeader = req.headers['x-planbridge-project-id'] as string | undefined;
    const projectId = projectIdFromHeader ?? (await findProjectIdByRepoUrl(repoUrl));

    if (!projectId) {
      logger.warn('프로젝트 ID를 확인할 수 없습니다.', { projectPath, repoUrl });
      res.status(202).json({ message: 'Received but project not found' });
      return;
    }

    res.status(200).json({ message: 'Sync triggered', projectId });

    setImmediate(async () => {
      try {
        const result = await syncProject(projectId, 'WEBHOOK');
        if (result.success) {
          logger.info('GitLab Webhook 트리거 동기화 성공', {
            projectId,
            commitHash: result.commitHash,
          });
        } else {
          logger.error('GitLab Webhook 트리거 동기화 실패', {
            projectId,
            error: result.error,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('GitLab Webhook 동기화 처리 중 예외 발생', { projectId, error: message });
      }
    });
  });

  /**
   * POST /webhook/sync/:projectId
   * 수동 동기화 트리거 (내부 API용)
   */
  router.post('/sync/:projectId', async (req: Request, res: Response) => {
    const { projectId } = req.params;

    logger.info('수동 동기화 요청', { projectId });

    // 즉시 응답
    res.status(202).json({ message: 'Sync accepted', projectId });

    setImmediate(async () => {
      try {
        const result = await syncProject(projectId, 'MANUAL');
        logger.info('수동 동기화 완료', { projectId, success: result.success });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('수동 동기화 실패', { projectId, error: message });
      }
    });
  });

  return router;
}

/**
 * Express 앱 생성 및 설정
 */
export function createApp(): express.Application {
  const app = express();

  // 헬스체크 (raw body 파싱 전에 처리)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'planbridge-git-mirror',
      timestamp: new Date().toISOString(),
    });
  });

  // Webhook 라우터 등록
  app.use('/webhook', createWebhookRouter());

  // 404 처리
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // 에러 핸들러
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Express 에러 핸들러', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
