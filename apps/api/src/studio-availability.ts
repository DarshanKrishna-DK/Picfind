import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { readAppointmentRecord } from './studio-appointments.js';
import { appointmentsOverlap } from '../../../packages/shared/src/studio-appointments.js';
import {
  AVAILABILITY_ACTOR,
  AVAILABILITY_LIMIT,
  availabilityWrite,
  availabilityIdentity,
  savedAvailability,
  onlyDeactivates,
} from '../../../packages/shared/src/studio-availability.js';
import {
  availabilityMissing,
  availabilityChanged,
  scheduleInvalid,
  readAvailability,
  scheduleRows,
  availabilityRows,
  verifyScheduleRows,
} from './availability-access.js';

export function createStudioAvailability(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const accountId = await owner(req);
    if (
      req.get(AVAILABILITY_ACTOR) &&
      req.get(AVAILABILITY_ACTOR) !== accountId
    )
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the studio.',
      );
    return accountId;
  }
  function idOf(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw availabilityMissing();
    return parsed.data;
  }
  async function find(id: string, accountId: string) {
    let row: LibraryRecord;
    try {
      row = await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
    return { row, block: readAvailability(row, accountId, id) };
  }
  router.get('/studio/availability', async (req, res) => {
    const accountId = await actor(req);
    const blocks = await withAccountLock(accountId, async () => {
      const values = availabilityRows(
        await scheduleRows(getStore(), accountId),
        accountId,
      );
      await verifyScheduleRows(
        getStore(),
        values.map((value) => value.row),
      );
      return values
        .map((value) => value.block)
        .sort(
          (a, b) =>
            Date.parse(a.startAt) - Date.parse(b.startAt) ||
            a.id.localeCompare(b.id),
        );
    });
    res.json({ accountId, limit: AVAILABILITY_LIMIT, blocks });
  });
  router.get('/studio/availability/:id', async (req, res) => {
    const accountId = await actor(req),
      current = await find(idOf(req.params.id), accountId);
    if (!current) throw availabilityMissing();
    res.json({ accountId, block: current.block });
  });
  router.put('/studio/availability/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const parsed = availabilityWrite.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_AVAILABILITY',
        'Choose a title, valid timezone occurrences and an interval of at most 31 days.',
      );
    const { version, generation, ...fields } = parsed.data;
    const digest = createHash('sha256')
      .update(JSON.stringify({ accountId, id, ...parsed.data }))
      .digest('hex');
    const block = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (
        current?.block.generation === generation &&
        current.block.version === version + 1 &&
        current.row.availabilityCommandDigest === digest
      )
        return current.block;
      if (
        (current?.block.version ?? 0) !== version ||
        (current && current.block.generation !== generation)
      )
        throw availabilityChanged();
      const deactivationOnly =
        !!current && onlyDeactivates(current.block, fields);
      if (!deactivationOnly) {
        const rows = await scheduleRows(getStore(), accountId),
          blocks = availabilityRows(rows, accountId);
        if (!current && blocks.length >= AVAILABILITY_LIMIT)
          throw new ApiError(
            409,
            'AVAILABILITY_LIMIT',
            'Remove an unused block before creating another. The limit is one hundred.',
          );
        if (fields.active) {
          const appointmentRows = rows.filter(
            (row) => row.purpose === 'studio-appointment',
          );
          if (appointmentRows.length > 500) throw scheduleInvalid();
          const appointments = appointmentRows.map(
            (row) => readAppointmentRecord(row, accountId).appointment,
          );
          await verifyScheduleRows(getStore(), [
            ...blocks.map((value) => value.row),
            ...appointmentRows,
          ]);
          if (
            blocks.some(
              (value) =>
                value.block.id !== id &&
                value.block.active &&
                appointmentsOverlap(value.block, fields),
            ) ||
            appointments.some(
              (value) =>
                value.status === 'scheduled' &&
                appointmentsOverlap(value, fields),
            )
          )
            throw new ApiError(
              409,
              'AVAILABILITY_OVERLAP',
              'This time overlaps a scheduled appointment or active unavailable-time block. Change the time or deactivate the other reservation.',
            );
        }
      }
      const fresh = await find(id, accountId);
      if (
        (fresh?.block.version ?? 0) !== version ||
        (fresh && fresh.block.generation !== generation)
      )
        throw availabilityChanged();
      const now = new Date(
        Math.max(
          Date.now(),
          Date.parse(current?.block.updatedAt ?? '1970-01-01T00:00:00.000Z'),
        ),
      ).toISOString();
      const next = savedAvailability.parse({
        ...fields,
        id,
        generation,
        version: version + 1,
        createdAt: current?.block.createdAt ?? now,
        updatedAt: now,
      });
      const row: LibraryRecord = {
        id,
        ownerId: accountId,
        kind: 'job',
        purpose: 'studio-availability',
        createdAt: next.createdAt,
        studioAvailability: next,
        availabilityCommandDigest: digest,
      };
      if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 12000)
        throw new ApiError(
          400,
          'AVAILABILITY_SIZE',
          'Shorten the block title or note.',
        );
      await getStore().put(row, !current);
      return next;
    });
    res.json({ accountId, block });
  });
  router.delete('/studio/availability/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = availabilityIdentity.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_AVAILABILITY',
        'Load the current block before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) throw availabilityMissing();
      if (
        current.block.version !== input.data.version ||
        current.block.generation !== input.data.generation
      )
        throw availabilityChanged();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
