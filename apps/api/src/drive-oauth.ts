import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';

export const DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';

export interface DriveOAuthConfig {
  clientId: string;
  clientSecret: string;
  webOrigin: string;
  secureCookies: boolean;
}

const accessCache = new Map<string, { token: string; expiresAt: number }>();

export function driveRefreshCookie(secure: boolean) {
  return secure ? '__Host-picfind_drive' : 'picfind_drive';
}

export function driveStateCookie(secure: boolean) {
  return secure ? '__Host-picfind_drive_oauth' : 'picfind_drive_oauth';
}

export function driveRedirectUri(webOrigin: string) {
  return `${webOrigin}/api/drive/callback`;
}

export function beginDriveAuthorization(
  config: DriveOAuthConfig,
  state: string,
) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: driveRedirectUri(config.webOrigin),
    response_type: 'code',
    scope: DRIVE_READONLY_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !data.access_token)
    throw new ApiError(
      400,
      'DRIVE_AUTH_FAILED',
      'Google Drive authorization did not complete. Try connecting again.',
    );
  return data;
}

export async function exchangeDriveCode(
  config: DriveOAuthConfig,
  code: string,
) {
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: driveRedirectUri(config.webOrigin),
    }),
  );
  if (!data.refresh_token)
    throw new ApiError(
      400,
      'DRIVE_AUTH_FAILED',
      'Google did not return a reusable Drive grant. Disconnect other Drive apps and try again.',
    );
  return data.refresh_token;
}

function cacheKey(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex');
}

export async function driveAccessToken(
  config: DriveOAuthConfig,
  refreshToken: string,
) {
  const key = cacheKey(refreshToken);
  const cached = accessCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  );
  accessCache.set(key, {
    token: data.access_token!,
    expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000,
  });
  return data.access_token!;
}

export function forgetDriveAccess(refreshToken: string) {
  accessCache.delete(cacheKey(refreshToken));
}
