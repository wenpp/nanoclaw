import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CLAUDE_CODE_MODEL',
  'WEB_API_KEY',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const CLAUDE_CODE_MODEL =
  process.env.CLAUDE_CODE_MODEL || envConfig.CLAUDE_CODE_MODEL;

// Anthropic model overrides for API proxy compatibility (e.g., Kimi)
export const ANTHROPIC_DEFAULT_HAIKU_MODEL =
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL;
export const ANTHROPIC_DEFAULT_OPUS_MODEL =
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL;
export const ANTHROPIC_DEFAULT_SONNET_MODEL =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL;
export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || envConfig.ANTHROPIC_MODEL;

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Web Channel Configuration
export const WEB_API_KEY = process.env.WEB_API_KEY || envConfig.WEB_API_KEY;
export const WEB_PORT = parseInt(process.env.WEB_PORT || '8080', 10);
export const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
export const SHARED_UPLOADS_DIR =
  process.env.SHARED_UPLOADS_DIR || '/shared/uploads';
export const SHARED_OUTPUTS_DIR =
  process.env.SHARED_OUTPUTS_DIR || '/shared/outputs';
