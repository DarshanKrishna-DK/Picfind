import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';
import {
  assertPhotoAvailable,
  photoExpiry,
  purgeExpiredPhotos,
} from '../../apps/api/src/retention.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';

const origin = 'http://localhost:5173';
function fixture() {
  const records = new Map<string, LibraryRecord>();
  const files = new Map<string, Uint8Array>();
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...records.values()]
        .filter((r) => r.ownerId === owner && r.kind === kind)
        .map((r) => structuredClone(r)),
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    put: vi.fn(async (row) => {
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(async (id) => {
      records.delete(id);
    }),
    upload: vi.fn(async (id, bytes) => {
      files.set(id, bytes);
    }),
    removeFile: vi.fn(async (id) => {
      files.delete(id);
    }),
    file: vi.fn(
      async (id) => new Response(new Uint8Array(files.get(id) ?? [])),
    ),
    expired: vi.fn(async (before, limit) =>
      [...records.values()]
        .filter(
          (r) =>
            r.kind === 'photo' &&
            r.expiresAt &&
            Date.parse(r.cleanupAfter ?? r.expiresAt) <= Date.parse(before),
        )
        .slice(0, limit)
        .map((r) => structuredClone(r)),
    ),
  };
  const auth: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async (secret) => ({
      id: secret,
      name: 'Synthetic owner',
      email: 'owner@example.test',
      emailVerified: true,
    }),
  };
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(),
    indexPhoto: vi.fn(),
    search: vi.fn(),
    deleteFaces: vi.fn(async () => {}),
    deleteScope: vi.fn(async () => {}),
  };
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'event',
    title: 'Synthetic event',
    visibility: 'link',
    createdAt: new Date().toISOString(),
  };
  records.set(event.id, event);
  const photo = (expired = true, extra: Partial<LibraryRecord> = {}) => {
    const row: LibraryRecord = {
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'photo',
      filename: 'synthetic.jpg',
      bytes: 5,
      eventId: event.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + (expired ? -60000 : 60000),
      ).toISOString(),
      indexState: 'none',
      ...extra,
    };
    records.set(row.id, row);
    files.set(row.id, new Uint8Array([1, 2, 3, 4, 5]));
    return row;
  };
  const billing = {
    reserve: vi.fn(async () => {}),
    reserveDelivery: vi.fn(async () => {}),
    refundDelivery: vi.fn(async () => {}),
    reserveStorage: vi.fn(async () => {}),
    releaseStorage: vi.fn(async () => {}),
    retentionDays: vi.fn(async () => 30),
  } as unknown as BillingService;
  const app = (metered = false) =>
    createApp(
      { provider: auth, webOrigin: origin, secureCookies: false },
      { store, ...(metered ? { billing } : {}) },
    );
  return { records, files, store, event, photo, matcher, billing, app, auth };
}

