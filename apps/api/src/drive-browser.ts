import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { parseDriveFolderId } from './drive.js';
import type { SourceConnections } from './source-connections.js';

const folderMime = 'application/vnd.google-apps.folder';
const imageMimes = ['image/jpeg', 'image/png', 'image/webp'];
const querySchema = z
  .object({
    folder: z.string().max(2048).default(''),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict();
const pageSchema = z.object({
  files: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
        name: z.string().min(1).max(1024),
        mimeType: z.string(),
        size: z.string().regex(/^\d+$/).optional(),
      }),
    )
    .max(100)
    .default([]),
  nextPageToken: z.string().max(4096).optional(),
  incompleteSearch: z.boolean().optional(),
});
const invalidCursor = () =>
  new ApiError(
    400,
    'DRIVE_CURSOR_INVALID',
    'This folder page expired or the connection changed. Browse the folder again.',
  );

/** Metadata only. Cursors expire on restart; saved import manifests do not. */
export class DriveFolderBrowser {
  private readonly key = randomBytes(32);
  constructor(
    private readonly connections: Pick<SourceConnections, 'access'>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  private seal(token: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const bytes = Buffer.concat([
      cipher.update(
        JSON.stringify({ token, expires: this.now() + 30 * 60_000 }),
      ),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      'base64url',
    );
  }
  private open(cursor: string, context: string) {
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length < 29) throw invalidCursor();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const value = z
        .object({
          token: z.string().min(1).max(4096),
          expires: z.number().finite(),
        })
        .parse(
          JSON.parse(
            Buffer.concat([
              decipher.update(bytes.subarray(28)),
              decipher.final(),
            ]).toString(),
          ),
        );
      if (value.expires <= this.now()) throw invalidCursor();
      return value.token;
    } catch {
      throw invalidCursor();
    }
  }
  async list(ownerId: string, input: unknown) {
    const query = querySchema.safeParse(input);
    if (!query.success)
      throw new ApiError(
        400,
        'INVALID_SOURCE',
        'Choose a Drive folder and a valid page.',
      );
    let folder = query.data.folder || 'root';
    if (folder.startsWith('https://')) {
      if (!URL.canParse(folder))
        throw new ApiError(
          400,
          'INVALID_SOURCE',
          'Enter a Google Drive folder link.',
        );
      const url = new URL(folder);
      if (url.username || url.password || url.port)
        throw new ApiError(
          400,
          'INVALID_SOURCE',
          'Enter a Google Drive folder link.',
        );
      folder = parseDriveFolderId(folder);
    }
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(folder))
      throw new ApiError(
        400,
        'INVALID_SOURCE',
        'Enter a Google Drive folder link.',
      );
    const access = await this.connections.access(ownerId, 'drive');
    const context = JSON.stringify([ownerId, folder, access.generation]);
    const token = query.data.cursor
      ? this.open(query.data.cursor, context)
      : undefined;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.search = new URLSearchParams({
      q: `'${folder}' in parents and trashed = false and (mimeType = '${folderMime}' or ${imageMimes.map((mime) => `mimeType = '${mime}'`).join(' or ')})`,
      pageSize: '100',
      fields: 'files(id,name,mimeType,size),nextPageToken,incompleteSearch',
      orderBy: 'folder,name_natural',
      spaces: 'drive',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(token ? { pageToken: token } : {}),
    }).toString();
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${access.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new ApiError(
        502,
        'SOURCE_UNAVAILABLE',
        'Google Drive could not load this folder. Try again.',
      );
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 400 && token) throw invalidCursor();
      if (response.status === 401)
        throw new ApiError(
          401,
          'SOURCE_RECONNECT_REQUIRED',
          'Reconnect Google Drive before browsing this folder.',
        );
      if ([403, 404].includes(response.status))
        throw new ApiError(
          403,
          'SOURCE_ACCESS_DENIED',
          'This Google account cannot open that folder. Check the link and folder sharing permissions.',
        );
      throw new ApiError(
        502,
        'SOURCE_UNAVAILABLE',
        'Google Drive could not load this folder. Try again.',
      );
    }
    const parsed = pageSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success || (token && parsed.data.nextPageToken === token))
      throw new ApiError(
        502,
        'SOURCE_UNAVAILABLE',
        'Google Drive returned an invalid folder page. Try browsing again.',
      );
    return {
      items: parsed.data.files
        .filter(
          (file) =>
            file.mimeType === folderMime || imageMimes.includes(file.mimeType),
        )
        .map((file) => ({
          id: file.id,
          name: file.name,
          folder: file.mimeType === folderMime,
          bytes: file.size
            ? Math.min(Number(file.size), Number.MAX_SAFE_INTEGER)
            : 0,
        })),
      cursor: parsed.data.nextPageToken
        ? this.seal(parsed.data.nextPageToken, context)
        : null,
      generation: access.generation,
      incomplete: parsed.data.incompleteSearch ?? false,
    };
  }
}
