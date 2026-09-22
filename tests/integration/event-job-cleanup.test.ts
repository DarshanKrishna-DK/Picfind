import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobQueue, type EnqueueIndex } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';

function fixture() {
  const store = new TestJobStore(),
    queue = new JobQueue(store);
  const owner = 'owner',
    event = randomUUID();
  const enqueue = (
    type: NonNullable<EnqueueIndex['type']>,
    destination?: string,
    ownerId = owner,
  ) =>
    queue.enqueue({
      ownerId,
      type,
      eventId: type === 'event-index' ? (destination ?? event) : randomUUID(),
      requestId: randomUUID(),
      photoIds: ['photo-a'],
      consentPolicyVersion:
        type === 'cloud-import' ? 'cloud-import-v1' : 'face-matching-v1',
      ...(type === 'cloud-import'
        ? {
            importSource: {
              provider: 'drive' as const,
              generation: randomUUID(),
              ...(destination ? { destinationEventId: destination } : {}),
            },
          }
        : {}),
    });
  return { store, queue, owner, event, enqueue };
}

describe('event processing cleanup, synthetic storage and no cloud calls', () => {
  it('erases both indexing jobs and cloud jobs addressed through import-session IDs', async () => {
    const f = fixture();
    const index = await f.enqueue('event-index');
    const cloud = await f.enqueue('cloud-import', f.event);
    expect(cloud.eventId).not.toBe(f.event);
    await f.queue.eraseEvent(f.owner, f.event);
    expect(await f.store.get(index.id)).toBeUndefined();
    expect(await f.store.get(cloud.id)).toBeUndefined();
  });
  it('leaves personal work, other events and other owners untouched', async () => {
    const f = fixture();
    await f.enqueue('cloud-import', f.event);
    const kept = await Promise.all([
      f.enqueue('cloud-import'),
      f.enqueue('discover-library'),
      f.enqueue('cloud-import', randomUUID()),
      f.enqueue('event-index', randomUUID()),
      f.enqueue('cloud-import', f.event, 'another-owner'),
    ]);
    await f.queue.eraseEvent(f.owner, f.event);
    for (const job of kept) expect(await f.store.get(job.id)).toEqual(job);
  });
  it('cancels every scoped job and retains receipts until the active photo finishes', async () => {
    const f = fixture();
    const cloud = await f.enqueue('cloud-import', f.event);
    const claim = (await f.queue.claim('worker'))!;
    await f.queue.beginItem(cloud.id, claim.leaseToken!);
    const queued = await f.enqueue('event-index');
    await expect(f.queue.eraseEvent(f.owner, f.event)).rejects.toMatchObject({
      code: 'PROCESSING_ACTIVE',
    });
    expect(await f.store.get(cloud.id)).toMatchObject({
      status: 'running',
      cancelRequestedAt: expect.any(String),
    });
    expect(await f.store.get(queued.id)).toMatchObject({ status: 'cancelled' });
    await f.queue.finishItem(cloud.id, claim.leaseToken!, 'imported');
    await f.queue.eraseEvent(f.owner, f.event);
    expect(f.store.rows.size).toBe(0);
  });
  it('is safe to retry after job erasure already committed', async () => {
    const f = fixture();
    await f.enqueue('cloud-import', f.event);
    await f.queue.eraseEvent(f.owner, f.event);
    await expect(f.queue.eraseEvent(f.owner, f.event)).resolves.toBeUndefined();
  });
});
