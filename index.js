// Entry point for hosting panels (PebbleHost, Pterodactyl and similar) and for
// `npm start`.
//
// 1. Node.js 22.5–22.12 and 23.0–23.3 only offer the built-in database
//    (node:sqlite) behind a flag. On those versions this file starts itself
//    again with the flag turned on.
// 2. When the source code is here (e.g. pulled with Git), it builds the bot
//    first, so "pull, then restart" is all an update takes. If building isn't
//    possible, it starts the dist folder that is already here.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('.', import.meta.url));
const has = (path) => existsSync(new URL(path, import.meta.url));
const SQLITE_FLAG = '--experimental-sqlite';

async function hasSqlite() {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/** Runs this file again with the database flag, passing signals through and exiting with its code. */
function relaunchWithSqlite() {
  console.log(`Node.js ${process.version} needs ${SQLITE_FLAG} for the built-in database; restarting with it.`);
  const child = spawn(process.execPath, [...process.execArgv, SQLITE_FLAG, self, ...process.argv.slice(2)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function build() {
  const tsc = './node_modules/typescript/bin/tsc';
  if (!has('./src/index.ts') || !has(tsc) || process.env.SKIP_BUILD === '1') return;
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

if (!(await hasSqlite())) {
  if (process.execArgv.includes(SQLITE_FLAG)) {
    console.error(`Node.js ${process.version} has no built-in database (node:sqlite). Choose Node.js 22.13 or newer.`);
    process.exit(1);
  }
  relaunchWithSqlite();
} else {
  build();
  if (!has('./dist/src/index.js')) {
    console.error('The bot has not been built yet: the dist folder is missing.');
    console.error('Either install packages (so the build tools are here) and restart, or upload the dist folder built on your PC with "npm run build".');
    process.exit(1);
  }
  await import('./dist/src/index.js');
}
