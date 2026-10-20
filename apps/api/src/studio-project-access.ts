import { ApiError } from './auth.js';
import { z } from 'zod';
import type { LibraryRecord } from './library.js';
import { savedProject } from '../../../packages/shared/src/studio-projects.js';

export function ownedProjectRecord(
  row: LibraryRecord,
  actorId: string,
  id = row.id,
) {
  if (
    row.id !== id ||
    row.ownerId !== actorId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-project' ||
    row.eventId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw new ApiError(
      404,
      'PROJECT_UNAVAILABLE',
      'This project is not available.',
    );
  const parsed = savedProject.safeParse(row.studioProject);
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    parsed.data.createdAt !== row.createdAt ||
    parsed.data.transitions.some((entry) => entry.actorId !== actorId) ||
    !/^[a-f0-9]{64}$/.test(row.projectCommandDigest ?? '') ||
    (row.projectRemovalStartedAt !== undefined &&
      (!z.iso.datetime().safeParse(row.projectRemovalStartedAt).success ||
        parsed.data.stage !== 'archived'))
  )
    throw new ApiError(
      503,
      'PROJECT_METADATA_INVALID',
      'A project record needs metadata repair.',
    );
  return { row, project: parsed.data };
}
