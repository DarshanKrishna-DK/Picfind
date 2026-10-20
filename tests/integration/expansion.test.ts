import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type {
  LibraryOptions,
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports';
import {
  processingUsage,
  reserveProcessing,
} from '../../apps/api/src/processing-budget';
import { withAccountFaceCleanup } from '../../apps/api/src/account-face-cleanup';
import {
  openSource,
  sealSource,
  trustedSourceDownload,
} from '../../apps/api/src/cloud-sources';
import {
  hashPasscode,
  safeCsv,
  verifyPasscode,
} from '../../apps/api/src/event-tools';
import { estimatePlan, PHOTO_PLANS } from '../../packages/shared/src/plans';

const origin = 'http://localhost:5173';
const key = 'ab'.repeat(32);
function fixture(options: Omit<LibraryOptions, 'store'> = {}) {
  const records = new Map<string, LibraryRecord>();
  const files = new Map<string, Uint8Array>();
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
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
    upload: async (id, bytes) => {
      files.set(id, new Uint8Array(bytes));
    },
    file: async (id) => new Response(new Uint8Array(files.get(id) ?? [])),
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
          name: 'Owner',
          email: 'owner@example.test',
          emailVerified: true,
        }),
      },
    },
    { store, ...options },
  );
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'event',
    createdAt: new Date().toISOString(),
    title: 'Test event',
    visibility: 'link',
  };
  const photo: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'photo',
    eventId: event.id,
    createdAt: new Date().toISOString(),
    filename: 'group.jpg',
    bytes: 3,
    width: 32,
    height: 24,
  };
  records.set(event.id, event);
  records.set(photo.id, photo);
  files.set(photo.id, new Uint8Array([1, 2, 3]));
  return { app, store, records, files, event, photo };
}
function matcher(): FaceMatchingProvider {
  return {
    healthCheck: vi.fn(async () => {}),
    ensureScope: vi.fn(async () => ({ modelVersion: 'test' })),
    indexPhoto: vi.fn(async (input) => ({
      modelVersion: 'test',
      externalImageId: input.photoId,
      faceIds: ['face'],
      unindexedReasons: [],
    })),
    search: vi.fn(async () => ({
      modelVersion: 'test',
      matches: [],
      limitReached: false,
    })),
    deleteFaces: vi.fn(async () => {}),
    deleteScope: vi.fn(async () => {}),
  };
}

