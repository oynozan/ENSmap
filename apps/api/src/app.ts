import {
  envSecrets,
  loadEnv,
  type Env,
  type NamespaceId,
} from '@ensmap/core/config';
import { parseNameInput } from '@ensmap/core/ens';
import { redact } from '@ensmap/core/http';
import { Hono } from 'hono';

import { apiError, toErrorResponse } from './errors.ts';
import { createLiveMapService, type MapService } from './mapService.ts';

export interface AppDeps {
  readonly env?: Env;
  readonly maps?: MapService;
  readonly log?: (line: string) => void;
}

const NAMESPACES: readonly string[] = ['mainnet', 'sepolia-v2'];

function isNamespace(value: string): value is NamespaceId {
  return NAMESPACES.includes(value);
}

function errorDetail(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? String(error))
    : String(error);
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log =
    deps.log ??
    ((line: string) => {
      console.error(line);
    });

  // Env and the live service load on first use, so /health needs neither
  let env = deps.env;
  let maps = deps.maps;
  const currentEnv = (): Env => (env ??= loadEnv());
  const mapService = (): MapService =>
    (maps ??= createLiveMapService({ env: currentEnv(), log: deps.log }));

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/map/name/:name', async (c) => {
    let secrets: readonly string[] = [];
    try {
      secrets = envSecrets(currentEnv());
      const namespace = c.req.query('namespace') ?? 'mainnet';
      if (!isNamespace(namespace)) {
        return c.json(
          apiError(
            'invalid-namespace',
            'Unknown namespace; use mainnet or sepolia-v2',
            secrets,
          ),
          400,
        );
      }
      const parsed = parseNameInput(c.req.param('name'));
      if (!parsed.ok) {
        return c.json(
          apiError('invalid-name', 'Invalid name', secrets, parsed.errors),
          400,
        );
      }
      return c.json(await mapService().nameMap(namespace, parsed.name));
    } catch (error) {
      const { status, body } = toErrorResponse(error, secrets);
      if (status === 500) {
        log(`map request failed: ${redact(errorDetail(error), secrets)}`);
      }
      return c.json(body, status);
    }
  });

  return app;
}
