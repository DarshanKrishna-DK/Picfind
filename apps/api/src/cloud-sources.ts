import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError, readSession, type AuthOptions } from './auth.js';
import { MAX_INPUT_BYTES } from './images.js';
import { withAccountLock } from './locks.js';
import type { SourceConnections } from './source-connections.js';

export type CloudSource = 'dropbox' | 'onedrive' | 'box';
type Credentials = { clientId: string; clientSecret: string };
export interface CloudSourceOptions {
  connections?: SourceConnections;
  key?: string;
  providers?: Partial<Record<CloudSource, Credentials>>;
  fetcher?: typeof fetch;
}
export interface CloudItem {
  id: string;
  name: string;
  folder: boolean;
  bytes: number;
}
const providers: CloudSource[] = ['dropbox', 'onedrive', 'box'];
const endpoints = {
  dropbox: {
    authorize: 'https://www.dropbox.com/oauth2/authorize',
    token: 'https://api.dropboxapi.com/oauth2/token',
    scope: 'files.metadata.read files.content.read',
  },
  onedrive: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://graph.microsoft.com/Files.Read',
  },
  box: {
    authorize: 'https://account.box.com/api/oauth2/authorize',
    token: 'https://api.box.com/oauth2/token',
    scope: 'root_readonly',
  },
};
type Envelope = {
  owner: string;
  provider: CloudSource;
  expires: number;
  value: string;
  extra?: string;
  authorizationAttempt?: string;
};
export function sealSource(value: Envelope, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function openSource(value: string, key: string): Envelope | null {
  try {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    const result = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    ) as Envelope;
    return result.expires > Date.now() && providers.includes(result.provider)
      ? result
      : null;
  } catch {
    return null;
  }
}
export function cloudSourceEnvironment(
  env: NodeJS.ProcessEnv,
): CloudSourceOptions {
  const configured: Partial<Record<CloudSource, Credentials>> = {};
  for (const name of providers) {
    const prefix = name.toUpperCase();
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecret = env[`${prefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) configured[name] = { clientId, clientSecret };
  }
  return {
    providers: configured,
    ...(env.SOURCE_COOKIE_KEY ? { key: env.SOURCE_COOKIE_KEY } : {}),
  };
}
function cloudError(status = 502) {
  return new ApiError(
    status,
    'SOURCE_UNAVAILABLE',
    'The source could not complete this request. Reconnect if access expired, and check file permissions.',
  );
}
export function trustedSourceDownload(provider: CloudSource, input: string) {
  const url = new URL(input);
  const suffixes =
    provider === 'dropbox'
      ? ['dropboxusercontent.com', 'dropbox.com']
      : provider === 'box'
        ? ['boxcloud.com']
        : ['1drv.com', 'onedrive.live.com', 'sharepoint.com', 'sharepoint.us'];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !suffixes.some(
      (suffix) =>
        url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  )
    throw cloudError();
  return url;
}
async function boundedBody(response: Response) {
  if (!response.ok || !response.body) throw cloudError();
  if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES)
    throw new ApiError(
      413,
      'PHOTO_TOO_LARGE',
      'Choose a photo smaller than 8 MB.',
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_INPUT_BYTES)
        throw new ApiError(
          413,
          'PHOTO_TOO_LARGE',
          'Choose a photo smaller than 8 MB.',
        );
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function createCloudSources(
  auth: AuthOptions,
  options: CloudSourceOptions,
  owner: (req: Request) => Promise<string>,
  importPhotos: (
    user: string,
    source: CloudSource,
    ids: string[],
    eventId: string | undefined,
    read: (id: string) => Promise<{ name: string; bytes: Buffer }>,
  ) => Promise<unknown>,
) {
  const router = Router();
  const fetcher = options.fetcher ?? fetch;
  const key = /^[a-f\d]{64}$/i.test(options.key ?? '')
    ? options.key
    : undefined;
  const cookie = {
    httpOnly: true,
    secure: auth.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const cookieName = (provider: CloudSource, state = false) =>
    `${auth.secureCookies ? '__Host-' : ''}picfind_${provider}${state ? '_state' : ''}`;
  function providerOf(value: unknown): CloudSource {
    if (!providers.includes(value as CloudSource))
      throw new ApiError(
        404,
        'SOURCE_NOT_FOUND',
        'This source is not supported.',
      );
    return value as CloudSource;
  }
  function configured(provider: CloudSource) {
    const credentials = options.providers?.[provider];
    if (!key || !credentials)
      throw new ApiError(
        503,
        'SOURCE_NOT_CONFIGURED',
        'This connection needs its provider OAuth application and a server encryption key.',
      );
    return credentials;
  }
  function saved(
    req: Request,
    provider: CloudSource,
    user: string,
    state = false,
  ) {
    const value =
      key &&
      openSource(readSession(req, cookieName(provider, state)) ?? '', key);
    return value && value.owner === user && value.provider === provider
      ? value
      : null;
  }
  async function connectionFor(
    req: Request,
    provider: CloudSource,
    user: string,
  ) {
    if (options.connections) {
      const access = await options.connections.access(user, provider);
      return {
        value: access.accessToken,
        expires: access.expiresAt,
        generation: access.generation,
      };
    }
    const connection = saved(req, provider, user);
    if (!connection) throw cloudError(401);
    return { ...connection, generation: undefined };
  }
  function scope(provider: CloudSource) {
    return (
      endpoints[provider].scope +
      (options.connections && provider === 'onedrive' ? ' offline_access' : '')
    );
  }
  async function json(url: string, token: string, body?: unknown) {
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw cloudError(response.status === 401 ? 401 : 502);
    return (await response.json()) as Record<string, unknown>;
  }
  async function read(provider: CloudSource, token: string, id: string) {
    let name: string;
    let url: string;
    if (provider === 'dropbox') {
      const data = await json(
        'https://api.dropboxapi.com/2/files/get_temporary_link',
        token,
        { path: id },
      );
      name = String((data.metadata as { name: string }).name);
      url = String(data.link);
    } else {
      const base =
        provider === 'box'
          ? `https://api.box.com/2.0/files/${encodeURIComponent(id)}`
          : `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}`;
      const metadata = await json(base, token);
      name = String(metadata.name);
      const result = await fetcher(`${base}/content`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      if (result.status === 200)
        return { name, bytes: await boundedBody(result) };
      if (![301, 302, 303, 307, 308].includes(result.status))
        throw cloudError();
      url = result.headers.get('location') ?? '';
    }
    // Never forward an OAuth token to a storage/CDN redirect.
    for (let redirects = 0; redirects < 4; redirects++) {
      const safe = trustedSourceDownload(provider, url);
      const result = await fetcher(safe, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (result.ok) return { name, bytes: await boundedBody(result) };
      const location = result.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(result.status) || !location)
        throw cloudError();
      url = new URL(location, safe).toString();
    }
    throw cloudError();
  }
  router.get('/sources', async (req, res) => {
    const user = await owner(req);
    res.json({
      sources: await Promise.all(
        providers.map(async (provider) => ({
          id: provider,
          configured: Boolean(key && options.providers?.[provider]),
          ...(options.connections
            ? await options.connections.status(user, provider)
            : {
                connected: Boolean(saved(req, provider, user)),
                persistent: false,
              }),
        })),
      ),
    });
  });
  router.post('/sources/:provider/connect', async (req, res) => {
    const user = await owner(req);
    const provider = providerOf(req.params.provider);
    const config = configured(provider);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const authorizationAttempt = options.connections
      ? await withAccountLock(user, async () => {
          await owner(req);
          return options.connections!.beginAuthorization(user, provider);
        })
      : undefined;
    res.cookie(
      cookieName(provider, true),
      sealSource(
        {
          owner: user,
          provider,
          value: state,
          extra: verifier,
          ...(authorizationAttempt ? { authorizationAttempt } : {}),
          expires: Date.now() + 600_000,
        },
        key!,
      ),
      { ...cookie, maxAge: 600_000 },
    );
    const url = new URL(endpoints[provider].authorize);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: `${auth.webOrigin}/api/sources/${provider}/callback`,
      state,
      scope: scope(provider),
    }).toString();
    if (options.connections && provider === 'dropbox')
      url.searchParams.set('token_access_type', 'offline');
    if (provider !== 'box') {
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
    }
    res.json({ url: url.toString() });
  });
  router.get('/sources/:provider/callback', async (req, res) => {
    const user = await owner(req);
    const provider = providerOf(req.params.provider);
    const config = configured(provider);
    const state = saved(req, provider, user, true);
    res.clearCookie(cookieName(provider, true), cookie);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (
        !state ||
        state.value !== req.query.state ||
        typeof req.query.code !== 'string'
      )
        throw cloudError();
      if (options.connections && !state.authorizationAttempt)
        throw cloudError();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: req.query.code,
        redirect_uri: `${auth.webOrigin}/api/sources/${provider}/callback`,
      });
      if (provider !== 'box') form.set('code_verifier', state.extra!);
      if (provider === 'onedrive') form.set('scope', scope(provider));
      const response = await fetcher(endpoints[provider].token, {
        method: 'POST',
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw cloudError();
      const result = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (
        typeof result.access_token !== 'string' ||
        !result.access_token ||
        result.access_token.length > (options.connections ? 16384 : 2300)
      )
        throw cloudError();
      const duration =
        Math.min(3600, Math.max(60, Number(result.expires_in) || 3600)) * 1000;
      if (options.connections) {
        if (
          typeof result.refresh_token !== 'string' ||
          !result.refresh_token ||
          result.refresh_token.length > 16384
        )
          throw cloudError();
        const grant = {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
          accessExpiresAt: Date.now() + duration,
        };
        await withAccountLock(user, async () => {
          await owner(req); // Revalidate after waiting: account deletion may have completed.
          await options.connections!.connect(
            user,
            provider,
            grant,
            state.authorizationAttempt,
          );
        });
        res.clearCookie(cookieName(provider), cookie);
      } else {
        res.cookie(
          cookieName(provider),
          sealSource(
            {
              owner: user,
              provider,
              value: result.access_token,
              expires: Date.now() + duration,
            },
            key!,
          ),
          { ...cookie, maxAge: duration },
        );
      }
      res.redirect(
        `${auth.webOrigin}/app/import?source=${provider}&connected=1`,
      );
    } catch {
      res.redirect(
        `${auth.webOrigin}/app/import?source=${provider}&connected=0`,
      );
    }
  });
  router.delete('/sources/:provider', async (req, res) => {
    const user = await owner(req);
    const provider = providerOf(req.params.provider);
    if (options.connections)
      await withAccountLock(user, async () => {
        await owner(req);
        await options.connections!.disconnect(user, provider);
      });
    res.clearCookie(cookieName(provider), cookie);
    res.clearCookie(cookieName(provider, true), cookie);
    res.status(204).end();
  });
  router.get('/sources/:provider/items', async (req, res) => {
    const user = await owner(req);
    const provider = providerOf(req.params.provider);
    configured(provider);
    const connection = await connectionFor(req, provider, user);
    const folder = typeof req.query.folder === 'string' ? req.query.folder : '';
    if (
      folder.length > 512 ||
      [...folder].some((char) => char.charCodeAt(0) < 32)
    )
      throw cloudError(400);
    let cursor: string | undefined;
    if (req.query.cursor) {
      const decoded =
        typeof req.query.cursor === 'string'
          ? openSource(req.query.cursor, key!)
          : null;
      if (
        !decoded ||
        decoded.owner !== user ||
        decoded.provider !== provider ||
        decoded.extra !== folder
      )
        throw cloudError(400);
      cursor = decoded.value;
    }
    let rows: Record<string, unknown>[];
    let next: string | undefined;
    if (provider === 'dropbox') {
      const data = await json(
        `https://api.dropboxapi.com/2/files/list_folder${cursor ? '/continue' : ''}`,
        connection.value,
        cursor
          ? { cursor }
          : {
              path: folder,
              limit: 100,
              recursive: false,
              include_deleted: false,
            },
      );
      rows = data.entries as Record<string, unknown>[];
      if (data.has_more) next = String(data.cursor);
    } else if (provider === 'box') {
      const url = new URL(
        `https://api.box.com/2.0/folders/${encodeURIComponent(folder || '0')}/items`,
      );
      url.search = new URLSearchParams({
        limit: '100',
        usemarker: 'true',
        fields: 'id,name,type,size',
        ...(cursor ? { marker: cursor } : {}),
      }).toString();
      const data = await json(url.toString(), connection.value);
      rows = data.entries as Record<string, unknown>[];
      if (data.next_marker) next = String(data.next_marker);
    } else {
      const path = folder ? `items/${encodeURIComponent(folder)}` : 'root';
      const url =
        cursor ??
        `https://graph.microsoft.com/v1.0/me/drive/${path}/children?$top=100&$select=id,name,size,folder,file`;
      if (!url.startsWith('https://graph.microsoft.com/v1.0/me/drive/'))
        throw cloudError(400);
      const data = await json(url, connection.value);
      rows = data.value as Record<string, unknown>[];
      if (data['@odata.nextLink']) next = String(data['@odata.nextLink']);
    }
    const items: CloudItem[] = rows
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        bytes: Number(row.size) || 0,
        folder:
          row['.tag'] === 'folder' ||
          row.type === 'folder' ||
          Boolean(row.folder),
      }))
      .filter((row) => row.folder || /\.(jpe?g|png|webp)$/i.test(row.name));
    res.json({
      items,
      generation: connection.generation ?? null,
      cursor: next
        ? sealSource(
            {
              owner: user,
              provider,
              expires: connection.expires,
              value: next,
              extra: folder,
            },
            key!,
          )
        : null,
    });
  });
  router.post('/imports/source', async (req, res) => {
    const user = await owner(req);
    const data = z
      .object({
        provider: z.enum(['dropbox', 'onedrive', 'box']),
        ids: z.array(z.string().min(1).max(512)).min(1).max(20),
        eventId: z.uuid().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose between 1 and 20 photos.',
      );
    configured(data.data.provider);
    const connection = await connectionFor(req, data.data.provider, user);
    const job = await importPhotos(
      user,
      data.data.provider,
      [...new Set(data.data.ids)],
      data.data.eventId,
      (id) => read(data.data.provider, connection.value, id),
    );
    res.status(201).json({ job });
  });
  return router;
}
