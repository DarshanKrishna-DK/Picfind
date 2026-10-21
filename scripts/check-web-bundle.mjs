import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const WEB_BUNDLE_BUDGET = { bytes: 600_000, gzipBytes: 200_000 };
export function initialJavascriptFiles(manifest) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest['index.html']?.isEntry !== true
  )
    throw new Error('The build manifest is missing the index.html entry.');
  const visited = new Set(),
    files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = Object.hasOwn(manifest, key) ? manifest[key] : undefined;
    if (
      !chunk ||
      typeof chunk.file !== 'string' ||
      !chunk.file.endsWith('.js') ||
      (chunk.imports !== undefined &&
        (!Array.isArray(chunk.imports) ||
          chunk.imports.some((id) => typeof id !== 'string')))
    )
      throw new Error(`Invalid static JavaScript chunk: ${key}`);
    files.add(chunk.file);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }
  visit('index.html');
  return [...files].sort();
}
export function assertWebBundleBudget(measurement, budget = WEB_BUNDLE_BUDGET) {
  if (
    !Number.isSafeInteger(budget?.bytes) ||
    budget.bytes < 0 ||
    !Number.isSafeInteger(budget?.gzipBytes) ||
    budget.gzipBytes < 0
  )
    throw new Error('The bundle budget is invalid.');
  if (
    !Number.isSafeInteger(measurement.bytes) ||
    measurement.bytes < 0 ||
    !Number.isSafeInteger(measurement.gzipBytes) ||
    measurement.gzipBytes < 0
  )
    throw new Error('The bundle measurement is invalid.');
  if (
    measurement.bytes > budget.bytes ||
    measurement.gzipBytes > budget.gzipBytes
  )
    throw new Error(
      `Initial JavaScript exceeds its budget: ${measurement.bytes}/${budget.bytes} bytes, ${measurement.gzipBytes}/${budget.gzipBytes} gzip bytes.`,
    );
}
async function main() {
  const directory = fileURLToPath(
    new URL('../apps/web/dist/', import.meta.url),
  );
  const manifest = JSON.parse(
    await readFile(resolve(directory, '.vite/manifest.json'), 'utf8'),
  );
  const files = initialJavascriptFiles(manifest),
    chunks = [];
  for (const file of files) {
    const path = resolve(directory, file),
      within = relative(directory, path);
    if (
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith('..\\') ||
      within.startsWith('../')
    )
      throw new Error(
        'A build chunk resolves outside the web output directory.',
      );
    const contents = await readFile(path);
    chunks.push({
      file,
      bytes: contents.length,
      gzipBytes: gzipSync(contents).length,
    });
  }
  const measurement = {
    bytes: chunks.reduce((sum, row) => sum + row.bytes, 0),
    gzipBytes: chunks.reduce((sum, row) => sum + row.gzipBytes, 0),
  };
  assertWebBundleBudget(measurement);
  console.log(
    JSON.stringify(
      { initialJavascript: measurement, budget: WEB_BUNDLE_BUDGET, chunks },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
