import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { TablesDB } from 'node-appwrite';
import { AppwriteJobStore } from '../../apps/api/src/adapters/appwrite-jobs.js';
import {
  encodeManifestJob,
  makeManifest,
} from '../../apps/api/src/job-manifest.js';
import { JobQueue, type JobRecord } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';
const row = (job: JobRecord) => ({
  $id: job.id,
  ownerId: job.ownerId,
  eventId: job.eventId,
  status: job.status,
  availableAt: job.availableAt,
  payload: JSON.stringify(encodeManifestJob(job, makeManifest(job).reference)),
});

describe('typed Appwrite work claiming without live Appwrite', () => {
  it('finds an import behind a full page of paused face jobs', async () => {
    const queue = new JobQueue(new TestJobStore()),
      ownerId = randomUUID();
    const faces: Array<ReturnType<typeof row>> = [];
    for (let n = 0; n < 100; n++)
      faces.push(
        row(
          await queue.enqueue({
            ownerId,
            eventId: randomUUID(),
            requestId: randomUUID(),
            photoIds: [randomUUID()],
            consentPolicyVersion: 'face-matching-v1',
          }),
        ),
      );
    const importing = await queue.enqueue({
      ownerId,
      eventId: randomUUID(),
      requestId: randomUUID(),
      type: 'cloud-import',
      importSource: { provider: 'box', generation: randomUUID() },
      photoIds: ['123'],
      consentPolicyVersion: 'cloud-import-v1',
    });
    const listRows = vi
      .fn()
      .mockResolvedValueOnce({ rows: faces })
      .mockResolvedValueOnce({ rows: [row(importing)] });
    const store = new AppwriteJobStore(
      {
        endpoint: 'https://unused.example/v1',
        projectId: 'synthetic',
        apiKey: 'synthetic',
      },
      { listRows } as unknown as TablesDB,
    );
    const candidates = await store.candidates(
      new Date(Date.now() + 10000).toISOString(),
      20,
      ['cloud-import'],
    );
    expect(candidates.map((job) => job.id)).toEqual([importing.id]);
    expect(listRows).toHaveBeenCalledTimes(2);
    expect(
      listRows.mock.calls[1]![0].queries.some(
        (query: string) =>
          query.includes('cursorAfter') && query.includes(faces[99]!.$id),
      ),
    ).toBe(true);
  });
  it('does not scan the store for an empty allowed-type set', async () => {
    const listRows = vi.fn();
    const store = new AppwriteJobStore(
      {
        endpoint: 'https://unused.example/v1',
        projectId: 'synthetic',
        apiKey: 'synthetic',
      },
      { listRows } as unknown as TablesDB,
    );
    expect(await store.candidates(new Date().toISOString(), 20, [])).toEqual(
      [],
    );
    expect(listRows).not.toHaveBeenCalled();
  });
});
