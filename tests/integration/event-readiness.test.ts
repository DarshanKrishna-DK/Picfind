import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type {
  LibraryOptions,
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library';
import type { JobListEntry, JobQueue } from '../../apps/api/src/jobs';
import { highlightRecordId } from '../../apps/api/src/highlights';
import { eventPreparationSnapshot } from '../../apps/api/src/event-readiness';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports';

const origin = 'http://localhost:5173',
  now = Date.parse('2026-10-20T12:00:00.000Z');
function fixture(options: Partial<LibraryOptions> = {}) {
  const eventId = randomUUID(),
    records = new Map<string, LibraryRecord>();
  const event: LibraryRecord = {
    id: eventId,
    kind: 'event',
    ownerId: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    title: 'Private event',
    visibility: 'private',
    expiresAt: '2099-01-01T00:00:00.000Z',
    passcodeHash: 'private-passcode-hash',
  };
  records.set(eventId, event);
  const store: LibraryStore = {
    list: vi.fn(async (actor, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row)),
    ),
    get: vi.fn(async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    }),
    put: vi.fn(),
    remove: vi.fn(),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store, ...options },
  );
  const photo = (changes: Partial<LibraryRecord> = {}) => {
    const row: LibraryRecord = {
      id: randomUUID(),
      kind: 'photo',
      ownerId: 'owner',
      eventId,
      createdAt: event.createdAt,
      bytes: 100,
      indexState: 'ready',
      provider: 'aws-rekognition',
      modelVersion: '7',
      externalImageId: 'private-image-id',
      faceIds: ['private-face-id'],
      filename: 'private.jpg',
      ...changes,
    };
    records.set(row.id, row);
    return row;
  };
  const job = (changes: Partial<LibraryRecord> = {}) => {
    const row: LibraryRecord = {
      id: randomUUID(),
      kind: 'job',
      ownerId: 'owner',
      eventId,
      createdAt: event.createdAt,
      purpose: 'import',
      state: 'complete',
      source: 'private-source-url',
      errors: ['private-provider-error'],
      ...changes,
    };
    records.set(row.id, row);
    return row;
  };
  const highlights = (photoIds: string[], published = true) =>
    job({
      id: highlightRecordId(eventId),
      purpose: 'event-highlights',
      highlights: {
        title: 'Guest highlights',
        photoIds,
        published,
        version: 1,
        updatedAt: event.createdAt,
      },
    });
  const snapshot = (
    processing: JobListEntry[] = [],
    worker: 'available' | 'unavailable' | 'not-configured' = 'available',
  ) =>
    eventPreparationSnapshot(
      event,
      {
        photos: [...records.values()],
        jobs: [...records.values()],
        processing,
      },
      {
        worker,
        provider: 'aws-rekognition',
        processingAvailable: worker === 'available',
      },
      now,
    );
  const read = (actor = 'owner') =>
    request(app)
      .get(`/api/events/${eventId}/readiness`)
      .set('Cookie', `picfind_session=${actor}`);
  return {
    app,
    event,
    eventId,
    records,
    store,
    photo,
    job,
    highlights,
    snapshot,
    read,
  };
}
function workerJob(
  rootId: string,
  changes: Partial<JobListEntry> = {},
): JobListEntry {
  return {
    id: randomUUID(),
    ownerId: 'owner',
    eventId: rootId,
    type: 'cloud-import',
    requestId: 'request-1',
    fingerprint: 'private-fingerprint',
    consentPolicyVersion: 'cloud-import-v1',
    consentAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    cursor: 1,
    indexed: 0,
    empty: 0,
    failed: 0,
    failedPhotoIds: [],
    ...changes,
  };
}
describe('owner event preparation snapshots', () => {
  it('returns safe metadata without touching files, face providers or writes', async () => {
    const f = fixture({ faceMatcher: {} as FaceMatchingProvider });
    f.photo();
    f.job();
    const result = await f.read().expect(200);
    expect(result.body).toMatchObject({
      accountId: 'owner',
      eventId: f.eventId,
      gallery: { state: 'private', hasPasscode: true },
      photos: { available: 1, knownBytes: 100 },
      imports: { total: 1, complete: 1 },
      matching: { status: 'ready', processingAvailable: false },
    });
    const text = JSON.stringify(result.body);
    for (const secret of [
      'private-passcode-hash',
      'private-image-id',
      'private-face-id',
      'private.jpg',
      'private-source-url',
      'private-provider-error',
    ])
      expect(text).not.toContain(secret);
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.store.remove).not.toHaveBeenCalled();
    expect(f.store.file).not.toHaveBeenCalled();
    expect(f.store.upload).not.toHaveBeenCalled();
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it('denies guests, foreign owners, moderators and browser account changes', async () => {
    const f = fixture();
    await request(f.app).get(`/api/events/${f.eventId}/readiness`).expect(401);
    await f.read('other').expect(404);
    f.event.members = [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: f.event.createdAt,
      },
    ];
    await f.read('moderator').expect(404);
    await f.read().set('X-PicFind-Readiness-Actor', 'other').expect(403);
  });
  it('rechecks event ownership after asynchronous metadata reads', async () => {
    const f = fixture(),
      get = f.store.get;
    let reads = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.eventId && ++reads === 2) row.ownerId = 'other';
      return row;
    };
    await f.read().expect(404);
  });
  it('never treats a spoofed expected-account header as session authorization', async () => {
    const f = fixture();
    await request(f.app)
      .get(`/api/events/${f.eventId}/readiness`)
      .set('X-PicFind-Readiness-Actor', 'owner')
      .expect(401);
    await f.read('other').set('X-PicFind-Readiness-Actor', 'owner').expect(403);
    await f.read('other').set('X-PicFind-Readiness-Actor', 'other').expect(404);
    f.event.members = [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: f.event.createdAt,
      },
    ];
    await f
      .read('moderator')
      .set('X-PicFind-Readiness-Actor', 'owner')
      .expect(403);
    await f
      .read('moderator')
      .set('X-PicFind-Readiness-Actor', 'moderator')
      .expect(404);
    // Rejected requests do not get as far as scanning private photo/job metadata.
    expect(f.store.list).not.toHaveBeenCalled();
    await f.read().set('X-PicFind-Readiness-Actor', 'owner').expect(200);
    expect(f.store.list).toHaveBeenCalledTimes(2);
  });
  it('scopes over-broad store results to event, owner, purpose and non-scan photos', async () => {
    const f = fixture();
    f.photo();
    f.photo({ ownerId: 'other' });
    f.photo({ eventId: randomUUID() });
    f.photo({ scanId: randomUUID() });
    f.job();
    f.job({ ownerId: 'other' });
    f.job({ eventId: randomUUID() });
    f.job({ purpose: 'studio-client' });
    f.store.list = async () => [...f.records.values()];
    const result = await f.read().expect(200);
    expect(result.body.photos.available).toBe(1);
    expect(result.body.imports.total).toBe(1);
  });
  it('distinguishes unavailable photo records and invalid saved sizes', () => {
    const f = fixture();
    f.photo();
    delete f.photo().bytes;
    f.photo({ bytes: -1 });
    f.photo({ bytes: Number.MAX_SAFE_INTEGER });
    f.photo({ expiresAt: '2020-01-01T00:00:00.000Z' });
    f.photo({ expiresAt: 'invalid' });
    f.photo({ deletionStartedAt: f.event.createdAt });
    f.photo({ deletionCompletedAt: f.event.createdAt });
    expect(f.snapshot().photos).toEqual({
      available: 4,
      expired: 2,
      deleting: 2,
      knownBytes: 100,
      unknownBytes: 3,
    });
  });
  it.each([
    [{}, 'private'],
    [{ visibility: 'link' }, 'shared'],
    [{ archived: true }, 'archived'],
    [{ expiresAt: '2020-01-01T00:00:00.000Z' }, 'expired'],
    [{ expiresAt: 'invalid' }, 'expired'],
    [{ deletionStartedAt: '2026-01-01T00:00:00.000Z' }, 'deleting'],
  ] as const)('reports the current gallery state %j', (changes, state) => {
    const f = fixture();
    Object.assign(f.event, changes);
    expect(f.snapshot().gallery.state).toBe(state);
    if ('expiresAt' in changes && changes.expiresAt === 'invalid')
      expect(f.snapshot().gallery.expiresAt).toBeNull();
  });
  it('reports mixed provider versions as attention rather than prepared', () => {
    const f = fixture();
    f.photo({ modelVersion: '6' });
    f.photo({ modelVersion: '7' });
    expect(f.snapshot().matching).toMatchObject({
      status: 'needs-attention',
      counts: { prepared: 0, needsReview: 2 },
    });
  });
  it('keeps full-gallery sharing separate from available, partial and withdrawn highlights', () => {
    const f = fixture(),
      photo = f.photo(),
      missing = randomUUID();
    const set = f.highlights([photo.id]);
    expect(f.snapshot()).toMatchObject({
      gallery: { state: 'private' },
      highlights: { state: 'published', selected: 1, available: 1 },
    });
    set.highlights!.photoIds.push(missing);
    expect(f.snapshot().highlights).toEqual({
      state: 'partial',
      selected: 2,
      available: 1,
    });
    f.event.archived = true;
    expect(f.snapshot().highlights.state).toBe('unavailable');
    set.highlights!.published = false;
    expect(f.snapshot().highlights.state).toBe('draft');
    set.highlights!.version = 0;
    expect(f.snapshot().highlights.state).toBe('invalid');
  });
  it('uses the correct cloud request and owner without accepting stale or foreign worker rows', () => {
    const f = fixture();
    const root = f.job({
      processingSource: 'cloud',
      processingRequestId: 'request-1',
      state: 'complete',
    });
    expect(
      f.snapshot([workerJob(root.id, { status: 'running' })]).imports.running,
    ).toBe(1);
    expect(
      f.snapshot([workerJob(root.id, { failed: 1 })]).imports.partial,
    ).toBe(1);
    expect(
      f.snapshot([workerJob(root.id, { status: 'cancelled' })]).imports.failed,
    ).toBe(1);
    expect(
      f.snapshot([
        workerJob(root.id, { ownerId: 'other' }),
        workerJob(root.id, { requestId: 'stale' }),
      ]).imports.unknown,
    ).toBe(1);
    expect(f.snapshot([], 'not-configured').imports.unknown).toBe(1);
  });
  it('shows a worker outage explicitly while preserving independent gallery and photo evidence', async () => {
    const list = vi.fn(async () => {
      throw new Error('private worker failure');
    });
    const f = fixture({
      jobQueue: { list } as unknown as JobQueue,
      faceMatcher: {} as FaceMatchingProvider,
    });
    f.photo();
    f.job({ processingSource: 'cloud', processingRequestId: 'request-1' });
    const result = await f.read().expect(200);
    expect(result.body).toMatchObject({
      worker: 'unavailable',
      matching: null,
      imports: { unknown: 1 },
      photos: { available: 1 },
      gallery: { state: 'private' },
    });
    expect(JSON.stringify(result.body)).not.toContain('private worker failure');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('owner');
  });
  it('uses only event-index jobs for the matching processing indicator', () => {
    const f = fixture();
    f.photo();
    expect(
      f.snapshot([workerJob(f.eventId, { status: 'running' })]).matching
        ?.status,
    ).toBe('ready');
    expect(
      f.snapshot([
        workerJob(f.eventId, { status: 'running', type: 'event-index' }),
      ]).matching?.status,
    ).toBe('processing');
    expect(
      f.snapshot([
        workerJob(randomUUID(), { status: 'running', type: 'event-index' }),
      ]).matching?.status,
    ).toBe('ready');
  });
});
