import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { ApiError } from '../../apps/api/src/auth.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import { productBillingScope } from '../../apps/api/src/billing/product-scope.js';
import { createPhotoIndexer } from '../../apps/api/src/face-indexing.js';
import { createScanPhotoPreparer } from '../../apps/api/src/scan-photo-preparation.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';
import { TestJobStore } from '../helpers/job-store.js';

// Synthetic routing-contract tests. Grant arithmetic is tested separately against
// the real ledger in role-allowances.test.ts; no external provider is contacted.
async function fixture() {
  const owner = randomUUID(),
    guest = randomUUID();
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#335577' },
  })
    .jpeg()
    .toBuffer();
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: owner,
    kind: 'event',
    title: 'Synthetic private link',
    visibility: 'link',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  };
  const personal: LibraryRecord = {
    id: randomUUID(),
    ownerId: owner,
    kind: 'photo',
    createdAt: new Date().toISOString(),
    filename: 'personal.jpg',
    bytes: bytes.length,
    indexState: 'ready',
    externalImageId: 'personal-face',
  };
  const eventPhoto: LibraryRecord = {
    ...personal,
    id: randomUUID(),
    eventId: event.id,
    externalImageId: 'event-face',
  };
  const scan: LibraryRecord = {
    id: randomUUID(),
    ownerId: owner,
    kind: 'job',
    purpose: 'discover-scan',
    createdAt: new Date().toISOString(),
    state: 'complete',
    consentPolicyVersion: 'face-matching-v1',
  };
  const scanPhoto: LibraryRecord = {
    ...personal,
    id: randomUUID(),
    scanId: scan.id,
  };
  scan.faceMap = { 'personal-face': scanPhoto.id };
  const rows = new Map(
    [event, personal, eventPhoto, scan, scanPhoto].map((row) => [row.id, row]),
  );
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (user, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === user && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    file: vi.fn(async () => new Response(new Uint8Array(bytes))),
  };
  const billing = new BillingService(
    new ImportTestBillingStore(),
    undefined,
    {},
    'test_mode',
    false,
    true,
  );
  const reserve = vi.spyOn(billing, 'reserve').mockResolvedValue(undefined);
  const storage = vi
    .spyOn(billing, 'reserveStorage')
    .mockResolvedValue(undefined);
  const delivery = vi
    .spyOn(billing, 'reserveDelivery')
    .mockResolvedValue(undefined);
  vi.spyOn(billing, 'retentionDays').mockResolvedValue(30);
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(),
    deleteScope: vi.fn(),
    deleteFaces: vi.fn(),
    indexPhoto: vi.fn(async () => ({
      modelVersion: 'synthetic',
      faceIds: ['synthetic-face'],
      externalImageId: 'synthetic-photo',
      unindexedReasons: [],
    })),
    search: vi.fn(async () => ({
      modelVersion: 'synthetic',
      matches: [],
      limitReached: false,
    })),
  };
  const app = createApp(
    {
      webOrigin: 'http://localhost:5173',
      secureCookies: false,
      provider: {
        getUser: async (secret) => ({
          id: secret,
          name: 'Synthetic',
          email: 'synthetic@example.test',
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    {
      store,
      billing,
      faceMatcher: matcher,
      jobQueue: new JobQueue(new TestJobStore()),
    },
  );
  const post = (path: string, user = owner) =>
    request(app)
      .post('/api' + path)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=' + user);
  return {
    app,
    owner,
    guest,
    bytes,
    event,
    eventPhoto,
    personal,
    scan,
    scanPhoto,
    rows,
    store,
    billing,
    reserve,
    storage,
    delivery,
    matcher,
    post,
  };
}

describe('server-derived product billing context', () => {
  it('keeps role routing closed with the catalog rollout switch', () => {
    const billing = new BillingService(
      new ImportTestBillingStore(),
      undefined,
      {},
      'test_mode',
      false,
    );
    expect(productBillingScope(billing, 'organizer')).toBe('legacy');
    expect(productBillingScope(billing, 'personal')).toBe('legacy');
    expect(productBillingScope(undefined, 'personal')).toBe('legacy');
  });
  it('charges a guest selfie search to the event owner and organizer balance', async () => {
    const f = await fixture();
    await f
      .post(`/public/events/${f.event.id}/find`, f.guest)
      .set('X-PicFind-Consent', 'face-matching-v1')
      .set('Content-Type', 'application/octet-stream')
      .send(f.bytes)
      .expect(200);
    expect(f.reserve).toHaveBeenCalledWith(
      f.owner,
      'search',
      1,
      undefined,
      'organizer',
    );
    expect(f.reserve).not.toHaveBeenCalledWith(
      f.guest,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(f.matcher.search).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'event', id: f.event.id } }),
    );
    expect(
      [...f.rows.values()].filter((row) => row.kind === 'photo'),
    ).toHaveLength(3);
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it('charges a saved Discover selfie search to personal allowances', async () => {
    const f = await fixture();
    await f
      .post(`/discover/scans/${f.scan.id}/search`)
      .set('Content-Type', 'application/octet-stream')
      .send(f.bytes)
      .expect(200);
    expect(f.reserve).toHaveBeenCalledWith(
      f.owner,
      'search',
      1,
      undefined,
      'personal',
    );
  });
  it.each(['personal', 'organizer'] as const)(
    'reserves %s storage from the authorized destination',
    async (context) => {
      const f = await fixture();
      const result = await f
        .post(
          '/photos' + (context === 'organizer' ? '?eventId=' + f.event.id : ''),
        )
        .set('Content-Type', 'application/octet-stream')
        .send(f.bytes)
        .expect(201);
      expect(f.storage).toHaveBeenCalledWith(
        f.owner,
        result.body.photo.id,
        expect.any(Number),
        expect.any(Function),
        context,
      );
      expect(f.billing.retentionDays).toHaveBeenCalledWith(f.owner, context);
      if (context === 'organizer') {
        expect(result.body.photo.eventId).toBe(f.event.id);
        expect(result.body.photo.expiresAt).toBe(f.event.expiresAt);
      } else expect(result.body.photo.eventId).toBeUndefined();
    },
  );
  it.each(['personal', 'organizer'] as const)(
    'uses saved photo ownership for %s delivery',
    async (context) => {
      const f = await fixture();
      const path =
        context === 'personal'
          ? `/photos/${f.personal.id}/file`
          : `/public/events/${f.event.id}/photos/${f.eventPhoto.id}`;
      await request(f.app)
        .get('/api' + path)
        .set(
          'Cookie',
          'picfind_session=' + (context === 'personal' ? f.owner : f.guest),
        )
        .expect(200);
      expect(f.delivery).toHaveBeenCalledWith(
        f.owner,
        expect.any(String),
        f.bytes.length,
        context,
      );
    },
  );
  it('rejects an event photo in a personal Discover job before enqueueing', async () => {
    const f = await fixture();
    await f
      .post('/discover/scans')
      .send({
        requestId: randomUUID(),
        photoIds: [f.eventPhoto.id],
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(404);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
  it('rejects an event source again inside scan preparation', async () => {
    const f = await fixture();
    await expect(
      createScanPhotoPreparer(f.store, f.billing)(
        f.owner,
        randomUUID(),
        f.eventPhoto.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.store.file).not.toHaveBeenCalled();
    expect(f.storage).not.toHaveBeenCalled();
  });
  it('does not charge or upload into an expired event', async () => {
    const f = await fixture();
    f.rows.set(f.event.id, {
      ...f.event,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await f
      .post('/photos?eventId=' + f.event.id)
      .set('Content-Type', 'application/octet-stream')
      .send(f.bytes)
      .expect(409);
    expect(f.storage).not.toHaveBeenCalled();
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it.each(['personal', 'organizer'] as const)(
    'passes %s indexing context from the collection',
    async (context) => {
      const f = await fixture();
      const reserveUsage = vi.fn(async () => {});
      const photo = {
        ...(context === 'personal' ? f.scanPhoto : f.eventPhoto),
        indexState: 'none' as const,
      };
      const scope =
        context === 'personal'
          ? { kind: 'scan' as const, id: f.scan.id.replaceAll('-', '') }
          : { kind: 'event' as const, id: f.event.id };
      await createPhotoIndexer({ providerName: 'synthetic', reserveUsage })(
        f.matcher,
        f.store,
        photo,
        scope,
        'synthetic-consent',
      );
      expect(reserveUsage).toHaveBeenCalledWith(f.owner, 'index', context);
    },
  );
  it('rejects a mismatched index collection before reading bytes or charging', async () => {
    const f = await fixture();
    const reserveUsage = vi.fn(async () => {});
    await expect(
      createPhotoIndexer({ providerName: 'synthetic', reserveUsage })(
        f.matcher,
        f.store,
        f.eventPhoto,
        { kind: 'event', id: randomUUID() },
        'synthetic-consent',
      ),
    ).rejects.toMatchObject({ code: 'COLLECTION_MISMATCH' });
    expect(reserveUsage).not.toHaveBeenCalled();
    expect(f.store.file).not.toHaveBeenCalled();
  });
});
