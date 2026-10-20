import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import { createApp } from '../../apps/api/src/app.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  addMonths,
  planById,
  type BillingOrder,
  type BillingProvider,
  type PaymentSnapshot,
  type PlanId,
} from '../../apps/api/src/billing/model.js';
import {
  eventCreationId,
  type EventBillingTransaction,
} from '../../apps/api/src/billing/event-entitlements.js';
import type { LibraryStore } from '../../apps/api/src/library.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const origin = 'http://localhost:5173';
const now = '2026-09-21T10:00:00.000Z';
const expiry = (days: number) =>
  new Date(Date.parse(now) + days * 86400000).toISOString();
async function fixture(plan?: PlanId) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const store = new ImportTestBillingStore(),
    owner = randomUUID();
  const provider: BillingProvider = {
    checkout: vi.fn(async (order) => ({
      sessionId: 'session_' + order.id,
      url: 'https://checkout.example.test/' + order.id,
    })),
    portal: vi.fn(),
    verify: vi.fn(),
  };
  const billing = new BillingService(
    store,
    provider,
    plan ? { [plan + ':INR']: 'pdt_synthetic' } : {},
    'test_mode',
    true,
    true,
  );
  const user = {
    id: owner,
    email: 'synthetic@example.test',
    name: 'Synthetic',
    emailVerified: true,
  };
  await billing.summary(owner);
  if (plan) {
    const requestId = randomUUID();
    await billing.checkout(user, requestId, plan, 'INR');
    const order = (await store.transaction((tx) =>
      tx.get<BillingOrder>(billing.key('order', owner + ':' + requestId)),
    ))!;
    const payment: PaymentSnapshot = {
      id: 'pay_' + randomUUID(),
      orderId: order.id,
      customerId: 'customer_synthetic',
      productId: order.productId,
      quantity: 1,
      currency: 'INR',
      status: 'succeeded',
      total: planById(plan).inr * 100,
      refunded: 0,
      held: false,
      createdAt: now,
      observedAt: now,
      setupOnly: false,
      sessionId: order.sessionId!,
      ...(plan.startsWith('organizer-')
        ? {
            subscription: {
              id: 'sub_synthetic',
              orderId: order.id,
              customerId: 'customer_synthetic',
              productId: order.productId,
              status: 'active' as const,
              nextBillingAt: addMonths(now, plan.endsWith('yearly') ? 12 : 1),
              cancelAtPeriodEnd: false,
              observedAt: now,
            },
          }
        : {}),
    };
    await billing.apply({
      id: randomUUID(),
      type: 'payment.succeeded',
      payment,
    });
  }
  const library: LibraryStore = {
    get: async (id) => {
      const row = store.events.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (user, kind) =>
      [...store.events.values()].filter(
        (row) => row.ownerId === user && row.kind === kind,
      ),
    put: async (row) => {
      store.events.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      store.events.delete(id);
    },
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (secret) => ({ ...user, id: secret }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store: library, billing },
  );
  const create = (body: object, actor: string = owner) =>
    request(app)
      .post('/api/events')
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=' + actor)
      .send(body);
  const patch = (id: string, body: object, actor: string = owner) =>
    request(app)
      .patch('/api/events/' + id)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=' + actor)
      .send(body);
  return { app, store, owner, billing, library, create, patch };
}
describe('organizer event entitlement and atomic live capacity, synthetic payments only', () => {
  it('persists selection count metadata through the billing event transaction', async () => {
    const f = await fixture('organizer-starter-monthly');
    const created = await f
      .create({ title: 'Proofing', expiresAt: expiry(7) })
      .expect(201);
    const id = created.body.event.id as string;
    await request(f.app)
      .patch(`/api/events/${id}/selection-rules`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.owner}`)
      .send({ minimum: 5, maximum: 12 })
      .expect(200);
    expect(f.store.events.get(id)).toMatchObject({
      selectionMinimum: 5,
      selectionMaximum: 12,
      title: 'Proofing',
      expiresAt: expiry(7),
      visibility: 'private',
    });
    const insights = await request(f.app)
      .get(`/api/events/${id}/insights`)
      .set('Cookie', `picfind_session=${f.owner}`)
      .expect(200);
    expect(insights.body.selectionRules).toEqual({ minimum: 5, maximum: 12 });
  });
  it.each([undefined, 'personal-1000'] as const)(
    'does not let %s personal credit host events',
    async (plan) => {
      const f = await fixture(plan);
      const result = await f
        .create({ title: 'Not entitled', expiresAt: expiry(1) })
        .expect(402);
      expect(result.body.error.code).toBe('ORGANIZER_PLAN_REQUIRED');
      expect(f.store.events.size).toBe(0);
      expect((await f.billing.eventPolicy(f.owner)).canCreate).toBe(false);
    },
  );
  it.each([
    ['organizer-starter-monthly', 30],
    ['organizer-pro-yearly', 90],
    ['organizer-scale-monthly', 365],
  ] as const)('enforces the %s retention cap', async (plan, days) => {
    const f = await fixture(plan);
    await f.create({ title: 'Missing expiry' }).expect(400);
    const tooLate = await f
      .create({
        title: 'Too late',
        expiresAt: new Date(Date.parse(expiry(days)) + 1).toISOString(),
      })
      .expect(400);
    expect(tooLate.body.error.code).toBe('EVENT_RETENTION_LIMIT');
    await f.create({ title: 'Past', expiresAt: expiry(-1) }).expect(400);
    const result = await f
      .create({ title: 'Valid', expiresAt: expiry(days), visibility: 'link' })
      .expect(201);
    expect(result.body.event.expiresAt).toBe(expiry(days));
    expect(result.body.event.visibility).toBe('private');
  });
  it('serializes competing creates against the paid live-event limit', async () => {
    const f = await fixture('organizer-starter-monthly');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        f.billing.saveOrganizerEvent(
          f.owner,
          randomUUID(),
          { title: String(i), expiresAt: expiry(2) },
          true,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(6);
    expect(f.store.events.size).toBe(2);
    expect(await f.billing.eventPolicy(f.owner)).toMatchObject({
      activeEvents: 2,
      remainingEvents: 0,
      canCreate: false,
    });
  });
  it('releases an archived event slot but rejects restoring it over capacity', async () => {
    const f = await fixture('organizer-starter-monthly');
    const first = (
      await f.create({ title: 'One', expiresAt: expiry(2) }).expect(201)
    ).body.event;
    await f.create({ title: 'Two', expiresAt: expiry(2) }).expect(201);
    await f.patch(first.id, { archived: true }).expect(200);
    await f.create({ title: 'Three', expiresAt: expiry(2) }).expect(201);
    await f.patch(first.id, { archived: false }).expect(409);
    expect(f.store.events.get(first.id)?.archived).toBe(true);
  });
  it('replays the original event after an ambiguous commit without consuming another slot', async () => {
    const f = await fixture('organizer-starter-monthly');
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce(async (work) => {
      await original(work);
      throw new ApiError(
        503,
        'SYNTHETIC_LOST_REPLY',
        'Synthetic lost commit acknowledgement',
      );
    });
    const requestId = randomUUID(),
      body = { requestId, title: 'Idempotent', expiresAt: expiry(2) };
    await f.create(body).expect(503);
    const replay = await f.create(body).expect(201);
    expect(replay.body.event.id).toBe(eventCreationId(f.owner, requestId));
    expect(f.store.events.size).toBe(1);
    await f.create({ ...body, title: 'Different' }).expect(409);
  });
  it('rolls back event and capacity revision together on a staged write failure', async () => {
    const f = await fixture('organizer-starter-monthly');
    const before = structuredClone(f.store.rows);
    const original = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementationOnce((work) =>
      original(async (tx) => {
        (tx as typeof tx & EventBillingTransaction).events.put = async () => {
          throw new ApiError(
            503,
            'SYNTHETIC_FAILURE',
            'Synthetic staged failure',
          );
        };
        return work(tx);
      }),
    );
    await f
      .create({ title: 'No partial state', expiresAt: expiry(2) })
      .expect(503);
    expect(f.store.events.size).toBe(0);
    expect(f.store.rows).toEqual(before);
  });
  it('enforces expiry updates and event ownership on the existing route', async () => {
    const f = await fixture('organizer-starter-monthly');
    const event = (
      await f.create({ title: 'Owned', expiresAt: expiry(2) }).expect(201)
    ).body.event;
    await f.patch(event.id, { expiresAt: expiry(31) }).expect(400);
    await f.patch(event.id, { expiresAt: '' }).expect(400);
    await f.patch(event.id, { archived: true }, 'guest').expect(404);
    expect(f.store.events.get(event.id)?.expiresAt).toBe(expiry(2));
  });
  it('counts undated legacy events until the owner chooses expiry or archives them', async () => {
    const f = await fixture('organizer-starter-monthly');
    const id = randomUUID();
    f.store.events.set(id, {
      id,
      ownerId: f.owner,
      kind: 'event',
      title: 'Older event',
      createdAt: now,
      visibility: 'private',
    });
    expect((await f.billing.eventPolicy(f.owner)).activeEvents).toBe(1);
    await f.patch(id, { visibility: 'link' }).expect(400);
    await f.patch(id, { expiresAt: expiry(3), visibility: 'link' }).expect(200);
  });
  it('reclaims expired slots and rechecks entitlement after its paid term ends', async () => {
    const f = await fixture('organizer-starter-monthly');
    await f.create({ title: 'One', expiresAt: expiry(1) }).expect(201);
    await f.create({ title: 'Two', expiresAt: expiry(1) }).expect(201);
    vi.setSystemTime(new Date(expiry(2)));
    expect((await f.billing.eventPolicy(f.owner)).remainingEvents).toBe(2);
    vi.setSystemTime(new Date(expiry(40)));
    await f.create({ title: 'Not renewed', expiresAt: expiry(41) }).expect(402);
  });
});
