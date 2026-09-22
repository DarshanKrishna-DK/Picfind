import { describe, expect, it, vi } from 'vitest';
import {
  FolderSyncCleanupWorker,
  SYNC_CLEANUP_RETRY_MS,
  type SyncCleanupCandidates,
} from '../../apps/api/src/folder-sync-cleanup-worker.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';

function fixture() {
  let now = Date.parse('2026-09-21T00:00:00.000Z');
  const row: FolderSync = {
    id: 'source',
    ownerId: 'owner',
    actorId: 'owner',
    eventId: 'event',
    provider: 'drive',
    generation: 'generation',
    folderId: 'folder',
    status: 'expired',
    pages: 0,
    imported: 0,
    cursor: null,
    createdAt: new Date(now).toISOString(),
    nextRunAt: new Date(now).toISOString(),
    cleanupRequestedAt: new Date(now).toISOString(),
  };
  const records = new Map([[row.id, row]]);
  const candidates = vi.fn(async (before: string) =>
    [...records.values()].filter(
      (r) =>
        r.status === 'expired' && Date.parse(r.nextRunAt) <= Date.parse(before),
    ),
  );
  const sources: SyncCleanupCandidates = {
    cleanupCandidates: candidates,
    get: async (id) => structuredClone(records.get(id)),
    async mutate(id, operation) {
      const saved = operation(structuredClone(records.get(id)));
      if (saved.record) records.set(id, saved.record);
      return saved.result;
    },
  };
  const continueSource = vi
    .fn<() => Promise<'complete' | 'progress' | 'redacted' | 'idle'>>()
    .mockResolvedValue('progress');
  const worker = new FolderSyncCleanupWorker(
    sources,
    { continueSource },
    () => now,
  );
  return {
    worker,
    records,
    row,
    continueSource,
    candidates,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('bounded background sync cleanup, no external calls', () => {
  it('schedules another short pass for a partially erased receipt page', async () => {
    const f = fixture();
    expect(await f.worker.processNext()).toBe(true);
    expect(
      Date.parse(f.records.get('source')!.nextRunAt) -
        Date.parse(f.row.nextRunAt),
    ).toBe(1000);
    expect(await f.worker.processNext()).toBe(false);
    f.advance(1000);
    expect(await f.worker.processNext()).toBe(true);
    expect(f.continueSource).toHaveBeenCalledTimes(2);
  });
  it('backs off a blocked source so other sources can finish', async () => {
    const f = fixture();
    f.records.set('second', { ...f.row, id: 'second' });
    f.continueSource.mockRejectedValueOnce(
      new Error('private provider detail'),
    );
    expect(await f.worker.processNext()).toBe(true);
    expect(f.worker.status()).toEqual({ outcome: 'deferred' });
    expect(
      Date.parse(f.records.get('source')!.nextRunAt) -
        Date.parse(f.row.nextRunAt),
    ).toBe(SYNC_CLEANUP_RETRY_MS);
    expect(await f.worker.processNext()).toBe(true);
    expect(f.continueSource).toHaveBeenLastCalledWith('second');
  });
  it('does not recreate a source removed by the final transaction', async () => {
    const f = fixture();
    f.continueSource.mockImplementation(async () => {
      f.records.delete('source');
      return 'complete';
    });
    expect(await f.worker.processNext()).toBe(true);
    expect(f.records.size).toBe(0);
  });
  it('preserves a newer owner-deletion request instead of delaying it', async () => {
    const f = fixture();
    f.continueSource.mockImplementation(async () => {
      f.records.set('source', { ...f.row, cleanupAccountId: 'owner' });
      return 'redacted';
    });
    await f.worker.processNext();
    expect(f.records.get('source')!.nextRunAt).toBe(f.row.nextRunAt);
  });
  it('does not busy-poll retained redacted references', async () => {
    const f = fixture();
    f.continueSource.mockResolvedValue('idle');
    await f.worker.processNext();
    expect(
      Date.parse(f.records.get('source')!.nextRunAt) -
        Date.parse(f.row.nextRunAt),
    ).toBe(86400000);
  });
  it('ignores stale candidate rows that are not terminal anymore', async () => {
    const f = fixture();
    f.candidates.mockResolvedValue([f.row]);
    f.records.set('source', { ...f.row, status: 'active' });
    expect(await f.worker.processNext()).toBe(false);
    expect(f.continueSource).not.toHaveBeenCalled();
  });
  it('does not overlap passes or accept new work after shutdown', async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.continueSource.mockImplementation(async () => {
      await pending;
      return 'progress';
    });
    const first = f.worker.processNext();
    expect(await f.worker.processNext()).toBe(false);
    f.worker.stop();
    release();
    await first;
    expect(await f.worker.processNext()).toBe(false);
    expect(f.continueSource).toHaveBeenCalledTimes(1);
  });
});
