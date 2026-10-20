import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryOptions, LibraryRecord } from './library.js';
import type { JobListEntry } from './jobs.js';
import { photoAvailable } from './retention.js';
import { matchingReadiness } from './matching-readiness.js';
import { highlightRecordId } from './highlights.js';
import { storedHighlights } from '../../../packages/shared/src/highlights.js';
import {
  eventReadiness,
  type EventReadiness,
} from '../../../packages/shared/src/event-readiness.js';

export function eventPreparationSnapshot(
  event: LibraryRecord,
  rows: {
    photos: LibraryRecord[];
    jobs: LibraryRecord[];
    processing: JobListEntry[];
  },
  runtime: {
    worker: EventReadiness['worker'];
    provider: 'aws-rekognition' | null;
    processingAvailable: boolean;
  },
  now = Date.now(),
): EventReadiness {
  const photos = rows.photos.filter(
    (photo) =>
      photo.kind === 'photo' &&
      photo.ownerId === event.ownerId &&
      photo.eventId === event.id &&
      !photo.scanId,
  );
  const available = photos.filter(
    (photo) =>
      !photo.deletionStartedAt &&
      !photo.deletionCompletedAt &&
      photoAvailable(photo, now),
  );
  const ids = new Set(available.map((photo) => photo.id));
  const jobs = rows.jobs.filter(
    (row) =>
      row.ownerId === event.ownerId &&
      row.kind === 'job' &&
      row.eventId === event.id &&
      !row.deletionStartedAt &&
      !row.deletionCompletedAt,
  );
  const processing = rows.processing.filter(
    (row) => row.ownerId === event.ownerId,
  );
  const roots = jobs.filter(
    (row) => row.purpose === 'import' || row.purpose === undefined,
  );
  const imports = {
    total: roots.length,
    running: 0,
    complete: 0,
    partial: 0,
    failed: 0,
    unknown: 0,
  };
  for (const root of roots) {
    if (root.processingSource !== 'cloud') {
      if (
        root.state === 'running' ||
        root.state === 'complete' ||
        root.state === 'partial' ||
        root.state === 'failed'
      )
        imports[root.state]++;
      else imports.unknown++;
      continue;
    }
    const job = processing.find(
      (row) =>
        row.type === 'cloud-import' &&
        row.eventId === root.id &&
        !!root.processingRequestId &&
        row.requestId === root.processingRequestId,
    );
    if (runtime.worker !== 'available' || !job) imports.unknown++;
    else if (job.status === 'queued' || job.status === 'running')
      imports.running++;
    else if (job.status === 'complete' && !job.failed) imports.complete++;
    else if (
      job.status === 'partial' ||
      (job.status === 'complete' && job.failed)
    )
      imports.partial++;
    else imports.failed++;
  }
  const matching = matchingReadiness(
    event,
    available,
    {
      provider: runtime.provider,
      processingAvailable: runtime.processingAvailable,
      active: processing.some(
        (job) =>
          job.type === 'event-index' &&
          job.eventId === event.id &&
          ['queued', 'running'].includes(job.status),
      ),
    },
    now,
  );
  const highlightRows = jobs.filter(
    (row) => row.purpose === 'event-highlights',
  );
  const selected = highlightRows.find(
    (row) => row.id === highlightRecordId(event.id),
  );
  let highlights: EventReadiness['highlights'] = {
    state: 'none',
    selected: 0,
    available: 0,
  };
  if (highlightRows.length) {
    const parsed = storedHighlights.safeParse(selected?.highlights);
    if (!selected || highlightRows.length !== 1 || !parsed.success)
      highlights.state = 'invalid';
    else {
      const set = parsed.data;
      const count = set.photoIds.filter((id) => ids.has(id)).length;
      const open = !['archived', 'expired', 'deleting'].includes(
        matching.gallery,
      );
      highlights = {
        state: !set.published
          ? 'draft'
          : !open || !count
            ? 'unavailable'
            : count < set.photoIds.length
              ? 'partial'
              : 'published',
        selected: set.photoIds.length,
        available: count,
      };
    }
  }
  let knownBytes = 0,
    unknownBytes = 0;
  for (const photo of available) {
    if (
      !Number.isSafeInteger(photo.bytes) ||
      photo.bytes! < 0 ||
      !Number.isSafeInteger(knownBytes + photo.bytes!)
    )
      unknownBytes++;
    else knownBytes += photo.bytes!;
  }
  return eventReadiness.parse({
    accountId: event.ownerId,
    eventId: event.id,
    checkedAt: new Date(now).toISOString(),
    gallery: {
      state: matching.gallery,
      hasPasscode: !!event.passcodeHash,
      expiresAt: z.iso.datetime().safeParse(event.expiresAt).success
        ? event.expiresAt
        : null,
    },
    photos: {
      available: available.length,
      expired: photos.filter(
        (photo) =>
          !photo.deletionStartedAt &&
          !photo.deletionCompletedAt &&
          !photoAvailable(photo, now),
      ).length,
      deleting: photos.filter(
        (photo) => photo.deletionStartedAt || photo.deletionCompletedAt,
      ).length,
      knownBytes,
      unknownBytes,
    },
    worker: runtime.worker,
    imports,
    matching:
      runtime.worker === 'unavailable'
        ? null
        : {
            status: matching.status,
            searchAvailable: matching.searchAvailable,
            processingAvailable: matching.processingAvailable,
            provider: matching.provider,
            counts: matching.counts,
            uncertain: matching.uncertain,
          },
    highlights,
  });
}
export function createEventReadiness(
  options: LibraryOptions,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  router.get('/events/:id/readiness', async (req, res) => {
    const accountId = await owner(req),
      id = z.uuid().safeParse(req.params.id);
    if (
      req.get('X-PicFind-Readiness-Actor') &&
      req.get('X-PicFind-Readiness-Actor') !== accountId
    )
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the event.',
      );
    const missing = () =>
      new ApiError(404, 'EVENT_UNAVAILABLE', 'This event is not available.');
    if (!id.success) throw missing();
    const store = options.store;
    if (!store)
      throw new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Event storage is unavailable.',
      );
    async function ownedEvent() {
      const event = await store!.get(id.data!);
      if (
        event.id !== id.data ||
        event.kind !== 'event' ||
        event.ownerId !== accountId ||
        event.deletionCompletedAt
      )
        throw missing();
      return event;
    }
    await ownedEvent();
    const [photos, jobs, worker] = await Promise.all([
      store.list(accountId, 'photo'),
      store.list(accountId, 'job'),
      options.jobQueue
        ? options.jobQueue.list(accountId).then(
            (processing) => ({ state: 'available' as const, processing }),
            () => ({
              state: 'unavailable' as const,
              processing: [] as JobListEntry[],
            }),
          )
        : Promise.resolve({
            state: 'not-configured' as const,
            processing: [] as JobListEntry[],
          }),
    ]);
    const event = await ownedEvent();
    res.json(
      eventPreparationSnapshot(
        event,
        { photos, jobs, processing: worker.processing },
        {
          worker: worker.state,
          provider: options.faceMatcher
            ? (options.faceProviderName ?? 'aws-rekognition')
            : null,
          processingAvailable: !!(
            options.jobQueue &&
            options.faceMatcher &&
            options.faceJobsEnabled !== false &&
            worker.state === 'available'
          ),
        },
      ),
    );
  });
  return router;
}
