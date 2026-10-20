import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validationListeners } from '../../scripts/validation-listeners';

describe('offline deployment listener isolation', () => {
  it.each([
    ['listen 80;', 'listen 127.0.0.1:18080;'],
    [
      '  listen   80 default_server;',
      '  listen 127.0.0.1:18080 default_server;',
    ],
    ['listen 443 ssl http2;', 'listen 127.0.0.1:18443 ssl http2;'],
    ['listen 0.0.0.0:443 ssl;', 'listen 127.0.0.1:18443 ssl;'],
    ['listen *:80;', 'listen 127.0.0.1:18080;'],
    ['listen [::]:443 ssl ipv6only=on;', 'listen [::1]:18443 ssl ipv6only=on;'],
    ['listen\t80;\t# local check', 'listen 127.0.0.1:18080;\t# local check'],
  ])('rewrites %s while retaining directive options', (input, expected) => {
    expect(validationListeners(input)).toBe(expected);
  });

  it.each([
    'listen 8080;',
    'listen unix:/tmp/socket;',
    'listen\n80;',
    'server { listen 80; }',
    'listen 80; listen 443 ssl;',
    'listen localhost:80;',
    '# listen 80;',
    'server {}',
  ])('rejects unsupported or missing listeners: %s', (input) => {
    expect(() => validationListeners(input)).toThrow();
  });

  it('rewrites the actual template, preserves comments and never changes the source file', () => {
    const file = new URL('../../infra/picfind.nginx.conf', import.meta.url);
    const source = readFileSync(file, 'utf8');
    const result = validationListeners(source);
    expect(result.match(/^\s*listen\s+[^;]+;/gm)).toEqual([
      '    listen 127.0.0.1:18080;',
      '    listen 127.0.0.1:18443 ssl;',
    ]);
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(validationListeners('# listen 9999;\nlisten 80;\r\n')).toBe(
      '# listen 9999;\nlisten 127.0.0.1:18080;\n',
    );
  });
});
