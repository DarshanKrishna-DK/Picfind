import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { ATTRIBUTION_HEADER } from '../../packages/shared/src/photo-attribution';

const origin = 'http://localhost:5173';
const fields = {
  name: 'Asha Photography',
  website: 'https://example.test/portfolio',
  published: false,
};
function fixture() {
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    title: 'Credit test',
    visibility: 'link',
    createdAt: new Date().toISOString(),
  };
  const photo: LibraryRecord = {
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    filename: 'portrait.jpg',
    createdAt: event.createdAt,
    bytes: 4,
    digest: 'original-digest',
    privatePhotoNote: 'Private owner instructions',
    faceIds: ['face-reference'],
  };
  const rows = new Map([
    [event.id, event],
    [photo.id, photo],
  ]);
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row) => {
      rows.set(row.id, structuredClone(row));
    }),
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(),
    file: vi.fn(async () => new Response(new Uint8Array([255, 216, 255, 217]))),
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
  const url = `/api/photos/${photo.id}/attribution`;
  const read = (actor = 'owner') =>
    request(app).get(url).set('Cookie', `picfind_session=${actor}`);
  const save = (changes: object = {}, actor = 'owner') =>
    request(app)
      .patch(url)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ ...fields, version: 0, ...changes });
  const gallery = () =>
    request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest');
  const file = () =>
    request(app)
      .get(`/api/public/events/${event.id}/photos/${photo.id}`)
      .set('Cookie', 'picfind_session=guest');
  return { app, event, photo, rows, store, url, read, save, gallery, file };
}
describe('owner controlled photo attribution and current delivery metadata', () => {
  it('persists draft, publishes and withdraws without changing image or private metadata', async () => {
    const f = fixture();
    expect((await f.read().expect(200)).body.attribution).toEqual({
      name: '',
      website: '',
      published: false,
      version: 0,
      updatedAt: null,
    });
    await f.save().expect(200);
    expect((await f.read().expect(200)).body.attribution).toMatchObject({
      ...fields,
      version: 1,
    });
    expect((await f.gallery().expect(200)).body.photos[0]).not.toHaveProperty(
      'credit',
    );
    expect(
      (await f.file().expect(200)).headers[ATTRIBUTION_HEADER.toLowerCase()],
    ).toBeUndefined();
    await f.save({ published: true, version: 1 }).expect(200);
    const gallery = await f.gallery().expect(200);
    expect(gallery.body.photos[0].credit).toEqual({
      name: fields.name,
      website: fields.website,
    });
    expect(JSON.stringify(gallery.body)).not.toMatch(
      /Private owner|face-reference|attribution|updatedAt/,
    );
    const delivered = await f.file().expect(200);
    expect(
      JSON.parse(
        decodeURIComponent(
          delivered.headers[ATTRIBUTION_HEADER.toLowerCase()]!,
        ),
      ),
    ).toEqual(gallery.body.photos[0].credit);
    const owner = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(owner.body.photos[0]).not.toHaveProperty('attribution');
    expect(owner.body.photos[0].credit).toEqual(gallery.body.photos[0].credit);
    await f
      .save({ version: 2, name: '', website: '', published: false })
      .expect(200);
    expect((await f.gallery().expect(200)).body.photos[0]).not.toHaveProperty(
      'credit',
    );
    expect(
      (await f.file().expect(200)).headers[ATTRIBUTION_HEADER.toLowerCase()],
    ).toBeUndefined();
    expect(f.rows.get(f.photo.id)).toMatchObject({
      bytes: 4,
      digest: 'original-digest',
      privatePhotoNote: 'Private owner instructions',
      faceIds: ['face-reference'],
    });
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it.each(['guest', 'moderator', 'other'])(
    'denies credit reads and writes to %s',
    async (actor) => {
      const f = fixture();
      await f.read(actor).expect(404);
      await f.save({}, actor).expect(404);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('requires authentication and the expected write origin', async () => {
    const f = fixture();
    await request(f.app).get(f.url).expect(401);
    await request(f.app)
      .patch(f.url)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://other.test')
      .send({ ...fields, version: 0 })
      .expect(403);
  });
  it('makes immediate exact retries idempotent but rejects stale and intervening edits', async () => {
    const f = fixture();
    const first = await f.save().expect(200);
    expect((await f.save().expect(200)).body).toEqual(first.body);
    expect(f.store.put).toHaveBeenCalledOnce();
    await f.save({ name: 'Different', version: 0 }).expect(409);
    await f.save({ name: 'Another photographer', version: 1 }).expect(200);
    await f.save({ version: 2 }).expect(200);
    await f.save().expect(409);
    expect((await f.read().expect(200)).body.attribution.version).toBe(3);
  });
  it.each([
    { name: '', published: true },
    { name: 'x'.repeat(101) },
    { name: 'Name\nInjected' },
    { name: '\ud800' },
    { website: 'javascript:alert(1)' },
    { website: 'http://example.test' },
    { website: 'https://user:secret@example.test' },
    { website: 'https://example.test/' + 'x'.repeat(512) },
    { version: -1 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER },
    { published: 'true' },
    { extra: 'not permitted' },
  ])('rejects invalid attribution input %j', async (input) => {
    const f = fixture();
    await f.save(input).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'expired', 'wrong-owner', 'wrong-kind'])(
    'rejects a %s photo',
    async (state) => {
      const f = fixture();
      if (state === 'deleted')
        f.photo.deletionStartedAt = new Date().toISOString();
      if (state === 'expired') f.photo.expiresAt = '2000-01-01T00:00:00.000Z';
      if (state === 'wrong-owner') f.photo.ownerId = 'other';
      if (state === 'wrong-kind') f.photo.kind = 'job';
      await f.read().expect(404);
      await f.save().expect(404);
    },
  );
  it('allows withdrawal in an archived event but denies publishing there', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    f.event.archived = true;
    await f.read().expect(200);
    await f.save({ published: true, name: 'Updated', version: 1 }).expect(409);
    await f.save({ published: false, version: 1 }).expect(200);
  });
  it('denies owner attribution access when the parent event was removed or changed owner', async () => {
    const f = fixture();
    f.event.ownerId = 'other';
    await f.read().expect(404);
    await f.save().expect(404);
    f.rows.delete(f.event.id);
    await f.read().expect(404);
  });
  it('omits corrupt stored credit publicly and refuses to overwrite it', async () => {
    const f = fixture();
    f.photo.attribution = {
      ...fields,
      published: true,
      version: -1,
      updatedAt: 'invalid',
    };
    await f.read().expect(503);
    await f.save().expect(503);
    expect((await f.gallery().expect(200)).body.photos[0]).not.toHaveProperty(
      'credit',
    );
    expect(
      (await f.file().expect(200)).headers[ATTRIBUTION_HEADER.toLowerCase()],
    ).toBeUndefined();
  });
  it('does not attach withdrawn credit from an earlier gallery or file lookup', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    f.store.file = vi.fn(async () => {
      f.rows.get(f.photo.id)!.attribution!.published = false;
      return new Response(new Uint8Array([255, 216, 255, 217]));
    });
    expect(
      (await f.file().expect(200)).headers[ATTRIBUTION_HEADER.toLowerCase()],
    ).toBeUndefined();
  });
  it.each(['owner', 'digest', 'deleted'])(
    'refuses delivery if the photo %s changes while bytes are read',
    async (change) => {
      const f = fixture();
      await f.save({ published: true }).expect(200);
      f.store.file = vi.fn(async () => {
        const row = f.rows.get(f.photo.id)!;
        if (change === 'owner') row.ownerId = 'other';
        if (change === 'digest') row.digest = 'replacement';
        if (change === 'deleted')
          row.deletionStartedAt = new Date().toISOString();
        return new Response(new Uint8Array([255, 216, 255, 217]));
      });
      const response = await f.file().expect(404);
      expect(
        response.headers[ATTRIBUTION_HEADER.toLowerCase()],
      ).toBeUndefined();
    },
  );
  it('returns the same published credit for authorized HEAD without fetching image bytes', async () => {
    const f = fixture();
    await f.save({ published: true }).expect(200);
    const response = await request(f.app)
      .head(`/api/public/events/${f.event.id}/photos/${f.photo.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(response.headers[ATTRIBUTION_HEADER.toLowerCase()]).toBeTruthy();
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it('detects credit changing during the last save read and preserves the other update', async () => {
    const f = fixture();
    const get = f.store.get;
    let reads = 0;
    f.store.get = async (id) => {
      if (id === f.photo.id && ++reads === 2)
        f.rows.get(id)!.attribution = {
          ...fields,
          name: 'Concurrent',
          version: 1,
          updatedAt: new Date().toISOString(),
        };
      return get(id);
    };
    await f.save().expect(409);
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.rows.get(f.photo.id)!.attribution!.name).toBe('Concurrent');
  });
});
