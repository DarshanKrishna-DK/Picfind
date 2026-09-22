import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkLaunchConfig } from '../apps/api/src/launch-config.js';

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(
      'Launch configuration could not be loaded. Details withheld to protect secrets.',
    );
    process.exit(1);
  }
}
const checks = checkLaunchConfig(process.env);
const blocked = checks.filter((check) => check.status === 'block').length;
const manual = checks.filter((check) => check.status === 'manual').length;
console.info(
  'PicFind offline launch preflight. No providers contacted; no settings changed.',
);
for (const check of checks)
  console.info(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
console.info(
  `${blocked} configuration blockers; ${manual} external/manual gates. Passing configuration does not mean launch-ready.`,
);
process.exitCode = blocked ? 1 : 0;
