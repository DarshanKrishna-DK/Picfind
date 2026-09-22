import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { AppwriteLibraryStore } from '../apps/api/src/adapters/appwrite-library.js';
import { ApiError } from '../apps/api/src/auth.js';
import { purgeExpiredPhotos } from '../apps/api/src/retention.js';
import type { LibraryStore } from '../apps/api/src/library.js';

if (process.env.PICFIND_RETENTION_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_RETENTION_STORAGE_TEST=1 to test one disposable generated image. No AWS calls are used.',
  );
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const store = new AppwriteLibraryStore({
  endpoint: process.env.APPWRITE_ENDPOINT!,
  projectId: process.env.APPWRITE_PROJECT_ID!,
  apiKey: process.env.APPWRITE_API_KEY!,
});
const ownerId = randomUUID();
const photoId = randomUUID();
const image = await sharp({
  create: { width: 8, height: 8, channels: 3, background: '#456789' },
})
  .jpeg()
  .toBuffer();
const isolated = new Proxy(store, {
  get(target, property) {
    if (property === 'expired')
      return async (before: string) =>
        (await target.expired(before, 100)).filter(
          (row) => row.ownerId === ownerId && row.id === photoId,
        );
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as LibraryStore;
async function cleanup() {
  await store.removeFile(photoId);
  try {
    await store.remove(photoId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  console.info('Disposable retention test resources cleaned up.');
}
try {
  await store.upload(photoId, image);
  await store.put(
    {
      id: photoId,
      ownerId,
      kind: 'photo',
      filename: 'retention-generated-test.jpg',
      bytes: image.byteLength,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      indexState: 'none',
    },
    true,
  );
  const result = await purgeExpiredPhotos(isolated);
  if (result.deleted !== 1 || result.deferred !== 0)
    throw new Error(
      'The indexed expiry query did not clean the isolated photo.',
    );
  for (const read of [() => store.get(photoId), () => store.file(photoId)]) {
    try {
      await read();
      throw new Error('An expired test resource still exists.');
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  console.info(
    'PASS: real Appwrite expiry index, generated object deletion and metadata deletion. No AWS calls or user photo deletions.',
  );
} finally {
  await cleanup();
}
