import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { createPhotoIndexer } from '../../apps/api/src/face-indexing';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports';

async function fixture(kind: 'event' | 'scan' = 'event') {
  const id = randomUUID();
  const root: LibraryRecord = {
    id,
    ownerId: 'owner',
    kind: kind === 'event' ? 'event' : 'job',
    ...(kind === 'scan'
      ? {
          purpose: 'discover-scan' as const,
          state: 'complete' as const,
          consentPolicyVersion: 'face-matching-v1',
          provider: 'aws-rekognition',
        }
      : { visibility: 'link' as const }),
    createdAt: new Date().toISOString(),
  };
  const photo: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'photo',
    ...(kind === 'event' ? { eventId: id } : { scanId: id }),
    createdAt: root.createdAt,
    filename: 'group.jpg',
    indexState: 'ready',
    provider: 'aws-rekognition',
    modelVersion: '7',
    externalImageId: 'external',
    faceIds: ['face'],
  };
  if (kind === 'scan') root.faceMap = { external: photo.id };
  const rows = new Map([root, photo].map((row) => [row.id, row]));
  const jpeg = await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#50796a' },
  })
    .jpeg()
    .toBuffer();
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (owner, type) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === type)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row) => {
      rows.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(),
    upload: vi.fn(),
    removeFile: vi.fn(),
    file: vi.fn(async () => new Response(new Uint8Array(jpeg))),
  };
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(async () => ({ modelVersion: '7' })),
    indexPhoto: vi.fn(async () => ({
      modelVersion: '7',
      externalImageId: 'external',
      faceIds: ['face'],
      unindexedReasons: [],
    })),
    search: vi.fn(async () => ({
      modelVersion: '7',
      matches: [
        { faceId: 'face', externalImageId: 'external', similarity: 97 },
      ],
      limitReached: false,
    })),
    deleteFaces: vi.fn(),
    deleteScope: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: 'http://localhost:5173',
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store, faceMatcher: matcher, faceProviderName: 'aws-rekognition' },
  );
  const search = () =>
    request(app)
      .post(
        kind === 'event'
          ? `/api/public/events/${id}/find`
          : `/api/discover/scans/${id}/search`,
      )
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=owner')
      .set('X-PicFind-Consent', 'face-matching-v1')
      .set('Content-Type', 'application/octet-stream')
      .send(jpeg);
  const reserveUsage = vi.fn(async () => {});
  const index = createPhotoIndexer({
    providerName: 'aws-rekognition',
    reserveUsage,
  });
  return {
    app,
    root,
    photo,
    rows,
    store,
    matcher,
    search,
    reserveUsage,
    index,
    scope: { kind, id: kind === 'scan' ? id.replaceAll('-', '') : id },
  };
}

