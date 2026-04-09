export interface HttpRuntimeConfig {
  host: string;
  nodeEnv: string;
  port: number;
}

export interface HcmRuntimeConfig {
  baseUrl: string;
  internalSyncToken: string;
  requestTimeoutMs: number;
}

export interface OutboxRuntimeConfig {
  baseDelayMs: number;
  batchSize: number;
  maxAttempts: number;
}

interface HttpRuntimeConfigOptions {
  defaultHost?: string;
  defaultPort: number;
  hostEnv?: string;
  portEnv: string;
}

export function getHttpRuntimeConfig(
  options: HttpRuntimeConfigOptions,
): HttpRuntimeConfig {
  const hostEnv = options.hostEnv ?? 'HOST';
  const host = process.env[hostEnv] ?? options.defaultHost ?? '127.0.0.1';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const portValue = process.env[options.portEnv];
  const port = portValue ? parsePort(portValue, options.portEnv) : options.defaultPort;

  return {
    host,
    nodeEnv,
    port,
  };
}

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'file:./dev.db';
}

export function getHcmRuntimeConfig(): HcmRuntimeConfig {
  const mockPort = process.env.HCM_MOCK_PORT
    ? parsePort(process.env.HCM_MOCK_PORT, 'HCM_MOCK_PORT')
    : 3001;
  const baseUrl =
    process.env.HCM_BASE_URL ?? `http://127.0.0.1:${mockPort}`;
  const requestTimeoutValue = process.env.HCM_REQUEST_TIMEOUT_MS ?? '5000';

  return {
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    internalSyncToken:
      process.env.HCM_INTERNAL_SYNC_TOKEN ?? 'local-dev-internal-sync-token',
    requestTimeoutMs: parsePort(requestTimeoutValue, 'HCM_REQUEST_TIMEOUT_MS'),
  };
}

export function getOutboxRuntimeConfig(): OutboxRuntimeConfig {
  return {
    baseDelayMs: parsePort(
      process.env.OUTBOX_RETRY_BASE_DELAY_MS ?? '1000',
      'OUTBOX_RETRY_BASE_DELAY_MS',
    ),
    batchSize: parsePort(
      process.env.OUTBOX_BATCH_SIZE ?? '25',
      'OUTBOX_BATCH_SIZE',
    ),
    maxAttempts: parsePort(
      process.env.OUTBOX_MAX_ATTEMPTS ?? '5',
      'OUTBOX_MAX_ATTEMPTS',
    ),
  };
}

function parsePort(portValue: string, portEnv: string): number {
  const parsedPort = Number.parseInt(portValue, 10);

  if (Number.isNaN(parsedPort) || parsedPort <= 0) {
    throw new Error(`Environment variable ${portEnv} must be a positive integer.`);
  }

  return parsedPort;
}
