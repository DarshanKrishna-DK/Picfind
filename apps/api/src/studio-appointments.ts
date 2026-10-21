import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { ownedProjectRecord } from './studio-project-access.js';
import {
  APPOINTMENT_LIMIT,
  PROJECT_APPOINTMENT_LIMIT,
  appointmentWrite,
  savedAppointment,
  appointmentsOverlap,
  onlyCancels,
} from '../../../packages/shared/src/studio-appointments.js';

const missing = () =>
  new ApiError(
    404,
    'APPOINTMENT_UNAVAILABLE',
    'This appointment is not available.',
  );
const changed = () =>
  new ApiError(
    409,
    'APPOINTMENT_CHANGED',
    'This appointment changed. Reload the schedule before saving again.',
  );
export function readAppointmentRecord(
  row: LibraryRecord,
  actorId: string,
  id = row.id,
) {
  if (
    row.id !== id ||
    row.ownerId !== actorId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-appointment' ||
    row.eventId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw missing();
  const parsed = savedAppointment.safeParse(row.studioAppointment);
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    parsed.data.createdAt !== row.createdAt ||
    !/^[a-f0-9]{64}$/.test(row.appointmentCommandDigest ?? '')
  )
    throw new ApiError(
      503,
      'APPOINTMENT_METADATA_INVALID',
      'A saved appointment needs metadata repair.',
    );
  return { row, appointment: parsed.data };
}
const read = readAppointmentRecord;
export function createStudioAppointments(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const value = await owner(req);
    if (
      req.get('X-PicFind-Studio-Actor') &&
      req.get('X-PicFind-Studio-Actor') !== value
    )
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the studio.',
      );
    return value;
  }
  function idOf(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  async function maybe(id: string) {
    try {
      return await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  async function find(id: string, actorId: string) {
    const row = await maybe(id);
    return row ? read(row, actorId, id) : null;
  }
  async function activeProject(id: string, actorId: string) {
    const row = await maybe(id);
    if (!row)
      throw new ApiError(
        404,
        'PROJECT_UNAVAILABLE',
        'Choose an available project that you own.',
      );
    const { project } = ownedProjectRecord(row, actorId, id);
    if (row.projectRemovalStartedAt || project.stage === 'archived')
      throw new ApiError(
        409,
        'PROJECT_INACTIVE',
        'Restore the project before scheduling work. Projects pending removal cannot be changed.',
      );
  }
  router.get('/studio/appointments', async (req, res) => {
    const accountId = await actor(req);
    const rows = (await getStore().list(accountId, 'job')).filter(
      (row) => row.ownerId === accountId && row.kind === 'job',
    );
    const projects = new Map(
      rows
        .filter(
          (row) =>
            row.purpose === 'studio-project' &&
            !row.deletionStartedAt &&
            !row.deletionCompletedAt,
        )
        .map((row) => {
          const { project } = ownedProjectRecord(row, accountId);
          return [
            row.id,
            {
              id: row.id,
              name: project.name,
              stage: project.stage,
              removalPending: !!row.projectRemovalStartedAt,
            },
          ] as const;
        }),
    );
    const appointments = rows
      .filter((row) => row.purpose === 'studio-appointment')
      .map((row) => read(row, accountId).appointment)
      .sort(
        (a, b) =>
          a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id),
      );
    if (
      new Set(appointments.map((entry) => entry.id)).size !==
      appointments.length
    )
      throw new ApiError(
        503,
        'APPOINTMENT_METADATA_INVALID',
        'Appointment identifiers need repair.',
      );
    res.json({
      accountId,
      limit: APPOINTMENT_LIMIT,
      totalCount: appointments.length,
      appointments: appointments
        .slice(0, APPOINTMENT_LIMIT)
        .map((appointment) => ({
          appointment,
          project: projects.get(appointment.projectId) ?? null,
        })),
      projects: [...projects.values()]
        .filter(
          (project) => project.stage !== 'archived' && !project.removalPending,
        )
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .slice(0, 200),
    });
  });
  router.put('/studio/appointments/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = appointmentWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_APPOINTMENT',
        'Choose a project, title, valid timezone occurrences and an end after the start within seven days.',
      );
    const { version, ...fields } = input.data;
    const digest = createHash('sha256')
      .update(JSON.stringify({ accountId, id, ...input.data }))
      .digest('hex');
    const appointment = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      const cancellationOnly =
        !!current && onlyCancels(current.appointment, fields);
      if (!cancellationOnly) await activeProject(fields.projectId, accountId);
      if (
        current?.appointment.version === version + 1 &&
        current.row.appointmentCommandDigest === digest
      )
        return current.appointment;
      if ((current?.appointment.version ?? 0) !== version) throw changed();
      if (current && current.appointment.projectId !== fields.projectId)
        throw new ApiError(
          400,
          'APPOINTMENT_PROJECT_FIXED',
          'Create another appointment to use a different project.',
        );
      const rows =
        !current || fields.status === 'scheduled'
          ? (await getStore().list(accountId, 'job')).filter(
              (row) =>
                row.ownerId === accountId &&
                row.kind === 'job' &&
                row.purpose === 'studio-appointment',
            )
          : [];
      if (
        !current &&
        (rows.length >= APPOINTMENT_LIMIT ||
          rows.filter(
            (row) => row.studioAppointment?.projectId === fields.projectId,
          ).length >= PROJECT_APPOINTMENT_LIMIT)
      )
        throw new ApiError(
          409,
          'APPOINTMENT_LIMIT',
          'Remove unused appointments first. Limits are thirty per project and three hundred per account.',
        );
      if (
        fields.status === 'scheduled' &&
        rows.some((row) => {
          const saved = read(row, accountId).appointment;
          return (
            saved.id !== id &&
            saved.status === 'scheduled' &&
            appointmentsOverlap(saved, fields)
          );
        })
      )
        throw new ApiError(
          409,
          'APPOINTMENT_OVERLAP',
          'This time overlaps another scheduled appointment. Change the time or cancel the other reservation.',
        );
      if (!cancellationOnly) await activeProject(fields.projectId, accountId);
      const fresh = await find(id, accountId);
      if ((fresh?.appointment.version ?? 0) !== version) throw changed();
      const now = new Date(
        Math.max(
          Date.now(),
          Date.parse(
            current?.appointment.updatedAt ?? '1970-01-01T00:00:00.000Z',
          ),
        ),
      ).toISOString();
      const next = savedAppointment.parse({
        ...fields,
        id,
        version: version + 1,
        createdAt: current?.appointment.createdAt ?? now,
        updatedAt: now,
      });
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-appointment',
          createdAt: next.createdAt,
          studioAppointment: next,
          appointmentCommandDigest: digest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, appointment });
  });
  router.delete('/studio/appointments/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = z
      .object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_APPOINTMENT',
        'Load the current appointment before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) throw missing();
      if (current.appointment.version !== input.data.version) throw changed();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
