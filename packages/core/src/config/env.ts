import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const ensSourceKind = z.enum(['ens-subgraph', 'ens-dev-graphql']);
const fixturesMode = z.enum(['record', 'replay', 'off']);

// fetch rejects userinfo, and urlSecrets only redacts path+query
const endpointUrl = z.httpUrl().refine((value) => {
  const url = URL.parse(value);
  return url !== null && url.username === '' && url.password === '';
});

export const EnvSchema = z.object({
  // Spec ground rules (section 1): secrets that never reach the browser.
  ALCHEMY_API_KEY: z.string().optional(),
  ENSNODE_URL_MAINNET: endpointUrl.optional(),
  ENSNODE_URL_SEPOLIA_V2: endpointUrl.optional(),
  DUNE_API_KEY: z.string().optional(),
  BITQUERY_API_KEY: z.string().optional(),
  // Not a URL type: DATABASE_URL also accepts pglite:<path> and memory:, and
  // createDb() already validates the scheme without echoing the value.
  DATABASE_URL: z.string().min(1).optional(),

  // Spec deviation 2: subgraph / graphql.ens.dev source config and RPC URLs.
  GRAPH_API_KEY: z.string().optional(),
  ENS_SOURCE_KIND_MAINNET: ensSourceKind.optional(),
  ENS_SOURCE_KIND_SEPOLIA_V2: ensSourceKind.optional(),
  ENS_SOURCE_URL_MAINNET: endpointUrl.optional(),
  ENS_SOURCE_URL_SEPOLIA_V2: endpointUrl.optional(),
  RPC_URL_1: endpointUrl.optional(),
  RPC_URL_11155111: endpointUrl.optional(),

  ENSMAP_FIXTURES: fixturesMode.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  // A copied .env.example (or any unset shell var) reaches here as ''.
  // Treat that as absent rather than an invalid URL/enum value.
  const withoutBlanks = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ''),
  );
  const result = EnvSchema.safeParse(withoutBlanks);
  if (!result.success) {
    // Keys only: values may be secrets (RPC_URL_*, ENS_SOURCE_URL_*, DATABASE_URL, ...)
    // and must never appear in a thrown error message.
    const keys = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(`Invalid environment variable(s): ${keys.join(', ')}`);
  }
  return result.data;
}

export function requireEnv<K extends keyof Env>(
  env: Env,
  key: K,
): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
}

export function workspaceRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

export function loadDotEnv(path: string = join(workspaceRoot(), '.env')): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
