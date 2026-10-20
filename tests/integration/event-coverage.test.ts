import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { coverageRecordId } from '../../apps/api/src/event-coverage';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://localhost:5173';
function fixture() {
  const now = new Date().toISOString();
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    title: 'Private wedding',
    visibility: 'private',
    createdAt: now,
  };
  const photos: LibraryRecord[] = [0, 1, 2].map((index) => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    filename: `Photo-${index}.jpg`,
    createdAt: now,
    privatePhotoNote: 'Unrelated private note',
    faceIds: [],
  }));
  const records = new Map([event, ...photos].map((row) => [row.id, row]));
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (actor, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row, createOnly) => {
      if (createOnly && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(async (id) => {
      records.delete(id);
    }),
    file: vi.fn(),
    upload: vi.fn(),
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
  const url = `/api/events/${event.id}/coverage`;
  const items = [
    {
      id: randomUUID(),
      label: 'Family portraits',
      target: 2,
      note: 'Private shot instructions',
      photoIds: [photos[0]!.id],
    },
  ];
  const read = (actor = 'owner') =>
    request(app).get(url).set('Cookie', `picfind_session=${actor}`);
  const save = (changes: object = {}, actor = 'owner') =>
    request(app)
      .put(url)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ version: 0, items, ...changes });
  const stored = () => records.get(coverageRecordId(event.id))!;
  return { app, event, photos, records, store, url, items, read, save, stored };
}
describe('owner-only event coverage planning', () => {
  it('persists a bounded private plan and returns only explicit identity/availability fields', async () => {
    const f = fixture();
    expect((await f.read().expect(200)).body.plan).toEqual({
      version: 0,
      updatedAt: null,
      items: [],
    });
    const saved = await f.save().expect(200);
    expect(saved.body).toMatchObject({
      accountId: 'owner',
      eventId: f.event.id,
      editable: true,
      availableIds: [f.photos[0]!.id],
      plan: { version: 1, items: f.items },
    });
    expect(Object.keys(saved.body).sort()).toEqual([
      'accountId',
      'availableIds',
      'editable',
      'eventId',
      'plan',
    ]);
    expect(JSON.stringify(saved.body)).not.toContain('Unrelated private note');
    expect(f.stored()).toMatchObject({
      ownerId: 'owner',
      eventId: f.event.id,
      purpose: 'event-coverage',
    });
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(JSON.stringify(library.body)).not.toContain(
      'Private shot instructions',
    );
  });
  it('enforces sessions, same origin and account headers without trusting spoofed identity', async () => {
    const f = fixture();
    await request(f.app)
      .get(f.url)
      .set('X-PicFind-Coverage-Actor', 'owner')
      .expect(401);
    await f.read('other').set('X-PicFind-Coverage-Actor', 'owner').expect(403);
    await f.read().set('X-PicFind-Coverage-Actor', 'other').expect(403);
    await f.save().set('Origin', 'https://evil.example').expect(403);
    await f.save().set('X-PicFind-Coverage-Actor', 'other').expect(403);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each(['guest', 'moderator', 'other'])(
    'denies %s access and offers no public endpoint',
    async (actor) => {
      const f = fixture();
      f.event.members = [
        {
          userId: 'moderator',
          role: 'moderator',
          grantId: randomUUID(),
          addedAt: f.event.createdAt,
        },
      ];
      await f.read(actor).expect(404);
      await f.save({}, actor).expect(404);
      await request(f.app)
        .get(`/api/public/events/${f.event.id}/coverage`)
        .set('Cookie', 'picfind_session=guest')
        .expect(404);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('serializes conflicting writes and permits immediate exact retry without another write', async () => {
    const f = fixture();
    const first = await f.save().expect(200);
    expect((await f.save().expect(200)).body.plan).toEqual(first.body.plan);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    const responses = await Promise.all([
      f.save({ version: 1, items: [{ ...f.items[0], label: 'One edit' }] }),
      f.save({ version: 1, items: [{ ...f.items[0], label: 'Other edit' }] }),
    ]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(f.stored().coverage!.version).toBe(2);
    await f.save().expect(409);
  });
  it.each([
    'foreign',
    'event',
    'scan',
    'expired',
    'deleting',
    'deleted',
    'missing',
  ])('rejects new %s photo assignments', async (reason) => {
    const f = fixture(),
      photo = f.photos[0]!;
    if (reason === 'foreign') photo.ownerId = 'other';
    if (reason === 'event') photo.eventId = randomUUID();
    if (reason === 'scan') photo.scanId = randomUUID();
    if (reason === 'expired') photo.expiresAt = '2000-01-01T00:00:00.000Z';
    if (reason === 'deleting') photo.deletionStartedAt = f.event.createdAt;
    if (reason === 'deleted') photo.deletionCompletedAt = f.event.createdAt;
    if (reason === 'missing') f.records.delete(photo.id);
    await f.save().expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('keeps unavailable references without counting them and prevents moving them into a new category', async () => {
    const f = fixture();
    await f.save().expect(200);
    f.records.delete(f.photos[0]!.id);
    expect((await f.read().expect(200)).body.availableIds).toEqual([]);
    await f
      .save({
        version: 1,
        items: [{ ...f.items[0], note: 'Updated instructions' }],
      })
      .expect(200);
    await f
      .save({ version: 2, items: [{ ...f.items[0], id: randomUUID() }] })
      .expect(400);
    await f
      .save({ version: 2, items: [{ ...f.items[0], photoIds: [] }] })
      .expect(200);
    expect(f.stored().coverage!.items[0]!.photoIds).toEqual([]);
  });
  it.each(['event', 'photo'])(
    'rechecks %s ownership before writing',
    async (kind) => {
      const f = fixture(),
        get = f.store.get,
        watched = kind === 'event' ? f.event.id : f.photos[0]!.id;
      let count = 0;
      f.store.get = async (id) => {
        const row = await get(id);
        if (id === watched && ++count === 2) row.ownerId = 'other';
        return row;
      };
      await f.save().expect(kind === 'event' ? 404 : 400);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('rechecks event ownership after snapshot reads and detects an intervening plan write', async () => {
    const f = fixture();
    await f.save().expect(200);
    const get = f.store.get;
    let count = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.event.id && ++count === 2) row.ownerId = 'other';
      return row;
    };
    await f.read().expect(404);
    count = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === coverageRecordId(f.event.id) && ++count === 2)
        row.coverage!.version++;
      return row;
    };
    await f
      .save({ version: 1, items: [{ ...f.items[0], label: 'Changed' }] })
      .expect(409);
    expect(f.store.put).toHaveBeenCalledTimes(1);
  });
  it.each(['archived', 'expired'])(
    'retains %s plan reading but rejects edits',
    async (state) => {
      const f = fixture();
      await f.save().expect(200);
      if (state === 'archived') f.event.archived = true;
      else f.event.expiresAt = '2000-01-01T00:00:00.000Z';
      expect((await f.read().expect(200)).body.editable).toBe(false);
      await f.save({ version: 1, items: [] }).expect(409);
    },
  );
  it('fails closed on corrupt saved metadata, wrong scope and invalid request fields', async () => {
    const f = fixture();
    await f.save({ extra: true }).expect(400);
    await f.save({ version: Number.MAX_SAFE_INTEGER }).expect(400);
    await f.save().expect(200);
    f.stored().coverage!.items[0]!.target = 0;
    await f.read().expect(503);
    await f.save({ version: 1 }).expect(503);
    f.stored().ownerId = 'other';
    await f.read().expect(404);
  });
  it('preserves nondecreasing record times on clock rollback and clears without deleting photos', async () => {
    const f = fixture();
    await f.save().expect(200);
    const prior = f.stored().coverage!.updatedAt;
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(prior) - 60_000);
    try {
      await f.save({ version: 1, items: [] }).expect(200);
      expect(f.stored().coverage!.updatedAt).toBe(prior);
      expect(f.photos.every((photo) => f.records.has(photo.id))).toBe(true);
      expect(f.store.removeFile).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('includes the private plan in confirmed event removal', async () => {
    const f = fixture();
    await f.save().expect(200);
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(coverageRecordId(f.event.id))).toBe(false);
  });
});
