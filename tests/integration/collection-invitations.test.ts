import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError, type AuthUser } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://localhost:5173';
function fixture() {
  const now = new Date().toISOString();
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    createdAt: now,
    title: 'Private wedding',
    visibility: 'private',
    passcodeHash: 'private-hash',
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    members: [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: now,
      },
    ],
  };
  const photos: LibraryRecord[] = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: 'owner',
    eventId: event.id,
    createdAt: now,
    filename: 'same.jpg',
    bytes: 3,
    width: 80,
    height: 60,
    privatePhotoNote: 'Private instructions',
    faceIds: ['private-face'],
  }));
  const collection: LibraryRecord = {
    id: randomUUID(),
    kind: 'job',
    purpose: 'proofing-collection',
    ownerId: 'owner',
    eventId: event.id,
    title: 'Album',
    selectedIds: [photos[0]!.id],
    collectionVersion: 1,
    createdAt: now,
  };
  const records = new Map(
    [event, collection, ...photos].map((row) => [row.id, row]),
  );
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
    removeFile: vi.fn(),
    file: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  };
  const resolve = vi.fn(async (email: string): Promise<AuthUser | null> => ({
    id: email.split('@')[0]!,
    name: 'Client',
    email,
    emailVerified: true,
  }));
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          email: `${id}@example.test`,
          name: id,
          emailVerified: true,
        }),
        resolveEventMember: resolve,
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store },
  );
  const root = `/api/events/${event.id}/proofing-collections/${collection.id}/invitations`;
  const create = (
    body: object = { email: 'client@example.test', days: 7 },
    actor = 'owner',
  ) =>
    request(app)
      .post(root)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin)
      .send(body);
  const read = (path: string, actor = 'client') =>
    request(app).get(path).set('Cookie', `picfind_session=${actor}`);
  const revoke = (invitationId: string, actor = 'owner') =>
    request(app)
      .delete(`${root}/${invitationId}`)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin);
  const path = (invitationId: string) =>
    `/api/proofing-invitations/${invitationId}`;
  return {
    app,
    event,
    photos,
    collection,
    records,
    store,
    resolve,
    root,
    create,
    read,
    revoke,
    path,
  };
}

