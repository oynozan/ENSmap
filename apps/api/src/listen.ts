import type { Env } from '@ensmap/core/config';

// Loopback only, since GET /map spends the configured provider keys
const HOSTNAME = 'localhost';

export function listenOptions(env: Env): { hostname: string; port: number } {
  return { hostname: HOSTNAME, port: env.ENSMAP_API_PORT };
}
