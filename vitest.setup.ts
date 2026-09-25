import process from 'node:process';

// ??= leaves an explicitly blank ENSMAP_FIXTURES= in place; loadEnv then
// treats that as unset, bypassing this default. Treat unset and blank alike.
if (!process.env['ENSMAP_FIXTURES']) {
  process.env['ENSMAP_FIXTURES'] = 'replay';
}
