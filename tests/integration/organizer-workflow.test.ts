import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';

const origin = 'http://localhost:5173';
async function fixture() {
  const records = new Map<string, LibraryRecord>();
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      structuredClone(
        [...records.values()].filter(
          (row) => row.ownerId === owner && row.kind === kind,
        ),
      ),
    put: vi.fn(async (row) => {
      records.set(row.id, structuredClone(row));
    }),
    remove: async (id) => {
      records.delete(id);
    },
    upload: vi.fn(async () => {}),
    file: vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/jpeg' },
        }),
    ),
    removeFile: vi.fn(async () => {}),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
        getUser: async (id) => ({
          id,
          name: 'Owner',
          email: 'owner@example.test',
          emailVerified: true,
        }),
      },
    },
    { store, billing: await paidOrganizerBilling(records, 'owner') },
  );
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'event',
    title: 'Wedding',
    visibility: 'link',
    folder: 'Private client folder',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  const photo: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'photo',
    eventId: event.id,
    filename: 'ceremony.jpg',
    createdAt: event.createdAt,
    bytes: 3,
  };
  const selection: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'job',
    purpose: 'selection',
    eventId: event.id,
    selectedIds: [photo.id],
    visitorName: 'Guest',
    note: 'Album cover please',
    createdAt: event.createdAt,
  };
  for (const row of [event, photo, selection]) records.set(row.id, row);
  const path = `/api/events/${event.id}/selections/${selection.id}`;
  const patch = (data: object, user = 'owner') =>
    request(app)
      .patch(path)
      .set('Cookie', `picfind_session=${user}`)
      .set('Origin', origin)
      .send(data);
  const insights = () =>
    request(app)
      .get(`/api/events/${event.id}/insights`)
      .set('Cookie', 'picfind_session=owner');
  return {
    app,
    records,
    store,
    event,
    photo,
    selection,
    path,
    patch,
    insights,
  };
}
const review = {
  reviewStatus: 'in-progress',
  reviewNote: 'Retouch and export',
  version: 0,
};

describe('private event organization', () => {
  it('persists trimmed private folders without exposing them to gallery guests', async () => {
    const { app, event, records } = await fixture();
    const created = await request(app)
      .post('/api/events')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({
        title: 'New event',
        folder: '  Weddings 2026  ',
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      })
      .expect(201);
    expect(records.get(created.body.event.id)?.folder).toBe('Weddings 2026');
    expect(created.body.event.visibility).toBe('private');
    const publicGallery = await request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(publicGallery.body.event.folder).toBeUndefined();
    const library = await request(app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(
      library.body.events.find((row: { id: string }) => row.id === event.id)
        .folder,
    ).toBe(event.folder);
  });
  it('preserves omitted folder/visibility fields and supports clearing a folder', async () => {
    const { app, event, records } = await fixture();
    await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(records.get(event.id)).toMatchObject({
      folder: event.folder,
      visibility: 'link',
    });
    await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ folder: '' })
      .expect(200);
    expect(records.get(event.id)?.folder).toBe('');
  });
  it('validates folder input and protects another organizer events', async () => {
    const { app, event, records } = await fixture();
    for (const folder of ['x'.repeat(81), null, { name: 'Folder' }])
      await request(app)
        .patch(`/api/events/${event.id}`)
        .set('Cookie', 'picfind_session=owner')
        .set('Origin', origin)
        .send({ folder })
        .expect(400);
    await request(app)
      .patch(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .send({ folder: 'Stolen' })
      .expect(404);
    expect(records.get(event.id)?.folder).toBe(event.folder);
  });
});

