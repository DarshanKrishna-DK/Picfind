import { ApiError } from './auth.js';
import { eventAccess } from './event-membership-access.js';
import type { ImportSource } from './import-policy.js';
import type { LibraryRecord } from './library.js';

/** Source credentials and event billing belong to different people for moderators. */
export function assertImportActor(
  source: ImportSource,
  root: LibraryRecord,
  event?: LibraryRecord,
) {
  const actor = source.actorId ?? root.ownerId;
  if (
    (root.uploadedBy ?? root.ownerId) !== actor ||
    root.folderSyncId !== source.folderSyncId ||
    root.membershipGrantId !== source.membershipGrantId
  )
    throw new ApiError(
      409,
      'IMPORT_UNAVAILABLE',
      'This import authorization is no longer valid.',
    );
  if (source.actorId) {
    if (
      !event ||
      event.ownerId !== root.ownerId ||
      event.id !== source.destinationEventId
    )
      throw new ApiError(
        409,
        'EVENT_UNAVAILABLE',
        'The destination event is no longer available.',
      );
    try {
      const access = eventAccess(event, actor, true);
      if (
        access.role !== 'moderator' ||
        access.grantId !== source.membershipGrantId
      )
        throw new Error('Membership changed');
    } catch {
      throw new ApiError(
        409,
        'EVENT_UNAVAILABLE',
        'Your event access changed. Ask the organizer before importing again.',
      );
    }
  }
  return actor;
}
