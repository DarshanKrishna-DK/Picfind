import { ApiError } from './auth.js';
import { AppwriteSourceConnectionStore } from './adapters/appwrite-source-connections.js';
import {
  SourceConnections,
  type SourceProvider,
  type SourceRefresh,
} from './source-connections.js';

const endpoints: Record<SourceProvider, string> = {
  drive: 'https://oauth2.googleapis.com/token',
  dropbox: 'https://api.dropboxapi.com/oauth2/token',
  onedrive: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  box: 'https://api.box.com/oauth2/token',
};
export function sourceRefresher(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
  now = Date.now,
): SourceRefresh {
  return async (provider, refreshToken) => {
    const prefix =
      provider === 'drive' ? 'GOOGLE_DRIVE' : provider.toUpperCase();
    const clientId = env[prefix + '_CLIENT_ID'],
      clientSecret = env[prefix + '_CLIENT_SECRET'];
    if (!clientId || !clientSecret)
      throw new ApiError(
        503,
        'SOURCE_NOT_CONFIGURED',
        'This cloud source needs its OAuth application configured.',
      );
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
    if (provider === 'onedrive')
      body.set(
        'scope',
        'https://graph.microsoft.com/Files.Read offline_access',
      );
    // A rotating refresh token is single-use. Never automatically retry this request.
    const response = await fetcher(endpoints[provider], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new ApiError(
        401,
        'SOURCE_RECONNECT_REQUIRED',
        'Reconnect this cloud source to continue.',
      );
    const value = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof value.access_token !== 'string' ||
      !value.access_token ||
      value.access_token.length > 16384 ||
      (value.refresh_token !== undefined &&
        (typeof value.refresh_token !== 'string' ||
          !value.refresh_token ||
          value.refresh_token.length > 16384)) ||
      typeof value.expires_in !== 'number' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 30
    )
      throw new ApiError(
        401,
        'SOURCE_RECONNECT_REQUIRED',
        'Reconnect this cloud source to continue.',
      );
    return {
      accessToken: value.access_token,
      accessExpiresAt: now() + Math.min(value.expires_in, 86400) * 1000,
      ...(typeof value.refresh_token === 'string'
        ? { refreshToken: value.refresh_token }
        : {}),
    };
  };
}
export function sourceConnectionsFromEnvironment(env: NodeJS.ProcessEnv) {
  if (env.SOURCE_CONNECTIONS_ENABLED !== 'true') return undefined;
  const {
    APPWRITE_ENDPOINT: endpoint,
    APPWRITE_PROJECT_ID: projectId,
    APPWRITE_API_KEY: apiKey,
    SOURCE_COOKIE_KEY: key,
  } = env;
  if (!endpoint || !projectId || !apiKey || !key)
    throw new Error(
      'Persistent cloud connections require Appwrite credentials, SOURCE_COOKIE_KEY, and the source-connections table.',
    );
  return new SourceConnections(
    new AppwriteSourceConnectionStore({ endpoint, projectId, apiKey }),
    key,
    sourceRefresher(env),
  );
}
