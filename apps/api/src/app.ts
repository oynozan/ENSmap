import type { Env } from '@ensmap/core/config';
import { Hono } from 'hono';

export interface AppDeps {
  readonly env?: Env;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- deps is reserved for routes that need env-backed adapters in later phases
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
