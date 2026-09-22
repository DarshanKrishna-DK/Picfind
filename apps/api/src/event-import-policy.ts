import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';

/** Checked at enqueue and again around every external read/write by the worker. */
export function assertEventImportOpen(event: LibraryRecord, now = Date.now()) {
  const expires = event.expiresAt ? Date.parse(event.expiresAt) : undefined;
  if (
    event.kind !== 'event' ||
    event.archived ||
    event.deletionStartedAt ||
    (expires !== undefined && (!Number.isFinite(expires) || expires <= now))
  )
    throw new ApiError(
      409,
      'EVENT_UNAVAILABLE',
      'This event is closed. Photos cannot be added after its gallery expires.',
    );
}
