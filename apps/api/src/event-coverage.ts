import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  coveragePhotoIds,
  coverageWrite,
  emptyCoverage,
  newCoverageAssignments,
  storedCoverage,
  type CoveragePlan,
} from '../../../packages/shared/src/event-coverage.js';

export function coverageRecordId(eventId: string) {
  const hex = createHash('sha256')
    .update(`picfind:coverage:${eventId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const missing = () =>
  new ApiError(
    404,
    'COVERAGE_UNAVAILABLE',
    'This private event coverage plan is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'COVERAGE_CHANGED',
    'Coverage changed. Your draft was not saved. Reload the latest plan before saving again.',
  );
function editable(event: LibraryRecord) {
  return (
    !event.archived &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
export function createEventCoverage(
  getStore: () => LibraryStore,
  actorOf: (request: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/events/:id/coverage';
  async function actor(req: Request) {
    const account = await actorOf(req),
      expected = req.get('X-PicFind-Coverage-Actor');
    if (expected && expected !== account)
      throw new ApiError(
        403,
        'COVERAGE_ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the event.',
      );
    return account;
  }
  async function eventOf(eventId: string, accountId: string) {
    const event = await getStore().get(eventId);
    if (
      event.id !== eventId ||
      event.kind !== 'event' ||
      event.ownerId !== accountId ||
      event.deletionStartedAt ||
      event.deletionCompletedAt
    )
      throw missing();
    return event;
  }
  async function load(
    event: LibraryRecord,
  ): Promise<{ plan: CoveragePlan; createdAt: string | null }> {
    const key = coverageRecordId(event.id);
    let row: LibraryRecord;
    try {
      row = await getStore().get(key);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404)
        return { plan: emptyCoverage(), createdAt: null };
      throw failure;
    }
    if (
      row.id !== key ||
      row.kind !== 'job' ||
      row.ownerId !== event.ownerId ||
      row.eventId !== event.id ||
      row.purpose !== 'event-coverage' ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = storedCoverage.safeParse(row.coverage);
    if (
      !parsed.success ||
      !z.iso.datetime().safeParse(row.createdAt).success ||
      Date.parse(row.createdAt) > Date.parse(parsed.data.updatedAt)
    )
      throw new ApiError(
        503,
        'COVERAGE_INVALID',
        'Coverage metadata needs repair before it can be read or changed.',
      );
    return { plan: parsed.data, createdAt: row.createdAt };
  }
  async function available(event: LibraryRecord, ids: string[]) {
    const accepted: string[] = [];
    for (let start = 0; start < ids.length; start += 8) {
      const batch = await Promise.all(
        ids.slice(start, start + 8).map(async (id) => {
          let photo: LibraryRecord;
          try {
            photo = await getStore().get(id);
          } catch (failure) {
            if (failure instanceof ApiError && failure.status === 404)
              return null;
            throw failure;
          }
          return photo.id === id &&
            photo.ownerId === event.ownerId &&
            photo.eventId === event.id &&
            !photo.scanId &&
            !photo.deletionStartedAt &&
            !photo.deletionCompletedAt &&
            photoAvailable(photo)
            ? id
            : null;
        }),
      );
      accepted.push(...batch.filter((id) => id !== null));
    }
    return accepted;
  }
  function eventId(req: Request) {
    const parsed = z.uuid().safeParse(req.params.id);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  async function snapshot(id: string, accountId: string) {
    const event = await eventOf(id, accountId),
      { plan } = await load(event);
    const availableIds = await available(event, coveragePhotoIds(plan.items));
    const latest = await eventOf(id, accountId);
    return {
      accountId,
      eventId: id,
      editable: editable(latest),
      plan,
      availableIds,
    };
  }
  router.get(root, async (req, res) => {
    const accountId = await actor(req);
    res.json(await snapshot(eventId(req), accountId));
  });
  router.put(root, async (req, res) => {
    const accountId = await actor(req),
      id = eventId(req);
    const input = coverageWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_COVERAGE',
        'Use unique category labels, up to 20 categories, targets from 1 to 50, short notes and at most 100 photo references.',
      );
    await withAccountLock(accountId, async () => {
      let event = await eventOf(id, accountId);
      const initial = await load(event),
        current = initial.plan;
      if (!editable(event))
        throw new ApiError(
          409,
          'COVERAGE_EVENT_CLOSED',
          'Restore an active event before editing coverage.',
        );
      const same =
        JSON.stringify(current.items) === JSON.stringify(input.data.items);
      if (
        same &&
        (current.version === input.data.version ||
          current.version === input.data.version + 1)
      )
        return;
      if (current.version !== input.data.version) throw changed();
      const added = newCoverageAssignments(current.items, input.data.items);
      const validate = async () => {
        if ((await available(event, added)).length !== added.length)
          throw new ApiError(
            400,
            'COVERAGE_PHOTOS_UNAVAILABLE',
            'New assignments must use currently available photos from this event.',
          );
      };
      await validate();
      event = await eventOf(id, accountId);
      await validate();
      if (JSON.stringify((await load(event)).plan) !== JSON.stringify(current))
        throw changed();
      event = await eventOf(id, accountId);
      if (!editable(event))
        throw new ApiError(
          409,
          'COVERAGE_EVENT_CLOSED',
          'Restore an active event before editing coverage.',
        );
      const updatedAt = new Date(
        Math.max(
          Date.now(),
          current.updatedAt ? Date.parse(current.updatedAt) : 0,
        ),
      ).toISOString();
      await getStore().put(
        {
          id: coverageRecordId(id),
          ownerId: accountId,
          kind: 'job',
          purpose: 'event-coverage',
          eventId: id,
          createdAt: initial.createdAt ?? updatedAt,
          coverage: {
            items: input.data.items,
            version: current.version + 1,
            updatedAt,
          },
        },
        current.version === 0,
      );
    });
    res.json(await snapshot(id, accountId));
  });
  return router;
}
