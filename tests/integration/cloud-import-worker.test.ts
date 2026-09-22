import { randomUUID } from 'node:crypto';
import { BillingService } from '../../apps/api/src/billing/service.js';
import { AppwriteLibraryStore } from '../../apps/api/src/adapters/appwrite-library.js';
import { createCloudFileReader } from '../../apps/api/src/cloud-file-reader.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ApiError } from '../../apps/api/src/auth.js';
import { CloudImportWorker } from '../../apps/api/src/cloud-import-worker.js';
import {
  cloudPhotoId,
  createCloudPhotoImporter,
} from '../../apps/api/src/cloud-photo-import.js';
import type { CloudFileReader } from '../../apps/api/src/cloud-file-reader.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { TestJobStore } from '../helpers/job-store.js';

async function fixture() {
  const ownerId = randomUUID(),
    importId = randomUUID(),
    requestId = randomUUID(),
    generation = randomUUID();
  const root: LibraryRecord = {
    id: importId,
    ownerId,
    kind: 'job',
    purpose: 'import',
    source: 'dropbox',
    processingSource: 'cloud',
    processingRequestId: requestId,
    state: 'running',
    createdAt: new Date().toISOString(),
  };
  const rows = new Map([[root.id, root]]);
  const fileBytes = new Map<string, Uint8Array>();
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row, create) => {
      if (create && rows.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Already exists');
      rows.set(row.id, structuredClone(row));
    }),
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async (id, bytes) => {
      fileBytes.set(id, new Uint8Array(bytes));
    }),
    file: async (id) => new Response(new Uint8Array(fileBytes.get(id) ?? [])),
    removeFile: vi.fn(async (id) => {
      fileBytes.delete(id);
    }),
  };
  const source = { provider: 'dropbox' as const, generation };
  const access = vi.fn(
    async (_owner: string, _provider: string, expected?: string) => {
      if (expected !== generation)
        throw new ApiError(409, 'SOURCE_CONNECTION_CHANGED', 'Changed');
      return {
        accessToken: 'synthetic-token',
        expiresAt: Date.now() + 3600000,
        generation,
      };
    },
  );
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#4488aa' },
  })
    .jpeg()
    .toBuffer();
  const read = vi.fn<CloudFileReader>(async () => ({
    name: 'synthetic.jpg',
    bytes: Buffer.from(jpeg),
  }));
  const importPhoto = createCloudPhotoImporter(
    store,
    { access },
    undefined,
    {
      production: false,
      libraryPhotos: 20,
      events: 20,
      eventPhotos: 20,
      discoverPhotos: 20,
    },
    read,
  );
  const jobs = new TestJobStore(),
    queue = new JobQueue(jobs);
  const worker = new CloudImportWorker(queue, store, importPhoto);
  const enqueue = (ids = ['id:first', 'id:second']) =>
    queue.enqueue({
      ownerId,
      eventId: importId,
      requestId,
      photoIds: ids,
      type: 'cloud-import',
      importSource: source,
      consentPolicyVersion: 'cloud-import-v1',
    });
  return {
    ownerId,
    importId,
    requestId,
    source,
    root,
    rows,
    store,
    fileBytes,
    access,
    read,
    importPhoto,
    jobs,
    queue,
    worker,
    enqueue,
  };
}
describe('durable cloud imports with synthetic photos and no provider network', () => {
  it('imports a saved manifest without indexing faces or persisting credentials', async () => {
    const f = await fixture(),
      job = await f.enqueue();
    expect(await f.worker.processNext()).toBe(true);
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'complete',
      imported: 2,
      indexed: 0,
      cursor: 2,
    });
    const photos = await f.store.list(f.ownerId, 'photo');
    expect(photos).toHaveLength(2);
    expect(photos.every((row) => row.indexState === 'none')).toBe(true);
    expect(JSON.stringify([...f.rows.values()])).not.toContain(
      'synthetic-token',
    );
    expect(f.access).toHaveBeenCalledWith(
      f.ownerId,
      'dropbox',
      f.source.generation,
    );
    expect(
      f.read.mock.results.every((result) => result.type === 'return'),
    ).toBe(true);
  });
  it('reuses completed destination photos instead of downloading or uploading again', async () => {
    const f = await fixture(),
      guard = async () => {};
    const first = await f.importPhoto(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      guard,
    );
    const second = await f.importPhoto(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      guard,
    );
    expect(second.id).toBe(first.id);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.store.upload).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost library commit reply without deleting the successfully imported photo', async () => {
    const f = await fixture(),
      put = f.store.put.bind(f.store);
    f.store.put = async (row, create) => {
      await put(row, create);
      if (row.kind === 'photo') throw new Error('Lost acknowledgement');
    };
    const photo = await f.importPhoto(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      async () => {},
    );
    expect(photo.kind).toBe('photo');
    expect(f.fileBytes.has(photo.id)).toBe(true);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it('cleans a failed file write and leaves the same deterministic photo retryable', async () => {
    const f = await fixture(),
      upload = f.store.upload;
    f.store.upload = vi.fn(async () => {
      throw new Error('Storage unavailable');
    });
    await expect(
      f.importPhoto(
        f.ownerId,
        f.importId,
        f.source,
        'id:first',
        async () => {},
      ),
    ).rejects.toThrow('Storage unavailable');
    expect(f.rows.has(cloudPhotoId(f.importId, 'id:first'))).toBe(false);
    f.store.upload = upload;
    expect(
      (
        await f.importPhoto(
          f.ownerId,
          f.importId,
          f.source,
          'id:first',
          async () => {},
        )
      ).kind,
    ).toBe('photo');
  });
  it('does not take over an unresolved upload cleanup intent', async () => {
    const f = await fixture(),
      id = cloudPhotoId(f.importId, 'id:first');
    await f.importPhoto(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      async () => {},
    );
    f.rows.set(id, {
      ...f.rows.get(id)!,
      kind: 'job',
      purpose: 'upload-cleanup',
    });
    await expect(
      f.importPhoto(
        f.ownerId,
        f.importId,
        f.source,
        'id:first',
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_RECOVERY_REQUIRED' });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('stops before another provider request after a connection changes', async () => {
    const f = await fixture(),
      job = await f.enqueue();
    f.access.mockImplementation(async () => {
      throw new ApiError(409, 'SOURCE_CONNECTION_CHANGED', 'Changed');
    });
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'SOURCE_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('does not publish an image if access is revoked during its download', async () => {
    const f = await fixture(),
      originalRead = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      f.access.mockImplementation(async () => {
        throw new ApiError(401, 'SOURCE_RECONNECT_REQUIRED', 'Disconnected');
      });
      return result;
    });
    await expect(
      f.importPhoto(
        f.ownerId,
        f.importId,
        f.source,
        'id:first',
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_RECONNECT_REQUIRED' });
    expect(f.store.upload).not.toHaveBeenCalled();
    expect(await f.store.list(f.ownerId, 'photo')).toHaveLength(0);
  });
  it('fences deleted or archived destination events', async () => {
    const f = await fixture(),
      eventId = randomUUID();
    f.root.eventId = eventId;
    f.rows.set(eventId, {
      id: eventId,
      ownerId: f.ownerId,
      kind: 'event',
      archived: true,
      createdAt: new Date().toISOString(),
    });
    await expect(
      f.importPhoto(
        f.ownerId,
        f.importId,
        { ...f.source, destinationEventId: eventId },
        'id:first',
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('finishes the in-flight photo on pause but never starts the next one', async () => {
    const f = await fixture(),
      job = await f.enqueue(),
      originalRead = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {
      await f.queue.cancel(job.id, f.ownerId);
      return originalRead(...args);
    });
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'cancelled',
      imported: 1,
      cursor: 1,
    });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('skips an invalid individual photo but pauses systemic source failures', async () => {
    const f = await fixture(),
      job = await f.enqueue(['id:bad', 'id:good']);
    f.read.mockRejectedValueOnce(
      new ApiError(422, 'INVALID_IMAGE', 'Not a photo'),
    );
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'partial',
      failed: 1,
      imported: 1,
    });
    const g = await fixture(),
      blocked = await g.enqueue();
    g.read.mockRejectedValue(new Error('Provider unavailable'));
    await g.worker.processNext();
    expect(await g.queue.owned(blocked.id, g.ownerId)).toMatchObject({
      status: 'failed',
      cursor: 0,
    });
    expect(g.read).toHaveBeenCalledTimes(1);
  });
  it('retries only a lost queue checkpoint and never re-downloads the file', async () => {
    const f = await fixture(),
      job = await f.enqueue(['id:first']),
      finish = f.queue.finishItem.bind(f.queue);
    let lost = false;
    f.queue.finishItem = async (...args) => {
      const saved = await finish(...args);
      if (!lost) {
        lost = true;
        throw new Error('Lost reply');
      }
      return saved;
    };
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'complete',
      imported: 1,
      cursor: 1,
    });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('cannot consume face-index jobs when matching is disabled', async () => {
    const f = await fixture();
    const face = await f.queue.enqueue({
      ownerId: f.ownerId,
      eventId: randomUUID(),
      requestId: randomUUID(),
      photoIds: [randomUUID()],
      consentPolicyVersion: 'face-matching-v1',
    });
    const importing = await f.enqueue();
    await f.worker.processNext();
    expect((await f.queue.owned(face.id, f.ownerId)).status).toBe('queued');
    expect((await f.queue.owned(importing.id, f.ownerId)).status).toBe(
      'complete',
    );
  });
  it('stops cleanly when the saved import record has been deleted', async () => {
    const f = await fixture(),
      job = await f.enqueue();
    f.rows.delete(f.importId);
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('stops the whole import when the destination event was deleted after enqueue', async () => {
    const f = await fixture(),
      eventId = randomUUID();
    f.root.eventId = eventId;
    Object.assign(f.source, { destinationEventId: eventId });
    const job = await f.enqueue();
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('skips malformed image bytes without discarding the next valid photo', async () => {
    const f = await fixture(),
      job = await f.enqueue();
    f.read.mockResolvedValueOnce({
      name: 'bad.jpg',
      bytes: Buffer.from('not an image'),
    });
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'partial',
      failed: 1,
      imported: 1,
    });
  });
});

describe('saved import review regressions', () => {
  it('recovers a failed billed upload with one active storage reservation', async () => {
    const f = await fixture(),
      ledger = new ImportTestBillingStore();
    const billing = new BillingService(
      ledger,
      undefined,
      {},
      'test_mode',
      false,
    );
    const importer = createCloudPhotoImporter(
      f.store,
      { access: f.access },
      billing,
      undefined,
      f.read,
    );
    const upload = f.store.upload;
    f.store.upload = vi.fn(async () => {
      throw new Error('Synthetic failed upload');
    });
    await expect(
      importer(f.ownerId, f.importId, f.source, 'id:first', async () => {}),
    ).rejects.toThrow('Synthetic failed upload');
    f.store.upload = upload;
    const photo = await importer(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      async () => {},
    );
    expect(f.fileBytes.size).toBe(1);
    const account = await ledger.transaction((tx) =>
      tx.get<{ storedBytes: number }>(billing.key('account', f.ownerId)),
    );
    expect(account?.storedBytes).toBe(photo.bytes);
    expect(
      [...ledger.rows.values()].filter(
        (row) => (row.value as { status?: string }).status === 'reserved',
      ),
    ).toHaveLength(1);
  });
  it('imports later valid photos when one source file was deleted', async () => {
    const f = await fixture();
    Object.assign(f.source, { provider: 'box' });
    f.root.source = 'box';
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#4488aa' },
    })
      .jpeg()
      .toBuffer();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ name: 'valid.jpg', size: jpeg.length }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(jpeg)));
    const importer = createCloudPhotoImporter(
      f.store,
      { access: f.access },
      undefined,
      undefined,
      createCloudFileReader(fetcher),
    );
    const job = await f.enqueue();
    await new CloudImportWorker(f.queue, f.store, importer).processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'partial',
      failed: 1,
      imported: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('releases the upload-attempt reservation when retention deletes a photo', async () => {
    const ownerId = randomUUID(),
      photoId = randomUUID(),
      reservationId = randomUUID();
    const releaseStorage = vi.fn(async () => {});
    const store = new AppwriteLibraryStore(
      {
        endpoint: 'https://unused.example/v1',
        projectId: 'synthetic',
        apiKey: 'synthetic',
      },
      { releaseStorage } as unknown as BillingService,
    );
    vi.spyOn(store, 'get').mockResolvedValue({
      id: photoId,
      ownerId,
      kind: 'photo',
      bytes: 200,
      createdAt: new Date().toISOString(),
      storageReservationId: reservationId,
    } as LibraryRecord);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    try {
      await store.remove(photoId);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(releaseStorage).toHaveBeenCalledWith(
      ownerId,
      reservationId,
      200,
      expect.any(Function),
      false,
    );
  });
});
function attachEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  expiresAt: string,
) {
  const id = randomUUID();
  f.root.eventId = id;
  Object.assign(f.source, { destinationEventId: id });
  f.rows.set(id, {
    id,
    ownerId: f.ownerId,
    kind: 'event',
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  return id;
}
describe('event destination boundaries inside the cloud worker', () => {
  it.each(['2000-01-01T00:00:00.000Z', 'invalid'])(
    'stops before downloading when the destination expiry is %s',
    async (expiresAt) => {
      const f = await fixture();
      attachEvent(f, expiresAt);
      const job = await f.enqueue();
      await f.worker.processNext();
      expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
        status: 'failed',
        failureCode: 'EVENT_UNAVAILABLE',
        cursor: 0,
      });
      expect(f.read).not.toHaveBeenCalled();
      expect(f.store.upload).not.toHaveBeenCalled();
    },
  );
  it('does not let an unchecked event date extend the existing server retention allowance', async () => {
    const f = await fixture(),
      expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
    const eventId = attachEvent(f, expiresAt);
    await f.enqueue(['id:first']);
    await f.worker.processNext();
    const photos = await f.store.list(f.ownerId, 'photo');
    expect(photos).toHaveLength(1);
    expect(photos[0]?.eventId).toBe(eventId);
    expect(Date.parse(photos[0]!.expiresAt!)).toBeLessThanOrEqual(
      Date.now() + 7 * 86400000,
    );
    expect(Date.parse(photos[0]!.expiresAt!)).toBeGreaterThan(
      Date.now() + 6 * 86400000,
    );
  });
  it('does not publish a photo if the event expires during download', async () => {
    const f = await fixture(),
      eventId = attachEvent(f, new Date(Date.now() + 86400000).toISOString());
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => {
      const photo = await original(...args);
      f.rows.set(eventId, {
        ...f.rows.get(eventId)!,
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      return photo;
    });
    const job = await f.enqueue();
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it('cleans up a file if the event expires during its storage write', async () => {
    const f = await fixture(),
      eventId = attachEvent(f, new Date(Date.now() + 86400000).toISOString());
    const upload = f.store.upload;
    f.store.upload = vi.fn(async (id, bytes) => {
      await upload(id, bytes);
      f.rows.set(eventId, {
        ...f.rows.get(eventId)!,
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
    });
    const job = await f.enqueue();
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.fileBytes.size).toBe(0);
    expect(await f.store.list(f.ownerId, 'photo')).toHaveLength(0);
  });
  it('rechecks a shortened event expiry before committing the photo', async () => {
    const f = await fixture(),
      eventId = attachEvent(
        f,
        new Date(Date.now() + 90 * 86400000).toISOString(),
      );
    const shorter = new Date(Date.now() + 2 * 86400000).toISOString(),
      upload = f.store.upload;
    f.store.upload = vi.fn(async (id, bytes) => {
      await upload(id, bytes);
      f.rows.set(eventId, { ...f.rows.get(eventId)!, expiresAt: shorter });
    });
    await f.enqueue(['id:first']);
    await f.worker.processNext();
    expect((await f.store.list(f.ownerId, 'photo'))[0]?.expiresAt).toBe(
      shorter,
    );
  });
  it('does not let a changed import root redirect a queued manifest', async () => {
    const f = await fixture();
    attachEvent(f, new Date(Date.now() + 86400000).toISOString());
    const job = await f.enqueue();
    f.root.eventId = randomUUID();
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
      cursor: 0,
    });
    expect(f.read).not.toHaveBeenCalled();
  });
  it('keeps copies of the same source file isolated in two event collections', async () => {
    const f = await fixture(),
      expiresAt = new Date(Date.now() + 86400000).toISOString();
    const first = attachEvent(f, expiresAt),
      second = randomUUID(),
      secondImport = randomUUID();
    f.rows.set(second, {
      id: second,
      ownerId: f.ownerId,
      kind: 'event',
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    f.rows.set(secondImport, { ...f.root, id: secondImport, eventId: second });
    const one = await f.importPhoto(
      f.ownerId,
      f.importId,
      f.source,
      'id:first',
      async () => {},
    );
    const two = await f.importPhoto(
      f.ownerId,
      secondImport,
      { ...f.source, destinationEventId: second },
      'id:first',
      async () => {},
    );
    expect(one.id).not.toBe(two.id);
    expect(one.eventId).toBe(first);
    expect(two.eventId).toBe(second);
    expect(
      (await f.store.list(f.ownerId, 'photo'))
        .map((photo) => photo.eventId)
        .sort(),
    ).toEqual([first, second].sort());
  });
});

describe('cloud worker account deletion checkpoints', () => {
  it('does not access source files after an account deletion fence is observed', async () => {
    const f = await fixture();
    const job = await f.enqueue();
    const authority = vi.fn(async () => {
      throw new ApiError(409, 'ACCOUNT_DELETION_PENDING', 'Synthetic deletion');
    });
    const worker = new CloudImportWorker(
      f.queue,
      f.store,
      f.importPhoto,
      undefined,
      authority,
    );
    await worker.processNext();
    expect(authority).toHaveBeenCalledWith(f.ownerId, f.ownerId);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.store.upload).not.toHaveBeenCalled();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      cursor: 0,
      failureCode: 'EVENT_UNAVAILABLE',
    });
  });
  it('stops before publication when deletion is observed after downloading a source file', async () => {
    const f = await fixture();
    const job = await f.enqueue();
    let deleting = false;
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementationOnce(async (...args) => {
      const photo = await original(...args);
      deleting = true;
      return photo;
    });
    const worker = new CloudImportWorker(
      f.queue,
      f.store,
      f.importPhoto,
      undefined,
      async () => {
        if (deleting)
          throw new ApiError(
            409,
            'ACCOUNT_DELETION_PENDING',
            'Synthetic deletion',
          );
      },
    );
    await worker.processNext();
    expect(f.read).toHaveBeenCalledOnce();
    expect(await f.store.list(f.ownerId, 'photo')).toEqual([]);
    expect(f.fileBytes.size).toBe(0);
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      cursor: 0,
      failureCode: 'EVENT_UNAVAILABLE',
    });
  });
});
