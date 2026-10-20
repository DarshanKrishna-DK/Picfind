import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
const origin = 'http://localhost:5173';
function setup(eventIndexMax = 20) {
  const records = new Map<string, LibraryRecord>();
  const files = new Map<string, Uint8Array>();
  const store: LibraryStore = {
    list: async (ownerId, kind) =>
      [...records.values()].filter(
        (row) => row.ownerId === ownerId && row.kind === kind,
      ),
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return structuredClone(row);
    },
    put: async (row) => {
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
    upload: vi.fn(async (id, bytes) => {
      files.set(id, bytes);
    }),
    file: async (id) =>
      new Response(new Uint8Array(files.get(id) ?? []), {
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    removeFile: async (id) => {
      files.delete(id);
    },
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
        getUser: async (secret) => ({
          id: secret,
          name: 'Test account',
          email: 'test@example.test',
          emailVerified: true,
        }),
      },
    },
    { store, eventIndexMax },
  );
  const event = (user = 'owner'): LibraryRecord => ({
    id: randomUUID(),
    ownerId: user,
    kind: 'event',
    title: 'Test event',
    createdAt: new Date().toISOString(),
    visibility: 'private',
    archived: false,
  });
  return { app, store, records, files, event };
}
async function replayFixture(inEvent = false) {
  const f = setup(inEvent ? 1 : 20);
  const event = f.event();
  if (inEvent) f.records.set(event.id, event);
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#234543' },
  })
    .png()
    .toBuffer();
  const send = (
    input = bytes,
    destination = inEvent ? event.id : '',
    actor = 'owner',
  ) =>
    request(f.app)
      .post('/api/photos' + (destination ? `?eventId=${destination}` : ''))
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'original.png')
      .send(input);
  const first = await send().expect(201);
  return {
    ...f,
    event,
    bytes,
    send,
    photo: f.records.get(first.body.photo.id)!,
  };
}
describe('photo library isolation and bounded processing, no external calls', () => {
  it('accepts an upload and replay for the authenticated expected actor', async () => {
    const f = await replayFixture();
    expect(f.store.upload).toHaveBeenCalledOnce();
    const replay = await f
      .send()
      .set('X-PicFind-Upload-Actor', 'owner')
      .expect(201);
    expect(replay.body.photo.id).toBe(f.photo.id);
    expect(f.store.upload).toHaveBeenCalledOnce();
    const bytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#861228' },
    })
      .png()
      .toBuffer();
    const uploaded = await f
      .send(bytes)
      .set('X-PicFind-Upload-Actor', 'owner')
      .expect(201);
    expect(uploaded.body.photo.ownerId).toBe('owner');
    expect(uploaded.body.photo.id).not.toBe(f.photo.id);
    expect(f.store.upload).toHaveBeenCalledTimes(2);
  });
  it('rejects a queued upload when the actual signed-in actor differs from its expected actor', async () => {
    const { app, store, records } = setup();
    const result = await request(app)
      .post('/api/photos')
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .set('X-PicFind-Upload-Actor', 'owner')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not processed'))
      .expect(409);
    expect(result.body.error.code).toBe('UPLOAD_ACCOUNT_CHANGED');
    expect(store.upload).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });
  it('accepts the current actor header without granting access to another owner event', async () => {
    const { app, store, records, event } = setup();
    const destination = event('owner');
    records.set(destination.id, destination);
    await request(app)
      .post(`/api/photos?eventId=${destination.id}`)
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .set('X-PicFind-Upload-Actor', 'other')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not processed'))
      .expect(404);
    expect(store.upload).not.toHaveBeenCalled();
  });
  it('requires authentication and rejects cross-origin writes', async () => {
    const { app } = setup();
    await request(app).get('/api/library').expect(401);
    await request(app)
      .post('/api/events')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://other.example')
      .send({ title: 'Test' })
      .expect(403);
  });
  it('requires organizer accounting even if a client asks to publish immediately', async () => {
    const { app } = setup();
    const response = await request(app)
      .post('/api/events')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ title: 'Test event', visibility: 'link' })
      .expect(402);
    expect(response.body.error.code).toBe('ORGANIZER_PLAN_REQUIRED');
  });
  it('prevents another account from editing or deleting a private event', async () => {
    const { app, records, event } = setup();
    const row = event();
    records.set(row.id, row);
    await request(app)
      .patch(`/api/events/${row.id}`)
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .send({ title: 'Changed' })
      .expect(404);
    await request(app)
      .delete(`/api/events/${row.id}`)
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .expect(404);
    expect(records.get(row.id)?.title).toBe('Test event');
  });
  it('does not reveal private, archived, or expired public events', async () => {
    const { app, records, event } = setup();
    const row = event();
    records.set(row.id, row);
    await request(app)
      .get(`/api/public/events/${row.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
    records.set(row.id, { ...row, visibility: 'link', archived: true });
    await request(app)
      .get(`/api/public/events/${row.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
    records.set(row.id, {
      ...row,
      visibility: 'link',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    await request(app)
      .get(`/api/public/events/${row.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
  });
  it('validates actual image bytes and re-encodes a valid upload', async () => {
    const { app, store, records } = setup();
    await request(app)
      .post('/api/photos')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not an image'))
      .expect(400);
    expect(store.upload).not.toHaveBeenCalled();
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#287f83' },
    })
      .png()
      .toBuffer();
    const response = await request(app)
      .post('/api/photos')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('X-File-Name', 'test.png')
      .set('Content-Type', 'application/octet-stream')
      .send(bytes)
      .expect(201);
    expect(response.body.photo.width).toBe(32);
    expect(response.body.photo.height).toBe(24);
    expect(store.upload).toHaveBeenCalledOnce();
    expect(records.size).toBe(1);
    await request(app)
      .get(`/api/photos/${response.body.photo.id}/file`)
      .set('Cookie', 'picfind_session=other')
      .expect(404);
  });
  it('enforces the 20-photo limit before image processing or storage', async () => {
    const { app, records, store } = setup();
    for (let index = 0; index < 20; index++) {
      const id = randomUUID();
      records.set(id, {
        id,
        ownerId: 'owner',
        kind: 'photo',
        createdAt: new Date().toISOString(),
      });
    }
    const response = await request(app)
      .post('/api/photos')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not processed'))
      .expect(409);
    expect(response.body.error.code).toBe('PHOTO_LIMIT');
    expect(store.upload).not.toHaveBeenCalled();
  });
  it('recovers a byte-identical last-slot upload without creating another object', async () => {
    const { app, records, store } = setup();
    for (let i = 0; i < 19; i++) {
      const id = randomUUID();
      records.set(id, {
        id,
        ownerId: 'owner',
        kind: 'photo',
        createdAt: new Date().toISOString(),
      });
    }
    const bytes = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#143529' },
    })
      .png()
      .toBuffer();
    const send = (name: string) =>
      request(app)
        .post('/api/photos')
        .set('Cookie', 'picfind_session=owner')
        .set('Origin', origin)
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', name)
        .send(bytes);
    const first = await send('first.png').expect(201);
    const again = await send('renamed.png').expect(201);
    expect(again.body.photo.id).toBe(first.body.photo.id);
    expect(again.body.photo.filename).toBe('first.png');
    expect(again.body.photo.expiresAt).toBe(first.body.photo.expiresAt);
    expect(records.size).toBe(20);
    expect(store.upload).toHaveBeenCalledOnce();
  });
  it('replays at the event limit while keeping unknown files behind the quota', async () => {
    const f = await replayFixture(true);
    expect((await f.send().expect(201)).body.photo.id).toBe(f.photo.id);
    const other = await f
      .send(Buffer.from('not decoded at capacity'))
      .expect(409);
    expect(other.body.error.code).toBe('EVENT_PHOTO_LIMIT');
    expect(f.store.upload).toHaveBeenCalledOnce();
  });
  it.each(['expired', 'deleting', 'deleted'])(
    'never replays an %s photo at the library limit',
    async (state) => {
      const f = await replayFixture();
      for (let index = 0; index < 19; index++) {
        const id = randomUUID();
        f.records.set(id, {
          id,
          ownerId: 'owner',
          kind: 'photo',
          createdAt: new Date().toISOString(),
        });
      }
      if (state === 'expired') f.photo.expiresAt = '2000-01-01T00:00:00.000Z';
      if (state === 'deleting')
        f.photo.deletionStartedAt = new Date().toISOString();
      if (state === 'deleted')
        f.photo.deletionCompletedAt = new Date().toISOString();
      await f.send().expect(409);
      expect(f.store.upload).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    'projects safe metadata for raw and legacy optimized duplicate paths (legacy=%s)',
    async (legacy) => {
      const f = await replayFixture();
      const inputDigest = f.photo.uploadInputDigest;
      expect(inputDigest).toMatch(/^[0-9a-f]{64}$/);
      if (legacy) delete f.photo.uploadInputDigest;
      f.photo.privatePhotoNote = 'Private retouch instructions';
      f.photo.faceIds = ['private-face-id'];
      const again = await f.send().expect(201);
      expect(again.body.photo.id).toBe(f.photo.id);
      expect(again.body.photo).not.toHaveProperty('uploadInputDigest');
      expect(again.body.photo).not.toHaveProperty('digest');
      expect(JSON.stringify(again.body)).not.toMatch(
        /Private retouch|private-face/,
      );
      const library = await request(f.app)
        .get('/api/library')
        .set('Cookie', 'picfind_session=owner')
        .expect(200);
      expect(JSON.stringify(library.body)).not.toContain(inputDigest);
      expect(f.store.upload).toHaveBeenCalledOnce();
    },
  );
  it('does not infer an original-input digest for legacy photos at capacity', async () => {
    const f = await replayFixture(true);
    delete f.photo.uploadInputDigest;
    await f.send().expect(409);
    expect(f.photo.uploadInputDigest).toBeUndefined();
  });
  it('keeps identical bytes isolated across event, personal and account scopes', async () => {
    const f = await replayFixture(true);
    const other = { ...f.event, id: randomUUID() };
    f.records.set(other.id, other);
    const second = await f.send(f.bytes, other.id).expect(201);
    const personal = await f.send(f.bytes, '').expect(201);
    const stranger = await f.send(f.bytes, '', 'stranger').expect(201);
    expect(
      new Set([
        f.photo.id,
        second.body.photo.id,
        personal.body.photo.id,
        stranger.body.photo.id,
      ]).size,
    ).toBe(4);
    await f.send(f.bytes, f.event.id, 'stranger').expect(404);
    expect(f.store.upload).toHaveBeenCalledTimes(4);
  });
  it.each(['archived', 'expired', 'deleted'])(
    'denies replay after the event is %s',
    async (state) => {
      const f = await replayFixture(true);
      if (state === 'archived') f.event.archived = true;
      if (state === 'expired') f.event.expiresAt = '2000-01-01T00:00:00.000Z';
      if (state === 'deleted')
        f.event.deletionStartedAt = new Date().toISOString();
      await f.send().expect(state === 'deleted' ? 404 : 409);
      expect(f.store.upload).toHaveBeenCalledOnce();
    },
  );
  it.each(['photo', 'event'])(
    'rechecks changing %s state before acknowledging a replay',
    async (target) => {
      const f = await replayFixture(true);
      const get = f.store.get;
      f.store.get = async (id) => {
        if (id === f.photo.id) {
          if (target === 'photo')
            f.photo.deletionStartedAt = new Date().toISOString();
          else f.event.archived = true;
        }
        return get(id);
      };
      await f.send().expect(409);
      expect(f.store.upload).toHaveBeenCalledOnce();
    },
  );
  it('revokes link access before deleting event photos', async () => {
    const { app, records, files, event } = setup();
    const row = { ...event(), visibility: 'link' as const };
    const photoId = randomUUID();
    records.set(row.id, row);
    records.set(photoId, {
      id: photoId,
      ownerId: 'owner',
      eventId: row.id,
      kind: 'photo',
      createdAt: new Date().toISOString(),
    });
    files.set(photoId, new Uint8Array([1]));
    await request(app)
      .get(`/api/public/events/${row.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    await request(app)
      .delete(`/api/events/${row.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(204);
    expect(records.size).toBe(0);
    expect(files.size).toBe(0);
    await request(app)
      .get(`/api/public/events/${row.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
  });
});
