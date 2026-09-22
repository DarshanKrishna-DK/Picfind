import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { purgeExpiredPhotos } from '../../apps/api/src/retention.js';
import { withAccountFaceCleanup } from '../../apps/api/src/account-face-cleanup.js';

function fixture() {
  const ownerId = randomUUID(),
    eventId = randomUUID();
  const expired: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    eventId,
    kind: 'photo',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 60000).toISOString(),
    provider: 'aws-rekognition',
    indexState: 'failed',
  };
  const sibling: LibraryRecord = {
    ...expired,
    id: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    indexState: 'ready',
    faceIds: ['known-face'],
  };
  const rows = new Map([
    [expired.id, expired],
    [sibling.id, sibling],
  ]);
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return row;
    },
    list: async (owner, kind) =>
      [...rows.values()].filter((r) => r.ownerId === owner && r.kind === kind),
    put: async (row) => {
      rows.set(row.id, row);
    },
    remove: vi.fn(async (id) => {
      rows.delete(id);
    }),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(async () => {}),
    expired: async () => [expired],
  };
  const matcher = {
    deleteScope: vi.fn(async () => {}),
    deleteFaces: vi.fn(async () => {}),
  } as unknown as FaceMatchingProvider;
  return { expired, sibling, rows, store, matcher };
}
describe('uncertain cloud-index cleanup retains erasure references', () => {
  it('does not claim erasure while live sibling photos prevent collection deletion', async () => {
    const { store, matcher, expired, rows } = fixture();
    expect(await purgeExpiredPhotos(store, matcher)).toEqual({
      deleted: 0,
      deferred: 1,
    });
    expect(rows.has(expired.id)).toBe(true);
    expect(store.removeFile).not.toHaveBeenCalled();
  });
  it('erases the whole scope when every photo has expired, including unknown face IDs', async () => {
    const { store, matcher, sibling, rows, expired } = fixture();
    rows.set(sibling.id, { ...sibling, expiresAt: expired.expiresAt! });
    expect(await purgeExpiredPhotos(store, matcher)).toEqual({
      deleted: 1,
      deferred: 0,
    });
    expect(matcher.deleteScope).toHaveBeenCalledTimes(1);
  });
  it('blocks account erasure of uncertain cloud state until its provider reconnects', async () => {
    const { store, expired, rows } = fixture();
    await expect(
      withAccountFaceCleanup(store, undefined)!.remove(expired.id),
    ).rejects.toMatchObject({ status: 503 });
    expect(rows.has(expired.id)).toBe(true);
  });
  it('erases an uncertain scope before releasing its final account-cleanup reference', async () => {
    const { store, matcher, expired } = fixture();
    await withAccountFaceCleanup(store, matcher)!.remove(expired.id);
    expect(matcher.deleteScope).toHaveBeenCalledWith({
      kind: 'event',
      id: expired.eventId,
    });
  });
});
