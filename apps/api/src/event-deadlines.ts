import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryStore } from './library.js';
import {
  DEADLINE_ACTOR,
  EVENT_DEADLINE_LIMIT,
  deadlineSnapshot,
  eventDeadline,
  type EventDeadline,
} from '../../../packages/shared/src/event-deadlines.js';

const invalid = () =>
  new ApiError(
    503,
    'DEADLINES_INVALID',
    'Event deadline metadata needs repair before a complete planner can be shown.',
  );
export function createEventDeadlines(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  router.get('/studio/event-deadlines', async (req, res) => {
    const actor = await owner(req);
    if (req.get(DEADLINE_ACTOR) && req.get(DEADLINE_ACTOR) !== actor)
      throw new ApiError(
        403,
        'DEADLINE_ACCOUNT_CHANGED',
        'The signed-in account changed. Reload event deadlines.',
      );
    if (!z.object({}).strict().safeParse(req.query).success)
      throw new ApiError(
        400,
        'INVALID_DEADLINE_QUERY',
        'Load the complete bounded deadline snapshot before filtering.',
      );
    const result = await withAccountLock(actor, async () => {
      const listed = (await store().list(actor, 'event')).filter(
        (row) => row.ownerId === actor,
      );
      if (listed.length > EVENT_DEADLINE_LIMIT)
        throw new ApiError(
          503,
          'DEADLINE_LIMIT',
          'This account exceeds the 500-event planner limit. Review events individually until a complete planner can be loaded.',
        );
      if (
        new Set(listed.map((row) => row.id)).size !== listed.length ||
        listed.some((row) => !z.uuid().safeParse(row.id).success)
      )
        throw invalid();
      const events: EventDeadline[] = [];
      for (let offset = 0; offset < listed.length; offset += 8) {
        const rows = await Promise.all(
          listed.slice(offset, offset + 8).map(async (candidate) => {
            let row;
            try {
              row = await store().get(candidate.id);
            } catch (error) {
              if (error instanceof ApiError && error.status === 404)
                return null;
              throw error;
            }
            if (row.id !== candidate.id) throw invalid();
            if (
              row.ownerId !== actor ||
              row.kind !== 'event' ||
              row.deletionStartedAt ||
              row.deletionCompletedAt
            )
              return null;
            const parsed = eventDeadline.safeParse({
              id: row.id,
              title: row.title,
              archived: row.archived ?? false,
              expiresAt:
                row.expiresAt === undefined || row.expiresAt === ''
                  ? null
                  : row.expiresAt,
            });
            if (!parsed.success) throw invalid();
            return parsed.data;
          }),
        );
        events.push(
          ...rows.filter((row): row is EventDeadline => row !== null),
        );
      }
      return deadlineSnapshot.parse({
        accountId: actor,
        checkedAt: new Date().toISOString(),
        events,
      });
    });
    res.json(result);
  });
  return router;
}
