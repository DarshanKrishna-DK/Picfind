import { ApiError } from './auth.js';
import { MAX_INPUT_BYTES } from './images.js';

export type DriveCredentials = { apiKey: string } | { accessToken: string };

export function parseDriveFolderId(raw: string) {
  const url = new URL(raw);
  const match = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]+)\/?$/.exec(
    url.pathname,
  );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'drive.google.com' ||
    !match?.[1]
  )
    throw new ApiError(
      400,
      'INVALID_SOURCE',
      'Enter a Google Drive folder link.',
    );
  return match[1];
}

function driveRequest(url: URL, credentials: DriveCredentials): RequestInit {
  if ('apiKey' in credentials) url.searchParams.set('key', credentials.apiKey);
  return {
    signal: AbortSignal.timeout(20_000),
    ...('accessToken' in credentials
      ? { headers: { Authorization: `Bearer ${credentials.accessToken}` } }
      : {}),
  };
}

export async function listDriveImages(
  credentials: DriveCredentials,
  folderId: string,
  limit: number,
) {
  const query = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false and (mimeType = 'image/jpeg' or mimeType = 'image/png' or mimeType = 'image/webp')`,
    pageSize: String(limit),
    fields: 'files(id,name,size)',
    orderBy: 'name',
  });
  const url = new URL(`https://www.googleapis.com/drive/v3/files?${query}`);
  const listing = await fetch(url, driveRequest(url, credentials));
  if (!listing.ok)
    throw new ApiError(
      400,
      'SOURCE_ACCESS_DENIED',
      'PicFind could not read that folder with the current Drive grant.',
    );
  const files = (
    (await listing.json()) as {
      files: { id: string; name: string; size?: string }[];
    }
  ).files.slice(0, limit);
  if (!files.length)
    throw new ApiError(
      400,
      'SOURCE_EMPTY',
      'No accessible JPEG, PNG, or WebP photos were found.',
    );
  return files;
}

export async function downloadDriveFile(
  credentials: DriveCredentials,
  fileId: string,
) {
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
  );
  url.searchParams.set('alt', 'media');
  const response = await fetch(url, driveRequest(url, credentials));
  if (!response.ok || !response.body) throw new Error('download');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_INPUT_BYTES) throw new Error('size');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
