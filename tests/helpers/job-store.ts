import type { JobRecord, JobStore } from '../../apps/api/src/jobs.js';

export class TestJobStore implements JobStore {
  readonly rows = new Map<string, JobRecord>();
  private tail: Promise<unknown> = Promise.resolve();
  async get(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async list(ownerId: string, eventId?: string) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.ownerId === ownerId && (!eventId || row.eventId === eventId),
      )
      .map((row) => structuredClone(row));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async candidates(
    before: string,
    limit: number,
    types?: readonly JobRecord['type'][],
  ) {
    return [...this.rows.values()]
      .filter(
        (job) =>
          ['queued', 'running'].includes(job.status) &&
          job.availableAt <= before &&
          (!types || types.includes(job.type)),
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
