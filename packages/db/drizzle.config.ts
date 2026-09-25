import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  // Matches the 'snake_case' casing createDb() passes to drizzle() in client.ts
  casing: 'snake_case',
});
