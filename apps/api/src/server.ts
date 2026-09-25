import { loadDotEnv } from '@ensmap/core/config';
import { serve } from '@hono/node-server';

import { createApp } from './app.ts';

loadDotEnv();

serve({ fetch: createApp({}).fetch, port: 3000 });
