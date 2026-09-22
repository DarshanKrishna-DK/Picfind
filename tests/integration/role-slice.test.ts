import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { ApiError } from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { studioReturnPath } from '../../packages/shared/src/navigation.js';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';
import {
  catalogPlans,
  estimatePlan,
  ORGANIZER_RETENTION_DAYS,
  PERSONAL_PLANS,
} from '../../packages/shared/src/plans.js';

async function fixture() {
  const id = randomUUID();
  const otherId = randomUUID();
  const photoId = randomUUID();
  const rows = new Map<string, LibraryRecord>([
    [
      id,
      {
        id,
        ownerId: 'owner',
        kind: 'event',
        createdAt: new Date().toISOString(),
        title: 'Secret event',
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        visibility: 'link',
      },
    ],
    [
      otherId,
      {
        id: otherId,
        ownerId: 'owner',
        kind: 'event',
        createdAt: new Date().toISOString(),
        title: 'Other event',
        visibility: 'link',
      },
    ],
    [
      photoId,
      {
        id: photoId,
        ownerId: 'owner',
        eventId: otherId,
        kind: 'photo',
        createdAt: new Date().toISOString(),
        filename: 'other.jpg',
      },
    ],
  ]);
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...rows.values()].filter(
        (row) => row.ownerId === owner && row.kind === kind,
      ),
    get: async (key) => {
      const row = rows.get(key);
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'This gallery is not available.');
      return structuredClone(row);
    },
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: async (key) => {
      rows.delete(key);
    },
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: 'http://localhost:5173',
      secureCookies: false,
      provider: {
        getUser: async (secret) => ({
          id: secret,
          name: secret,
          email: `${secret}@example.test`,
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store, billing: await paidOrganizerBilling(rows, 'owner') },
  );
  return { app, rows, id, otherId, photoId, store };
}
describe('secret-event access boundaries', () => {
  it.each(['', '/access', '/photos/00000000-0000-4000-8000-000000000000'])(
    'requires a session for gallery resource %s',
    async (suffix) => {
      const f = await fixture();
      const result = await request(f.app)
        .get(`/api/public/events/${f.id}${suffix}`)
        .expect(401);
      expect(result.body.error.code).toBe('UNAUTHENTICATED');
      expect(f.store.file).not.toHaveBeenCalled();
    },
  );
  it.each(['/find', '/unlock', '/selections'])(
    'requires a session before guest mutation-like resource %s',
    async (suffix) => {
      const f = await fixture();
      const result = await request(f.app)
        .post(`/api/public/events/${f.id}${suffix}`)
        .set('Origin', 'http://localhost:5173')
        .send({})
        .expect(401);
      expect(result.body.error.code).toBe('UNAUTHENTICATED');
    },
  );
  it('allows a signed-in guest without membership or payment and isolates photos', async () => {
    const f = await fixture();
    const result = await request(f.app)
      .get(`/api/public/events/${f.id}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(200);
    expect(result.body.photos).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('Other event');
    await request(f.app)
      .get(`/api/public/events/${f.id}/photos/${f.photoId}`)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
  });
  it.each(['missing', 'expired', 'private', 'archived'])(
    'keeps %s event access generic',
    async (mode) => {
      const f = await fixture();
      if (mode === 'missing') f.rows.delete(f.id);
      if (mode === 'expired')
        f.rows.get(f.id)!.expiresAt = new Date(0).toISOString();
      if (mode === 'private') f.rows.get(f.id)!.visibility = 'private';
      if (mode === 'archived') f.rows.get(f.id)!.archived = true;
      await request(f.app).get(`/api/public/events/${f.id}/access`).expect(404);
    },
  );
  it('does not give guests organizer edit or delete rights', async () => {
    const f = await fixture();
    await request(f.app)
      .patch(`/api/events/${f.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=guest')
      .send({ title: 'Takeover' })
      .expect(404);
    await request(f.app)
      .delete(`/api/events/${f.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
    expect(f.rows.get(f.id)?.title).toBe('Secret event');
  });
  it('allows the owner to share an empty event before uploading', async () => {
    const f = await fixture();
    f.rows.get(f.id)!.visibility = 'private';
    await request(f.app)
      .patch(`/api/events/${f.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=owner')
      .send({ visibility: 'link' })
      .expect(200);
    expect(f.rows.get(f.id)?.visibility).toBe('link');
  });
});
describe('safe event sign-in destination', () => {
  it('retains exactly the invited event', () => {
    const path = `/e/${randomUUID()}`;
    expect(studioReturnPath(path)).toBe(path);
    expect(studioReturnPath('/app/events')).toBe('/app/events');
  });
  it.each([
    '//evil.test',
    'https://evil.test',
    '/e/../app',
    '/e/not-an-id',
    `/e/${randomUUID()}?next=https://evil.test`,
    '/app/../../e/secret',
  ])('rejects unsafe destination %s', (value) =>
    expect(studioReturnPath(value)).toBe('/app'),
  );
});
describe('separate personal and organizer catalogs', () => {
  it('offers only discounted one-time personal packs with proportional searches', () => {
    expect(
      PERSONAL_PLANS.map((plan) => [plan.photos, plan.inr, plan.searches]),
    ).toEqual([
      [250, 99, 250],
      [500, 179, 500],
      [1000, 299, 1000],
    ]);
    expect(
      PERSONAL_PLANS.every(
        (plan) => plan.cadence === 'once' && plan.liveEvents === 0,
      ),
    ).toBe(true);
    expect(179 / 500).toBeLessThan(99 / 250);
    expect(299 / 1000).toBeLessThan(179 / 500);
  });
  it.each(['INR', 'USD'] as const)(
    'finds pack combinations without subscription mixing in %s',
    (currency) => {
      const result = estimatePlan(1250, false, currency);
      expect(result.capacity).toBe(1250);
      expect(result.inr).toBe(398);
      expect(result.usd).toBe(5);
      expect(result.items.every((item) => item.plan.scope === 'personal')).toBe(
        true,
      );
    },
  );
  it('prices yearly at ten monthly and keeps the same monthly capacity', () => {
    const monthly = catalogPlans('organizer');
    const yearly = catalogPlans('organizer', 'yearly');
    monthly.forEach((plan, index) => {
      expect(yearly[index]!.inr).toBe(plan.inr * 10);
      expect(yearly[index]!.usd).toBe(plan.usd * 10);
      expect(yearly[index]!.photos).toBe(plan.photos);
      expect(yearly[index]!.retentionDays).toBe(plan.retentionDays);
    });
    expect(ORGANIZER_RETENTION_DAYS).toEqual({
      starter: 30,
      pro: 90,
      scale: 365,
    });
  });
  it('never offers personal packs to fill an organizer allowance gap', () => {
    expect(estimatePlan(2501, true).plan.name).toBe('Pro');
    expect(estimatePlan(20, true).plan.name).toBe('Starter');
    expect(estimatePlan(50001, true).fits).toBe(false);
    expect(estimatePlan(10000, true, 'INR', 'yearly').inr).toBe(19990);
  });
});
