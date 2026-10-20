import {
  ATTRIBUTION_HEADER,
  attributionCsv,
  decodeAttributionHeader,
  type PublishedAttribution,
} from '../../../packages/shared/src/photo-attribution';

export interface DownloadPhoto {
  id: string;
  filename: string;
  url: string;
}

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export function archiveFilename(filename: string, index: number) {
  const stem =
    filename
      .normalize('NFKC')
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120) || 'photo';
  return `${String(index + 1).padStart(3, '0')}-${stem}.jpg`;
}

// Device downloads only. No cloud-write API is involved in this operation.
export async function collectPhotoFiles(
  photos: DownloadPhoto[],
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
  maxBytes = MAX_ARCHIVE_BYTES,
) {
  if (!photos.length) throw new Error('Choose at least one photo to download.');
  const files: Record<string, Uint8Array> = {};
  const credits: {
    archiveName: string;
    photoId: string;
    filename: string;
    credit: PublishedAttribution;
  }[] = [];
  let totalBytes = 0;
  for (const [index, photo] of photos.entries()) {
    signal.throwIfAborted();
    onProgress(index, photos.length);
    const response = await fetch(photo.url, { credentials: 'include', signal });
    if (
      !response.ok ||
      !response.body ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('image/jpeg')
    ) {
      throw new Error(
        `Could not download ${photo.filename}. The gallery may have expired. Try again or contact the organizer.`,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let fileBytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        fileBytes += result.value.byteLength;
        if (totalBytes > maxBytes)
          throw new Error(
            'This download is too large to prepare safely on your device. Select a smaller batch.',
          );
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!fileBytes)
      throw new Error(`The file ${photo.filename} is empty. Please try again.`);
    const bytes = new Uint8Array(fileBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const archiveName = archiveFilename(photo.filename, index);
    files[archiveName] = bytes;
    const credit = decodeAttributionHeader(
      response.headers.get(ATTRIBUTION_HEADER),
    );
    if (credit)
      credits.push({
        archiveName,
        photoId: photo.id,
        filename: photo.filename,
        credit,
      });
    onProgress(index + 1, photos.length);
  }
  if (credits.length) {
    const manifest = new TextEncoder().encode(attributionCsv(credits));
    if (totalBytes + manifest.byteLength > maxBytes)
      throw new Error(
        'This download is too large to include photographer credits. Select a smaller batch.',
      );
    files['credits.csv'] = manifest;
  }
  return files;
}

export async function createGalleryArchive(
  files: Record<string, Uint8Array>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { zip } = await import('fflate');
  signal.throwIfAborted();
  return new Promise<Uint8Array>((resolve, reject) => {
    const cancel = () => {
      terminate();
      reject(new DOMException('Download cancelled.', 'AbortError'));
    };
    const terminate = zip(files, { level: 0 }, (error, result) => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted)
        reject(new DOMException('Download cancelled.', 'AbortError'));
      else if (error) reject(error);
      else resolve(result);
    });
    signal.addEventListener('abort', cancel, { once: true });
  });
}
