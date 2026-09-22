import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports';

const origin = 'http://localhost:5173';

function jpeg() {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: '#445566' },
  })
    .jpeg()
    .toBuffer();
}

function setup(matcher?: FaceMatchingProvider) {
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
    {
      store,
      faceIndexMax: 20,
      ...(matcher
        ? {
            faceMatcher: matcher,
            faceProviderName: 'aws-rekognition' as const,
          }
        : {}),
    },
  );
  return { app, records, files };
}

describe('discover face matching without live AWS', () => {
  it('reports face matching as unavailable until a provider is injected', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/capabilities').expect(200);
    expect(response.body.faceMatching).toBe(false);
    expect(response.body.driveOAuth).toBe(false);
    expect(response.body.driveConnected).toBe(false);
  });
  it('does not start Drive OAuth without a Google Cloud client', async () => {
    const { app } = setup();
    await request(app)
      .post('/api/drive/connect')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(503);
  });
  it('rejects a search without consent', async () => {
    const matcher: FaceMatchingProvider = {
      healthCheck: async () => {},
      ensureScope: async () => ({ modelVersion: '7.0' }),
      indexPhoto: async () => ({
        modelVersion: '7.0',
        externalImageId: 'ext',
        faceIds: ['11111111-1111-4111-8111-111111111111'],
        unindexedReasons: [],
      }),
      search: async () => ({
        modelVersion: '7.0',
        matches: [],
        limitReached: false,
      }),
      deleteFaces: async () => {},
      deleteScope: async () => {},
    };
    const { app } = setup(matcher);
    await request(app)
      .post('/api/discover/scans')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ url: 'https://drive.google.com/drive/folders/abc' })
      .expect(400);
  });
  it('ranks matches from the injected provider and never sends a selfie to storage', async () => {
    const matcher: FaceMatchingProvider = {
      healthCheck: async () => {},
      ensureScope: async () => ({ modelVersion: '7.0' }),
      indexPhoto: async (input) => ({
        modelVersion: '7.0',
        externalImageId: `ext-${input.photoId}`,
        faceIds: [randomUUID()],
        unindexedReasons: [],
      }),
      search: async () => ({
        modelVersion: '7.0',
        matches: [
          {
            faceId: randomUUID(),
            externalImageId: 'ext-photo',
            similarity: 91.2,
          },
        ],
        limitReached: false,
      }),
      deleteFaces: async () => {},
      deleteScope: async () => {},
    };
    const { app, records, files } = setup(matcher);
    const photoId = randomUUID();
    const scanId = randomUUID();
    records.set(scanId, {
      id: scanId,
      ownerId: 'owner',
      kind: 'job',
      purpose: 'discover-scan',
      state: 'complete',
      consentPolicyVersion: 'face-matching-v1',
      consentAt: new Date().toISOString(),
      imported: 1,
      indexed: 1,
      errors: [],
      faceMap: { 'ext-photo': photoId },
      createdAt: new Date().toISOString(),
    });
    records.set(photoId, {
      id: photoId,
      ownerId: 'owner',
      kind: 'photo',
      scanId,
      filename: 'group.jpg',
      createdAt: new Date().toISOString(),
      indexState: 'ready',
      externalImageId: 'ext-photo',
    });
    files.set(photoId, new Uint8Array([1, 2, 3]));
    const selfie = await jpeg();
    const selfieCopy = Buffer.from(selfie);
    const response = await request(app)
      .post(`/api/discover/scans/${scanId}/search`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(selfie)
      .expect(200);
    expect(response.body.matches[0].photoId).toBe(photoId);
    expect(response.body.matches[0].similarity).toBe(91.2);
    expect(files.has(scanId)).toBe(false);
    expect(selfieCopy.equals(selfie)).toBe(true);
  });
  it('requires consent on public event search', async () => {
    const { app, records } = setup({
      healthCheck: async () => {},
      ensureScope: async () => ({ modelVersion: '7.0' }),
      indexPhoto: async () => ({
        modelVersion: '7.0',
        externalImageId: 'x',
        faceIds: [],
        unindexedReasons: [],
      }),
      search: async () => ({
        modelVersion: '7.0',
        matches: [],
        limitReached: false,
      }),
      deleteFaces: async () => {},
      deleteScope: async () => {},
    });
    const eventId = randomUUID();
    records.set(eventId, {
      id: eventId,
      ownerId: 'owner',
      kind: 'event',
      title: 'Public',
      visibility: 'link',
      archived: false,
      createdAt: new Date().toISOString(),
    });
    await request(app)
      .post(`/api/public/events/${eventId}/find`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(await jpeg())
      .expect(403);
  });
});
