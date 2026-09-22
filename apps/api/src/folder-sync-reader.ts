import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import {
  SYNC_PAGE_SIZE,
  type FolderSync,
  type FolderSyncPorts,
} from './folder-sync.js';
import { validImportFileId } from './import-policy.js';
import { MAX_INPUT_BYTES } from './images.js';
import type { SourceConnections } from './source-connections.js';

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_TOKEN_BYTES = 4096;
const supported = new Set(['image/jpeg', 'image/png', 'image/webp']);
const extension = /\.(jpe?g|png|webp)$/i;
const invalid = () =>
  new ApiError(
    409,
    'SYNC_INVALID_PAGE',
    'The provider returned a folder page that cannot safely advance.',
  );
const expired = () =>
  new ApiError(
    409,
    'SYNC_CURSOR_EXPIRED',
    'Restart this folder scan using its saved import history.',
  );
const unavailable = () =>
  new ApiError(
    503,
    'SOURCE_UNAVAILABLE',
    'Folder metadata is temporarily unavailable.',
  );
const entries = z.array(z.record(z.string(), z.unknown())).max(1000);
const tokenSchema = z.string().min(1).max(MAX_TOKEN_BYTES);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
export function validateSyncFolder(
  sync: Pick<FolderSync, 'provider' | 'folderId'>,
) {
  const value = sync.folderId;
  const valid =
    sync.provider === 'drive'
      ? /^[A-Za-z0-9_-]{1,512}$/.test(value) && value !== 'root'
      : sync.provider === 'box'
        ? /^[0-9]{1,32}$/.test(value) && value !== '0'
        : sync.provider === 'onedrive'
          ? /^[A-Za-z0-9!._-]{1,512}$/.test(value) && value !== 'root'
          : /^(id:[A-Za-z0-9_-]+|\/.+)$/.test(value) &&
            ![...value].some(
              (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
            ) &&
            value.length <= 2048;
  if (!valid)
    throw new ApiError(
      400,
      'SYNC_FOLDER_REQUIRED',
      'Select one specific cloud folder for automatic sync.',
    );
  return value;
}
function graphPage(input: string, folderId: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  const path = url.pathname.match(
    /^\/v1\.0\/(?:me\/drive|drives\/[A-Za-z0-9!._-]+)\/items\/([^/]+)\/children$/,
  );
  let item: string;
  try {
    item = decodeURIComponent(path?.[1] ?? '');
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'graph.microsoft.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    item !== folderId ||
    [...url.searchParams.keys()].some(
      (key) => !['$top', '$select', '$skiptoken', '$skip'].includes(key),
    ) ||
    (url.searchParams.has('$top') &&
      (!/^\d+$/.test(url.searchParams.get('$top')!) ||
        Number(url.searchParams.get('$top')) < 1 ||
        Number(url.searchParams.get('$top')) > SYNC_PAGE_SIZE))
  )
    throw invalid();
  return url;
}
async function json(response: Response) {
  if (!response.body) throw unavailable();
  if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
    await response.body.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_METADATA_BYTES) throw invalid();
      chunks.push(next.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw invalid();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function photo(row: Record<string, unknown>, size: unknown) {
  if (
    !validImportFileId(row.id) ||
    typeof row.name !== 'string' ||
    !row.name ||
    row.name.length > 1024 ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw invalid();
  return size > 0 && size <= MAX_INPUT_BYTES ? row.id : null;
}

/** Private worker cursors only. Unlike browser cursors, these use a stable server key. */
export function createFolderSyncReader(
  connections: Pick<SourceConnections, 'access'>,
  encryptionKey: string,
  fetcher: typeof fetch = fetch,
  now = Date.now,
): FolderSyncPorts['list'] {
  if (!/^[a-f\d]{64}$/i.test(encryptionKey))
    throw new Error(
      'Folder sync requires a stable 32-byte server encryption key.',
    );
  const key = createHmac('sha256', Buffer.from(encryptionKey, 'hex'))
    .update('picfind-folder-sync-cursor-v1')
    .digest();
  const context = (sync: FolderSync) =>
    Buffer.from(
      JSON.stringify([
        sync.id,
        sync.ownerId,
        sync.actorId,
        sync.eventId,
        sync.provider,
        sync.generation,
        sync.membershipGrantId ?? null,
        sync.folderId,
      ]),
    );
  function seal(value: string, sync: FolderSync) {
    if (Buffer.byteLength(value) > MAX_TOKEN_BYTES) throw invalid();
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context(sync));
    const bytes = Buffer.concat([
      cipher.update(
        JSON.stringify({ token: value, expires: now() + 7 * 86400000 }),
      ),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      'base64url',
    );
  }
  function open(value: string, sync: FolderSync) {
    try {
      if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value))
        throw invalid();
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length < 29) throw invalid();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(context(sync));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const data = parse(
        z.object({ token: tokenSchema, expires: z.number().finite() }).strict(),
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString('utf8'),
        ),
      );
      if (data.expires <= now()) throw expired();
      return data.token;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SYNC_CURSOR_EXPIRED')
        throw error;
      throw invalid();
    }
  }
  return async (sync, limit, guard) => {
    if (limit !== SYNC_PAGE_SIZE) throw invalid();
    const folderId = validateSyncFolder(sync),
      cursor = sync.cursor ? open(sync.cursor, sync) : null;
    let url: URL, body: object | undefined;
    if (sync.provider === 'drive') {
      url = new URL('https://www.googleapis.com/drive/v3/files');
      url.search = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp')`,
        pageSize: String(limit),
        fields: 'files(id,name,mimeType,size),nextPageToken,incompleteSearch',
        spaces: 'drive',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(cursor ? { pageToken: cursor } : {}),
      }).toString();
    } else if (sync.provider === 'dropbox') {
      url = new URL(
        'https://api.dropboxapi.com/2/files/list_folder' +
          (cursor ? '/continue' : ''),
      );
      body = cursor
        ? { cursor }
        : {
            path: folderId,
            recursive: false,
            include_deleted: false,
            include_non_downloadable_files: false,
            limit,
          };
    } else if (sync.provider === 'box') {
      url = new URL(`https://api.box.com/2.0/folders/${folderId}/items`);
      url.search = new URLSearchParams({
        usemarker: 'true',
        limit: String(limit),
        fields: 'id,type,name,size',
        ...(cursor ? { marker: cursor } : {}),
      }).toString();
    } else {
      url = cursor
        ? graphPage(cursor, folderId)
        : new URL(
            `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(folderId)}/children`,
          );
      if (!cursor)
        url.search = new URLSearchParams({
          $top: String(limit),
          $select: 'id,name,size,file,folder,remoteItem',
        }).toString();
    }
    await guard();
    const access = await connections.access(
      sync.actorId,
      sync.provider,
      sync.generation,
    );
    await guard();
    const response = await fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + access.accessToken,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw unavailable();
    });
    if (!response.ok) {
      if (cursor && sync.provider === 'dropbox' && response.status === 409) {
        const error = parse(
          z.object({ error: z.object({ '.tag': z.string() }) }),
          await json(response),
        );
        if (error.error['.tag'] === 'reset') throw expired();
        throw new ApiError(
          403,
          'SOURCE_ACCESS_DENIED',
          'This folder is no longer available to the connected account.',
        );
      }
      await response.body?.cancel().catch(() => {});
      if (cursor && [400, 410].includes(response.status)) throw expired();
      if (response.status === 401)
        throw new ApiError(
          401,
          'SOURCE_RECONNECT_REQUIRED',
          'Reconnect this source before continuing sync.',
        );
      if ([403, 404].includes(response.status))
        throw new ApiError(
          403,
          'SOURCE_ACCESS_DENIED',
          'This folder is no longer available to the connected account.',
        );
      throw unavailable();
    }
    const data = await json(response);
    let rows: Record<string, unknown>[], next: string | null;
    if (sync.provider === 'drive') {
      const page = parse(
        z.object({
          files: entries.default([]),
          nextPageToken: tokenSchema.optional(),
          incompleteSearch: z.boolean().optional(),
        }),
        data,
      );
      if (page.incompleteSearch) throw invalid();
      rows = page.files.filter(
        (row) =>
          typeof row.mimeType === 'string' && supported.has(row.mimeType),
      );
      next = page.nextPageToken ?? null;
    } else if (sync.provider === 'dropbox') {
      const page = parse(
        z.object({ entries, cursor: tokenSchema, has_more: z.boolean() }),
        data,
      );
      rows = page.entries.filter(
        (row) =>
          row['.tag'] === 'file' &&
          row.is_downloadable !== false &&
          typeof row.name === 'string' &&
          extension.test(row.name),
      );
      next = page.has_more ? page.cursor : null;
    } else if (sync.provider === 'box') {
      const page = parse(
        z.object({ entries, next_marker: tokenSchema.nullable().optional() }),
        data,
      );
      rows = page.entries.filter(
        (row) =>
          row.type === 'file' &&
          typeof row.name === 'string' &&
          extension.test(row.name),
      );
      next = page.next_marker ?? null;
    } else {
      const page = parse(
        z.object({ value: entries, '@odata.nextLink': tokenSchema.optional() }),
        data,
      );
      rows = page.value.filter(
        (row) =>
          !!row.file &&
          !row.folder &&
          !row.remoteItem &&
          typeof row.name === 'string' &&
          extension.test(row.name),
      );
      next = page['@odata.nextLink'] ?? null;
      if (next) graphPage(next, folderId);
    }
    if (next && next === cursor) throw invalid();
    const fileIds = [
      ...new Set(
        rows.flatMap((row) => {
          const size =
            sync.provider === 'drive' &&
            typeof row.size === 'string' &&
            /^\d+$/.test(row.size)
              ? Number(row.size)
              : row.size;
          const id = photo(row, size);
          return id ? [id] : [];
        }),
      ),
    ];
    // A provider may treat its requested limit as approximate. Never truncate it.
    if (fileIds.length > limit) throw invalid();
    await guard();
    await connections.access(sync.actorId, sync.provider, sync.generation);
    await guard();
    return { fileIds, nextCursor: next ? seal(next, sync) : null };
  };
}
