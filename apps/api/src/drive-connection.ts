import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { ApiError } from './auth.js';
import type { DriveOAuthConfig } from './drive-oauth.js';

type Purpose = 'state' | 'refresh';
const lifetimes = { state: 10 * 60_000, refresh: 180 * 86400000 };
function key(config: DriveOAuthConfig, purpose: Purpose) {
  return Buffer.from(
    hkdfSync(
      'sha256',
      config.clientSecret,
      config.clientId,
      `picfind.drive.${purpose}.v1`,
      32,
    ),
  );
}
const invalid = () =>
  new ApiError(
    401,
    'DRIVE_NOT_CONNECTED',
    'Connect Google Drive for this PicFind account again.',
  );
export function sealDriveValue(
  config: DriveOAuthConfig,
  ownerId: string,
  value: string,
  purpose: Purpose,
  now = Date.now(),
): string {
  if (!ownerId || !value || value.length > 2048) throw invalid();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config, purpose), iv);
  cipher.setAAD(Buffer.from(`${config.webOrigin}:${ownerId}:${purpose}`));
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        value,
        issuedAt: now,
        expiresAt: now + lifetimes[purpose],
      }),
      'utf8',
    ),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function openDriveValue(
  config: DriveOAuthConfig,
  ownerId: string,
  sealed: string,
  purpose: Purpose,
  now = Date.now(),
): string {
  try {
    if (!ownerId || sealed.length > 4096) throw invalid();
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw invalid();
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key(config, purpose), iv);
    decipher.setAAD(Buffer.from(`${config.webOrigin}:${ownerId}:${purpose}`));
    decipher.setAuthTag(tag);
    const clear = Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64url')),
      decipher.final(),
    ]);
    try {
      const payload = JSON.parse(clear.toString('utf8')) as {
        value?: unknown;
        issuedAt?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof payload.value !== 'string' ||
        !payload.value ||
        payload.value.length > 2048 ||
        typeof payload.issuedAt !== 'number' ||
        !Number.isFinite(payload.issuedAt) ||
        typeof payload.expiresAt !== 'number' ||
        !Number.isFinite(payload.expiresAt) ||
        payload.issuedAt > now + 60_000 ||
        payload.expiresAt <= now ||
        payload.expiresAt - payload.issuedAt !== lifetimes[purpose]
      )
        throw invalid();
      return payload.value;
    } finally {
      clear.fill(0);
    }
  } catch {
    throw invalid();
  }
}
