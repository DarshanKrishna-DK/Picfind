import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { deadlineFixture as fixture } from '../fixtures/event-deadlines';
import {
  DEADLINE_ACTOR,
  deadlineSnapshot,
} from '../../packages/shared/src/event-deadlines';
import { ApiError } from '../../apps/api/src/auth';

describe('private owned event deadline snapshots', () => {
  it('projects only owned event deadlines without photo or private participant data and performs no writes', async () => {
    const f = fixture();
    f.events[0]!.description = 'Private description omitted';
    const writes = vi.spyOn(f.store, 'put'),
      files = vi.spyOn(f.store, 'file');
    const response = await f.read(f.deadlineRoot).expect(200);
    const result = deadlineSnapshot.parse(response.body);
    expect(result.events).toHaveLength(5);
    expect(result.accountId).toBe(f.ownerId);
    expect(
      result.events.find((row) => row.id === f.events[4]!.id)!.expiresAt,
    ).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Private description omitted');
    expect(JSON.stringify(result)).not.toContain('Another photographer');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(writes).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
  });
  it('requires a session, rejects account-header mismatches and validates query scope', async () => {
    const f = fixture();
    await request(f.app).get(f.deadlineRoot).expect(401);
    await f.read(f.deadlineRoot).set(DEADLINE_ACTOR, f.strangerId).expect(403);
    await f.read(`${f.deadlineRoot}?ownerId=${f.strangerId}`).expect(400);
    const own = (await f.read(f.deadlineRoot, f.strangerId).expect(200)).body;
    expect(own.events.map((row: { id: string }) => row.id)).toEqual([
      f.foreign.id,
    ]);
  });
  it('excludes another owner even if a storage listing includes shared or moderated events', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([...f.events, f.foreign]);
    expect((await f.read(f.deadlineRoot).expect(200)).body.events).toHaveLength(
      5,
    );
  });
  it('rereads title, archive and deadline changes and omits deleted or transferred sources', async () => {
    const f = fixture(),
      get = f.store.get;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.events[0]!.id) f.records.get(id)!.title = 'Fresh title';
      if (id === f.events[1]!.id) f.records.get(id)!.archived = true;
      if (id === f.events[2]!.id) f.records.delete(id);
      if (id === f.events[3]!.id) f.records.get(id)!.ownerId = f.strangerId;
      return get(id);
    });
    const result = (await f.read(f.deadlineRoot).expect(200)).body;
    expect(result.events).toHaveLength(3);
    expect(
      result.events.find((row: { id: string }) => row.id === f.events[0]!.id)
        .title,
    ).toBe('Fresh title');
    expect(
      result.events.find((row: { id: string }) => row.id === f.events[1]!.id)
        .archived,
    ).toBe(true);
  });
  it('omits events whose deletion has started', async () => {
    const f = fixture();
    f.records.get(f.events[0]!.id)!.deletionStartedAt =
      new Date().toISOString();
    expect((await f.read(f.deadlineRoot).expect(200)).body.events).toHaveLength(
      4,
    );
  });
  it.each(['invalid', '2026-02-30T00:00:00.000Z', '2026-10-21'])(
    'rejects invalid deadline metadata: %s',
    async (expiresAt) => {
      const f = fixture();
      f.records.get(f.events[0]!.id)!.expiresAt = expiresAt;
      await f.read(f.deadlineRoot).expect(503);
    },
  );
  it('rejects duplicate or invalid identities before pretending the snapshot is complete', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([
      f.events[0]!,
      f.events[0]!,
    ]);
    await f.read(f.deadlineRoot).expect(503);
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([
      { ...f.events[0]!, id: 'invalid' },
    ]);
    await f.read(f.deadlineRoot).expect(503);
    vi.spyOn(f.store, 'get').mockResolvedValueOnce({
      ...f.events[0]!,
      id: randomUUID(),
    });
    await f.read(f.deadlineRoot).expect(503);
  });
  it('propagates operational listing and source failures instead of an empty success', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'list').mockRejectedValueOnce(
      new ApiError(503, 'OFFLINE', 'Unavailable.'),
    );
    await f.read(f.deadlineRoot).expect(503);
    vi.spyOn(f.store, 'get').mockRejectedValueOnce(
      new ApiError(503, 'OFFLINE', 'Unavailable.'),
    );
    await f.read(f.deadlineRoot).expect(503);
  });
  it('bounds concurrent source reads and rejects snapshots beyond the complete-event ceiling', async () => {
    const f = fixture();
    for (let i = f.events.length; i < 500; i++) {
      const row = { ...f.events[0]!, id: randomUUID(), title: `Event ${i}` };
      f.records.set(row.id, row);
    }
    const get = f.store.get;
    let active = 0,
      maximum = 0;
    const reads = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await get(id);
      } finally {
        active--;
      }
    });
    expect((await f.read(f.deadlineRoot).expect(200)).body.events).toHaveLength(
      500,
    );
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    const extra = { ...f.events[0]!, id: randomUUID() };
    f.records.set(extra.id, extra);
    reads.mockClear();
    await f.read(f.deadlineRoot).expect(503);
    expect(reads).not.toHaveBeenCalled();
  });
  it('rejects an erased account session', async () => {
    const f = fixture();
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    await f.read(f.deadlineRoot).expect(401);
  });
});
