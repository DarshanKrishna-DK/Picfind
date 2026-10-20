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
    title: 'Photo notes',
    createdAt: new Date().toISOString(),
    visibility: 'link',
  };
  const photo: LibraryRecord = {
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    createdAt: new Date().toISOString(),
    filename: 'portrait.jpg',
    bytes: 100,
    faceIds: ['existing-face'],
    indexState: 'ready',
  };
  const records = new Map([
    [event.id, event],
    [photo.id, photo],
  ]);
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
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
  const url = `/api/photos/${photo.id}/private-note`;
  const read = (actor = 'owner') =>
    request(app).get(url).set('Cookie', `picfind_session=${actor}`);
  const save = (text: string, version = 0, actor = 'owner') =>
    request(app)
      .patch(url)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ text, version });
  return { event, photo, records, app, url, read, save };
}

describe('owner-only photo instructions', () => {
  it('persists, reloads and clears notes without changing photo metadata or public projections', async () => {
    const f = fixture();
    expect((await f.read().expect(200)).body).toEqual({
      note: { text: '', version: 0, updatedAt: null },
    });
    const saved = await f.save('  Crop slightly from the left.  ').expect(200);
    expect(saved.body.note).toEqual({
      text: 'Crop slightly from the left.',
      version: 1,
      updatedAt: expect.any(String),
    });
    expect((await f.read().expect(200)).body).toEqual(saved.body);
    expect(f.records.get(f.photo.id)).toMatchObject({
      bytes: 100,
      faceIds: ['existing-face'],
      indexState: 'ready',
    });
    const gallery = await request(f.app)
      .get(`/api/public/events/${f.event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(JSON.stringify(gallery.body)).not.toMatch(
      /privatePhotoNote|Crop slightly/,
    );
    const cleared = await f.save('', 1).expect(200);
    expect(cleared.body.note).toMatchObject({ text: '', version: 2 });
    expect((await f.read().expect(200)).body).toEqual(cleared.body);
  });
  it('requires the photo owner and a trusted mutation origin', async () => {
    const f = fixture();
    await request(f.app).get(f.url).expect(401);
    for (const actor of ['guest', 'moderator', 'other-owner']) {
      await f.read(actor).expect(404);
      await f.save('Unauthorized', 0, actor).expect(404);
    }
    await request(f.app)
      .patch(f.url)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://other.example')
      .send({ text: 'Bad origin', version: 0 })
      .expect(403);
    expect(f.records.get(f.photo.id)?.privatePhotoNote).toBeUndefined();
  });
  it('allows only one concurrent write for a version and preserves the winner', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.save('First draft'),
      f.save('Second draft'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!;
    const loser = results.find((result) => result.status === 409)!;
    expect(loser.body.error.code).toBe('PHOTO_NOTE_CHANGED');
    expect((await f.read().expect(200)).body).toEqual(winner.body);
    await f.save('Stale overwrite', 0).expect(409);
  });
  it.each([
    { text: 'x'.repeat(2001), version: 0 },
    { text: 'note', version: -1 },
    { text: 'note', version: 0.5 },
    { text: 'note', version: Number.MAX_SAFE_INTEGER },
    { text: 'note', version: 0, ownerId: 'another' },
  ])('rejects invalid payloads without writing: %j', async (body) => {
    const f = fixture();
    await request(f.app)
      .patch(f.url)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send(body)
      .expect(400);
    expect(f.records.get(f.photo.id)?.privatePhotoNoteVersion).toBeUndefined();
  });
  it.each([
    'expired',
    'deleting-photo',
    'deleting-event',
    'missing-event',
    'wrong-kind',
  ])('denies read and write when unavailable: %s', async (state) => {
    const f = fixture();
    if (state === 'expired') f.photo.expiresAt = new Date(0).toISOString();
    if (state === 'deleting-photo')
      f.photo.deletionStartedAt = new Date().toISOString();
    if (state === 'deleting-event')
      f.event.deletionStartedAt = new Date().toISOString();
    if (state === 'missing-event') f.records.delete(f.event.id);
    if (state === 'wrong-kind') f.photo.kind = 'job';
    await f.read().expect(404);
    await f.save('Unavailable').expect(404);
  });
});
