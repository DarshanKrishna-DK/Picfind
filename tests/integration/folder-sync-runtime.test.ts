import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';
import {
  createFolderSyncRuntime,
  folderSyncFlags,
} from '../../apps/api/src/folder-sync-runtime.js';
import {
  FolderSyncWorker,
  type FolderSync,
  type FolderSyncDirectory,
} from '../../apps/api/src/folder-sync.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { TestJobStore } from '../helpers/job-store.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), list: vi.fn() }));
vi.mock('../../apps/api/src/processing-worker.js', () => ({
  startProcessingWorker: mocks.start,
}));
vi.mock('../../apps/api/src/folder-sync-reader.js', async () => ({
  ...(await vi.importActual<
    typeof import('../../apps/api/src/folder-sync-reader.js')
  >('../../apps/api/src/folder-sync-reader.js')),
  createFolderSyncReader: () => mocks.list,
}));
beforeEach(() => {
  mocks.start.mockReset();
  mocks.list.mockReset();
  mocks.start.mockImplementation((worker?: FolderSyncWorker) => ({
    status: () => ({
      enabled: Boolean(worker),
      running: false,
      lastSuccessAt: null,
      error: null,
    }),
    stop: async () => {
      worker?.stop();
    },
  }));
  mocks.list.mockResolvedValue({ fileIds: ['photo-a'], nextCursor: null });
});

function fixture(moderator = false) {
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 86400000).toISOString();
  const source: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: moderator ? 'moderator' : 'owner',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    ...(moderator ? { membershipGrantId: randomUUID() } : {}),
    folderId: 'folder',
    consentPolicyVersion: 'folder-sync-v1',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
  };
  const records = new Map<string, LibraryRecord>([
    [
      source.eventId,
      {
        id: source.eventId,
        kind: 'event',
        ownerId: 'owner',
        createdAt: now,
        expiresAt,
        members: moderator
          ? [
              {
                userId: 'moderator',
                role: 'moderator',
                grantId: source.membershipGrantId!,
                addedAt: now,
              },
            ]
          : [],
      },
    ],
  ]);
  const rows = new Map([[source.id, source]]);
  const syncs: FolderSyncDirectory = {
    candidates: async () =>
      [...rows.values()].filter(
        (row) =>
          row.status === 'active' && Date.parse(row.nextRunAt) <= Date.now(),
      ),
    get: async (id) => structuredClone(rows.get(id)),
    knownFiles: async () => new Set(),
    isSuppressed: async () => false,
    listEvent: async (owner, event) =>
      [...rows.values()].filter(
        (row) => row.ownerId === owner && row.eventId === event,
      ),
    async mutate(id, operation) {
      const result = operation(structuredClone(rows.get(id)));
      if (result.record) rows.set(id, result.record);
      return result.result;
    },
  };
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...records.values()].filter(
        (row) => row.ownerId === owner && row.kind === kind,
      ),
    put: async (row) => {
      records.set(row.id, structuredClone(row));
    },
    remove: vi.fn(),
    upload: vi.fn(),
    removeFile: vi.fn(),
    file: vi.fn(),
  };
  const billing = {
    roleCatalogEnabled: true,
    stageFolderSyncImport: vi
      .fn<BillingService['stageFolderSyncImport']>()
      .mockImplementation(async (_sync, root) => {
        await store.put(root, true);
        return root;
      }),
    authorizeFolderSync: vi
      .fn<BillingService['authorizeFolderSync']>()
      .mockResolvedValue({ expiresAt }),
    createFolderSync: vi.fn<BillingService['createFolderSync']>(),
    resumeFolderSync: vi.fn<BillingService['resumeFolderSync']>(),
    commitFolderSyncPhoto: vi
      .fn<BillingService['commitFolderSyncPhoto']>()
      .mockImplementation(async (_sync, _root, photo) => photo),
  };
  const connections = {
    access: vi.fn().mockResolvedValue({
      accessToken: 'synthetic',
      generation: source.generation,
    }),
  };
  const queue = new JobQueue(new TestJobStore());
  const env = {
    FOLDER_SYNC_ENABLED: 'true',
    FOLDER_SYNC_STORAGE_ENABLED: 'true',
    CLOUD_IMPORT_WORKER_ENABLED: 'true',
    SOURCE_COOKIE_KEY: 'ab'.repeat(32),
  };
  return {
    source,
    rows,
    records,
    syncs,
    store,
    billing,
    connections,
    queue,
    env,
  };
}

