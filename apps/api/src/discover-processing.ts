import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { FaceMatchingProvider } from '../../../packages/shared/src/ports.js';
import type { JobQueue } from './jobs.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { assertPhotoAvailable, photoAvailable } from './retention.js';
import { requiresUncertainRetry } from './face-indexing.js';
import { tolerateMissingFaceOperation } from './photo-deletion.js';
import { stableScanId, scanPhotoId } from './scan-photo-preparation.js';
import { discoverState, publicScan } from './discover-state.js';

export function createDiscoverProcessingRouter(options: {
  store(): LibraryStore;
  owner(req: Request): Promise<string>;
  queue?: JobQueue | undefined;
  matcher?: FaceMatchingProvider | undefined;
  limit: number;
  production: boolean;
  accounting: boolean;
}) {
  const router = Router();
  const queue = () => {
    if (!options.queue)
      throw new ApiError(
        503,
        'JOB_WORKER_UNAVAILABLE',
        'Saved Discover processing is unavailable. No photos were processed.',
      );
    return options.queue;
  };
  async function owned(id: unknown, ownerId: string) {
    if (!z.uuid().safeParse(id).success)
      throw new ApiError(400, 'INVALID_INPUT', 'Choose a saved search.');
    const scan = await options.store().get(String(id));
    if (
      scan.ownerId !== ownerId ||
      scan.kind !== 'job' ||
      scan.purpose !== 'discover-scan'
    )
      throw new ApiError(404, 'NOT_FOUND', 'This search is not available.');
    return scan;
  }
  async function status(scan: LibraryRecord) {
    return discoverState(
      scan,
      await options.store().list(scan.ownerId, 'photo'),
      await queue().list(scan.ownerId, scan.id),
    );
  }
  function writable(scan: LibraryRecord) {
    if (scan.deletionStartedAt)
      throw new ApiError(
        409,
        'SCAN_DELETING',
        'Deletion has started. Retry deleting this search to finish cleanup.',
      );
  }
  router.post('/discover/scans', async (req, res, next) => {
    if (!req.body?.photoIds) return next();
    if (!options.queue && !options.production) return next();
    const ownerId = await options.owner(req);
    if (!options.matcher)
      throw new ApiError(
        503,
        'FACE_MATCHING_UNAVAILABLE',
        'Face matching is not configured.',
      );
    if (options.production && !options.accounting)
      throw new ApiError(
        503,
        'USAGE_ACCOUNTING_UNAVAILABLE',
        'Processing requires usage accounting.',
      );
    const parsed = z
      .object({
        requestId: z.uuid(),
        photoIds: z.array(z.uuid()).min(1).max(options.limit),
        consent: z.literal(true),
        policyVersion: z.literal('face-matching-v1'),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        `Choose up to ${options.limit} library photos and confirm the processing notice.`,
      );
    const data = parsed.data;
    const photoIds = [...new Set(data.photoIds)];
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([...photoIds].sort()))
      .digest('hex');
    const scanId = stableScanId(
      'discover-library',
      ownerId + ':' + data.requestId,
    );
    const scan = await withAccountLock(ownerId, async () => {
      let saved: LibraryRecord | undefined;
      try {
        saved = await options.store().get(scanId);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      if (saved) {
        if (
          saved.ownerId !== ownerId ||
          saved.processingSource !== 'library' ||
          saved.sourceFingerprint !== fingerprint
        )
          throw new ApiError(
            409,
            'SCAN_REQUEST_REUSED',
            'This request already belongs to a different photo selection.',
          );
        writable(saved);
        const existing = (await queue().list(ownerId, scanId)).find(
          (job) => job.requestId === data.requestId,
        );
        if (existing) return status(saved);
      }
      const available = new Map(
        (await options.store().list(ownerId, 'photo')).map((photo) => [
          photo.id,
          photo,
        ]),
      );
      for (const id of photoIds) {
        const photo = available.get(id);
        if (!photo || photo.scanId || photo.eventId)
          throw new ApiError(
            404,
            'NOT_FOUND',
            'A selected library photo is not available.',
          );
        assertPhotoAvailable(photo);
      }
      saved ??= {
        id: scanId,
        ownerId,
        kind: 'job',
        purpose: 'discover-scan',
        source: 'library',
        processingSource: 'library',
        processingRequestId: data.requestId,
        sourceFingerprint: fingerprint,
        state: 'running',
        imported: 0,
        indexed: 0,
        errors: [],
        createdAt: new Date().toISOString(),
        consentAt: new Date().toISOString(),
        consentPolicyVersion: data.policyVersion,
        provider: 'aws-rekognition',
      };
      await options.store().put(saved);
      await queue().enqueue({
        ownerId,
        eventId: scanId,
        type: 'discover-library',
        requestId: data.requestId,
        photoIds,
        consentPolicyVersion: data.policyVersion,
      });
      return status(saved);
    });
    res.status(202).json({ scan: publicScan(scan) });
  });
  router.get('/discover/scans/:id', async (req, res, next) => {
    const scan = await owned(req.params.id, await options.owner(req));
    if (!scan.processingSource) return next();
    const result = publicScan(await status(scan));
    res.json({ scan: result, matches: [] });
  });
  router.post('/discover/scans/:id/processing', async (req, res) => {
    const ownerId = await options.owner(req);
    const parsed = z
      .object({
        requestId: z.uuid(),
        consent: z.literal(true),
        policyVersion: z.literal('face-matching-v1'),
        retryUncertain: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'CONSENT_REQUIRED',
        'Confirm processing before resuming.',
      );
    const result = await withAccountLock(ownerId, async () => {
      const scan = await owned(req.params.id, ownerId);
      writable(scan);
      if (scan.processingSource !== 'library')
        throw new ApiError(
          409,
          'SCAN_NOT_DURABLE',
          'This older scan does not use saved processing.',
        );
      const jobs = await queue().list(ownerId, scan.id);
      if (jobs.some((job) => job.requestId === parsed.data.requestId))
        return status(scan);
      if (jobs.some((job) => ['queued', 'running'].includes(job.status)))
        throw new ApiError(
          409,
          'PROCESSING_ACTIVE',
          'This search is already processing.',
        );
      const original = jobs.find(
        (job) => job.requestId === scan.processingRequestId,
      );
      if (!original)
        throw new ApiError(
          503,
          'SCAN_RECOVERY_REQUIRED',
          'The saved source snapshot is unavailable. Delete this incomplete search and select its source again.',
        );
      const source = await queue().owned(original.id, ownerId);
      const photos = new Map(
        (await options.store().list(ownerId, 'photo')).map((photo) => [
          photo.id,
          photo,
        ]),
      );
      const remaining = source.photoIds.filter((id) => {
        const photo = photos.get(scanPhotoId(scan.id, id));
        return (
          !photo ||
          !photoAvailable(photo) ||
          !['ready', 'empty'].includes(photo.indexState ?? 'none')
        );
      });
      if (!remaining.length) {
        await queue().reconcileCompleted(
          jobs[0]!.id,
          ownerId,
          new Map(
            source.photoIds.map((id) => [
              id,
              photos.get(scanPhotoId(scan.id, id))!.indexState === 'ready'
                ? 'indexed'
                : 'empty',
            ]),
          ),
        );
        return status(scan);
      }
      const uncertain = remaining.filter((id) => {
        const photo = photos.get(scanPhotoId(scan.id, id));
        return photo && requiresUncertainRetry(photo);
      });
      if (uncertain.length && !parsed.data.retryUncertain)
        throw new ApiError(
          409,
          'RETRY_UNCERTAIN_REQUIRED',
          'A previous provider attempt may already have been charged. Explicitly allow a new paid attempt before resuming.',
        );
      await queue().enqueue({
        ownerId,
        eventId: scan.id,
        type: 'discover-library',
        requestId: parsed.data.requestId,
        photoIds: remaining,
        consentPolicyVersion: parsed.data.policyVersion,
        retryUncertain: parsed.data.retryUncertain === true,
        retryUncertainPhotoIds: uncertain,
      });
      return status(scan);
    });
    res.status(202).json({ scan: publicScan(result) });
  });
  router.post('/discover/scans/:id/processing/cancel', async (req, res) => {
    const scan = await owned(req.params.id, await options.owner(req));
    if (scan.processingSource !== 'library')
      throw new ApiError(
        409,
        'SCAN_NOT_DURABLE',
        'This older scan does not use saved processing.',
      );
    await queue().cancelOwner(scan.ownerId, scan.id);
    res.json({ scan: publicScan(await status(scan)) });
  });
  router.delete('/discover/scans/:id', async (req, res, next) => {
    const ownerId = await options.owner(req);
    const before = await owned(req.params.id, ownerId);
    if (!before.processingSource) return next();
    await withAccountLock(ownerId, async () => {
      const scan = await owned(req.params.id, ownerId);
      const deleting = {
        ...scan,
        deletionStartedAt: scan.deletionStartedAt ?? new Date().toISOString(),
      };
      await options.store().put(deleting);
      await queue().cancelOwner(ownerId, scan.id);
      if (
        (await queue().list(ownerId, scan.id)).some(
          (job) => job.status === 'running',
        )
      )
        throw new ApiError(
          409,
          'PROCESSING_ACTIVE',
          'Processing is stopping. Retry deletion after the current operation finishes.',
        );
      const photos = (await options.store().list(ownerId, 'photo')).filter(
        (photo) => photo.scanId === scan.id,
      );
      if (
        !options.matcher &&
        photos.some((photo) => photo.provider || photo.faceIds?.length)
      )
        throw new ApiError(
          503,
          'FACE_DELETION_INCOMPLETE',
          'Reconnect matching before deleting this face index.',
        );
      if (options.matcher)
        await tolerateMissingFaceOperation(() =>
          options.matcher!.deleteScope({
            kind: 'scan',
            id: scan.id.replaceAll('-', ''),
          }),
        );
      for (const photo of photos) {
        await options.store().removeFile(photo.id);
        await options.store().remove(photo.id);
      }
      for (const intent of (await options.store().list(ownerId, 'job')).filter(
        (row) => row.purpose === 'upload-cleanup' && row.scanId === scan.id,
      )) {
        await options.store().removeFile(intent.id);
        await options.store().remove(intent.id);
      }
      await queue().eraseOwner(ownerId, scan.id);
      await options.store().put({
        ...deleting,
        state: 'failed',
        imported: 0,
        indexed: 0,
        errors: [],
        matches: [],
        faceMap: {},
        deletionCompletedAt: new Date().toISOString(),
      });
    });
    res.status(204).end();
  });
  return router;
}
