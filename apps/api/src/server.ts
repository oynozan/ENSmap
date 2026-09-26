import { loadDotEnv, loadEnv } from '@ensmap/core/config';
import { serve } from '@hono/node-server';

import { createApp } from './app.ts';

const PORT = 3000;

loadDotEnv();

serve({ fetch: createApp({ env: loadEnv() }).fetch, port: PORT }, () => {
  console.log(`ENSmap API on http://localhost:${PORT}`);
});
