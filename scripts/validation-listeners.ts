import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rewrite the repository's single-line HTTP/TLS listeners for offline validation.
 * Unsupported forms fail before nginx runs. This is not a general Nginx parser.
 */
export function validationListeners(source: string): string {
  let listeners = 0;
  const result = source.split('\n').map((line) => {
    const code = line.split('#', 1)[0]!;
    if (!/\blisten\b/.test(code)) return line;
    const directive =
      /^(\s*)listen\s+(\S+?)([ \t][^;]*)?;([ \t]*(?:#.*)?)$/.exec(
        line.replace(/\r$/, ''),
      );
    if (!directive) throw new Error('Unsupported validation listener syntax.');
    const [, indent, address, options = '', suffix] = directive;
    const port = /^(?:(?:[\d.]+|\*|\[[\da-fA-F:]+\]):)?(80|443)$/.exec(
      address!,
    )?.[1];
    if (!port) throw new Error('Validation listeners must use port 80 or 443.');
    listeners++;
    const loopback = address!.startsWith('[') ? '[::1]' : '127.0.0.1';
    return `${indent}listen ${loopback}:${port === '80' ? '18080' : '18443'}${options};${suffix}`;
  });
  if (!listeners) throw new Error('No validation listeners found.');
  return result.join('\n');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/validation-listeners.ts <config>');
    process.stdout.write(
      validationListeners(readFileSync(process.argv[2]!, 'utf8')),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Listener validation failed.',
    );
    process.exitCode = 1;
  }
}