describe('folder sync runtime composition, synthetic reader and billing only', () => {
  it.each(['FOLDER_SYNC_ENABLED', 'FOLDER_SYNC_STORAGE_ENABLED'])(
    'rejects an invalid %s flag',
    (key) => {
      expect(() => folderSyncFlags({ [key]: 'yes' })).toThrow(
        'must be true or false',
      );
    },
  );
  it('cannot enable syncing without both import scheduling and durable cleanup storage', () => {
    expect(() => folderSyncFlags({ FOLDER_SYNC_ENABLED: 'true' })).toThrow(
      'imports and cleanup',
    );
    expect(() =>
      folderSyncFlags({
        FOLDER_SYNC_ENABLED: 'true',
        FOLDER_SYNC_STORAGE_ENABLED: 'true',
      }),
    ).toThrow('imports and cleanup');
  });
  it('does not start workers or expose controls when storage is disabled', () => {
    const f = fixture(),
      runtime = createFolderSyncRuntime({ ...f, env: {} });
    expect(runtime.controls).toBeUndefined();
    expect(runtime.authority).toBeUndefined();
    expect(runtime.enabled).toBe(false);
    expect(mocks.start).toHaveBeenCalledWith();
  });
  it('keeps management and import authority available while refusing new sync creation when scheduling is disabled', async () => {
    const f = fixture(),
      runtime = createFolderSyncRuntime({
        ...f,
        env: { ...f.env, FOLDER_SYNC_ENABLED: 'false' },
      });
    expect(runtime.controls).toBeDefined();
    expect(runtime.authority).toBeDefined();
    expect(runtime.status().enabled).toBe(false);
    await expect(
      runtime.controls!.create('owner', f.source.eventId, {
        requestId: randomUUID(),
        provider: 'drive',
        generation: f.source.generation,
        folderId: 'folder',
      }),
    ).rejects.toMatchObject({ code: 'FOLDER_SYNC_UNAVAILABLE' });
    expect(f.billing.createFolderSync).not.toHaveBeenCalled();
  });
  it('refuses activation without the organizer catalog or persistent connection credentials', () => {
    const f = fixture();
    expect(() =>
      createFolderSyncRuntime({
        ...f,
        billing: { ...f.billing, roleCatalogEnabled: false },
      }),
    ).toThrow('organizer catalog');
    expect(() =>
      createFolderSyncRuntime({
        ...f,
        env: { ...f.env, SOURCE_COOKIE_KEY: '' },
      }),
    ).toThrow('SOURCE_COOKIE_KEY');
  });
  it.each([false, true])(
    'queues only the event collection with correct source actor (moderator=%s)',
    async (moderator) => {
      const f = fixture(moderator),
        runtime = createFolderSyncRuntime(f);
      const worker = mocks.start.mock.calls[0]![0] as FolderSyncWorker;
      expect(await worker.processNext()).toBe(true);
      const jobs = await f.queue.list('owner');
      expect(jobs).toHaveLength(1);
      const job = await f.queue.owned(jobs[0]!.id, 'owner');
      expect(job.photoIds).toEqual(['photo-a']);
      expect(job.importSource).toMatchObject({
        destinationEventId: f.source.eventId,
        folderSyncId: f.source.id,
        generation: f.source.generation,
      });
      expect(job.importSource?.actorId ?? job.ownerId).toBe(f.source.actorId);
      expect(f.connections.access).toHaveBeenCalledWith(
        f.source.actorId,
        'drive',
        f.source.generation,
      );
      expect(f.rows.get(f.source.id)?.pending?.batchId).toBe(job.id);
      const root = await f.store.get(job.eventId);
      await expect(
        runtime.authority!.assert(
          'intruder',
          root,
          job.importSource!,
          'photo-a',
        ),
      ).rejects.toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
      expect(f.billing.commitFolderSyncPhoto).not.toHaveBeenCalled();
      await runtime.stop();
      expect(await worker.processNext()).toBe(false);
    },
  );
  it('does not read a folder or enqueue after organizer authority is revoked', async () => {
    const f = fixture();
    f.billing.authorizeFolderSync.mockRejectedValue(
      new ApiError(403, 'ACCESS_REVOKED', 'Denied'),
    );
    createFolderSyncRuntime(f);
    await (mocks.start.mock.calls[0]![0] as FolderSyncWorker).processNext();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(await f.queue.list('owner')).toEqual([]);
    expect(f.rows.get(f.source.id)?.status).toBe('attention');
  });
});
