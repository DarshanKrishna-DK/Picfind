import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { ApiError } from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';
import {
  eventAccess,
  membershipInboxId,
} from '../../apps/api/src/event-membership-access.js';

const origin = 'http://localhost:5173';
const moderator = {
  id: 'moderator',
  name: 'Morgan',
  email: 'morgan@example.test',
  emailVerified: true,
};
async function fixture() {
  const rows = new Map<string, LibraryRecord>();
  const billing = await paidOrganizerBilling(rows, 'owner');
  const event = await billing.saveOrganizerEvent(
    'owner',
    randomUUID(),
    {
      title: 'Private collaboration',
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    },
    true,
  );
  const other = await billing.saveOrganizerEvent(
    'owner',
    randomUUID(),
    {
      title: 'Unrelated event',
      expiresAt: event.expiresAt!,
    },
    true,
  );
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(),
    removeFile: vi.fn(),
    file: vi.fn(),
  };
  const lookup = vi.fn(async (email: string) =>
    email === moderator.email ? moderator : null,
  );
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (secret) => ({
          id: secret,
          name: secret,
          email: `${secret}@example.test`,
          emailVerified: true,
        }),
        resolveEventMember: lookup,
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store, billing },
  );
  const invite = () =>
    request(app)
      .post(`/api/events/${event.id}/members`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ email: moderator.email, role: 'moderator' });
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#238a73' },
  })
    .jpeg()
    .toBuffer();
  return { rows, billing, event, other, store, lookup, app, invite, image };
}
describe('event moderator authority', () => {
  it('adds a verified existing account idempotently and discovers only its shared event', async () => {
    const f = await fixture();
    const first = await f.invite().expect(201),
      second = await f.invite().expect(201);
    expect(second.body.member.grantId).toBe(first.body.member.grantId);
    const result = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=moderator')
      .expect(200);
    expect(result.body.events).toHaveLength(1);
    expect(result.body.events[0]).toMatchObject({
      id: f.event.id,
      accessRole: 'moderator',
    });
    expect(result.body.events[0]).not.toHaveProperty('members');
    expect(result.body.photos).toEqual([]);
    expect(result.body.jobs).toEqual([]);
    await request(f.app)
      .get(`/api/events/${f.other.id}/gallery`)
      .set('Cookie', 'picfind_session=moderator')
      .expect(404);
  });
  it('authorizes the owner before account lookup and denies guest or moderator mutations', async () => {
    const f = await fixture();
    await f.invite().expect(201);
    f.lookup.mockClear();
    for (const actor of ['guest', 'moderator']) {
      const cookie = `picfind_session=${actor}`;
      await request(f.app)
        .post(`/api/events/${f.event.id}/members`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send({ email: 'other@example.test', role: 'moderator' })
        .expect(404);
      await request(f.app)
        .delete(`/api/events/${f.event.id}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .expect(404);
      await request(f.app)
        .patch(`/api/events/${f.event.id}`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send({ title: 'Changed' })
        .expect(404);
    }
    expect(f.lookup).not.toHaveBeenCalled();
    await request(f.app)
      .post(`/api/photos?eventId=${f.event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(f.image)
      .expect(404);
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it('stores moderator device uploads under the owner and prevents moderator deletion', async () => {
    const f = await fixture();
    await f.invite().expect(201);
    const reservation = vi.spyOn(f.billing, 'reserveStorage');
    const result = await request(f.app)
      .post(`/api/photos?eventId=${f.event.id}`)
      .set('Cookie', 'picfind_session=moderator')
      .set('X-PicFind-Upload-Actor', 'moderator')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(f.image)
      .expect(201);
    expect(result.body.photo).toMatchObject({
      ownerId: 'owner',
      eventId: f.event.id,
      uploadedBy: 'moderator',
      kind: 'photo',
    });
    expect(reservation.mock.calls[0]?.[0]).toBe('owner');
    expect(reservation.mock.calls[0]?.[4]).toBe('organizer');
    const gallery = await request(f.app)
      .get(`/api/events/${f.event.id}/gallery`)
      .set('Cookie', 'picfind_session=moderator')
      .expect(200);
    expect(gallery.body.photos.map((row: LibraryRecord) => row.id)).toEqual([
      result.body.photo.id,
    ]);
    await request(f.app)
      .delete(`/api/photos/${result.body.photo.id}`)
      .set('Cookie', 'picfind_session=moderator')
      .set('Origin', origin)
      .expect(404);
  });
  it('revocation during object upload prevents publication and cleans up storage', async () => {
    const f = await fixture();
    await f.invite().expect(201);
    vi.mocked(f.store.upload).mockImplementation(async () => {
      await f.billing.revokeEventMember('owner', f.event.id, moderator.id);
    });
    await request(f.app)
      .post(`/api/photos?eventId=${f.event.id}`)
      .set('Cookie', 'picfind_session=moderator')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(f.image)
      .expect(404);
    expect([...f.rows.values()].filter((row) => row.kind === 'photo')).toEqual(
      [],
    );
    expect(f.store.removeFile).toHaveBeenCalledOnce();
  });
  it('keeps owner notes and face metadata out of moderator duplicate acknowledgements', async () => {
    const f = await fixture();
    await f.invite().expect(201);
    const send = () =>
      request(f.app)
        .post(`/api/photos?eventId=${f.event.id}`)
        .set('Cookie', 'picfind_session=moderator')
        .set('Origin', origin)
        .set('Content-Type', 'application/octet-stream')
        .send(f.image);
    const first = await send().expect(201);
    const photo = f.rows.get(first.body.photo.id)!;
    photo.privatePhotoNote = 'Owner-only instructions';
    photo.faceIds = ['private-face-reference'];
    const again = await send().expect(201);
    expect(again.body.photo.id).toBe(photo.id);
    expect(JSON.stringify(again.body)).not.toMatch(
      /Owner-only|private-face|uploadInputDigest|digest/,
    );
    await f.billing.revokeEventMember('owner', f.event.id, moderator.id);
    await send().expect(404);
    expect(f.store.upload).toHaveBeenCalledOnce();
  });
  it('reinvitation changes the grant and stale discovery records cannot authorize access', async () => {
    const f = await fixture();
    const first = await f.invite().expect(201);
    await f.billing.revokeEventMember('owner', f.event.id, moderator.id);
    expect(() => eventAccess(f.rows.get(f.event.id)!, moderator.id)).toThrow();
    const second = await f.invite().expect(201);
    expect(second.body.member.grantId).not.toBe(first.body.member.grantId);
    const inbox = f.rows.get(membershipInboxId(f.event.id, moderator.id))!;
    f.rows.set(inbox.id, {
      ...inbox,
      membershipGrantId: first.body.member.grantId,
    });
    const result = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=moderator')
      .expect(200);
    expect(result.body.events).toEqual([]);
  });
  it('protects the creator and closes moderator access at expiry', async () => {
    const f = await fixture();
    await f.invite().expect(201);
    await expect(
      f.billing.revokeEventMember('owner', f.event.id, 'owner'),
    ).rejects.toMatchObject({ code: 'OWNER_ROLE_PROTECTED' });
    f.rows.set(f.event.id, {
      ...f.rows.get(f.event.id)!,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await request(f.app)
      .get(`/api/events/${f.event.id}/gallery`)
      .set('Cookie', 'picfind_session=moderator')
      .expect(404);
  });
});
