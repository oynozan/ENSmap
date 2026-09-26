import { loadDotEnv, loadEnv } from '@ensmap/core/config';
import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
import { listenOptions } from './listen.ts';

loadDotEnv();
const env = loadEnv();
const { hostname, port } = listenOptions(env);

serve({ fetch: createApp({ env }).fetch, hostname, port }, (info) => {
  console.log(`ENSmap API on http://${hostname}:${info.port}`);
});