describe('account-bound collection invitations', () => {
  it('persists a capped invitation, projects only selected photos and revokes future metadata and media access', async () => {
    const f = fixture();
    const invitation = (await f.create().expect(201)).body.invitation;
    expect(invitation).toEqual({
      id: expect.any(String),
      email: 'client@example.test',
      createdAt: expect.any(String),
      expiresAt: f.event.expiresAt,
      revokedAt: null,
    });
    expect(
      (await f.read(f.root, 'owner').expect(200)).body.invitations,
    ).toEqual([invitation]);
    const response = await f.read(f.path(invitation.id)).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      title: 'Album',
      eventTitle: 'Private wedding',
      expiresAt: f.event.expiresAt,
      photos: [
        { id: f.photos[0]!.id, filename: 'same.jpg', width: 80, height: 60 },
      ],
    });
    const image = `${f.path(invitation.id)}/photos/${f.photos[0]!.id}`;
    await f
      .read(image)
      .expect(200)
      .expect('Content-Type', /image\/jpeg/);
    await f
      .read(`${f.path(invitation.id)}/photos/${f.photos[1]!.id}`)
      .expect(404);
    await f.read(`/api/photos/${f.photos[0]!.id}/file`).expect(404);
    await f.read(`/api/events/${f.event.id}/gallery`).expect(404);
    await f.revoke(invitation.id).expect(204);
    const revokedAt = f.records.get(invitation.id)!.invitationRevokedAt;
    await f.revoke(invitation.id).expect(204);
    expect(f.records.get(invitation.id)!.invitationRevokedAt).toBe(revokedAt);
    await f.read(f.path(invitation.id)).expect(404);
    await f.read(image).expect(404);
    expect(f.store.file).toHaveBeenCalledTimes(1);
    expect(f.records.get(f.collection.id)).toEqual(f.collection);
    expect(f.event.members).toHaveLength(1);
  });
  it('denies unauthenticated, forwarded-link, moderator and cross-owner access', async () => {
    const f = fixture();
    const invitation = (await f.create().expect(201)).body.invitation;
    await request(f.app).get(f.path(invitation.id)).expect(401);
    await request(f.app)
      .post(f.root)
      .set('Origin', origin)
      .send({})
      .expect(401);
    for (const actor of ['other-client', 'moderator', 'owner']) {
      await f.read(f.path(invitation.id), actor).expect(404);
      await f
        .read(`${f.path(invitation.id)}/photos/${f.photos[0]!.id}`, actor)
        .expect(404);
    }
    for (const actor of ['client', 'moderator', 'other-owner']) {
      await f.read(f.root, actor).expect(404);
      await f
        .create({ email: 'third@example.test', days: 7 }, actor)
        .expect(404);
      await f.revoke(invitation.id, actor).expect(404);
    }
    expect(f.store.file).not.toHaveBeenCalled();
    await request(f.app)
      .post(f.root)
      .set('Cookie', 'picfind_session=owner')
      .send({})
      .expect(403);
  });
  it.each([
    'expired',
    'invalid-expiry',
    'revoked',
    'archived',
    'event-expired',
    'event-deleting',
    'collection-deleted',
    'collection-owner',
    'invitation-owner',
    'collection-event',
  ])('fails closed when %s', async (condition) => {
    const f = fixture();
    const invitation = (await f.create().expect(201)).body.invitation;
    const row = f.records.get(invitation.id)!;
    if (condition === 'expired') row.expiresAt = '2020-01-01T00:00:00Z';
    if (condition === 'invalid-expiry') row.expiresAt = 'invalid';
    if (condition === 'revoked')
      row.invitationRevokedAt = new Date().toISOString();
    if (condition === 'archived') f.event.archived = true;
    if (condition === 'event-expired') f.event.expiresAt = 'invalid';
    if (condition === 'event-deleting')
      f.event.deletionStartedAt = new Date().toISOString();
    if (condition === 'collection-deleted') f.records.delete(f.collection.id);
    if (condition === 'collection-owner') f.collection.ownerId = 'foreign';
    if (condition === 'invitation-owner') row.ownerId = 'foreign';
    if (condition === 'collection-event') f.collection.eventId = randomUUID();
    await f.read(f.path(invitation.id)).expect(404);
    await f
      .read(`${f.path(invitation.id)}/photos/${f.photos[0]!.id}`)
      .expect(404);
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it.each([
    'expired',
    'deleting',
    'foreign-owner',
    'foreign-event',
    'scan',
    'removed',
  ])('omits and denies %s photos', async (condition) => {
    const f = fixture();
    const invitation = (await f.create().expect(201)).body.invitation;
    const photo = f.photos[0]!;
    if (condition === 'expired') photo.expiresAt = '2020-01-01T00:00:00Z';
    if (condition === 'deleting')
      photo.deletionStartedAt = new Date().toISOString();
    if (condition === 'foreign-owner') photo.ownerId = 'foreign';
    if (condition === 'foreign-event') photo.eventId = randomUUID();
    if (condition === 'scan') photo.scanId = randomUUID();
    if (condition === 'removed') f.collection.selectedIds = [];
    expect(
      (await f.read(f.path(invitation.id)).expect(200)).body.photos,
    ).toEqual([]);
    await f.read(`${f.path(invitation.id)}/photos/${photo.id}`).expect(404);
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'photo-removed', 'photo-deleted', 'expired'])(
    'rechecks %s after asynchronous file retrieval before delivering bytes',
    async (condition) => {
      const f = fixture();
      const invitation = (await f.create().expect(201)).body.invitation;
      vi.mocked(f.store.file).mockImplementationOnce(async () => {
        if (condition === 'revoked')
          f.records.get(invitation.id)!.invitationRevokedAt =
            new Date().toISOString();
        if (condition === 'photo-removed') f.collection.selectedIds = [];
        if (condition === 'photo-deleted') f.records.delete(f.photos[0]!.id);
        if (condition === 'expired')
          f.records.get(invitation.id)!.expiresAt = '2020-01-01T00:00:00Z';
        return new Response(new Uint8Array([1, 2, 3]));
      });
      await f
        .read(`${f.path(invitation.id)}/photos/${f.photos[0]!.id}`)
        .expect(404)
        .expect('Content-Type', /application\/json/);
    },
  );
  it('prevents duplicate grants and concurrent event-cap overflow', async () => {
    const f = fixture();
    const results = await Promise.all([f.create(), f.create()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const invitation = results.find((r) => r.status === 201)!.body.invitation;
    const template = f.records.get(invitation.id)!;
    for (let i = 0; i < 98; i++) {
      const id = randomUUID();
      f.records.set(id, {
        ...template,
        id,
        invitationRecipientId: `client-${i}`,
      });
    }
    const capped = await Promise.all([
      f.create({ email: 'next@example.test', days: 1 }),
      f.create({ email: 'last@example.test', days: 1 }),
    ]);
    expect(capped.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      [...f.records.values()].filter(
        (row) => row.purpose === 'collection-invitation',
      ),
    ).toHaveLength(100);
  });
  it.each([
    { email: 'bad', days: 1 },
    { email: 'client@example.test', days: 0 },
    { email: 'client@example.test', days: 31 },
    { email: 'client@example.test', days: 1.5 },
    { email: 'client@example.test', days: 1, ownerId: 'foreign' },
  ])('rejects invalid input %j', async (body) => {
    const f = fixture();
    await f.create(body).expect(400);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('rejects missing, unverified and self recipients and rechecks lifecycle after lookup', async () => {
    const f = fixture();
    f.resolve.mockResolvedValueOnce(null);
    await f.create().expect(400);
    f.resolve.mockResolvedValueOnce({
      id: 'client',
      email: 'client@example.test',
      name: '',
      emailVerified: false,
    });
    await f.create().expect(400);
    await f.create({ email: 'owner@example.test', days: 1 }).expect(400);
    f.resolve.mockImplementationOnce(async (email) => {
      f.event.archived = true;
      return { id: 'client', email, name: '', emailVerified: true };
    });
    await f.create().expect(404);
    expect(
      [...f.records.values()].filter(
        (row) => row.purpose === 'collection-invitation',
      ),
    ).toEqual([]);
  });
  it('follows saved collection changes and erases invitations with their event', async () => {
    const f = fixture();
    const invitation = (await f.create().expect(201)).body.invitation;
    f.collection.selectedIds = [f.photos[1]!.id];
    expect(
      (await f.read(f.path(invitation.id)).expect(200)).body.photos.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([f.photos[1]!.id]);
    // Erasure needs no provider because these synthetic photos have no live index.
    for (const photo of f.photos) delete photo.faceIds;
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(invitation.id)).toBe(false);
    await f.read(f.path(invitation.id)).expect(404);
  });
});
