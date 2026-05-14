import dotenv from 'dotenv';
import path from 'path';

// .env 파일 로드 (프로젝트 루트 기준)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface AppConfig {
  oracle: {
    url: string;
    user: string;
    password: string;
  };
  reposBasePath: string;
  webhookSecret: string;
  pollIntervalMs: number;
  port: number;
  logLevel: string;
  nodeEnv: string;
}

function getEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export function loadConfig(): AppConfig {
  return {
    oracle: {
      url: getEnv('ORACLE_URL', ''),
      user: getEnv('ORACLE_USER', ''),
      password: getEnv('ORACLE_PASSWORD', ''),
    },
    reposBasePath: getEnv('REPOS_BASE_PATH', '/repos'),
    webhookSecret: getEnv('WEBHOOK_SECRET', ''),
    pollIntervalMs: parseInt(getEnv('POLL_INTERVAL_MS', '300000'), 10),
    port: parseInt(getEnv('PORT', '3001'), 10),
    logLevel: getEnv('LOG_LEVEL', 'info'),
    nodeEnv: getEnv('NODE_ENV', 'development'),
  };
}

export function validateConfig(config: AppConfig): void {
  if (!config.webhookSecret) {
    console.warn('[config] WEBHOOK_SECRET이 설정되지 않았습니다. Webhook 서명 검증이 비활성화됩니다.');
  }

  if (!config.oracle.url || !config.oracle.user || !config.oracle.password) {
    console.warn('[config] Oracle DB 접속 정보가 불완전합니다. DB 기능 없이 실행됩니다.');
  }
}

// 싱글톤 config 인스턴스
const config = loadConfig();
validateConfig(config);

export default config;
