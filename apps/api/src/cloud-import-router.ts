import { createHash } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { DriveFolderBrowser } from './drive-browser.js';
import { libraryCapacity } from './capacity.js';
import { validImportFileId } from './import-policy.js';
import { publicJob, type JobQueue, type JobListEntry } from './jobs.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { assertEventImportOpen } from './event-import-policy.js';
import { requireEventAccess } from './event-membership-access.js';
import { stableScanId } from './scan-photo-preparation.js';
import {
  SOURCE_PROVIDERS,
  type SourceConnections,
} from './source-connections.js';

export function importState(
  root: LibraryRecord,
  photos: LibraryRecord[],
  jobs: JobListEntry[],
): LibraryRecord {
  if (root.processingSource !== 'cloud') return root;
  const job = jobs.find(
    (row) =>
      row.type === 'cloud-import' &&
      row.eventId === root.id &&
      row.requestId === root.processingRequestId,
  );
  const imported = photos.filter(
    (photo) => photo.importId === root.id && photoAvailable(photo),
  ).length;
  return {
    ...root,
    imported,
    state: job
      ? ['queued', 'running'].includes(job.status)
        ? 'running'
        : job.status === 'complete'
          ? 'complete'
          : imported
            ? 'partial'
            : 'failed'
      : 'failed',
    errors: !job
      ? [
          'Saved import status is unavailable. Retry the original import request before starting another batch.',
        ]
      : job.status === 'interrupted'
        ? [
            'This import was interrupted. Resume to keep completed photos and continue.',
          ]
        : job.status === 'cancelled'
          ? ['Import paused. Completed photos remain in your library.']
          : job.failureCode === 'SOURCE_UNAVAILABLE'
            ? [
                'The source is unavailable. Check the connection before resuming.',
              ]
            : job.failureCode === 'QUOTA_EXHAUSTED'
              ? [
                  'This account or event has reached its photo or storage allowance.',
                ]
              : job.failureCode
                ? ['Import processing needs attention before it can continue.']
                : job.failed
                  ? [
                      job.failed +
                        ' photos could not be imported. Resume to retry missing photos.',
                    ]
                  : [],
    ...(job ? { processing: publicJob(job) } : {}),
  };
}
export function createCloudImportRouter(options: {
  enabled: boolean;
  queue?: JobQueue;
  store: () => LibraryStore;
  connections?: SourceConnections;
  owner: (request: Request) => Promise<string>;
  limits?: ReturnType<typeof libraryCapacity>;
}) {
  const router = Router(),
    limits = options.limits ?? libraryCapacity();
  const driveBrowser = options.connections
    ? new DriveFolderBrowser(options.connections)
    : undefined;
  const requestSchema = z
    .object({
      requestId: z.uuid(),
      provider: z.enum(SOURCE_PROVIDERS),
      generation: z.uuid(),
      ids: z
        .array(z.string().refine(validImportFileId))
        .min(1)
        .max(limits.eventPhotos),
      eventId: z.uuid().optional(),
    })
    .strict();
  const resumeSchema = z
    .object({
      requestId: z.uuid(),
      generation: z.uuid(),
      acceptConnectionChange: z.boolean().default(false),
    })
    .strict();
  function ready() {
    if (!options.enabled || !options.queue || !options.connections)
      throw new ApiError(
        503,
        'SAVED_IMPORTS_UNAVAILABLE',
        'Saved cloud imports are not enabled on this deployment.',
      );
    return {
      queue: options.queue,
      connections: options.connections,
      store: options.store(),
    };
  }
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Check the source, selected photos, connection, and request identifier.',
      );
    return result.data;
  }
  function consent(req: Request) {
    if (req.get('X-PicFind-Consent') !== 'cloud-import-v1')
      throw new ApiError(
        400,
        'IMPORT_CONSENT_REQUIRED',
        'Confirm that you may copy these selected photos into PicFind. Importing does not perform face matching.',
      );
  }
  async function ownedRoot(id: string, owner: string) {
    const root = await options.store().get(id);
    if (
      root.kind !== 'job' ||
      root.purpose !== 'import' ||
      root.processingSource !== 'cloud' ||
      root.deletionStartedAt
    )
      throw new ApiError(
        404,
        'IMPORT_NOT_FOUND',
        'This import is not available.',
      );
    if (root.ownerId !== owner) {
      if (!root.eventId || root.uploadedBy !== owner)
        throw new ApiError(
          404,
          'IMPORT_NOT_FOUND',
          'This import is not available.',
        );
      const access = await requireEventAccess(
        options.store(),
        root.eventId,
        owner,
        true,
      );
      if (
        access.event.ownerId !== root.ownerId ||
        access.grantId !== root.membershipGrantId
      )
        throw new ApiError(
          404,
          'IMPORT_NOT_FOUND',
          'This import is not available.',
        );
    }
    return root;
  }
  async function ownedJob(id: string, owner: string) {
    const job = await ready().queue.authorizedImport(id, async (candidate) => {
      const root = await ownedRoot(candidate.eventId, owner);
      if (root.ownerId !== candidate.ownerId)
        throw new ApiError(
          404,
          'IMPORT_NOT_FOUND',
          'This import is not available.',
        );
    });
    if (job.type !== 'cloud-import' || !job.importSource)
      throw new ApiError(
        404,
        'IMPORT_NOT_FOUND',
        'This import is not available.',
      );
    const root = await ownedRoot(job.eventId, owner);
    if (
      root.source !== job.importSource.provider ||
      root.eventId !== job.importSource.destinationEventId ||
      (root.uploadedBy ?? root.ownerId) !==
        (job.importSource.actorId ?? job.ownerId) ||
      root.membershipGrantId !== job.importSource.membershipGrantId
    )
      throw new ApiError(
        503,
        'IMPORT_STORAGE_INVALID',
        'This saved import needs repair.',
      );
    return { job, root };
  }
  async function destination(eventId: string | undefined, owner: string) {
    if (!eventId) return;
    const event = await options.store().get(eventId);
    if (event.ownerId !== owner || event.kind !== 'event')
      throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
    assertEventImportOpen(event);
  }
  function publicImport(
    job: JobListEntry,
    root: LibraryRecord,
    photos: LibraryRecord[],
    viewer = job.ownerId,
  ) {
    const state = importState(root, photos, [job]);
    return {
      ...publicJob(job),
      importId: root.id,
      eventId: root.eventId ?? null,
      imported: state.imported ?? 0,
      source: root.source,
      errors: state.errors ?? [],
      canResume:
        !job.importSource?.folderSyncId &&
        (job.importSource?.actorId ?? job.ownerId) === viewer,
    };
  }
  router.use(async (req, res, next) => {
    res.locals.importOwner = await options.owner(req);
    ready();
    next();
  });
  router.use(express.json({ limit: '6mb' }));
  router.get('/drive/items', async (req, res) => {
    res.json(
      await driveBrowser!.list(res.locals.importOwner as string, req.query),
    );
  });
  router.get('/connection/:provider', async (req, res) => {
    const provider = parse(z.enum(SOURCE_PROVIDERS), req.params.provider);
    const access = await ready().connections.access(
      res.locals.importOwner as string,
      provider,
    );
    res.json({ provider, generation: access.generation });
  });
  router.get('/', async (req, res) => {
    const actor = res.locals.importOwner as string,
      { queue, store } = ready();
    let owner = actor;
    let grantId: string | undefined;
    const { eventId } = parse(
      z.object({ eventId: z.uuid().optional() }).strict(),
      req.query,
    );
    if (eventId) {
      const access = await requireEventAccess(store, eventId, actor);
      owner = access.event.ownerId;
      grantId = access.grantId;
    }
    const [jobs, roots, photos] = await Promise.all([
      queue.list(owner),
      store.list(owner, 'job'),
      store.list(owner, 'photo'),
    ]);
    res.json({
      jobs: roots
        .filter(
          (root) =>
            root.purpose === 'import' &&
            root.processingSource === 'cloud' &&
            root.eventId === eventId &&
            (actor === owner ||
              (root.uploadedBy === actor &&
                root.membershipGrantId === grantId)) &&
            !root.deletionStartedAt,
        )
        .flatMap((root) => {
          const job = jobs.find(
            (row) =>
              row.type === 'cloud-import' &&
              row.eventId === root.id &&
              row.requestId === root.processingRequestId,
          );
          return job ? [publicImport(job, root, photos, actor)] : [];
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  });
  router.post('/', async (req, res) => {
    consent(req);
    const data = parse(requestSchema, req.body),
      actor = res.locals.importOwner as string;
    const access = data.eventId
      ? await requireEventAccess(options.store(), data.eventId, actor, true)
      : undefined;
    const owner = access?.event.ownerId ?? actor;
    const memberSource =
      access?.role === 'moderator'
        ? { actorId: actor, membershipGrantId: access.grantId }
        : {};
    const ids = [...new Set(data.ids)];
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          data.provider,
          data.generation,
          data.eventId ?? null,
          [...ids].sort(),
          ...(access?.role === 'moderator' ? [actor, access.grantId] : []),
        ]),
      )
      .digest('hex');
    const importId = stableScanId('cloud-import', actor + ':' + data.requestId);
    const job = await withAccountLock(owner, async () => {
      await options.owner(req);
      const { queue, connections, store } = ready();
      await connections.access(actor, data.provider, data.generation);
      await destination(data.eventId, owner);
      if (data.eventId) {
        const current = await requireEventAccess(
          store,
          data.eventId,
          actor,
          true,
        );
        if (current.grantId !== access?.grantId)
          throw new ApiError(
            409,
            'MEMBERSHIP_CHANGED',
            'Your event access changed. Start a new import.',
          );
      }
      let root: LibraryRecord | undefined;
      try {
        root = await store.get(importId);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      if (root) {
        if (
          root.ownerId !== owner ||
          (root.uploadedBy ?? root.ownerId) !== actor ||
          root.membershipGrantId !== memberSource.membershipGrantId ||
          root.purpose !== 'import' ||
          root.processingSource !== 'cloud' ||
          root.sourceFingerprint !== fingerprint ||
          root.processingRequestId !== data.requestId ||
          root.deletionStartedAt
        )
          throw new ApiError(
            409,
            'JOB_REQUEST_REUSED',
            'This request was already used for a different import.',
          );
      } else {
        const photos = await store.list(owner, 'photo');
        const room = Math.min(
          limits.libraryPhotos - photos.length,
          data.eventId
            ? limits.eventPhotos -
                photos.filter(
                  (photo) => photo.eventId === data.eventId && !photo.scanId,
                ).length
            : limits.eventPhotos,
        );
        if (ids.length > room)
          throw new ApiError(
            402,
            'PHOTO_LIMIT',
            'Choose no more than ' + Math.max(0, room) + ' additional photos.',
          );
        root = {
          id: importId,
          ownerId: owner,
          kind: 'job',
          uploadedBy: actor,
          ...(memberSource.membershipGrantId
            ? { membershipGrantId: memberSource.membershipGrantId }
            : {}),
          purpose: 'import',
          source: data.provider,
          processingSource: 'cloud',
          processingRequestId: data.requestId,
          sourceFingerprint: fingerprint,
          ...(data.eventId ? { eventId: data.eventId } : {}),
          createdAt: new Date().toISOString(),
          state: 'running',
          imported: 0,
          errors: [],
        };
        if (!root.eventId || !store.stageEventImport)
          await store.put(root, true);
      }
      if (root.eventId && store.stageEventImport)
        await store.stageEventImport(actor, root);
      return queue.enqueue({
        ownerId: owner,
        eventId: importId,
        requestId: data.requestId,
        type: 'cloud-import',
        importSource: {
          provider: data.provider,
          generation: data.generation,
          ...memberSource,
          ...(data.eventId ? { destinationEventId: data.eventId } : {}),
        },
        photoIds: ids,
        consentPolicyVersion: 'cloud-import-v1',
      });
    });
    res.status(202).json({
      job: publicImport(
        job,
        await ownedRoot(importId, actor),
        await options.store().list(owner, 'photo'),
        actor,
      ),
    });
  });
  router.get('/:id', async (req, res) => {
    const owner = res.locals.importOwner as string;
    const { job, root } = await ownedJob(String(req.params.id), owner);
    res.json({
      job: publicImport(
        job,
        root,
        await options.store().list(job.ownerId, 'photo'),
        owner,
      ),
    });
  });
  router.post('/:id/pause', async (req, res) => {
    const owner = res.locals.importOwner as string,
      { job, root } = await ownedJob(String(req.params.id), owner);
    const saved = await ready().queue.cancel(job.id, job.ownerId);
    res.json({
      job: publicImport(
        saved,
        root,
        await options.store().list(job.ownerId, 'photo'),
        owner,
      ),
    });
  });
  router.post('/:id/resume', async (req, res) => {
    consent(req);
    const data = parse(resumeSchema, req.body),
      actor = res.locals.importOwner as string;
    const initial = await ownedJob(String(req.params.id), actor);
    const owner = initial.job.ownerId;
    const resumed = await withAccountLock(owner, async () => {
      await options.owner(req);
      const { job, root } = await ownedJob(String(req.params.id), actor),
        { queue, connections, store } = ready();
      if (['queued', 'running'].includes(job.status))
        throw new ApiError(
          409,
          'IMPORT_ACTIVE',
          'Pause or wait for this import before resuming.',
        );
      if (data.requestId === job.requestId)
        throw new ApiError(
          409,
          'JOB_REQUEST_REUSED',
          'Use a new request identifier to resume this import.',
        );
      if (
        root.processingRequestId !== job.requestId &&
        root.processingRequestId !== data.requestId
      )
        throw new ApiError(
          409,
          'IMPORT_SUPERSEDED',
          'A newer import attempt already exists. Refresh its status.',
        );
      const active = (await queue.list(owner, root.id)).find(
        (row) =>
          ['queued', 'running'].includes(row.status) &&
          row.requestId !== data.requestId,
      );
      if (active)
        throw new ApiError(
          409,
          'IMPORT_ACTIVE',
          'Another attempt is already processing this import.',
        );
      const source = job.importSource!;
      if (source.folderSyncId)
        throw new ApiError(
          409,
          'SYNC_RECOVERY_REQUIRED',
          'Manage automatic imports from the event source controls.',
        );
      if ((source.actorId ?? owner) !== actor)
        throw new ApiError(
          403,
          'SOURCE_OWNER_REQUIRED',
          'Only the person who connected this source can resume this import.',
        );
      if (data.generation !== source.generation && !data.acceptConnectionChange)
        throw new ApiError(
          409,
          'SOURCE_CONNECTION_CHANGED',
          'Confirm that the reconnected source account contains the same selected files before resuming.',
        );
      await connections.access(actor, source.provider, data.generation);
      await destination(source.destinationEventId, owner);
      const resumedRoot: LibraryRecord = {
        ...root,
        processingRequestId: data.requestId,
        state: 'running',
        errors: [],
      };
      if (root.eventId && store.stageEventImport)
        await store.stageEventImport(
          actor,
          resumedRoot,
          root.processingRequestId,
        );
      else await store.put(resumedRoot);
      return queue.enqueue({
        ownerId: owner,
        eventId: root.id,
        requestId: data.requestId,
        type: 'cloud-import',
        photoIds: job.photoIds,
        importSource: { ...source, generation: data.generation },
        consentPolicyVersion: 'cloud-import-v1',
      });
    });
    res.status(202).json({
      job: publicImport(
        resumed,
        await ownedRoot(resumed.eventId, actor),
        await options.store().list(owner, 'photo'),
        actor,
      ),
    });
  });
  return router;
}
