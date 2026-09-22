import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

/** Works from tsx, the workspace npm command, and the nested tsc build. */
export function loadProjectEnvironment(moduleUrl: string) {
  let directory = dirname(fileURLToPath(moduleUrl));
  let target = process.env.PICFIND_ENV_FILE
    ? resolve(process.env.PICFIND_ENV_FILE)
    : undefined;
  while (!target) {
    const manifest = join(directory, 'package.json');
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ===
        'picfind'
    ) {
      target = join(directory, '.env');
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (target && existsSync(target)) loadEnvFile(target);
}