describe('owner selection review', () => {
  it('loads legacy selections as new without writing a migration', async () => {
    const { insights, selection, photo, store } = await fixture();
    const result = await insights().expect(200);
    expect(result.body.selections[0]).toMatchObject({
      id: selection.id,
      reviewStatus: 'new',
      reviewVersion: 0,
      reviewNote: '',
      reviewedAt: null,
      photos: [{ id: photo.id, filename: photo.filename }],
    });
    expect(store.put).not.toHaveBeenCalled();
  });
  it('saves private reviews, increments versions, and preserves guest input', async () => {
    const { app, patch, insights, selection, event, records } = await fixture();
    const saved = await patch({
      ...review,
      reviewNote: '  Private editing note  ',
    }).expect(200);
    expect(saved.body.review).toMatchObject({
      reviewStatus: 'in-progress',
      reviewNote: 'Private editing note',
      reviewVersion: 1,
    });
    expect(Date.parse(saved.body.review.reviewedAt)).toBeGreaterThan(0);
    expect(records.get(selection.id)).toMatchObject({
      note: selection.note,
      visitorName: selection.visitorName,
      selectedIds: selection.selectedIds,
    });
    expect((await insights()).body.selections[0].reviewNote).toBe(
      'Private editing note',
    );
    const guest = await request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(JSON.stringify(guest.body)).not.toContain('Private editing note');
    const library = await request(app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(library.body.jobs).toEqual([]);
    await patch({ ...review, reviewStatus: 'completed', version: 1 }).expect(
      200,
    );
    await patch({
      ...review,
      reviewStatus: 'new',
      reviewNote: '',
      version: 2,
    }).expect(200);
    expect(records.get(selection.id)).toMatchObject({
      reviewVersion: 3,
      reviewStatus: 'new',
      reviewNote: '',
    });
  });
  it('serializes competing review changes and rejects the stale writer', async () => {
    const { patch, records, selection } = await fixture();
    const results = await Promise.all([
      patch({ ...review, reviewNote: 'First' }),
      patch({ ...review, reviewNote: 'Second' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const accepted = results.find((result) => result.status === 200)!;
    expect(records.get(selection.id)?.reviewNote).toBe(
      accepted.body.review.reviewNote,
    );
    expect(records.get(selection.id)?.reviewVersion).toBe(1);
    expect(
      results.find((result) => result.status === 409)?.body.error.code,
    ).toBe('REVIEW_CHANGED');
  });
  it('rejects anonymous, cross-account and cross-origin review writes', async () => {
    const { app, path, patch, records, selection } = await fixture();
    await request(app)
      .patch(path)
      .set('Origin', origin)
      .send(review)
      .expect(401);
    await patch(review, 'other').expect(404);
    await request(app)
      .patch(path)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://evil.example')
      .send(review)
      .expect(403);
    expect(records.get(selection.id)?.reviewVersion).toBeUndefined();
  });
  it.each(['foreign-owner', 'different-event', 'wrong-kind', 'wrong-purpose'])(
    'rejects a %s selection record',
    async (scenario) => {
      const { patch, records, selection } = await fixture();
      const row = { ...selection };
      if (scenario === 'foreign-owner') row.ownerId = 'other';
      if (scenario === 'different-event') row.eventId = randomUUID();
      if (scenario === 'wrong-kind') row.kind = 'photo';
      if (scenario === 'wrong-purpose') row.purpose = 'usage';
      records.set(row.id, row);
      await patch(review).expect(404);
      expect(records.get(row.id)?.reviewVersion).toBeUndefined();
    },
  );
  it.each([
    { ...review, reviewStatus: 'sent' },
    { ...review, reviewNote: 'x'.repeat(2001) },
    { ...review, version: -1 },
    { ...review, version: 0.5 },
    { ...review, version: '0' },
    { ...review, version: Number.MAX_SAFE_INTEGER },
    { ...review, ownerId: 'other' },
    { reviewStatus: 'new', reviewNote: '' },
  ])('rejects invalid review input %#', async (body) => {
    const { patch, store } = await fixture();
    await patch(body).expect(400);
    expect(store.put).not.toHaveBeenCalled();
  });
  it('rejects malformed selection IDs and unknown rows', async () => {
    const { app, event } = await fixture();
    for (const id of ['bad-id', randomUUID()])
      await request(app)
        .patch(`/api/events/${event.id}/selections/${id}`)
        .set('Cookie', 'picfind_session=owner')
        .set('Origin', origin)
        .send(review)
        .expect(404);
  });
  it('does not advance the version if storage rejects a write', async () => {
    const { patch, store, records, selection } = await fixture();
    vi.mocked(store.put).mockRejectedValueOnce(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Retry later.'),
    );
    await patch(review).expect(503);
    expect(records.get(selection.id)?.reviewVersion).toBeUndefined();
    await patch(review).expect(200);
    expect(records.get(selection.id)?.reviewVersion).toBe(1);
  });
  it('retains selected IDs but omits missing, expired, deleting and foreign-event previews', async () => {
    const { records, photo, event, selection, insights } = await fixture();
    const expired = {
      ...photo,
      id: randomUUID(),
      expiresAt: '2000-01-01T00:00:00.000Z',
    };
    const deleting = {
      ...photo,
      id: randomUUID(),
      deletionStartedAt: new Date().toISOString(),
    };
    const other = { ...photo, id: randomUUID(), eventId: randomUUID() };
    const foreign = {
      ...photo,
      id: randomUUID(),
      ownerId: 'other',
      eventId: event.id,
    };
    for (const row of [expired, deleting, other, foreign])
      records.set(row.id, row);
    const selectedIds = [
      photo.id,
      randomUUID(),
      expired.id,
      deleting.id,
      other.id,
      foreign.id,
    ];
    records.set(selection.id, { ...selection, selectedIds });
    const response = await insights().expect(200);
    expect(response.body.selections[0].photoIds).toEqual(selectedIds);
    expect(response.body.selections[0].photos).toEqual([
      { id: photo.id, filename: photo.filename },
    ]);
    expect(response.body.photos).toBe(1);
  });
  it('rejects guest selection of a photo pending deletion', async () => {
    const { app, event, photo, records } = await fixture();
    records.set(photo.id, {
      ...photo,
      deletionStartedAt: new Date().toISOString(),
    });
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(400);
  });
  it('blocks auxiliary tools once an event begins deletion', async () => {
    const { app, event, records, patch, insights, photo } = await fixture();
    records.set(event.id, {
      ...event,
      deletionStartedAt: new Date().toISOString(),
    });
    await insights().expect(404);
    await patch(review).expect(404);
    await request(app)
      .get(`/api/public/events/${event.id}/access`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
    await request(app)
      .patch(`/api/events/${event.id}/presentation`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ brandingName: 'Studio', accentColor: '#123456' })
      .expect(404);
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(404);
  });
  it('exports private review fields with spreadsheet formula escaping', async () => {
    const { app, patch, event } = await fixture();
    await patch({ ...review, reviewNote: '=HYPERLINK("bad")' }).expect(200);
    const response = await request(app)
      .get(`/api/events/${event.id}/insights?format=csv`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(response.text).toContain('"Private review note"');
    expect(response.text).toContain('"\'=HYPERLINK(""bad"")"');
    expect(response.text).toContain('"in-progress"');
    await request(app)
      .get(`/api/events/${event.id}/insights?format=csv`)
      .expect(401);
  });
  it('removes reviewed selections when their event is deleted', async () => {
    const { app, event, patch, records, selection } = await fixture();
    await patch(review).expect(200);
    await request(app)
      .delete(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(204);
    expect(records.has(selection.id)).toBe(false);
  });
});
