import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { JobQueue, publicJob } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';

afterEach(() => vi.unstubAllEnvs());

async function productionFixture(
  count = 0,
  eventIndexMax = 10000,
  accounting = true,
  worker = true,
) {
  vi.stubEnv('NODE_ENV', 'production');
  const ownerId = randomUUID(),
    eventId = randomUUID();
  const event: LibraryRecord = {
    id: eventId,
    ownerId,
    kind: 'event',
    title: 'Synthetic event',
    visibility: 'private',
    archived: false,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  const rows = new Map<string, LibraryRecord>([[eventId, event]]);
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    rows.set(id, {
      id,
      ownerId,
      eventId,
      kind: 'photo',
      createdAt: event.createdAt,
    });
  }
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Synthetic missing row');
      return structuredClone(row);
    },
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    file: vi.fn(async () => new Response(new Uint8Array([1]))),
  };
  const reserveStorage = vi.fn<BillingService['reserveStorage']>(
    async () => {},
  );
  const eventBilling = await paidOrganizerBilling(
    rows,
    ownerId,
    'organizer-scale-monthly',
  );
  const billing = {
    saveOrganizerEvent: eventBilling.saveOrganizerEvent.bind(eventBilling),
    eventPolicy: eventBilling.eventPolicy.bind(eventBilling),
    retentionDays: async () => 30,
    reserveStorage,
    releaseStorage: vi.fn(async () => {}),
  } as unknown as BillingService;
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(),
    indexPhoto: vi.fn(),
    search: vi.fn(),
    deleteFaces: vi.fn(),
    deleteScope: vi.fn(),
  };
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async () => ({
      id: ownerId,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    }),
  };
  const app = createApp(
    { webOrigin: 'http://localhost:5173', secureCookies: false, provider },
    {
      store,
      eventIndexMax,
      faceMatcher: matcher,
      ...(worker ? { jobQueue: new JobQueue(new TestJobStore()) } : {}),
      ...(accounting ? { billing } : {}),
    },
  );
  const headers = {
    Origin: 'http://localhost:5173',
    Cookie: 'picfind_session=synthetic',
  };
  const upload = async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#246b54' },
    })
      .png()
      .toBuffer();
    return request(app)
      .post(`/api/photos?eventId=${eventId}`)
      .set(headers)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
  };
  return {
    app,
    rows,
    store,
    eventId,
    ownerId,
    headers,
    upload,
    reserveStorage,
    matcher,
  };
}

