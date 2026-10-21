import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth';
import { preflightFixture } from '../fixtures/upload-preflight';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import { PREFLIGHT_ACTOR } from '../../packages/shared/src/upload-preflight';
import { markDeletedAccount } from '../../apps/api/src/locks';
import { createApp } from '../../apps/api/src/app';

describe('read-only upload batch preflight', () => {
  it('rejects a deleted account before reading private records', async () => {
    const f = preflightFixture();
    const read = vi.spyOn(f.store, 'list');
    markDeletedAccount(f.ownerId);
    expect((await f.inspect()).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not report production readiness when upload accounting is unavailable', async () => {
    const f = preflightFixture();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let app;
    try {
      app = createApp(
        {
          provider: f.provider,
          webOrigin: questionnaireOrigin,
          secureCookies: false,
        },
        { store: f.store },
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    const response = await request(app)
      .post('/api/photos/preflight')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('Origin', questionnaireOrigin)
      .set(PREFLIGHT_ACTOR, f.ownerId)
      .send(f.command);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('USAGE_ACCOUNTING_UNAVAILABLE');
  });

  it('classifies exact-input reuse and new candidates without private filenames or mutations', async () => {
    const f = preflightFixture();
    const before = JSON.stringify([...f.records]);
    const spies = ['put', 'remove', 'upload', 'file', 'removeFile'].map(
      (name) => vi.spyOn(f.store, name as 'put'),
    );
    const result = await f.inspect();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      requestId: f.command.requestId,
      accountId: f.ownerId,
      eventId: f.eventId,
      reusable: 1,
      newCandidates: 1,
      inputBytes: 360,
      newInputBytes: 240,
      librarySlotsRemaining: 17,
      eventSlotsRemaining: 17,
      photoSlotsFit: true,
      outputStorageVerified: false,
      reservationCreated: false,
    });
    expect(result.body.items).toEqual([
      { id: f.items[0]!.id, status: 'reusable', inputBytes: 120 },
      { id: f.items[1]!.id, status: 'new-candidate', inputBytes: 240 },
    ]);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(result.body)).not.toContain(f.photos[0]!.filename);
    expect(JSON.stringify(result.body)).not.toContain(f.photos[0]!.id);
    expect(JSON.stringify([...f.records])).toBe(before);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it('requires a session, trusted origin, matching actor and current ownership', async () => {
    const f = preflightFixture();
    expect(
      (
        await request(f.app)
          .post('/api/photos/preflight')
          .set('Origin', questionnaireOrigin)
          .send(f.command)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(f.app)
          .post('/api/photos/preflight')
          .set('Cookie', `picfind_session=${f.ownerId}`)
          .set('Origin', 'https://other.example.test')
          .set(PREFLIGHT_ACTOR, f.ownerId)
          .send(f.command)
      ).status,
    ).toBe(403);
    expect((await f.inspect({}, f.ownerId, f.strangerId)).status).toBe(409);
    expect((await f.inspect({}, f.strangerId)).status).toBe(404);
    const event = f.records.get(f.eventId)!;
    event.members = [
      {
        userId: f.clientId,
        role: 'moderator',
        addedAt: event.createdAt,
        grantId: randomUUID(),
      },
    ];
    expect((await f.inspect({}, f.clientId)).status).toBe(404);
  });

  it.each([
    { items: [] },
    {
      items: Array.from({ length: 101 }, () => ({
        id: randomUUID(),
        digest: 'a'.repeat(64),
        size: 100,
      })),
    },
    { items: [{ id: randomUUID(), digest: 'invalid', size: 100 }] },
    { items: [{ id: randomUUID(), digest: 'a'.repeat(64), size: 0 }] },
    {
      items: [
        { id: randomUUID(), digest: 'a'.repeat(64), size: 8 * 1024 * 1024 + 1 },
      ],
    },
    { eventId: {} },
    { extra: true },
  ])('rejects malformed or over-budget commands %#', async (changes) => {
    const f = preflightFixture();
    expect((await f.inspect(changes)).status).toBe(400);
  });

  it('rejects repeated identities and content hashes', async () => {
    const f = preflightFixture();
    expect(
      (
        await f.inspect({
          items: [f.items[0], { ...f.items[1], id: f.items[0]!.id }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.inspect({
          items: [f.items[0], { ...f.items[1], digest: f.items[0]!.digest }],
        })
      ).status,
    ).toBe(400);
  });

  it('never reuses photos from another owner, event or scan', async () => {
    for (const patch of [
      { ownerId: randomUUID() },
      { eventId: randomUUID() },
      { scanId: randomUUID() },
      { scanId: '' },
    ]) {
      const f = preflightFixture();
      Object.assign(f.records.get(f.photos[0]!.id)!, patch);
      const response = await f.inspect();
      expect(response.status).toBe(200);
      expect(response.body.reusable).toBe(0);
    }
    const f = preflightFixture();
    expect((await f.inspect({ eventId: null })).body.reusable).toBe(0);
    delete f.records.get(f.photos[0]!.id)!.eventId;
    const response = await f.inspect({ eventId: null });
    expect(response.body.reusable).toBe(1);
    expect(response.body.eventSlotsRemaining).toBeNull();
  });

  it.each([
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: 'invalid' },
    { deletionStartedAt: new Date().toISOString() },
    { deletionCompletedAt: new Date().toISOString() },
  ])('excludes unavailable replay candidates %#', async (patch) => {
    const f = preflightFixture();
    Object.assign(f.records.get(f.photos[0]!.id)!, patch);
    expect((await f.inspect()).body.reusable).toBe(0);
  });

  it('allows an exact-input-only retry at full safety capacity but flags new candidates', async () => {
    const f = preflightFixture();
    for (let index = 3; index < 20; index++) {
      const id = randomUUID();
      const row = { ...f.photos[1]!, id };
      delete row.uploadInputDigest;
      f.records.set(id, row);
    }
    const reused = await f.inspect({ items: [f.items[0]] });
    expect(reused.body).toMatchObject({
      librarySlotsRemaining: 0,
      eventSlotsRemaining: 0,
      reusable: 1,
      photoSlotsFit: true,
    });
    expect((await f.inspect()).body.photoSlotsFit).toBe(false);
  });

  it.each(['removed', 'changed', 'moved'] as const)(
    'rechecks a listed candidate that becomes %s',
    async (action) => {
      const f = preflightFixture();
      const original = f.store.get;
      vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
        if (id === f.photos[0]!.id) {
          if (action === 'removed')
            throw new ApiError(404, 'NOT_FOUND', 'Missing');
          const row = await original(id);
          return action === 'changed'
            ? { ...row, uploadInputDigest: 'f'.repeat(64) }
            : { ...row, eventId: randomUUID() };
        }
        return original(id);
      });
      expect((await f.inspect()).body.reusable).toBe(0);
    },
  );

  it('propagates candidate storage failures and does not guess that an input is new', async () => {
    const f = preflightFixture();
    const original = f.store.get;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.photos[0]!.id)
        throw new ApiError(503, 'UNAVAILABLE', 'Try again');
      return original(id);
    });
    expect((await f.inspect()).status).toBe(503);
  });

  it('rechecks destination availability after candidate reads', async () => {
    const f = preflightFixture();
    const original = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const row = await original(id);
      if (id === f.eventId && ++reads === 2) return { ...row, archived: true };
      return row;
    });
    expect((await f.inspect()).status).toBe(409);
  });

  it('checks all 100 unique inputs while bounding concurrent reuse reads', async () => {
    const f = preflightFixture();
    const items = Array.from({ length: 100 }, (_, index) => {
      const id = randomUUID(),
        digest = index.toString(16).padStart(64, '0');
      f.records.set(id, { ...f.photos[0]!, id, uploadInputDigest: digest });
      return { id: randomUUID(), digest, size: 50 };
    });
    const original = f.store.get;
    let active = 0,
      peak = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await original(id);
      } finally {
        active--;
      }
    });
    const response = await f.inspect({ items });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(response.body.reusable).toBe(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