describe('expiry enforced independently of cleanup', () => {
  it('hides expired photos from private/public galleries and denies the image bytes', async () => {
    const f = fixture();
    const expired = f.photo();
    const current = f.photo(false);
    const app = f.app();
    const library = await request(app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(library.body.photos.map((r: { id: string }) => r.id)).toEqual([
      current.id,
    ]);
    const gallery = await request(app)
      .get(`/api/public/events/${f.event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(gallery.body.photos.map((r: { id: string }) => r.id)).toEqual([
      current.id,
    ]);
    await request(app)
      .get(`/api/photos/${expired.id}/file`)
      .set('Cookie', 'picfind_session=owner')
      .expect(410);
    await request(app)
      .get(`/api/public/events/${f.event.id}/photos/${expired.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(410);
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it('removes expired photo IDs from saved Discover matches', async () => {
    const f = fixture();
    const photo = f.photo();
    const scan: LibraryRecord = {
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'job',
      purpose: 'discover-scan',
      state: 'complete',
      createdAt: new Date().toISOString(),
      matches: [{ photoId: photo.id, similarity: 90 }],
    };
    f.records.set(scan.id, scan);
    const result = await request(f.app())
      .get(`/api/discover/scans/${scan.id}`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(result.body.matches).toEqual([]);
    expect(result.body.scan.matches).toEqual([]);
    const library = await request(f.app())
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(library.body.scans[0].matches).toEqual([]);
  });
  it('rejects expired photos in guest proofing selections', async () => {
    const f = fixture();
    const photo = f.photo();
    await request(f.app())
      .post(`/api/public/events/${f.event.id}/selections`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(400);
  });
  it('sets retention at upload using the server plan, not client input', async () => {
    const f = fixture();
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#123456' },
    })
      .jpeg()
      .toBuffer();
    const result = await request(f.app(true))
      .post('/api/photos')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .set('X-File-Name', 'generated.jpg')
      .send(image)
      .expect(201);
    const expiry = Date.parse(result.body.photo.expiresAt);
    expect(expiry).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect(expiry).toBeLessThan(Date.now() + 31 * 86400000);
    expect(f.billing.reserveStorage).toHaveBeenCalledOnce();
  });
  it('treats invalid expiry as unavailable and validates policy lengths', () => {
    const f = fixture();
    expect(() =>
      assertPhotoAvailable(f.photo(false, { expiresAt: 'invalid' })),
    ).toThrow();
    expect(() => photoExpiry(0)).toThrow();
    expect(() => photoExpiry(366)).toThrow();
  });
});

describe('metered image delivery', () => {
  it('reserves full stored bytes for previews and downloads on the gallery owner', async () => {
    const f = fixture();
    const photo = f.photo(false);
    const app = f.app(true);
    const response = await request(app)
      .get(`/api/public/events/${f.event.id}/photos/${photo.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(response.headers.etag).toBeUndefined();
    expect(f.billing.reserveDelivery).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      5,
      'legacy',
    );
    await request(app)
      .get(`/api/photos/${photo.id}/file?download=1`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(f.billing.reserveDelivery).toHaveBeenCalledTimes(2);
    expect(f.billing.refundDelivery).not.toHaveBeenCalled();
  });
  it('does not fetch storage or spend an allowance for HEAD requests', async () => {
    const f = fixture();
    const photo = f.photo(false);
    const res = await request(f.app(true))
      .head(`/api/photos/${photo.id}/file`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(res.headers['content-length']).toBe('5');
    expect(f.store.file).not.toHaveBeenCalled();
    expect(f.billing.reserveDelivery).not.toHaveBeenCalled();
  });
  it('denies exhausted delivery before reading the upstream object', async () => {
    const f = fixture();
    const photo = f.photo(false);
    vi.mocked(f.billing.reserveDelivery).mockRejectedValue(
      new ApiError(402, 'ALLOWANCE_EXHAUSTED', 'No delivery allowance.'),
    );
    await request(f.app(true))
      .get(`/api/photos/${photo.id}/file`)
      .set('Cookie', 'picfind_session=owner')
      .expect(402);
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it('does not send a file whose actual size contradicts its reserved metadata', async () => {
    const f = fixture();
    const photo = f.photo(false, { bytes: 1 });
    await request(f.app(true))
      .get(`/api/photos/${photo.id}/file`)
      .set('Cookie', 'picfind_session=owner')
      .expect(503);
    expect(f.billing.refundDelivery).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      'metadata-mismatch',
    );
  });
  it('refunds a storage failure before receiving image bytes', async () => {
    const f = fixture();
    const photo = f.photo(false);
    vi.mocked(f.store.file).mockRejectedValue(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Synthetic outage'),
    );
    await request(f.app(true))
      .get(`/api/photos/${photo.id}/file`)
      .set('Cookie', 'picfind_session=owner')
      .expect(503);
    expect(f.billing.reserveDelivery).toHaveBeenCalledOnce();
    expect(f.billing.refundDelivery).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      'upstream-http-failure',
    );
  });
});

describe('retryable retention cleanup, synthetic cloud adapter only', () => {
  it('deletes an expired unindexed object but retains a current photograph', async () => {
    const f = fixture();
    const old = f.photo();
    const current = f.photo(false);
    expect(await purgeExpiredPhotos(f.store)).toEqual({
      deleted: 1,
      deferred: 0,
    });
    expect(f.records.has(old.id)).toBe(false);
    expect(f.files.has(old.id)).toBe(false);
    expect(f.records.has(current.id)).toBe(true);
  });
  it('deletes only expired face IDs when a collection still has current photos', async () => {
    const f = fixture();
    const old = f.photo(true, {
      provider: 'aws-rekognition',
      faceIds: ['synthetic-face'],
    });
    f.photo(false);
    await purgeExpiredPhotos(f.store, f.matcher);
    expect(f.matcher.deleteFaces).toHaveBeenCalledWith(
      { kind: 'event', id: f.event.id },
      ['synthetic-face'],
    );
    expect(f.matcher.deleteScope).not.toHaveBeenCalled();
    expect(f.records.has(old.id)).toBe(false);
  });
  it('deletes the collection once when all its photos have expired', async () => {
    const f = fixture();
    f.photo(true, { provider: 'aws-rekognition', faceIds: ['one'] });
    f.photo(true, { provider: 'aws-rekognition', faceIds: ['two'] });
    expect(await purgeExpiredPhotos(f.store, f.matcher)).toEqual({
      deleted: 2,
      deferred: 0,
    });
    expect(f.matcher.deleteScope).toHaveBeenCalledTimes(1);
    expect(f.matcher.deleteFaces).not.toHaveBeenCalled();
  });
  it('keeps cleanup references and backs off if cloud deletion fails', async () => {
    const f = fixture();
    const old = f.photo(true, {
      provider: 'aws-rekognition',
      faceIds: ['one'],
    });
    vi.mocked(f.matcher.deleteScope).mockRejectedValue(
      new Error('Synthetic outage'),
    );
    expect(await purgeExpiredPhotos(f.store, f.matcher)).toEqual({
      deleted: 0,
      deferred: 1,
    });
    expect(f.records.has(old.id)).toBe(true);
    expect(f.files.has(old.id)).toBe(true);
    expect(Date.parse(f.records.get(old.id)!.cleanupAfter!)).toBeGreaterThan(
      Date.now(),
    );
    expect(await purgeExpiredPhotos(f.store, f.matcher)).toEqual({
      deleted: 0,
      deferred: 0,
    });
  });
  it('does not erase potentially indexed failed photos without a provider', async () => {
    const f = fixture();
    const old = f.photo(true, { indexState: 'failed' });
    expect(await purgeExpiredPhotos(f.store)).toEqual({
      deleted: 0,
      deferred: 1,
    });
    expect(f.records.has(old.id)).toBe(true);
  });
  it('keeps metadata when object deletion fails after cloud erasure', async () => {
    const f = fixture();
    const old = f.photo(true, {
      provider: 'aws-rekognition',
      faceIds: ['one'],
    });
    vi.mocked(f.store.removeFile).mockRejectedValue(
      new Error('Synthetic storage outage'),
    );
    expect(await purgeExpiredPhotos(f.store, f.matcher)).toEqual({
      deleted: 0,
      deferred: 1,
    });
    expect(f.records.has(old.id)).toBe(true);
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('is repeatable after already-completed cleanup', async () => {
    const f = fixture();
    f.photo();
    await purgeExpiredPhotos(f.store);
    expect(await purgeExpiredPhotos(f.store)).toEqual({
      deleted: 0,
      deferred: 0,
    });
  });
});
