import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError, type AuthUser } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import type { BillingService } from '../../apps/api/src/billing/service';

export const origin = 'http://localhost:5173';
export function invitationFixture(metered = false) {
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
  const billing = {
    roleCatalogEnabled: true,
    reserveDelivery: vi.fn(async () => {}),
    refundDelivery: vi.fn(async () => {}),
  };
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
    {
      store,
      ...(metered ? { billing: billing as unknown as BillingService } : {}),
    },
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
    billing,
  };
}
