import { ApiError } from './auth.js';
import { suppressSyncPhotoBeforeErase } from './folder-sync-suppression.js';
import { uncertainFaceIndex } from './face-cleanup-state.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';

export function photoAvailable(photo: LibraryRecord, now = Date.now()) {
  return (
    photo.kind === 'photo' &&
    (!photo.expiresAt || Date.parse(photo.expiresAt) > now)
  );
}
export function assertPhotoAvailable(photo: LibraryRecord) {
  if (!photoAvailable(photo))
    throw new ApiError(
      410,
      'PHOTO_EXPIRED',
      'This photo has expired and is no longer available.',
    );
}
export function photoExpiry(days: number, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error('Invalid retention policy.');
  return new Date(now + days * 86400000).toISOString();
}
function scopeOf(photo: LibraryRecord): Scope | undefined {
  return photo.scanId
    ? { kind: 'scan', id: photo.scanId.replaceAll('-', '') }
    : photo.eventId
      ? { kind: 'event', id: photo.eventId }
      : undefined;
}
function missing(error: unknown) {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (error instanceof Error && error.name === 'ResourceNotFoundException')
  );
}
async function tolerateMissing(operation: () => Promise<void>) {
  try {
    await operation();
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
export interface RetentionStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  deleted: number;
  deferred: number;
  error: string | null;
}
export async function purgeExpiredPhotos(
  store: LibraryStore,
  matcher?: FaceMatchingProvider,
  limit = 50,
) {
  if (!store.expired)
    throw new Error('The storage adapter does not support expiry queries.');
  const now = Date.now();
  const due = await store.expired(new Date(now).toISOString(), limit);
  let deleted = 0;
  let deferred = 0;
  const clearedScopes = new Set<string>();
  for (const candidate of due) {
    await withAccountLock(candidate.ownerId, async () => {
      let photo: LibraryRecord;
      try {
        photo = await store.get(candidate.id);
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      const pendingUpload =
        photo.kind === 'job' && photo.purpose === 'upload-cleanup';
      if (
        photo.ownerId !== candidate.ownerId ||
        (photo.kind !== 'photo' && !pendingUpload) ||
        !photo.expiresAt ||
        Date.parse(photo.expiresAt) > now ||
        photoAvailable(photo, now)
      )
        return;
      try {
        const scope = pendingUpload ? undefined : scopeOf(photo);
        const photos = scope ? await store.list(photo.ownerId, 'photo') : [];
        const inScope = (row: LibraryRecord) =>
          photo.scanId
            ? row.scanId === photo.scanId
            : row.eventId === photo.eventId;
        const siblings = photos.filter(inScope);
        const scopeIsExpired = Boolean(
          scope && !siblings.some((row) => photoAvailable(row, now)),
        );
        const needsProvider =
          !pendingUpload &&
          Boolean(
            photo.provider ||
            photo.faceIds?.length ||
            (photo.indexState && photo.indexState !== 'none') ||
            siblings.some((row) => row.provider || row.faceIds?.length),
          );
        if (needsProvider && !matcher)
          throw new ApiError(
            503,
            'FACE_CLEANUP_PENDING',
            'Cloud index cleanup requires the matching provider.',
          );
        if (needsProvider && !scope)
          throw new ApiError(
            503,
            'FACE_CLEANUP_PENDING',
            'The cloud cleanup scope must be repaired before deletion.',
          );
        if (uncertainFaceIndex(photo) && !scopeIsExpired)
          throw new ApiError(
            503,
            'FACE_CLEANUP_PENDING',
            'Unknown face references must remain until this collection can be erased safely.',
          );
        if (matcher && scope) {
          const key = `${scope.kind}:${scope.id}`;
          if (scopeIsExpired && !clearedScopes.has(key)) {
            await tolerateMissing(() => matcher.deleteScope(scope));
            clearedScopes.add(key);
          } else if (!clearedScopes.has(key) && photo.faceIds?.length) {
            await tolerateMissing(() =>
              matcher.deleteFaces(scope, photo.faceIds!),
            );
          }
        }
        // Keep the metadata/face IDs if object deletion or billing release fails.
        await suppressSyncPhotoBeforeErase(store, photo);
        await store.removeFile(photo.id);
        await tolerateMissing(() => store.remove(photo.id));
        deleted += 1;
      } catch {
        deferred += 1;
        // Back off failed rows so one unavailable provider cannot starve other cleanup.
        await store.put({
          ...photo,
          cleanupAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
      }
    });
  }
  return { deleted, deferred };
}
export function startRetentionWorker(
  store: LibraryStore | undefined,
  matcher: FaceMatchingProvider | undefined,
  enabled: boolean,
  intervalMs = 60000,
) {
  const status: RetentionStatus = {
    enabled,
    running: false,
    lastRunAt: null,
    lastSuccessAt: null,
    deleted: 0,
    deferred: 0,
    error: null,
  };
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  const tick = () => {
    if (!enabled || !store || status.running || stopped) return;
    status.running = true;
    status.lastRunAt = new Date().toISOString();
    pending = (async () => {
      try {
        const result = await purgeExpiredPhotos(store, matcher);
        status.deleted += result.deleted;
        status.deferred = result.deferred;
        status.error = result.deferred ? 'CLEANUP_DEFERRED' : null;
        if (!result.deferred) status.lastSuccessAt = new Date().toISOString();
        if (result.deleted || result.deferred)
          console.info(JSON.stringify({ event: 'retention_pass', ...result }));
      } catch {
        status.error = 'RETENTION_UNAVAILABLE';
        console.error(
          JSON.stringify({ event: 'retention_failed', code: status.error }),
        );
      } finally {
        status.running = false;
      }
    })();
  };
  const timer = enabled ? setInterval(tick, intervalMs) : undefined;
  timer?.unref();
  tick();
  return {
    status: () => ({ ...status }),
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}