describe('production capacity without paid provider calls', () => {
  it('does not advertise the development 20-photo library ceiling in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = createApp(
      { webOrigin: 'https://picfind.example', secureCookies: true },
      {},
    );
    const response = await request(app).get('/api/capabilities').expect(200);
    expect(response.body.photoLimit).toBeGreaterThanOrEqual(7500);
  });

  it('keeps the development library safety ceiling at twenty', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const app = createApp(
      { webOrigin: 'http://localhost:5173', secureCookies: false },
      {},
    );
    const response = await request(app).get('/api/capabilities').expect(200);
    expect(response.body.photoLimit).toBe(20);
  });

  it('can represent a full Studio-sized event without issuing provider requests', async () => {
    const queue = new JobQueue(new TestJobStore());
    const ids = Array.from({ length: 7500 }, () => randomUUID());
    const job = await queue.enqueue({
      ownerId: randomUUID(),
      eventId: randomUUID(),
      requestId: randomUUID(),
      photoIds: ids,
      consentPolicyVersion: 'face-matching-v1',
    });
    expect(publicJob(job).total).toBe(7500);
    expect(job.photoIds).toEqual(ids);
  });

  it('allows production event editing, publishing and archiving with a worker configured', async () => {
    const f = await productionFixture(1);
    await request(f.app)
      .patch(`/api/events/${f.eventId}`)
      .set(f.headers)
      .send({ title: 'Updated title' })
      .expect(200);
    await request(f.app)
      .patch(`/api/events/${f.eventId}`)
      .set(f.headers)
      .send({ visibility: 'link' })
      .expect(200);
    await request(f.app)
      .patch(`/api/events/${f.eventId}`)
      .set(f.headers)
      .send({ archived: true })
      .expect(200);
    expect(f.rows.get(f.eventId)).toMatchObject({
      title: 'Updated title',
      visibility: 'link',
      archived: true,
    });
  });

  it('requires the durable worker instead of synchronously processing a production event', async () => {
    const f = await productionFixture(1, 10000, true, false);
    const response = await request(f.app)
      .post(`/api/events/${f.eventId}/index-faces`)
      .set(f.headers)
      .set('X-PicFind-Consent', 'face-matching-v1')
      .send({ requestId: randomUUID() })
      .expect(503);
    expect(response.body.error.code).toBe('JOB_WORKER_UNAVAILABLE');
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });

  it('rejects new event photos at its processing ceiling before storage or a charge', async () => {
    const f = await productionFixture(2, 2);
    const response = await f.upload();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EVENT_PHOTO_LIMIT');
    expect(f.store.upload).not.toHaveBeenCalled();
    expect(f.reserveStorage).not.toHaveBeenCalled();
  });

  it('accepts a paid-account twenty-first photo through the server storage reservation', async () => {
    const f = await productionFixture(20);
    expect((await f.upload()).status).toBe(201);
    expect(f.reserveStorage).toHaveBeenCalledOnce();
    expect(f.reserveStorage.mock.calls[0]?.[0]).toBe(f.ownerId);
    expect(
      [...f.rows.values()].filter((row) => row.kind === 'photo'),
    ).toHaveLength(21);
  });

  it('fails closed without accounting and never uploads after a quota rejection', async () => {
    const missing = await productionFixture(0, 10000, false);
    expect((await missing.upload()).status).toBe(503);
    expect(missing.store.upload).not.toHaveBeenCalled();
    const denied = await productionFixture();
    denied.reserveStorage.mockRejectedValueOnce(
      new ApiError(
        402,
        'STORAGE_ALLOWANCE_EXHAUSTED',
        'Synthetic allowance exhausted',
      ),
    );
    expect((await denied.upload()).status).toBe(402);
    expect(denied.store.upload).not.toHaveBeenCalled();
  });
});

it('allows a production organizer to create more than twenty events', async () => {
  const f = await productionFixture();
  for (let i = 1; i < 20; i++) {
    const id = randomUUID();
    f.rows.set(id, { ...f.rows.get(f.eventId)!, id });
  }
  await request(f.app)
    .post('/api/events')
    .set(f.headers)
    .send({
      title: 'Twenty-first event',
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
    .expect(201);
  expect(
    [...f.rows.values()].filter((row) => row.kind === 'event'),
  ).toHaveLength(21);
});

it('queues a production event beyond twenty photos without starting any paid request', async () => {
  const f = await productionFixture(21);
  const response = await request(f.app)
    .post(`/api/events/${f.eventId}/index-faces`)
    .set(f.headers)
    .set('X-PicFind-Consent', 'face-matching-v1')
    .send({ requestId: randomUUID() })
    .expect(202);
  expect(response.body.job.total).toBe(21);
  expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  expect(f.matcher.ensureScope).not.toHaveBeenCalled();
});

it('preserves omitted sharing, archive, expiry and descriptive fields during an event edit', async () => {
  const f = await productionFixture(1);
  const original = {
    ...f.rows.get(f.eventId)!,
    archived: true,
    visibility: 'link' as const,
    description: 'Keep this description',
    date: '2026-12-20',
    expiresAt: '2026-12-31T00:00:00.000Z',
  };
  f.rows.set(f.eventId, original);
  await request(f.app)
    .patch(`/api/events/${f.eventId}`)
    .set(f.headers)
    .send({ title: 'Only rename' })
    .expect(200);
  expect(f.rows.get(f.eventId)).toEqual({ ...original, title: 'Only rename' });
});
