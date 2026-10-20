import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { removeQuestionnaireResponse } from './questionnaire-cleanup.js';

// Scope remains authoritative even when a child's non-identity content needs repair.
export async function removeProjectStudioWork(
  store: LibraryStore,
  actorId: string,
  projectId: string,
  assertRemoval: () => Promise<void>,
  lockedAccounts: ReadonlySet<string> = new Set([actorId]),
) {
  const belongs = (row: LibraryRecord) =>
    row.ownerId === actorId &&
    row.kind === 'job' &&
    !row.eventId &&
    ((row.purpose === 'studio-milestone' &&
      row.studioMilestone?.projectId === projectId) ||
      (row.purpose === 'studio-appointment' &&
        row.studioAppointment?.projectId === projectId) ||
      (row.purpose === 'studio-questionnaire' &&
        row.studioQuestionnaire?.projectId === projectId));
  const rows = (await store.list(actorId, 'job')).filter(belongs);
  for (const row of rows) {
    if (!z.uuid().safeParse(row.id).success)
      throw new ApiError(
        503,
        'PROJECT_WORK_METADATA_INVALID',
        'A work record identifier needs repair before project removal.',
      );
    let fresh: LibraryRecord;
    try {
      fresh = await store.get(row.id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) continue;
      throw failure;
    }
    if (!belongs(fresh))
      throw new ApiError(
        409,
        'PROJECT_CHANGED',
        'Project work changed during removal. Reload and retry.',
      );
    await assertRemoval();
    if (fresh.purpose === 'studio-questionnaire')
      await removeQuestionnaireResponse(
        store,
        fresh,
        lockedAccounts,
        assertRemoval,
      );
    try {
      await store.remove(row.id);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 404))
        throw failure;
    }
  }
}
