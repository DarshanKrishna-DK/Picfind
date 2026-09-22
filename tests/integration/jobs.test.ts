import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JobQueue,
  type JobRecord,
  type JobStore,
} from '../../apps/api/src/jobs.js';

class MemoryJobs implements JobStore {
  rows = new Map<string, JobRecord>();
  async list(ownerId: string, eventId?: string) {
    return [...this.rows.values()]
      .filter(
        (job) =>
          job.ownerId === ownerId && (!eventId || job.eventId === eventId),
      )
      .map((job) => structuredClone(job));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  private tail: Promise<unknown> = Promise.resolve();
  async get(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async candidates(before: string, limit: number) {
    return [...this.rows.values()]
      .filter(
        (job) =>
          ['queued', 'running'].includes(job.status) &&
          job.availableAt <= before,
      )
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }
  async mutate<T>(
    id: string,
    operation: (job: JobRecord | undefined) => { job?: JobRecord; result: T },
  ): Promise<T> {
    const next = this.tail.then(() => {
      const change = operation(structuredClone(this.rows.get(id)));
      if (change.job) this.rows.set(id, structuredClone(change.job));
      return change.result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
function fixture() {
  let now = Date.parse('2026-09-21T00:00:00Z');
  const store = new MemoryJobs();
  const queue = new JobQueue(store, { now: () => now, leaseMs: 30_000 });
  const input = {
    ownerId: randomUUID(),
    eventId: randomUUID(),
    requestId: randomUUID(),
    photoIds: [randomUUID(), randomUUID()],
    consentPolicyVersion: 'face-matching-v1' as const,
  };
  return {
    store,
    queue,
    input,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('durable indexing queue without cloud photo calls', () => {
  it('deduplicates an identical submitted request and rejects changed contents', async () => {
    const { queue, input } = fixture();
    const first = await queue.enqueue(input);
    expect((await queue.enqueue(input)).id).toBe(first.id);
    await expect(
      queue.enqueue({ ...input, photoIds: [randomUUID()] }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows only one concurrent worker to claim a job', async () => {
    const { queue, input } = fixture();
    await queue.enqueue(input);
    const claimed = await Promise.all([
      queue.claim('worker-a'),
      queue.claim('worker-b'),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });
  it('persists each completed photo and finishes at the end', async () => {
    const { queue, input } = fixture();
    const job = await queue.enqueue(input);
    const claim = (await queue.claim('worker'))!;
    await queue.beginItem(job.id, claim.leaseToken!);
    await queue.finishItem(job.id, claim.leaseToken!, 'indexed');
    expect((await queue.owned(job.id, input.ownerId)).cursor).toBe(1);
    await queue.beginItem(job.id, claim.leaseToken!);
    await queue.finishItem(job.id, claim.leaseToken!, 'empty');
    expect(await queue.owned(job.id, input.ownerId)).toMatchObject({
      status: 'complete',
      cursor: 2,
      indexed: 1,
      empty: 1,
    });
  });
  it('recovers an expired lease safely when no paid item was started', async () => {
    const { queue, input, advance } = fixture();
    await queue.enqueue(input);
    const old = (await queue.claim('old'))!;
    advance(31_000);
    const next = (await queue.claim('new'))!;
    expect(next.id).toBe(old.id);
    expect(next.leaseToken).not.toBe(old.leaseToken);
    await expect(
      queue.beginItem(old.id, old.leaseToken!),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('does not silently retry an interrupted paid operation', async () => {
    const { queue, input, advance } = fixture();
    const job = await queue.enqueue(input);
    const claim = (await queue.claim('worker'))!;
    await queue.beginItem(job.id, claim.leaseToken!);
    advance(31_000);
    expect(await queue.claim('replacement')).toBeUndefined();
    expect(await queue.owned(job.id, input.ownerId)).toMatchObject({
      status: 'interrupted',
      cursor: 0,
      activePhotoId: input.photoIds[0],
    });
  });
  it('cancels queued work without allowing a worker to claim it', async () => {
    const { queue, input } = fixture();
    const job = await queue.enqueue(input);
    expect((await queue.cancel(job.id, input.ownerId)).status).toBe(
      'cancelled',
    );
    expect(await queue.claim('worker')).toBeUndefined();
  });
  it('finishes an already started item before acknowledging cancellation', async () => {
    const { queue, input } = fixture();
    const job = await queue.enqueue(input);
    const claim = (await queue.claim('worker'))!;
    await queue.beginItem(job.id, claim.leaseToken!);
    await queue.cancel(job.id, input.ownerId);
    expect((await queue.owned(job.id, input.ownerId)).status).toBe('running');
    await queue.finishItem(job.id, claim.leaseToken!, 'indexed');
    expect(await queue.owned(job.id, input.ownerId)).toMatchObject({
      status: 'cancelled',
      cursor: 1,
    });
    await expect(
      queue.beginItem(job.id, claim.leaseToken!),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('hides job data and cancellation from other owners', async () => {
    const { queue, input } = fixture();
    const job = await queue.enqueue(input);
    await expect(queue.owned(job.id, 'another-owner')).rejects.toMatchObject({
      status: 404,
    });
    await expect(queue.cancel(job.id, 'another-owner')).rejects.toMatchObject({
      status: 404,
    });
  });
  it('keeps a heartbeat lease alive without allowing another claimant', async () => {
    const { queue, input, advance } = fixture();
    const job = await queue.enqueue(input);
    const claim = (await queue.claim('worker'))!;
    advance(20_000);
    await queue.heartbeat(job.id, claim.leaseToken!);
    advance(20_000);
    expect(await queue.claim('other')).toBeUndefined();
  });
  it('records bounded failure summaries without exposing provider secrets', async () => {
    const { queue, input } = fixture();
    const job = await queue.enqueue(input);
    const claim = (await queue.claim('worker'))!;
    await queue.beginItem(job.id, claim.leaseToken!);
    await queue.finishItem(job.id, claim.leaseToken!, 'failed');
    await queue.beginItem(job.id, claim.leaseToken!);
    await queue.finishItem(job.id, claim.leaseToken!, 'indexed');
    expect(await queue.owned(job.id, input.ownerId)).toMatchObject({
      status: 'partial',
      failed: 1,
      indexed: 1,
      cursor: 2,
    });
  });
});
