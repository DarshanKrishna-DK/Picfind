import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { highlightRecordId } from '../../apps/api/src/highlights';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://localhost:5173';
function fixture() {
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    title: 'Private event title',
    visibility: 'private',
    createdAt: new Date().toISOString(),
  };
  const photos: LibraryRecord[] = [0, 1, 2].map((index) => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    filename: `Photo-${index}.jpg`,
    createdAt: event.createdAt,
    bytes: 4,
    width: 2,
    height: 2,
    privatePhotoNote: 'Private note',
    faceIds: ['private-face'],
    attribution: {
      name: 'Published photographer',
      website: '',
      published: true,
      version: 1,
      updatedAt: event.createdAt,
    },
  }));
  const records = new Map([event, ...photos].map((row) => [row.id, row]));
  const store: LibraryStore = {
    get: async (key) => {
      const row = records.get(key);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Already exists.');
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(),
    upload: vi.fn(),
    removeFile: vi.fn(),
    file: vi.fn(async () => new Response(new Uint8Array([255, 216, 255, 217]))),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (key) => ({
          id: key,
          name: key,
          email: `${key}@example.test`,
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store },
  );
  const url = `/api/events/${event.id}/highlights`,
    publicUrl = `/api/public/highlights/${event.id}`;
  const read = (path = url, actor = 'owner') =>
    request(app).get(path).set('Cookie', `picfind_session=${actor}`);
  const fields = {
    title: 'Opening moments',
    photoIds: photos.slice(0, 2).map((photo) => photo.id),
    published: false,
    version: 0,
  };
  const save = (changes: object = {}, actor = 'owner') =>
    request(app)
      .patch(url)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ ...fields, ...changes });
  const file = (photoId = photos[0]!.id) =>
    read(`${publicUrl}/photos/${photoId}`, 'guest');
  const stored = () => records.get(highlightRecordId(event.id))!;
  return {
    app,
    event,
    photos,
    records,
    store,
    url,
    publicUrl,
    fields,
    read,
    save,
    file,
    stored,
  };
}