describe('saved face index compatibility', () => {
  it.each(['ready', 'empty', 'queued', 'failed'] as const)(
    'preserves a foreign-provider %s record even with explicit retry approval',
    async (state) => {
      const f = await fixture();
      f.photo.provider = 'local-sface';
      f.photo.indexState = state;
      const before = structuredClone(f.photo);
      await expect(
        f.index(f.matcher, f.store, f.photo, f.scope, 'consent', {
          retryUncertain: true,
        }),
      ).rejects.toMatchObject({ code: 'FACE_INDEX_INCOMPATIBLE', status: 409 });
      expect(f.photo).toEqual(before);
      expect(f.store.file).not.toHaveBeenCalled();
      expect(f.store.put).not.toHaveBeenCalled();
      expect(f.matcher.ensureScope).not.toHaveBeenCalled();
      expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
      expect(f.reserveUsage).not.toHaveBeenCalled();
    },
  );
  it.each(['provider', 'modelVersion'] as const)(
    'rejects incomplete cached %s provenance',
    async (field) => {
      const f = await fixture();
      delete f.photo[field];
      await expect(
        f.index(f.matcher, f.store, f.photo, f.scope, 'consent'),
      ).rejects.toMatchObject({ code: 'FACE_INDEX_INCOMPATIBLE' });
      expect(f.reserveUsage).not.toHaveBeenCalled();
      expect(f.store.file).not.toHaveBeenCalled();
    },
  );
  it('reuses identified AWS results and indexes untouched photos normally', async () => {
    const f = await fixture();
    expect(
      await f.index(f.matcher, f.store, f.photo, f.scope, 'consent'),
    ).toEqual(f.photo);
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    const fresh: LibraryRecord = {
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'photo',
      eventId: f.root.id,
      createdAt: f.root.createdAt,
      indexState: 'none',
    };
    const result = await f.index(f.matcher, f.store, fresh, f.scope, 'consent');
    expect(result).toMatchObject({
      provider: 'aws-rekognition',
      modelVersion: '7',
      indexState: 'ready',
    });
    expect(f.matcher.indexPhoto).toHaveBeenCalledOnce();
    expect(f.reserveUsage).toHaveBeenCalledOnce();
  });
  describe.each(['event', 'scan'] as const)('%s search', (kind) => {
    it('keeps existing compatible AWS matches available', async () => {
      const f = await fixture(kind);
      const response = await f.search().expect(200);
      expect(response.body.matches).toEqual([
        { photoId: f.photo.id, filename: 'group.jpg', similarity: 97 },
      ]);
    });
    it.each([
      'foreign-provider',
      'missing-provider',
      'missing-model',
      'mixed-model',
    ])(
      'rejects %s before contacting the matcher or recording usage',
      async (condition) => {
        const f = await fixture(kind);
        if (condition === 'foreign-provider') f.photo.provider = 'local-sface';
        if (condition === 'missing-provider') delete f.photo.provider;
        if (condition === 'missing-model') delete f.photo.modelVersion;
        if (condition === 'mixed-model') {
          const other = { ...f.photo, id: randomUUID(), modelVersion: '6' };
          f.rows.set(other.id, other);
        }
        const response = await f.search().expect(409);
        expect(response.body.error.code).toBe('FACE_INDEX_INCOMPATIBLE');
        expect(f.matcher.search).not.toHaveBeenCalled();
        expect(
          [...f.rows.values()].filter((row) => row.purpose === 'usage'),
        ).toEqual([]);
      },
    );
    it('does not deliver matches when the provider response uses another model', async () => {
      const f = await fixture(kind);
      vi.mocked(f.matcher.search).mockResolvedValueOnce({
        modelVersion: '8',
        matches: [
          { faceId: 'face', externalImageId: 'external', similarity: 100 },
        ],
        limitReached: false,
      });
      const response = await f.search().expect(409);
      expect(response.body.error.code).toBe('FACE_INDEX_INCOMPATIBLE');
      expect(response.body.matches).toBeUndefined();
      expect(f.rows.get(f.photo.id)?.modelVersion).toBe('7');
    });
    it('rechecks photo provenance after the provider response', async () => {
      const f = await fixture(kind);
      vi.mocked(f.matcher.search).mockImplementationOnce(async () => {
        f.photo.provider = 'local-sface';
        return {
          modelVersion: '7',
          matches: [
            { faceId: 'face', externalImageId: 'external', similarity: 100 },
          ],
          limitReached: false,
        };
      });
      await f.search().expect(409);
    });
  });
  it('rejects a foreign saved scan provider even when its photo rows claim AWS', async () => {
    const f = await fixture('scan');
    f.root.provider = 'local-sface';
    await f.search().expect(409);
    expect(f.matcher.search).not.toHaveBeenCalled();
  });
  it.each(['visibility', 'passcode', 'archive'])(
    'rechecks event %s after the provider response',
    async (condition) => {
      const f = await fixture();
      vi.mocked(f.matcher.search).mockImplementationOnce(async () => {
        if (condition === 'visibility') f.root.visibility = 'private';
        if (condition === 'passcode')
          f.root.passcodeHash = 'synthetic-new-passcode-hash';
        if (condition === 'archive') f.root.archived = true;
        return {
          modelVersion: '7',
          matches: [
            { faceId: 'face', externalImageId: 'external', similarity: 100 },
          ],
          limitReached: false,
        };
      });
      await f.search().expect(404);
    },
  );
});
