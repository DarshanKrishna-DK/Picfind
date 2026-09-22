import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';

function fixture(matcher?: FaceMatchingProvider) {
  const ownerId = randomUUID(),
    eventId = randomUUID();
  const photo: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    eventId,
    kind: 'photo',
    createdAt: new Date().toISOString(),
    indexState: 'failed',
    provider: 'aws-rekognition',
  };
  const sibling: LibraryRecord = {
    ...photo,
    id: randomUUID(),
    indexState: 'ready',
    faceIds: ['current-face'],
  };
  const rows = new Map([
    [photo.id, photo],
    [sibling.id, sibling],
  ]);
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()].filter((r) => r.ownerId === owner && r.kind === kind),
    put: async (row) => {
      rows.set(row.id, row);
    },
    remove: vi.fn(async (id) => {
      rows.delete(id);
    }),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(async () => {}),
  };
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async (secret) => ({
      id: secret,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    }),
  };
  const app = createApp(
    { provider, webOrigin: 'http://localhost:5173', secureCookies: false },
    { store, ...(matcher ? { faceMatcher: matcher } : {}) },
  );
  const remove = (owner: string = ownerId) =>
    request(app)
      .delete(`/api/photos/${photo.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `picfind_session=${owner}`);
  return { rows, photo, sibling, store, app, remove, ownerId };
}
describe('individual deletion revokes access without losing uncertain erasure references', () => {
  it('hides a photo immediately and reports pending cleanup when its face IDs are uncertain', async () => {
    const f = fixture();
    const response = await f.remove().expect(202);
    expect(response.body.deletion).toBe('pending');
    expect(f.rows.has(f.photo.id)).toBe(true);
    expect(Date.parse(f.rows.get(f.photo.id)!.expiresAt!)).toBeLessThanOrEqual(
      Date.now(),
    );
    await request(f.app)
      .get(`/api/photos/${f.photo.id}/file`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(410);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it('does not erase a live sibling collection to satisfy one uncertain deletion', async () => {
    const matcher = {
      deleteScope: vi.fn(),
      deleteFaces: vi.fn(),
    } as unknown as FaceMatchingProvider;
    const f = fixture(matcher);
    await f.remove().expect(202);
    expect(matcher.deleteScope).not.toHaveBeenCalled();
    expect(f.rows.has(f.sibling.id)).toBe(true);
  });
  it('erases the scope when no accessible siblings remain', async () => {
    const matcher = {
      deleteScope: vi.fn(async () => {}),
      deleteFaces: vi.fn(),
    } as unknown as FaceMatchingProvider;
    const f = fixture(matcher);
    f.rows.delete(f.sibling.id);
    await f.remove().expect(204);
    expect(matcher.deleteScope).toHaveBeenCalledWith({
      kind: 'event',
      id: f.photo.eventId,
    });
    expect(f.rows.has(f.photo.id)).toBe(false);
  });
  it('never allows another account to hide the photo', async () => {
    const f = fixture();
    await f.remove('another-owner').expect(404);
    expect(f.rows.get(f.photo.id)?.expiresAt).toBeUndefined();
  });
});