describe('explicit curated highlights and scoped delivery', () => {
  it('persists an ordered private draft, publishes only its selected projection and withdraws', async () => {
    const f = fixture();
    expect((await f.read().expect(200)).body.highlights).toMatchObject({
      version: 0,
      published: false,
      photoIds: [],
    });
    await f.save().expect(200);
    await f.read(f.publicUrl, 'guest').expect(404);
    const ids = [...f.fields.photoIds].reverse();
    await f.save({ photoIds: ids, published: true, version: 1 }).expect(200);
    const publicResponse = await f.read(f.publicUrl, 'guest').expect(200);
    expect(publicResponse.headers['cache-control']).toBe('no-store');
    expect(Object.keys(publicResponse.body).sort()).toEqual([
      'coverId',
      'photos',
      'title',
    ]);
    expect(publicResponse.body.coverId).toBe(ids[0]);
    expect(
      publicResponse.body.photos.map((photo: { id: string }) => photo.id),
    ).toEqual(ids);
    expect(publicResponse.body.photos[0]).toEqual({
      id: ids[0],
      filename: 'Photo-1.jpg',
      createdAt: f.event.createdAt,
      width: 2,
      height: 2,
      bytes: 4,
      credit: { name: 'Published photographer', website: '' },
    });
    await f.read(`/api/public/events/${f.event.id}`, 'guest').expect(404);
    expect(f.event.visibility).toBe('private');
    expect((await f.read('/api/library').expect(200)).body.jobs).toEqual([]);
    await f
      .file()
      .expect(200)
      .expect('Content-Type', /image\/jpeg/);
    await f.file(f.photos[2]!.id).expect(404);
    await f.read(`/api/photos/${f.photos[0]!.id}/file`, 'guest').expect(404);
    await f.save({ photoIds: ids, published: false, version: 2 }).expect(200);
    await f.file().expect(404);
    await f.read(f.publicUrl, 'guest').expect(404);
  });
  it.each(['guest', 'moderator', 'other'])(
    'denies owner editor access to %s',
    async (actor) => {
      const f = fixture();
      f.event.members = [
        {
          userId: actor,
          role: 'moderator',
          grantId: randomUUID(),
          addedAt: f.event.createdAt,
        },
      ];
      await f.read(f.url, actor).expect(404);
      await f.save({}, actor).expect(404);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('requires authentication and trusted write origin', async () => {
    const f = fixture();
    await request(f.app).get(f.publicUrl).expect(401);
    await request(f.app)
      .get(`${f.publicUrl}/photos/${f.photos[0]!.id}`)
      .expect(401);
    await request(f.app).get(f.url).expect(401);
    await request(f.app)
      .patch(f.url)
      .set('Cookie', 'picfind_session=owner')
      .send(f.fields)
      .expect(403);
    await request(f.app)
      .patch(f.url)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://other.test')
      .send(f.fields)
      .expect(403);
  });
  it('recovers only an immediate exact retry and rejects stale updates', async () => {
    const f = fixture();
    const first = (await f.save().expect(200)).body.highlights;
    const createdAt = f.stored().createdAt;
    expect((await f.save().expect(200)).body.highlights).toEqual(first);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    await f.save({ title: 'Other title' }).expect(409);
    await f.save({ title: 'Other title', version: 1 }).expect(200);
    expect(f.stored().createdAt).toBe(createdAt);
    await f.save({ version: 2 }).expect(200);
    await f.save().expect(409);
  });
  it.each([
    { title: '' },
    { title: 'a'.repeat(101) },
    { photoIds: ['invalid'] },
    { photoIds: Array.from({ length: 101 }, () => randomUUID()) },
    { photoIds: [], published: true },
    { version: -1 },
    { version: 0.5 },
    { version: Number.MAX_SAFE_INTEGER },
    { published: 'yes' },
    { extra: true },
  ])('rejects invalid fields %j', async (changes) => {
    const f = fixture();
    await f.save(changes).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('rejects duplicate IDs and photos outside the event', async () => {
    const f = fixture();
    await f.save({ photoIds: [f.photos[0]!.id, f.photos[0]!.id] }).expect(400);
    f.photos[0]!.eventId = randomUUID();
    await f.save().expect(400);
    f.photos[0]!.eventId = f.event.id;
    f.photos[0]!.ownerId = 'other';
    await f.save().expect(400);
  });
  it.each(['scan', 'deleted', 'expired', 'completed'] as const)(
    'rejects unavailable %s photo on save and delivery',
    async (reason) => {
      const f = fixture();
      await f.save({ published: true }).expect(200);
      if (reason === 'scan') f.photos[0]!.scanId = randomUUID();
      if (reason === 'deleted')
        f.photos[0]!.deletionStartedAt = f.event.createdAt;
      if (reason === 'completed')
        f.photos[0]!.deletionCompletedAt = f.event.createdAt;
      if (reason === 'expired')
        f.photos[0]!.expiresAt = '2000-01-01T00:00:00.000Z';
      expect((await f.read().expect(200)).body.unavailableIds).toEqual([
        f.photos[0]!.id,
      ]);
      const shown = (await f.read(f.publicUrl).expect(200)).body;
      expect(shown.coverId).toBe(f.photos[1]!.id);
      expect(shown.photos).toHaveLength(1);
      await f.file().expect(404);
      await f
        .save({ title: 'Updated', published: true, version: 1 })
        .expect(400);
      await f.save({ published: false, version: 1 }).expect(200);
    },
  );
  it.each(['archived', 'expired', 'invalid expiry'] as const)(
    'denies publication and access for %s events while allowing withdrawal',
    async (reason) => {
      const f = fixture();
      await f.save({ published: true }).expect(200);
      if (reason === 'archived') f.event.archived = true;
      else
        f.event.expiresAt =
          reason === 'expired' ? '2000-01-01T00:00:00.000Z' : 'invalid';
      await f.read(f.publicUrl).expect(404);
      await f.file().expect(404);
      await f.save({ published: true, version: 1 }).expect(409);
      await f.save({ published: false, version: 1 }).expect(200);
    },
  );
  it.each(['owner', 'deleted', 'wrong kind'])(
    'denies changed %s parent',
    async (change) => {
      const f = fixture();
      await f.save({ published: true }).expect(200);
      if (change === 'owner') f.event.ownerId = 'other';
      if (change === 'deleted') f.event.deletionStartedAt = f.event.createdAt;
      if (change === 'wrong kind') f.event.kind = 'photo';
      await f.read().expect(404);
      await f.read(f.publicUrl).expect(404);
      await f.file().expect(404);
    },
  );
  it('fails closed for corrupt or colliding records without overwriting them', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    f.stored().highlights!.version = -1;
    await f.read().expect(503);
    await f.read(f.publicUrl).expect(503);
    await f.save().expect(503);
    f.stored().purpose = 'selection';
    await f.read().expect(404);
    await f.save().expect(404);
    expect(f.store.put).toHaveBeenCalledTimes(1);
  });
  it('does not treat a storage outage as an absent draft', async () => {
    const f = fixture(),
      get = f.store.get;
    f.store.get = async (key) => {
      if (key === highlightRecordId(f.event.id))
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Unavailable.');
      return get(key);
    };
    await f.save().expect(503);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('never treats stored version zero as the absent editable draft', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    f.stored().highlights!.version = 0;
    await f.read().expect(503);
    await f.read(f.publicUrl, 'guest').expect(503);
    await f.save({ title: 'Attempted replacement', version: 0 }).expect(503);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    expect(f.stored().highlights!.title).toBe(f.fields.title);
  });
  it.each(['withdrawn', 'removed', 'owner changed'])(
    'denies %s highlights after image bytes are loaded',
    async (change) => {
      const f = fixture();
      await f.save({ published: true }).expect(200);
      f.store.file = vi.fn(async () => {
        if (change === 'withdrawn') f.stored().highlights!.published = false;
        if (change === 'removed')
          f.stored().highlights!.photoIds = [f.photos[1]!.id];
        if (change === 'owner changed') f.stored().ownerId = 'other';
        return new Response(new Uint8Array([255, 216, 255, 217]));
      });
      const response = await f.file().expect(404);
      expect(response.headers['x-picfind-attribution']).toBeUndefined();
    },
  );
  it('authorizes HEAD without reading bytes and denies an unselected HEAD', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    await request(f.app)
      .head(`${f.publicUrl}/photos/${f.photos[0]!.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200)
      .expect('Content-Length', '4');
    await request(f.app)
      .head(`${f.publicUrl}/photos/${f.photos[2]!.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it('rejects publication changing during the selected photo read', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    const get = f.store.get;
    f.store.get = async (key) => {
      const row = await get(key);
      if (key === f.photos[0]!.id) f.stored().highlights!.published = false;
      return row;
    };
    await f.read(f.publicUrl).expect(404);
  });
  it('preserves a concurrent update discovered during the final save read', async () => {
    const f = fixture();
    await f.save().expect(200);
    const get = f.store.get;
    let reads = 0;
    f.store.get = async (key) => {
      if (key === highlightRecordId(f.event.id) && ++reads === 2) {
        f.stored().highlights!.title = 'Concurrent title';
        f.stored().highlights!.version++;
      }
      return get(key);
    };
    await f.save({ title: 'Losing title', version: 1 }).expect(409);
    expect(f.stored().highlights!.title).toBe('Concurrent title');
  });
  it('does not publish when the event closes during final photo validation', async () => {
    const f = fixture(),
      get = f.store.get;
    let reads = 0;
    f.store.get = async (key) => {
      const row = await get(key);
      if (key === f.photos[0]!.id && ++reads === 2) f.event.archived = true;
      return row;
    };
    await f.save({ published: true }).expect(409);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('reads only selected photos, omits missing records and propagates storage failure', async () => {
    const f = fixture();
    f.store.list = vi.fn(async () => {
      throw new Error('Owner-wide listing is not allowed here.');
    });
    await f.save({ published: true }).expect(200);
    f.records.delete(f.photos[0]!.id);
    expect((await f.read(f.publicUrl).expect(200)).body.photos).toHaveLength(1);
    const get = f.store.get;
    f.store.get = async (key) => {
      if (key === f.photos[1]!.id)
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Unavailable.');
      return get(key);
    };
    await f.read(f.publicUrl).expect(503);
    expect(f.store.list).not.toHaveBeenCalled();
  });
});
