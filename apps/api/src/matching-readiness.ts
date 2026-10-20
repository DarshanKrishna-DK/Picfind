import type { MatchingReadiness } from '../../../packages/shared/src/matching-readiness.js';
import type { LibraryRecord } from './library.js';
import { requiresUncertainRetry } from './face-indexing.js';
import { photoAvailable } from './retention.js';

/** Metadata snapshot only. Reading readiness must never call a face provider. */
export function matchingReadiness(
  event: LibraryRecord,
  records: LibraryRecord[],
  runtime: {
    provider: 'aws-rekognition' | null;
    processingAvailable: boolean;
    active: boolean;
  },
  now = Date.now(),
): MatchingReadiness {
  const photos = records.filter(
    (photo) =>
      photo.ownerId === event.ownerId &&
      photo.eventId === event.id &&
      !photo.scanId &&
      !photo.deletionStartedAt &&
      photoAvailable(photo, now),
  );
  const counts = {
    total: photos.length,
    prepared: 0,
    noFaces: 0,
    waiting: 0,
    failed: 0,
    needsReview: 0,
  };
  const models = new Map<string, number>();
  let uncertain = 0;
  for (const photo of photos) {
    if (requiresUncertainRetry(photo)) uncertain++;
    if (photo.indexState === 'ready' || photo.indexState === 'empty') {
      // An older provider's saved result is not evidence for this deployment.
      if (
        photo.provider !== 'aws-rekognition' ||
        typeof photo.modelVersion !== 'string' ||
        !photo.modelVersion.trim() ||
        (photo.indexState === 'empty' && Boolean(photo.faceIds?.length)) ||
        (photo.indexState === 'ready' && !photo.externalImageId)
      ) {
        counts.needsReview++;
      } else {
        if (photo.indexState === 'ready') counts.prepared++;
        else counts.noFaces++;
        const version = photo.modelVersion || 'unknown';
        models.set(version, (models.get(version) ?? 0) + 1);
      }
    } else if (photo.indexState === 'failed') counts.failed++;
    else counts.waiting++;
  }
  if (models.size > 1) {
    counts.needsReview += counts.prepared + counts.noFaces;
    counts.prepared = 0;
    counts.noFaces = 0;
  }
  const gallery = event.deletionStartedAt
    ? 'deleting'
    : event.archived
      ? 'archived'
      : event.expiresAt &&
          (!Number.isFinite(Date.parse(event.expiresAt)) ||
            Date.parse(event.expiresAt) <= now)
        ? 'expired'
        : event.visibility === 'link'
          ? 'shared'
          : 'private';
  const status: MatchingReadiness['status'] =
    gallery === 'deleting' || gallery === 'archived' || gallery === 'expired'
      ? gallery
      : !counts.total
        ? 'empty'
        : !runtime.provider
          ? 'unavailable'
          : runtime.active
            ? 'processing'
            : counts.failed || counts.needsReview || uncertain
              ? 'needs-attention'
              : counts.waiting
                ? counts.prepared
                  ? 'partial'
                  : 'not-prepared'
                : counts.prepared
                  ? 'ready'
                  : 'no-faces';
  return {
    checkedAt: new Date(now).toISOString(),
    status,
    gallery,
    searchAvailable: Boolean(runtime.provider),
    processingAvailable: runtime.processingAvailable,
    provider: runtime.provider,
    counts,
    uncertain,
    models: [...models]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([version, photos]) => ({ version, photos })),
  };
}
