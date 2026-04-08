export interface HttpRuntimeConfig {
  host: string;
  nodeEnv: string;
  port: number;
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

function parsePort(portValue: string, portEnv: string): number {
  const parsedPort = Number.parseInt(portValue, 10);

  if (Number.isNaN(parsedPort) || parsedPort <= 0) {
    throw new Error(`Environment variable ${portEnv} must be a positive integer.`);
  }

  return parsedPort;
}