describe('guest selection receipts', () => {
  it('persists session identity and returns only the guest projection after submissions close', async () => {
    const f = fixture();
    const submit = (actor: string) =>
      request(f.app)
        .post(`/api/public/events/${f.event.id}/selections`)
        .set('Origin', origin)
        .set('Cookie', `picfind_session=${actor}`)
        .send({
          name: 'Same display name',
          note: 'My album',
          photoIds: [f.photo.id],
        });
    await submit('guest-a').expect(201);
    await submit('guest-b').expect(201);
    const rows = [...f.records.values()].filter(
      (row) => row.purpose === 'selection',
    );
    const own = rows.find((row) => row.submittedById === 'guest-a')!;
    expect(own).toBeDefined();
    own.reviewStatus = 'completed';
    own.reviewNote = 'Private photographer note';
    own.reviewVersion = 9;
    const legacy = { ...own, id: randomUUID() };
    delete legacy.submittedById;
    f.records.set(legacy.id, legacy);
    f.event.selectionClosesAt = new Date(Date.now() - 1000).toISOString();
    const result = await request(f.app)
      .get(`/api/public/events/${f.event.id}/my-selections`)
      .set('Cookie', 'picfind_session=guest-a')
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({
      receipts: [
        {
          id: own.id,
          name: 'Same display name',
          note: 'My album',
          createdAt: own.createdAt,
          originalCount: 1,
          unavailableCount: 0,
          photos: [{ id: f.photo.id, filename: f.photo.filename }],
        },
      ],
      nextCursor: null,
    });
    const ownerHistory = await request(f.app)
      .get(`/api/public/events/${f.event.id}/my-selections`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(ownerHistory.body.receipts).toEqual([]);
    await request(f.app)
      .post(`/api/public/events/${f.event.id}/selections`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=guest-a')
      .send({
        name: 'Impersonation',
        photoIds: [f.photo.id],
        submittedById: 'guest-b',
      })
      .expect(400);
  });

  it('omits expired, deleting and foreign photos without losing original counts', async () => {
    const f = fixture();
    const unavailable = ['expired', 'deleting', 'foreign'].map((kind) => ({
      ...f.photo,
      id: randomUUID(),
      filename: `private-${kind}.jpg`,
      ...(kind === 'expired' ? { expiresAt: new Date(0).toISOString() } : {}),
      ...(kind === 'deleting'
        ? { deletionStartedAt: new Date().toISOString() }
        : {}),
      ...(kind === 'foreign' ? { eventId: randomUUID() } : {}),
    }));
    unavailable.forEach((row) => f.records.set(row.id, row));
    const row: LibraryRecord = {
      id: randomUUID(),
      kind: 'job',
      purpose: 'selection',
      ownerId: 'owner',
      eventId: f.event.id,
      submittedById: 'guest',
      createdAt: new Date().toISOString(),
      selectedIds: [
        f.photo.id,
        f.photo.id,
        ...unavailable.map((photo) => photo.id),
        randomUUID(),
      ],
    };
    f.records.set(row.id, row);
    const response = await request(f.app)
      .get(`/api/public/events/${f.event.id}/my-selections`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(response.body.receipts[0]).toMatchObject({
      originalCount: 5,
      unavailableCount: 4,
      photos: [{ id: f.photo.id, filename: f.photo.filename }],
    });
    expect(JSON.stringify(response.body)).not.toContain('private-');
    for (const photo of unavailable)
      expect(JSON.stringify(response.body)).not.toContain(photo.id);
  });

  it('paginates only own requests with stable tie ordering and rejects foreign cursors', async () => {
    const f = fixture();
    const ownIds = Array.from({ length: 27 }, () => randomUUID())
      .sort()
      .reverse();
    for (const id of ownIds)
      f.records.set(id, {
        id,
        kind: 'job',
        purpose: 'selection',
        ownerId: 'owner',
        eventId: f.event.id,
        submittedById: 'guest',
        createdAt: '2026-10-20T12:00:00.000Z',
        selectedIds: [f.photo.id],
      });
    const get = (suffix = '') =>
      request(f.app)
        .get(`/api/public/events/${f.event.id}/my-selections${suffix}`)
        .set('Cookie', 'picfind_session=guest');
    const first = await get().expect(200);
    expect(first.body.receipts.map((row: { id: string }) => row.id)).toEqual(
      ownIds.slice(0, 25),
    );
    expect(first.body.nextCursor).toBe(ownIds[24]);
    const next = await get(`?cursor=${first.body.nextCursor}`).expect(200);
    expect(next.body.receipts.map((row: { id: string }) => row.id)).toEqual(
      ownIds.slice(25),
    );
    expect(next.body.nextCursor).toBeNull();
    const foreign = {
      ...f.records.get(ownIds[0]!)!,
      id: randomUUID(),
      submittedById: 'another-guest',
    };
    f.records.set(foreign.id, foreign);
    for (const cursor of ['bad', randomUUID(), foreign.id])
      expect((await get(`?cursor=${cursor}`).expect(400)).body.error.code).toBe(
        'INVALID_CURSOR',
      );
    await get('?limit=1000').expect(400);
  });

  it('requires sign-in and current passcode, including after storage reads', async () => {
    const f = fixture();
    const url = `/api/public/events/${f.event.id}/my-selections`;
    await request(f.app).get(url).expect(401);
    f.event.passcodeHash = await hashPasscode('secret123');
    await request(f.app)
      .get(url)
      .set('Cookie', 'picfind_session=guest')
      .expect(401);
    const unlocked = await request(f.app)
      .post(`/api/public/events/${f.event.id}/unlock`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=guest')
      .send({ passcode: 'secret123' })
      .expect(204);
    const galleryCookie = String(unlocked.headers['set-cookie']![0]).split(
      ';',
    )[0];
    const cookie = `picfind_session=guest; ${galleryCookie}`;
    await request(f.app).get(url).set('Cookie', cookie).expect(200);
    const list = f.store.list;
    const rotated = await hashPasscode('rotated123');
    f.store.list = async (...args) => {
      const result = await list(...args);
      if (args[1] === 'photo') f.event.passcodeHash = rotated;
      return result;
    };
    await request(f.app).get(url).set('Cookie', cookie).expect(401);
  });

  it.each([
    { visibility: 'private' as const },
    { archived: true },
    { expiresAt: new Date(0).toISOString() },
    { deletionStartedAt: new Date().toISOString() },
  ])(
    'denies receipts when gallery access is unavailable: %j',
    async (patch) => {
      const f = fixture();
      Object.assign(f.event, patch);
      await request(f.app)
        .get(`/api/public/events/${f.event.id}/my-selections`)
        .set('Cookie', 'picfind_session=guest')
        .expect(404);
    },
  );
});
const cookie = () =>
  `picfind_dropbox=${sealSource({ owner: 'owner', provider: 'dropbox', expires: Date.now() + 60_000, value: 'fixture-token' }, key)}`;
const image = () =>
  sharp({
    create: { width: 32, height: 24, channels: 3, background: '#376553' },
  })
    .jpeg()
    .toBuffer();

describe('pricing and bounded processing', () => {
  it('publishes planning prices but never enables checkout', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/plans').expect(200);
    expect(response.body.plans).toEqual(PHOTO_PLANS);
    expect(response.body.checkoutAvailable).toBe(false);
  });
  it('estimates packs and monthly allowances at boundaries', () => {
    expect(estimatePlan(20, false).plan.id).toBe('preview');
    expect(estimatePlan(1001, false).inr).toBe(398);
    expect(estimatePlan(2500, true).plan.id).toBe('organizer-starter-monthly');
    expect(estimatePlan(7501, true).inr).toBe(1999);
    expect(estimatePlan(2501, true).inr).toBe(1999);
  });
  it('serializes concurrent budget reservations and refuses the 21st indexing attempt', async () => {
    const { store } = fixture();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveProcessing(store, 'owner', 'index'),
      ),
    );
    await expect(
      reserveProcessing(store, 'owner', 'index'),
    ).rejects.toMatchObject({ status: 429 });
    expect((await processingUsage(store, 'owner')).indexed).toBe(20);
    expect((await processingUsage(store, 'other')).indexed).toBe(0);
  });
  it('does not index uploaded event photos before organizer consent', async () => {
    const provider = matcher();
    const { app, event } = fixture({ faceMatcher: provider });
    await request(app)
      .post(`/api/photos?eventId=${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('Content-Type', 'application/octet-stream')
      .send(await image())
      .expect(201);
    expect(provider.indexPhoto).not.toHaveBeenCalled();
    await request(app)
      .post(`/api/events/${event.id}/index-faces`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(403);
  });
  it('skips already processed no-face photos rather than paying to retry', async () => {
    const provider = matcher();
    const { app, event, photo, records } = fixture({ faceMatcher: provider });
    records.set(photo.id, { ...photo, indexState: 'empty' });
    await request(app)
      .post(`/api/events/${event.id}/index-faces`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .set('X-PicFind-Consent', 'face-matching-v1')
      .expect(200);
    expect(provider.indexPhoto).not.toHaveBeenCalled();
  });
  it('indexes owned library photos without any Drive connection', async () => {
    const provider = matcher();
    const { app, photo, files, records } = fixture({ faceMatcher: provider });
    const personal = { ...photo };
    delete personal.eventId;
    records.set(photo.id, personal);
    files.set(photo.id, await image());
    const response = await request(app)
      .post('/api/discover/scans')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({
        photoIds: [photo.id],
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(201);
    expect(response.body.scan.indexed).toBe(1);
    expect(provider.indexPhoto).toHaveBeenCalledOnce();
  });
  it('does not copy an event photo into the older personal Discover path', async () => {
    const provider = matcher();
    const { app, photo, records } = fixture({ faceMatcher: provider });
    const response = await request(app)
      .post('/api/discover/scans')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({
        photoIds: [photo.id],
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(201);
    expect(response.body.scan.state).toBe('failed');
    expect(provider.indexPhoto).not.toHaveBeenCalled();
    expect(
      [...records.values()].filter((row) => row.kind === 'photo'),
    ).toHaveLength(1);
  });
  it('does not process another account library photo', async () => {
    const provider = matcher();
    const { app, photo } = fixture({ faceMatcher: provider });
    const response = await request(app)
      .post('/api/discover/scans')
      .set('Cookie', 'picfind_session=other')
      .set('Origin', origin)
      .send({
        photoIds: [photo.id],
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(201);
    expect(response.body.scan.state).toBe('failed');
    expect(provider.indexPhoto).not.toHaveBeenCalled();
  });
});
describe('cloud source isolation and read-only imports', () => {
  it('encrypts tokens and rejects tampered or expired cookies', () => {
    const sealed = sealSource(
      {
        owner: 'owner',
        provider: 'dropbox',
        expires: Date.now() + 60_000,
        value: 'secret',
      },
      key,
    );
    expect(sealed).not.toContain('secret');
    expect(openSource(sealed, key)?.value).toBe('secret');
    expect(openSource(sealed + 'bad', key)).toBeNull();
    expect(
      openSource(
        sealSource(
          { owner: 'owner', provider: 'box', expires: 1, value: 'secret' },
          key,
        ),
        key,
      ),
    ).toBeNull();
  });
  it.each([
    'http://dl.dropboxusercontent.com/photo',
    'https://localhost/photo',
    'https://dropboxusercontent.com.attacker.test/photo',
    'https://user:password@dl.dropboxusercontent.com/photo',
    'https://dl.dropboxusercontent.com:444/photo',
  ])('rejects an unsafe storage URL: %s', (url) => {
    expect(() => trustedSourceDownload('dropbox', url)).toThrow();
  });
  it('accepts only a provider storage host', () => {
    expect(
      trustedSourceDownload(
        'dropbox',
        'https://dl.dropboxusercontent.com/photo',
      ).hostname,
    ).toBe('dl.dropboxusercontent.com');
  });
  it('requires authentication and reports missing provider setup honestly', async () => {
    const { app } = fixture();
    await request(app).get('/api/sources').expect(401);
    const result = await request(app)
      .get('/api/sources')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(
      result.body.sources.every(
        (source: { configured: boolean }) => !source.configured,
      ),
    ).toBe(true);
    await request(app)
      .post('/api/sources/dropbox/connect')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(503);
  });
  it('binds source cookies to the signed-in account', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { app } = fixture({
      sources: {
        key,
        providers: { dropbox: { clientId: 'id', clientSecret: 'secret' } },
        fetcher,
      },
    });
    await request(app)
      .get('/api/sources/dropbox/items')
      .set('Cookie', `picfind_session=other; ${cookie()}`)
      .expect(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses state and PKCE without exposing the client secret', async () => {
    const { app } = fixture({
      sources: {
        key,
        providers: { dropbox: { clientId: 'id', clientSecret: 'top-secret' } },
      },
    });
    const result = await request(app)
      .post('/api/sources/dropbox/connect')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(200);
    expect(result.body.url).toContain('code_challenge=');
    expect(result.body.url).not.toContain('top-secret');
    const callback = await request(app)
      .get('/api/sources/dropbox/callback?state=wrong&code=fake')
      .set('Cookie', 'picfind_session=owner')
      .expect(302);
    expect(callback.headers.location).toContain('connected=0');
  });
  it('imports selected bytes, strips CDN authorization, and makes no cloud writes', async () => {
    const bytes = await image();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/get_temporary_link')) {
          expect(init?.method).toBe('POST');
          return Response.json({
            metadata: { name: 'fixture.jpg' },
            link: 'https://dl.dropboxusercontent.com/fixture.jpg',
          });
        }
        expect(url).toBe('https://dl.dropboxusercontent.com/fixture.jpg');
        expect(init?.headers).toBeUndefined();
        return new Response(new Uint8Array(bytes));
      });
    const { app } = fixture({
      sources: {
        key,
        providers: { dropbox: { clientId: 'id', clientSecret: 'secret' } },
        fetcher,
      },
    });
    const result = await request(app)
      .post('/api/imports/source')
      .set('Cookie', `picfind_session=owner; ${cookie()}`)
      .set('Origin', origin)
      .send({ provider: 'dropbox', ids: ['id:test'] })
      .expect(201);
    expect(result.body.job.imported).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('gallery protection and client proofing', () => {
  it('salts passcodes and verifies without storing plaintext', async () => {
    const hash = await hashPasscode('event-secret');
    expect(hash).not.toContain('event-secret');
    expect(await verifyPasscode('event-secret', hash)).toBe(true);
    expect(await verifyPasscode('wrong', hash)).toBe(false);
  });
  it('gates gallery, image bytes and face search; unlock cookies work', async () => {
    const { app, event, photo, records } = fixture();
    records.set(event.id, {
      ...event,
      passcodeHash: await hashPasscode('secret-pass'),
    });
    await request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(401);
    await request(app)
      .get(`/api/public/events/${event.id}/photos/${photo.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(401);
    await request(app)
      .post(`/api/public/events/${event.id}/find`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .expect(401);
    await request(app)
      .post(`/api/public/events/${event.id}/unlock`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ passcode: 'wrong' })
      .expect(403);
    const unlocked = await request(app)
      .post(`/api/public/events/${event.id}/unlock`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ passcode: 'secret-pass' })
      .expect(204);
    const cookies = [
      'picfind_session=guest',
      ...unlocked.headers['set-cookie']!,
    ];
    await request(app)
      .get(`/api/public/events/${event.id}/photos/${photo.id}`)
      .set('Cookie', 'picfind_session=guest')
      .set('Cookie', cookies)
      .expect(200);
    records.set(event.id, {
      ...event,
      passcodeHash: await hashPasscode('new-pass'),
    });
    await request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .set('Cookie', cookies)
      .expect(401);
  });
  it('never exposes a passcode hash through library data', async () => {
    const { app, event, records } = fixture();
    records.set(event.id, {
      ...event,
      passcodeHash: await hashPasscode('secret-pass'),
    });
    const result = await request(app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(result.body.events[0].passcodeHash).toBeUndefined();
    expect(result.body.events[0].hasPasscode).toBe(true);
  });
  it('stores valid selections, rejects foreign photos, and hides submissions from guests', async () => {
    const { app, event, photo } = fixture();
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ name: 'Guest', photoIds: [randomUUID()] })
      .expect(400);
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Cookie', 'picfind_session=guest')
      .set('Origin', origin)
      .send({ name: 'Guest', note: 'Album cover', photoIds: [photo.id] })
      .expect(201);
    await request(app).get(`/api/events/${event.id}/insights`).expect(401);
    await request(app)
      .get(`/api/events/${event.id}/insights`)
      .set('Cookie', 'picfind_session=other')
      .expect(404);
    const result = await request(app)
      .get(`/api/events/${event.id}/insights`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(result.body.submissions).toBe(1);
    expect(result.body.selections[0].photoIds).toEqual([photo.id]);
    const library = await request(app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(library.body.jobs).toHaveLength(0);
  });
  it('protects CSV consumers from formulas and quotes', () => {
    expect(safeCsv('=IMPORTDATA("x")')).toBe('"\'=IMPORTDATA(""x"")"');
  });
  it('persists owner count rules, exposes only the policy to guests, and counts unique IDs', async () => {
    const { app, event, photo, records } = fixture();
    const second = { ...photo, id: randomUUID() };
    records.set(second.id, second);
    const route = `/api/events/${event.id}/selection-rules`;
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .send({ minimum: 2, maximum: 2 })
      .expect(401);
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=other')
      .send({ minimum: 2, maximum: 2 })
      .expect(404);
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ minimum: 2, maximum: 2 })
      .expect(200);
    expect(records.get(event.id)).toMatchObject({
      selectionMinimum: 2,
      selectionMaximum: 2,
    });
    const access = await request(app)
      .get(`/api/public/events/${event.id}/access`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(access.body).toEqual({
      brandingName: '',
      accentColor: '#173f37',
      selectionRules: { minimum: 2, maximum: 2 },
      selectionWindow: {
        closed: false,
        invalid: false,
        closesAt: null,
        serverNow: expect.any(String),
      },
    });
    const submit = (ids: string[]) =>
      request(app)
        .post(`/api/public/events/${event.id}/selections`)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=guest')
        .send({ name: 'Guest', photoIds: ids });
    const rejected = await submit([photo.id, photo.id]).expect(400);
    expect(rejected.body.error.code).toBe('SELECTION_COUNT_REQUIRED');
    await submit([photo.id, second.id]).expect(201);
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ minimum: 1, maximum: 1 })
      .expect(200);
    await submit([photo.id, second.id]).expect(400);
    const insights = await request(app)
      .get(`/api/events/${event.id}/insights`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(insights.body.selectionRules).toEqual({ minimum: 1, maximum: 1 });
    expect(insights.body.selections).toHaveLength(1);
    expect(insights.body.selections[0].photoIds).toEqual([photo.id, second.id]);
  });
  it.each([
    { minimum: 0, maximum: 10 },
    { minimum: 2, maximum: 1 },
    { minimum: 1, maximum: 101 },
    { minimum: 1.5, maximum: 2 },
    { minimum: '1', maximum: 2 },
    { minimum: 1, maximum: 2, ownerId: 'other' },
  ])(
    'rejects invalid rules without changing stored data: %j',
    async (rules) => {
      const { app, event, records } = fixture();
      await request(app)
        .patch(`/api/events/${event.id}/selection-rules`)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=owner')
        .send(rules)
        .expect(400);
      expect(records.get(event.id)?.selectionMinimum).toBeUndefined();
    },
  );
  it('fails closed on invalid persisted rules while allowing the owner to repair them', async () => {
    const { app, event, photo, records } = fixture();
    records.set(event.id, {
      ...event,
      selectionMinimum: 20,
      selectionMaximum: 2,
    });
    const access = await request(app)
      .get(`/api/public/events/${event.id}/access`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(access.body.selectionRules).toBeNull();
    await request(app)
      .get(`/api/public/events/${event.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=guest')
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(409);
    await request(app)
      .get(`/api/events/${event.id}/insights`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    await request(app)
      .patch(`/api/events/${event.id}/selection-rules`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ minimum: 1, maximum: 100 })
      .expect(200);
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=guest')
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(201);
  });
});
describe('favorites submission deadlines', () => {
  it('enforces the server deadline, preserves the gallery, and reopens without losing submissions', async () => {
    const { app, event, photo, records } = fixture();
    const initial = Date.parse('2026-10-20T12:00:00.000Z');
    let now = initial;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const deadline = new Date(initial + 60_000).toISOString();
      const change = (body: object) =>
        request(app)
          .patch(`/api/events/${event.id}/selection-window`)
          .set('Origin', origin)
          .set('Cookie', 'picfind_session=owner')
          .send(body);
      await change({ action: 'schedule', closesAt: deadline }).expect(200);
      expect(records.get(event.id)?.selectionClosesAt).toBe(deadline);
      const submit = () =>
        request(app)
          .post(`/api/public/events/${event.id}/selections`)
          .set('Origin', origin)
          .set('Cookie', 'picfind_session=guest')
          .send({ name: 'Guest', photoIds: [photo.id] });
      now = initial + 59_999;
      await submit().expect(201);
      now++;
      expect((await submit().expect(409)).body.error.code).toBe(
        'SELECTIONS_CLOSED',
      );
      await request(app)
        .get(`/api/public/events/${event.id}`)
        .set('Cookie', 'picfind_session=guest')
        .expect(200);
      const access = await request(app)
        .get(`/api/public/events/${event.id}/access`)
        .set('Cookie', 'picfind_session=guest')
        .expect(200);
      expect(access.body.selectionWindow).toEqual({
        closesAt: deadline,
        serverNow: deadline,
        closed: true,
        invalid: false,
      });
      await change({ action: 'open' }).expect(200);
      await submit().expect(201);
      const insights = await request(app)
        .get(`/api/events/${event.id}/insights`)
        .set('Cookie', 'picfind_session=owner')
        .expect(200);
      expect(insights.body.selections).toHaveLength(2);
      await change({ action: 'close' }).expect(200);
      expect(records.get(event.id)?.selectionClosesAt).toBe(
        new Date(now).toISOString(),
      );
      await submit().expect(409);
    } finally {
      clock.mockRestore();
    }
  });
  it('checks the deadline again after asynchronous storage reads', async () => {
    const { app, event, photo, store, records } = fixture();
    const initial = Date.parse('2026-10-20T12:00:00.000Z');
    let now = initial;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    records.set(event.id, {
      ...event,
      selectionClosesAt: new Date(initial + 1000).toISOString(),
    });
    const original = store.list;
    store.list = async (owner, kind) => {
      const rows = await original(owner, kind);
      if (kind === 'job') now += 1001;
      return rows;
    };
    try {
      const response = await request(app)
        .post(`/api/public/events/${event.id}/selections`)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=guest')
        .send({ name: 'Guest', photoIds: [photo.id] })
        .expect(409);
      expect(response.body.error.code).toBe('SELECTIONS_CLOSED');
      expect(
        [...records.values()].filter((row) => row.purpose === 'selection'),
      ).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });
  it('requires the owner and validates deadlines without modifying the event', async () => {
    const { app, event, records } = fixture();
    const route = `/api/events/${event.id}/selection-window`;
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .send({ action: 'close' })
      .expect(401);
    await request(app)
      .patch(route)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=other')
      .send({ action: 'close' })
      .expect(404);
    const expiry = new Date(Date.now() + 60_000).toISOString();
    records.set(event.id, { ...event, expiresAt: expiry });
    for (const body of [
      { action: 'schedule', closesAt: 'invalid' },
      { action: 'schedule', closesAt: '2020-01-01T00:00:00.000Z' },
      {
        action: 'schedule',
        closesAt: new Date(Date.now() + 120_000).toISOString(),
      },
      { action: 'open', closesAt: expiry },
      { action: 'close', ownerId: 'other' },
    ]) {
      await request(app)
        .patch(route)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=owner')
        .send(body)
        .expect(400);
    }
    expect(records.get(event.id)?.selectionClosesAt).toBeUndefined();
  });
  it('allows repair of an invalid deadline without hiding the gallery', async () => {
    const { app, event, photo, records } = fixture();
    records.set(event.id, { ...event, selectionClosesAt: 'broken' });
    const access = await request(app)
      .get(`/api/public/events/${event.id}/access`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(access.body.selectionWindow).toMatchObject({
      invalid: true,
      closed: true,
    });
    await request(app)
      .post(`/api/public/events/${event.id}/selections`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=guest')
      .send({ name: 'Guest', photoIds: [photo.id] })
      .expect(409);
    await request(app)
      .patch(`/api/events/${event.id}/selection-window`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ action: 'open' })
      .expect(200);
    expect(records.get(event.id)?.selectionClosesAt).toBe('');
  });
});

describe('provider erasure and retryability', () => {
  it('retains event and photos after failed provider cleanup', async () => {
    const provider = matcher();
    vi.mocked(provider.deleteScope).mockRejectedValueOnce(new Error('offline'));
    const { app, event, photo, records } = fixture({ faceMatcher: provider });
    await request(app)
      .delete(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(503);
    expect(records.get(event.id)?.archived).toBe(true);
    expect(records.has(photo.id)).toBe(true);
    await request(app)
      .delete(`/api/events/${event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(204);
    expect(records.has(event.id)).toBe(false);
  });
  it('retains account cleanup references while a provider is offline', async () => {
    const { store, photo, records } = fixture();
    records.set(photo.id, {
      ...photo,
      faceIds: ['face'],
      provider: 'aws-rekognition',
    });
    const guarded = withAccountFaceCleanup(store, undefined)!;
    await expect(guarded.remove(photo.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(records.has(photo.id)).toBe(true);
    const provider = matcher();
    await withAccountFaceCleanup(store, provider)!.remove(photo.id);
    expect(provider.deleteFaces).toHaveBeenCalledWith(
      { kind: 'event', id: photo.eventId },
      ['face'],
    );
    expect(records.has(photo.id)).toBe(false);
  });
});
