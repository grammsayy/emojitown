// Entry point for hosting panels (PebbleHost, Pterodactyl and similar) that
// start `node index.js`.
//
// When the source code is here (e.g. pulled with Git), it builds the bot first,
// so "pull, then restart" is all an update takes. If building isn't possible
// (no source, or the build tools weren't installed), it starts the dist folder
// that is already here, e.g. one uploaded from your PC.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const has = (path) => existsSync(new URL(path, import.meta.url));
const tsc = './node_modules/typescript/bin/tsc';

if (has('./src/index.ts') && has(tsc) && process.env.SKIP_BUILD !== '1') {
  console.log('Building the bot…');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL(tsc, import.meta.url)), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
    console.log('Build finished.');
  } catch {
    if (!has('./dist/src/index.js')) {
      console.error('The build failed (see above) and there is no earlier build to start. Send the error above to whoever maintains the bot.');
      process.exit(1);
    }
    console.warn('The build failed (see above). Starting the previous build instead.');
  }
}

if (!has('./dist/src/index.js')) {
  console.error('The bot has not been built yet: the dist folder is missing.');
  console.error('Either install packages (so the build tools are here) and restart, or upload the dist folder built on your PC with "npm run build".');
  process.exit(1);
}
await import('./dist/src/index.js');
