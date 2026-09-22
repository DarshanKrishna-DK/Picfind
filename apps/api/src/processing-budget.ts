import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';

const limits = { index: 20, search: 100 } as const;
function budgetId(owner: string) {
  return createHash('sha256')
    .update(`processing:${owner}:${new Date().toISOString().slice(0, 10)}`)
    .digest('hex')
    .slice(0, 32);
}
async function record(
  store: LibraryStore,
  ownerId: string,
): Promise<LibraryRecord | null> {
  try {
    return await store.get(budgetId(ownerId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
// Development spend guard, not paid-plan credits. Failed attempts may be billed.
export async function reserveProcessing(
  store: LibraryStore,
  ownerId: string,
  operation: 'index' | 'search',
) {
  return withAccountLock(`processing:${ownerId}`, async () => {
    const existing = await record(store, ownerId);
    const row: LibraryRecord = existing ?? {
      id: budgetId(ownerId),
      ownerId,
      kind: 'job',
      purpose: 'usage',
      createdAt: new Date().toISOString(),
      indexed: 0,
      searches: 0,
    };
    const field = operation === 'index' ? 'indexed' : 'searches';
    if ((row[field] ?? 0) >= limits[operation])
      throw new ApiError(
        429,
        'PROCESSING_BUDGET',
        `Today's development ${operation} allowance is used. It resets at midnight UTC. No extra provider request was sent.`,
      );
    row[field] = (row[field] ?? 0) + 1;
    await store.put(row, !existing);
  });
}
export async function processingUsage(store: LibraryStore, owner: string) {
  const row = await record(store, owner);
  return {
    plan: 'development-preview',
    indexed: row?.indexed ?? 0,
    searches: row?.searches ?? 0,
    indexLimit: limits.index,
    searchLimit: limits.search,
    resetsAt: new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate() + 1,
      ),
    ).toISOString(),
  };
}
