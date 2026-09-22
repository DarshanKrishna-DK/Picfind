import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
const origin = 'http://localhost:5173';
function setup() {
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
    { store },
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
describe('photo library isolation and bounded processing, no external calls', () => {
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
