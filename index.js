// Entry point for hosting panels (PebbleHost, Pterodactyl and similar) that
// start `node index.js`. It runs the compiled bot from dist/. Build it first
// with `npm run build`, or upload the dist folder built on your PC.
import { existsSync } from 'node:fs';

if (!existsSync(new URL('./dist/src/index.js', import.meta.url))) {
  console.error('The bot has not been built yet: the dist folder is missing.');
  console.error('Run "npm run build" (or upload the dist folder from your PC), then start the bot again.');
  process.exit(1);
}
await import('./dist/src/index.js');
