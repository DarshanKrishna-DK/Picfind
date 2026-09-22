import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { waitForStartup } from './dev-startup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) loadEnvFile(resolve(root, '.env'));
const safe = process.argv.includes('--safe');
const env = {
  ...process.env,
  PORT: '3001',
  WEB_ORIGIN: 'http://127.0.0.1:5173',
  ...(safe ? { FACE_PROVIDER: 'none' } : {}),
};
async function available(port) {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(
          `Port ${port} is in use. Stop the existing PicFind dev process before starting another.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolvePort));
  });
}
try {
  await available(3001);
  await available(5173);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
function start(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(child);
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
// One managed API process: a Windows watch subprocess can survive its parent.
start(['--import', 'tsx', 'apps/api/src/server.ts'], root);
start(
  [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--strictPort',
  ],
  resolve(root, 'apps/web'),
);
console.info('Waiting for the PicFind web page and API...');
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
try {
  if (await waitForStartup({ isStopping: () => stopping })) {
    console.info(
      `PicFind web + API running: http://127.0.0.1:5173. ${safe ? 'Safe mode: no face provider calls.' : 'Cloud processing still requires explicit in-app consent.'}`,
    );
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const browser = spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', "Start-Process 'http://127.0.0.1:5173'"],
        { windowsHide: true, stdio: 'ignore' },
      );
      browser.on('error', () =>
        console.info('Open http://127.0.0.1:5173 in your browser.'),
      );
    }
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
