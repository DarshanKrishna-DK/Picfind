import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://localhost:5173';
function fixture() {
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    createdAt: new Date().toISOString(),
    visibility: 'link',
    title: 'Collections',
    members: [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: new Date().toISOString(),
      },
    ],
  };
  const photos: LibraryRecord[] = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    createdAt: new Date().toISOString(),
    filename: 'same-name.jpg',
    privatePhotoNote: 'Private retouching instructions',
  }));
  const records = new Map([event, ...photos].map((row) => [row.id, row]));
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (ownerId, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === ownerId && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row) => {
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
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
    { store },
  );
  const root = `/api/events/${event.id}/proofing-collections`;
  const create = (
    body: object = { title: 'Album round', photoIds: photos.map((p) => p.id) },
    actor = 'owner',
  ) =>
    request(app)
      .post(root)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const read = (path = root, actor = 'owner') =>
    request(app).get(path).set('Cookie', `picfind_session=${actor}`);
  const patch = (id: string, body: object) =>
    request(app)
      .patch(`${root}/${id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send(body);
  const remove = (id: string, version: number) =>
    request(app)
      .delete(`${root}/${id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ version });
  return { app, event, photos, records, root, create, read, patch, remove };
}

describe('private named proofing collections', () => {
  it('persists collection-specific rules, preserves omitted policy updates and permits explicit repair', async () => {
    const f = fixture();
    const body = {
      title: 'Policy',
      photoIds: f.photos.map((photo) => photo.id),
    };
    const submissionPolicy = {
      minimum: 1,
      maximum: 2,
      closesAt: '2026-01-01T12:00:00.123Z',
    };
    const created = (await f.create({ ...body, submissionPolicy }).expect(201))
      .body.collection;
    expect(created.submissionPolicy).toEqual(submissionPolicy);
    expect(f.records.get(created.id)!.submissionPolicy).toEqual(
      submissionPolicy,
    );
    const changed = (
      await f
        .patch(created.id, { ...body, title: 'Renamed', version: 1 })
        .expect(200)
    ).body.collection;
    expect(changed.submissionPolicy).toEqual(submissionPolicy);
    expect(
      (await f.read(`${f.root}/${created.id}`).expect(200)).body.collection
        .submissionPolicy,
    ).toEqual(submissionPolicy);
    Object.assign(f.records.get(created.id)!, { submissionPolicy: null });
    await f.read(`${f.root}/${created.id}`).expect(503);
    await f.patch(created.id, { ...body, version: 2 }).expect(503);
    const repaired = { minimum: 0, maximum: 100, closesAt: null };
    await f
      .patch(created.id, { ...body, version: 2, submissionPolicy: repaired })
      .expect(200);
    expect(f.records.get(created.id)!.submissionPolicy).toEqual(repaired);
  });
  it.each([
    null,
    {},
    { minimum: -1, maximum: 2, closesAt: null },
    { minimum: 1.5, maximum: 2, closesAt: null },
    { minimum: 2, maximum: 1, closesAt: null },
    { minimum: 0, maximum: 101, closesAt: null },
    { minimum: 0, maximum: 0, closesAt: null },
    { minimum: '1', maximum: 2, closesAt: null },
    { minimum: 0, maximum: 2, closesAt: '' },
    { minimum: 0, maximum: 2, closesAt: '2026-10-20' },
    { minimum: 0, maximum: 2, closesAt: '2026-10-20T12:00:00+05:30' },
    { minimum: 0, maximum: 2, closesAt: '2026-02-30T12:00:00.000Z' },
    { minimum: 0, maximum: 2, closesAt: null, hidden: true },
  ])(
    'rejects malformed policy without writing: %j',
    async (submissionPolicy) => {
      const f = fixture();
      const body = {
        title: 'Policy',
        photoIds: f.photos.map((photo) => photo.id),
      };
      await f.create({ ...body, submissionPolicy }).expect(400);
      expect(
        [...f.records.values()].filter(
          (row) => row.purpose === 'proofing-collection',
        ),
      ).toHaveLength(0);
      const row = (await f.create(body).expect(201)).body.collection;
      const before = structuredClone(f.records.get(row.id));
      await f
        .patch(row.id, { ...body, version: 1, submissionPolicy })
        .expect(400);
      expect(f.records.get(row.id)).toEqual(before);
    },
  );
  it('checks the minimum against unique photos and prevents shrinking an existing constrained collection', async () => {
    const f = fixture();
    const submissionPolicy = { minimum: 2, maximum: 2, closesAt: null };
    await f
      .create({
        title: 'Duplicates',
        photoIds: [f.photos[0]!.id, f.photos[0]!.id],
        submissionPolicy,
      })
      .expect(400);
    const created = (
      await f
        .create({
          title: 'Both',
          photoIds: f.photos.map((p) => p.id),
          submissionPolicy,
        })
        .expect(201)
    ).body.collection;
    await f
      .patch(created.id, {
        title: 'One',
        photoIds: [f.photos[0]!.id],
        version: 1,
      })
      .expect(400);
    expect(f.records.get(created.id)!.collectionVersion).toBe(1);
  });
  it.each(['client', 'moderator', 'stranger'])(
    'does not let %s change collection rules',
    async (actor) => {
      const f = fixture();
      const collection = (await f.create().expect(201)).body.collection;
      const before = structuredClone(f.records.get(collection.id));
      await request(f.app)
        .patch(`${f.root}/${collection.id}`)
        .set('Origin', origin)
        .set('Cookie', `picfind_session=${actor}`)
        .send({
          title: 'Hijack',
          version: 1,
          photoIds: f.photos.map((p) => p.id),
          submissionPolicy: { minimum: 0, maximum: 100, closesAt: null },
        })
        .expect(404);
      expect(f.records.get(collection.id)).toEqual(before);
    },
  );
  it('normalizes missing filenames and hides deleting photos in the owner picker source', async () => {
    const f = fixture();
    delete f.photos[0]!.filename;
    f.photos[1]!.deletionStartedAt = new Date().toISOString();
    const result = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(result.body.photos).toHaveLength(1);
    expect(result.body.photos[0].filename).toBe('photo.jpg');
    expect(result.body.storedPhotoCount).toBe(2);
  });
  it.each([undefined, 0, -1, 0.5, Number.NaN])(
    'rejects malformed stored versions: %s',
    async (version) => {
      const f = fixture();
      const created = (await f.create().expect(201)).body.collection;
      const row = f.records.get(created.id)!;
      if (version === undefined) delete row.collectionVersion;
      else row.collectionVersion = version;
      const result = await f.read(`${f.root}/${created.id}`).expect(503);
      expect(result.body.error.code).toBe('COLLECTION_METADATA_INVALID');
      await f
        .patch(created.id, {
          title: 'Overwrite',
          photoIds: [f.photos[0]!.id],
          version: 1,
        })
        .expect(503);
      await f.remove(created.id, 1).expect(503);
      expect(f.records.get(created.id)?.title).toBe('Album round');
    },
  );
  it('creates, reloads, updates and deletes a set without changing photos or guest submissions', async () => {
    const f = fixture();
    const ids = f.photos.map((p) => p.id);
    const guestRequest: LibraryRecord = {
      id: randomUUID(),
      kind: 'job',
      ownerId: 'owner',
      purpose: 'selection',
      eventId: f.event.id,
      createdAt: new Date().toISOString(),
      selectedIds: ids,
    };
    f.records.set(guestRequest.id, guestRequest);
    const created = (
      await f
        .create({ title: '  Album round  ', photoIds: [...ids, ids[0]] })
        .expect(201)
    ).body.collection;
    expect(created).toMatchObject({
      title: 'Album round',
      photoIds: ids,
      version: 1,
      unavailableCount: 0,
    });
    expect(created.photos).toEqual(
      ids.map((id) => ({ id, filename: 'same-name.jpg' })),
    );
    expect(JSON.stringify(created)).not.toContain('Private retouching');
    const first = await f.read().expect(200);
    expect(first.body).toEqual({ collections: [created], limit: 50 });
    expect(
      (await f.read(`${f.root}/${created.id}`).expect(200)).body.collection,
    ).toEqual(created);
    const updated = await f
      .patch(created.id, {
        title: 'Retouch round',
        photoIds: [ids[1]],
        version: 1,
      })
      .expect(200);
    expect(updated.body.collection).toMatchObject({
      title: 'Retouch round',
      photoIds: [ids[1]],
      version: 2,
    });
    await f.remove(created.id, 1).expect(409);
    await f.remove(created.id, 2).expect(204);
    expect((await f.read().expect(200)).body.collections).toEqual([]);
    for (const photo of f.photos)
      expect(f.records.get(photo.id)).toEqual(photo);
    expect(f.records.get(guestRequest.id)).toEqual(guestRequest);
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(library.body.jobs).toEqual([]);
  });
  it('denies guests, actual moderators, other owners and cross-event collection access', async () => {
    const f = fixture();
    const row = (await f.create().expect(201)).body.collection;
    await request(f.app).get(f.root).expect(401);
    for (const actor of ['guest', 'moderator', 'another-owner']) {
      await f.read(f.root, actor).expect(404);
      await f.read(`${f.root}/${row.id}`, actor).expect(404);
      await f.create(undefined, actor).expect(404);
      await request(f.app)
        .patch(`${f.root}/${row.id}`)
        .set('Origin', origin)
        .set('Cookie', `picfind_session=${actor}`)
        .send({
          title: 'Unauthorized',
          photoIds: [f.photos[0]!.id],
          version: 1,
        })
        .expect(404);
      await request(f.app)
        .delete(`${f.root}/${row.id}`)
        .set('Origin', origin)
        .set('Cookie', `picfind_session=${actor}`)
        .send({ version: 1 })
        .expect(404);
    }
    const other = { ...f.event, id: randomUUID() };
    f.records.set(other.id, other);
    await f
      .read(`/api/events/${other.id}/proofing-collections/${row.id}`)
      .expect(404);
    f.event.deletionStartedAt = new Date().toISOString();
    await f.read().expect(404);
  });
  it.each([
    'foreign-event',
    'foreign-owner',
    'expired',
    'deleting',
    'scan',
    'missing',
  ])('rejects a %s photo on creation and update', async (state) => {
    const f = fixture();
    const created = (await f.create().expect(201)).body.collection;
    const photo = f.photos[1]!;
    if (state === 'foreign-event') photo.eventId = randomUUID();
    if (state === 'foreign-owner') photo.ownerId = 'another';
    if (state === 'expired') photo.expiresAt = new Date(0).toISOString();
    if (state === 'deleting')
      photo.deletionStartedAt = new Date().toISOString();
    if (state === 'scan') photo.scanId = randomUUID();
    if (state === 'missing') f.records.delete(photo.id);
    await f.create().expect(400);
    await f
      .patch(created.id, {
        title: 'Unsafe edit',
        photoIds: [photo.id],
        version: 1,
      })
      .expect(400);
    const latest = (await f.read(`${f.root}/${created.id}`).expect(200)).body
      .collection;
    expect(latest.unavailableCount).toBe(1);
    expect(latest.photoIds).toContain(photo.id);
    expect(latest.photos.map((p: { id: string }) => p.id)).not.toContain(
      photo.id,
    );
    await f
      .patch(created.id, {
        title: 'Removed unavailable photo',
        photoIds: [f.photos[0]!.id],
        version: 1,
      })
      .expect(200);
  });
  it('prevents concurrent stale updates and enforces the event collection limit', async () => {
    const f = fixture();
    const row = (await f.create().expect(201)).body.collection;
    const changes = await Promise.all(
      ['First', 'Second'].map((title) =>
        f.patch(row.id, { title, photoIds: [f.photos[0]!.id], version: 1 }),
      ),
    );
    expect(changes.map((r) => r.status).sort()).toEqual([200, 409]);
    const template = f.records.get(row.id)!;
    for (let i = 0; i < 48; i++) {
      const copy = { ...template, id: randomUUID() };
      f.records.set(copy.id, copy);
    }
    const creates = await Promise.all([f.create(), f.create()]);
    expect(creates.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await f.read().expect(200)).body.collections).toHaveLength(50);
  });
  it.each([
    { title: '', photoIds: [] },
    { title: 'x'.repeat(101), photoIds: [randomUUID()] },
    {
      title: 'Too many',
      photoIds: Array.from({ length: 101 }, () => randomUUID()),
    },
    { title: 'Spoof', photoIds: [randomUUID()], ownerId: 'another' },
  ])('rejects invalid create payloads: %j', async (body) => {
    await fixture().create(body).expect(400);
  });
  it('event erasure removes its collections and preserves another event collection', async () => {
    const f = fixture();
    const row = (await f.create().expect(201)).body.collection;
    const other = {
      ...f.records.get(row.id)!,
      id: randomUUID(),
      eventId: randomUUID(),
    };
    f.records.set(other.id, other);
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(row.id)).toBe(false);
    expect(f.records.has(other.id)).toBe(true);
  });
});
