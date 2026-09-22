import { ApiError } from './auth.js';
import { MAX_INPUT_BYTES } from './images.js';
import { validImportFileId } from './import-policy.js';
import type { SourceProvider } from './source-connections.js';

const unavailable = (status = 502) =>
  new ApiError(
    status,
    status === 401 ? 'SOURCE_RECONNECT_REQUIRED' : 'SOURCE_UNAVAILABLE',
    status === 401
      ? 'Reconnect this cloud source before continuing.'
      : 'The source could not return this photo. Check its permissions and try again.',
  );
const missingFile = () =>
  new ApiError(
    404,
    'SOURCE_FILE_MISSING',
    'This source photo is no longer available.',
  );
export function trustedSourceDownload(provider: SourceProvider, input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw unavailable();
  }
  const suffixes =
    provider === 'drive'
      ? ['googleusercontent.com', 'googleapis.com']
      : provider === 'dropbox'
        ? ['dropboxusercontent.com', 'dropbox.com']
        : provider === 'box'
          ? ['boxcloud.com']
          : [
              '1drv.com',
              'onedrive.live.com',
              'sharepoint.com',
              'sharepoint.us',
            ];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !suffixes.some(
      (suffix) =>
        url.hostname === suffix || url.hostname.endsWith('.' + suffix),
    )
  )
    throw unavailable();
  return url;
}
async function boundedBody(response: Response) {
  if (!response.ok || !response.body)
    throw unavailable(response.status === 401 ? 401 : 502);
  const tooLarge = () =>
    new ApiError(413, 'PHOTO_TOO_LARGE', 'Choose a photo smaller than 8 MB.');
  if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES) {
    await response.body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_INPUT_BYTES) {
        chunk.value.fill(0);
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
    if (!size) throw new ApiError(422, 'INVALID_IMAGE', 'This photo is empty.');
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => {});
  }
}
export type CloudFileReader = (
  provider: SourceProvider,
  token: string,
  id: string,
  assertAccess?: () => Promise<void>,
) => Promise<{ name: string; bytes: Buffer }>;
export function createCloudFileReader(
  fetcher: typeof fetch = fetch,
): CloudFileReader {
  return async (provider, token, id, assertAccess = async () => {}) => {
    if (!validImportFileId(id))
      throw new ApiError(400, 'INVALID_SOURCE', 'Choose a valid source file.');
    const authenticated = async (
      url: string,
      body?: unknown,
      redirect: RequestRedirect = 'error',
    ) => {
      await assertAccess();
      return fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect,
        signal: AbortSignal.timeout(20_000),
      });
    };
    const json = async (url: string, body?: unknown) => {
      const response = await authenticated(url, body);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([404, 410].includes(response.status)) throw missingFile();
        throw unavailable(response.status === 401 ? 401 : 502);
      }
      return (await response.json()) as Record<string, unknown>;
    };
    let name: unknown, download: string;
    if (provider === 'dropbox') {
      const data = await json(
        'https://api.dropboxapi.com/2/files/get_temporary_link',
        { path: id },
      );
      name = (data.metadata as { name?: unknown } | undefined)?.name;
      download = typeof data.link === 'string' ? data.link : '';
    } else {
      const base =
        provider === 'drive'
          ? 'https://www.googleapis.com/drive/v3/files/' +
            encodeURIComponent(id)
          : provider === 'box'
            ? 'https://api.box.com/2.0/files/' + encodeURIComponent(id)
            : 'https://graph.microsoft.com/v1.0/me/drive/items/' +
              encodeURIComponent(id);
      const metadata = await json(
        provider === 'drive'
          ? base + '?fields=name,size,mimeType&supportsAllDrives=true'
          : base,
      );
      name = metadata.name;
      if (Number(metadata.size) > MAX_INPUT_BYTES)
        throw new ApiError(
          413,
          'PHOTO_TOO_LARGE',
          'Choose a photo smaller than 8 MB.',
        );
      if (
        provider === 'drive' &&
        !['image/jpeg', 'image/png', 'image/webp'].includes(
          String(metadata.mimeType),
        )
      )
        throw new ApiError(
          422,
          'INVALID_IMAGE',
          'Choose a JPEG, PNG, or WebP photo.',
        );
      const result = await authenticated(
        provider === 'drive'
          ? base + '?alt=media&supportsAllDrives=true'
          : base + '/content',
        undefined,
        'manual',
      );
      if (result.ok) {
        if (typeof name !== 'string' || !name || name.length > 1024) {
          await result.body?.cancel().catch(() => {});
          throw unavailable();
        }
        return { name, bytes: await boundedBody(result) };
      }
      download = result.headers.get('location') ?? '';
      await result.body?.cancel().catch(() => {});
      if ([404, 410].includes(result.status)) throw missingFile();
      if (![301, 302, 303, 307, 308].includes(result.status))
        throw unavailable(result.status === 401 ? 401 : 502);
    }
    if (typeof name !== 'string' || !name || name.length > 1024)
      throw unavailable();
    // Signed download URLs never receive the provider's Authorization header.
    for (let redirects = 0; redirects < 4; redirects++) {
      await assertAccess();
      const safe = trustedSourceDownload(provider, download);
      const response = await fetcher(safe, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return { name, bytes: await boundedBody(response) };
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if ([404, 410].includes(response.status)) throw missingFile();
      if (![301, 302, 303, 307, 308].includes(response.status) || !location)
        throw unavailable();
      download = new URL(location, safe).toString();
    }
    throw unavailable();
  };
}
