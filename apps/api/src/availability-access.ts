import { isDeepStrictEqual } from 'node:util';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  savedAvailability,
  AVAILABILITY_RECOVERY_LIMIT,
} from '../../../packages/shared/src/studio-availability.js';
import { appointmentsOverlap } from '../../../packages/shared/src/studio-appointments.js';

export const availabilityMissing = () =>
  new ApiError(
    404,
    'AVAILABILITY_UNAVAILABLE',
    'This unavailable-time block is not available.',
  );
export const availabilityChanged = () =>
  new ApiError(
    409,
    'AVAILABILITY_CHANGED',
    'This block changed. Reload it before saving again.',
  );
export const scheduleInvalid = () =>
  new ApiError(
    503,
    'SCHEDULE_METADATA_INVALID',
    'The saved schedule needs repair before reserving more time.',
  );
export function readAvailability(
  row: LibraryRecord,
  accountId: string,
  id = row.id,
) {
  if (
    row.id !== id ||
    row.ownerId !== accountId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-availability' ||
    row.eventId !== undefined ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    throw availabilityMissing();
  const parsed = savedAvailability.safeParse(row.studioAvailability);
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    parsed.data.createdAt !== row.createdAt ||
    !/^[a-f0-9]{64}$/.test(row.availabilityCommandDigest ?? '')
  )
    throw scheduleInvalid();
  return parsed.data;
}
export async function scheduleRows(store: LibraryStore, accountId: string) {
  const rows = await store.list(accountId, 'job');
  if (rows.length > 2000) throw scheduleInvalid();
  const owned = rows.filter(
    (row) => row.ownerId === accountId && row.kind === 'job',
  );
  if (new Set(owned.map((row) => row.id)).size !== owned.length)
    throw scheduleInvalid();
  return owned;
}
export function availabilityRows(rows: LibraryRecord[], accountId: string) {
  const selected = rows.filter((row) => row.purpose === 'studio-availability');
  if (selected.length > AVAILABILITY_RECOVERY_LIMIT) throw scheduleInvalid();
  return selected.map((row) => ({
    row,
    block: readAvailability(row, accountId),
  }));
}
export async function verifyScheduleRows(
  store: LibraryStore,
  rows: LibraryRecord[],
) {
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(
      rows.slice(offset, offset + 8).map(async (row) => {
        let fresh: LibraryRecord;
        try {
          fresh = await store.get(row.id);
        } catch (failure) {
          if (failure instanceof ApiError && failure.status === 404)
            throw availabilityChanged();
          throw failure;
        }
        if (!isDeepStrictEqual(fresh, row)) throw availabilityChanged();
      }),
    );
  }
}
export async function assertAvailableTime(
  store: LibraryStore,
  accountId: string,
  fields: { startAt: string; endAt: string },
) {
  const blocks = availabilityRows(
    await scheduleRows(store, accountId),
    accountId,
  );
  await verifyScheduleRows(
    store,
    blocks.map((value) => value.row),
  );
  if (
    blocks.some(
      ({ block }) => block.active && appointmentsOverlap(block, fields),
    )
  )
    throw new ApiError(
      409,
      'AVAILABILITY_OVERLAP',
      'This time overlaps an active unavailable-time block. Change the time or deactivate the block.',
    );
}
