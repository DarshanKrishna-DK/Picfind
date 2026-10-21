import { Router, type Request } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { ownedProjectRecord } from './studio-project-access.js';
import { readMilestoneRecord } from './studio-milestones.js';
import { readAppointmentRecord } from './studio-appointments.js';
import {
  BRIEF_ACTOR,
  briefNoteMode,
  projectBrief,
} from '../../../packages/shared/src/project-brief.js';

const changed = () =>
  new ApiError(
    409,
    'BRIEF_CHANGED',
    'The project sources changed. Refresh the production brief.',
  );
const invalid = () =>
  new ApiError(
    503,
    'BRIEF_INVALID',
    'Project sources need repair or exceed the complete brief limit.',
  );
export function createProjectBrief(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  router.get('/studio/projects/:id/brief', async (req, res) => {
    const actor = await owner(req);
    if (req.get(BRIEF_ACTOR) && req.get(BRIEF_ACTOR) !== actor)
      throw new ApiError(
        403,
        'BRIEF_ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the brief.',
      );
    if (!z.uuid().safeParse(req.params.id).success)
      throw new ApiError(
        404,
        'PROJECT_UNAVAILABLE',
        'This project is not available.',
      );
    const input = z
      .object({ notes: briefNoteMode.default('omit') })
      .strict()
      .safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_BRIEF_QUERY',
        'Choose whether to include private notes.',
      );
    const id = String(req.params.id),
      notes = input.data.notes;
    const result = await withAccountLock(actor, async () => {
      const source = await store().get(id),
        { project } = ownedProjectRecord(source, actor, id);
      if (source.projectRemovalStartedAt)
        throw new ApiError(
          409,
          'PROJECT_REMOVING',
          'Project removal has started. Resume removal from Projects.',
        );
      const snapshots = new Map<string, LibraryRecord>([[id, source]]);
      async function maybe(recordId: string) {
        try {
          return await store().get(recordId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      }
      const listed = await store().list(actor, 'job');
      if (listed.length > 2000) throw invalid();
      const relevant = listed.filter(
        (row) =>
          row.ownerId === actor &&
          ['studio-milestone', 'studio-appointment'].includes(
            row.purpose ?? '',
          ),
      );
      if (new Set(relevant.map((row) => row.id)).size !== relevant.length)
        throw invalid();
      const milestones = [],
        appointments = [];
      for (const row of relevant) {
        const entry =
          row.purpose === 'studio-milestone'
            ? readMilestoneRecord(row, actor).milestone
            : readAppointmentRecord(row, actor).appointment;
        if (entry.projectId !== id) continue;
        if (snapshots.has(row.id)) throw invalid();
        const fresh = await maybe(row.id);
        if (!fresh || !isDeepStrictEqual(fresh, row)) throw changed();
        snapshots.set(row.id, fresh);
        if (row.purpose === 'studio-milestone') {
          const v = readMilestoneRecord(fresh, actor).milestone;
          milestones.push({
            id: v.id,
            title: v.title,
            dueDate: v.dueDate,
            timeZone: v.timeZone,
            status: v.status,
            ...(notes === 'include' ? { note: v.note } : {}),
          });
        } else {
          const v = readAppointmentRecord(fresh, actor).appointment;
          appointments.push({
            id: v.id,
            title: v.title,
            startAt: v.startAt,
            endAt: v.endAt,
            timeZone: v.timeZone,
            status: v.status,
            ...(notes === 'include' ? { note: v.note } : {}),
          });
        }
        if (milestones.length > 30 || appointments.length > 30) throw invalid();
      }
      const events = [];
      for (const eventId of project.eventIds) {
        const row = await maybe(eventId);
        if (row && row.id !== eventId) throw invalid();
        let title: string | null = null;
        if (
          row &&
          row.id === eventId &&
          row.ownerId === actor &&
          row.kind === 'event' &&
          !row.deletionStartedAt &&
          !row.deletionCompletedAt
        ) {
          if (
            typeof row.title !== 'string' ||
            !row.title.trim() ||
            row.title.length > 200
          )
            throw invalid();
          title = row.title;
          snapshots.set(eventId, row);
        }
        events.push({ id: eventId, title });
      }
      for (const [recordId, snapshot] of snapshots) {
        const fresh = await maybe(recordId);
        if (!fresh || !isDeepStrictEqual(fresh, snapshot)) throw changed();
      }
      return projectBrief.parse({
        accountId: actor,
        checkedAt: new Date().toISOString(),
        notes,
        project: {
          id: project.id,
          createdAt: project.createdAt,
          version: project.version,
          name: project.name,
          stage: project.stage,
          ...(notes === 'include' ? { summary: project.summary } : {}),
        },
        events,
        milestones: milestones.sort(
          (a, b) =>
            a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
        ),
        appointments: appointments.sort(
          (a, b) =>
            Date.parse(a.startAt) - Date.parse(b.startAt) ||
            a.id.localeCompare(b.id),
        ),
      });
    });
    res.json(result);
  });
  return router;
}
