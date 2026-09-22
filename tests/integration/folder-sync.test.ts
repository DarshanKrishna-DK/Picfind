import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import {
  FolderSyncWorker,
  SYNC_INTERVAL_MS,
  SYNC_LEASE_MS,
  type FolderSync,
  type FolderSyncPorts,
  type FolderSyncStore,
} from '../../apps/api/src/folder-sync.js';

class Store implements FolderSyncStore {
  rows = new Map<string, FolderSync>();
  seen = new Map<string, Set<string>>();
  private tail: Promise<unknown> = Promise.resolve();
  async get(id: string) {
    return structuredClone(this.rows.get(id));
  }
  async candidates(now: string, limit: number) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.status === 'active' &&
          Date.parse(row.nextRunAt) <= Date.parse(now),
      )
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
  async knownFiles(sync: FolderSync, ids: string[]) {
    return new Set(ids.filter((id) => this.seen.get(sync.id)?.has(id)));
  }
  mutate<T>(
    id: string,
    op: (row: FolderSync | undefined) => {
      record?: FolderSync;
      remember?: string[];
      result: T;
    },
  ): Promise<T> {
    const result = this.tail.then(() => {
      const change = op(structuredClone(this.rows.get(id)));
      if (change.record) this.rows.set(id, structuredClone(change.record));
      if (change.remember)
        this.seen.set(
          id,
          new Set([...(this.seen.get(id) ?? []), ...change.remember]),
        );
      return structuredClone(change.result);
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
function fixture() {
  let now = Date.parse('2026-09-21T00:00:00Z');
  const store = new Store();
  const record: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: 'moderator',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    membershipGrantId: randomUUID(),
    folderId: 'folder',
    status: 'active',
    createdAt: new Date(now).toISOString(),
    nextRunAt: new Date(now).toISOString(),
    cursor: null,
    pages: 0,
    imported: 0,
  };
  store.rows.set(record.id, record);
  const ports = {
    authorize: vi.fn<FolderSyncPorts['authorize']>(async () => ({
      expiresAt: new Date(now + 86400000).toISOString(),
    })),
    list: vi.fn<FolderSyncPorts['list']>(async () => ({
      fileIds: ['file-a', 'file-b'],
      nextCursor: null,
    })),
    enqueue: vi.fn<FolderSyncPorts['enqueue']>(async () => 'batch-one'),
    inspect: vi.fn<FolderSyncPorts['inspect']>(async () => 'complete'),
  };
  return {
    store,
    record,
    ports,
    worker: new FolderSyncWorker(store, ports, () => now),
    time: () => now,
    advance: (ms = SYNC_INTERVAL_MS) => {
      now += ms;
    },
  };
}
describe('durable folder sync coordinator; no cloud calls', () => {
  it('restarts an expired cursor without losing receipts or reimporting completed photos', async () => {
    const f = fixture();
    f.record.cursor = 'expired-private-cursor';
    f.record.pages = 12;
    f.store.seen.set(f.record.id, new Set(['file-a']));
    f.ports.list.mockRejectedValueOnce(
      new ApiError(409, 'SYNC_CURSOR_EXPIRED', 'Restart'),
    );
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)).toMatchObject({
      status: 'active',
      cursor: null,
      pages: 0,
    });
    expect(f.store.seen.get(f.record.id)).toEqual(new Set(['file-a']));
    expect(f.ports.enqueue).not.toHaveBeenCalled();
    f.advance();
    await f.worker.processNext();
    expect(f.ports.enqueue.mock.calls[0]?.[1].fileIds).toEqual(['file-b']);
  });
  it('remembers completed files atomically and imports only newly discovered files next cycle', async () => {
    const f = fixture();
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)?.pending?.fileIds).toEqual([
      'file-a',
      'file-b',
    ]);
    expect(f.store.seen.size).toBe(0);
    f.advance(15_000);
    await f.worker.processNext();
    expect(f.store.seen.get(f.record.id)).toEqual(
      new Set(['file-a', 'file-b']),
    );
    expect(f.store.rows.get(f.record.id)?.imported).toBe(2);
    f.advance();
    f.ports.list.mockResolvedValue({
      fileIds: ['file-a', 'file-b', 'file-c'],
      nextCursor: null,
    });
    await f.worker.processNext();
    expect(f.ports.enqueue.mock.calls[1]?.[1].fileIds).toEqual(['file-c']);
  });
  it('reuses a committed request identity after an ambiguous enqueue failure and restart', async () => {
    const f = fixture();
    f.ports.enqueue.mockRejectedValueOnce(new Error('Reply lost'));
    await f.worker.processNext();
    const first = f.ports.enqueue.mock.calls[0]![1].requestId;
    expect(f.store.rows.get(f.record.id)?.error).toBe('temporary');
    f.advance();
    await new FolderSyncWorker(f.store, f.ports, f.time).processNext();
    expect(f.ports.enqueue.mock.calls[1]![1].requestId).toBe(first);
    expect(f.ports.list).toHaveBeenCalledOnce();
  });
  it('allows only one worker to claim the same source', async () => {
    const f = fixture(),
      second = new FolderSyncWorker(f.store, f.ports, f.time);
    const results = await Promise.all([
      f.worker.processNext(),
      second.processNext(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.ports.enqueue).toHaveBeenCalledOnce();
  });
  it('does not enqueue after revocation while metadata is being listed', async () => {
    const f = fixture();
    f.ports.list.mockImplementation(async () => {
      f.ports.authorize.mockRejectedValue(
        new ApiError(404, 'NOT_FOUND', 'Unavailable'),
      );
      return { fileIds: ['file-a'], nextCursor: null };
    });
    await f.worker.processNext();
    expect(f.ports.enqueue).not.toHaveBeenCalled();
    expect(f.store.rows.get(f.record.id)).toMatchObject({
      status: 'attention',
      error: 'access-changed',
    });
  });
  it('stops at expiry before listing or importing', async () => {
    const f = fixture();
    f.ports.authorize.mockResolvedValue({
      expiresAt: new Date(f.time()).toISOString(),
    });
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)?.status).toBe('expired');
    expect(f.ports.list).not.toHaveBeenCalled();
    expect(f.ports.enqueue).not.toHaveBeenCalled();
  });
  it('requires attention after a source connection changes', async () => {
    const f = fixture();
    f.ports.authorize.mockRejectedValue(
      new ApiError(409, 'SOURCE_CONNECTION_CHANGED', 'Changed'),
    );
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)?.error).toBe('source-changed');
    f.advance();
    expect(await f.worker.processNext()).toBe(false);
  });
  it('cannot publish a cursor or start a batch after losing its lease', async () => {
    const f = fixture();
    f.ports.list.mockImplementation(async () => {
      f.advance(SYNC_LEASE_MS + 1);
      return { fileIds: ['file-a'], nextCursor: 'next' };
    });
    await f.worker.processNext();
    expect(f.ports.enqueue).not.toHaveBeenCalled();
    expect(f.store.rows.get(f.record.id)?.cursor).toBeNull();
  });
  it('respects disabling during listing without overwriting the pause', async () => {
    const f = fixture();
    f.ports.list.mockImplementation(async () => {
      await f.store.mutate(f.record.id, (row) => ({
        record: { ...row!, status: 'paused' },
        result: undefined,
      }));
      return { fileIds: ['file-a'], nextCursor: null };
    });
    await f.worker.processNext();
    expect(f.ports.enqueue).not.toHaveBeenCalled();
    expect(f.store.rows.get(f.record.id)?.status).toBe('paused');
  });
  it('waits for the existing import and does not skip a failed batch', async () => {
    const f = fixture();
    await f.worker.processNext();
    f.advance(15_000);
    f.ports.inspect.mockResolvedValueOnce('running');
    await f.worker.processNext();
    expect(f.ports.enqueue).toHaveBeenCalledOnce();
    f.advance(15_000);
    f.ports.inspect.mockResolvedValueOnce('attention');
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)).toMatchObject({
      status: 'attention',
      error: 'import-attention',
    });
    expect(f.store.seen.size).toBe(0);
  });
  it('rejects oversized and non-advancing pages rather than silently dropping photos', async () => {
    const f = fixture();
    f.ports.list.mockResolvedValue({
      fileIds: Array.from({ length: 51 }, (_, i) => `file-${i}`),
      nextCursor: null,
    });
    await f.worker.processNext();
    expect(f.store.rows.get(f.record.id)?.error).toBe('invalid-page');
    const g = fixture();
    g.store.rows.set(g.record.id, { ...g.record, cursor: 'same' });
    g.ports.list.mockResolvedValue({ fileIds: [], nextCursor: 'same' });
    await g.worker.processNext();
    expect(g.store.rows.get(g.record.id)?.error).toBe('invalid-page');
  });
});
