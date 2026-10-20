import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  SERVICE_ACTOR,
  SERVICE_LIMIT,
  SERVICE_PAGE_SIZE,
  savedService,
  serviceWrite,
  serviceFilter,
  servicePageFilter,
} from '../../../packages/shared/src/studio-services.js';

const unavailable = () =>
  new ApiError(404, 'SERVICE_UNAVAILABLE', 'This service is not available.');
const changed = () =>
  new ApiError(
    409,
    'SERVICE_CHANGED',
    'This service changed. Refresh the catalog and load the latest version.',
  );
const invalid = () =>
  new ApiError(
    503,
    'SERVICE_METADATA_INVALID',
    'Service metadata needs repair before continuing.',
  );
export function createStudioServices(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const value = await owner(req);
    if (req.get(SERVICE_ACTOR) && req.get(SERVICE_ACTOR) !== value)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the catalog.',
      );
    return value;
  }
  function idOf(value: unknown) {
    const id = z.uuid().safeParse(value);
    if (!id.success) throw unavailable();
    return id.data;
  }
  function parse(row: LibraryRecord, accountId: string, id = row.id) {
    if (
      row.id !== id ||
      row.ownerId !== accountId ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-service' ||
      row.eventId ||
      row.deletionStartedAt !== undefined ||
      row.deletionCompletedAt !== undefined
    )
      throw unavailable();
    const result = savedService.safeParse(row.studioService);
    if (
      !result.success ||
      result.data.id !== id ||
      result.data.createdAt !== row.createdAt
    )
      throw invalid();
    return result.data;
  }
  async function get(id: string, accountId: string) {
    let row: LibraryRecord;
    try {
      row = await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
    return { row, value: parse(row, accountId, id) };
  }
  async function all(accountId: string) {
    const records = (await getStore().list(accountId, 'job')).filter(
      (row) => row.ownerId === accountId && row.purpose === 'studio-service',
    );
    if (records.length > 500) throw invalid();
    const values = records.map((row) => parse(row, accountId));
    if (new Set(values.map((row) => row.id)).size !== values.length)
      throw invalid();
    return values;
  }
  function filter(
    values: ReturnType<typeof parse>[],
    input: z.infer<typeof serviceFilter>,
  ) {
    return values
      .filter(
        (row) =>
          (input.state === 'all' ||
            row.archived === (input.state === 'archived')) &&
          `${row.title} ${row.description} ${row.deliverables.join(' ')}`
            .toLowerCase()
            .includes(input.search.toLowerCase()),
      )
      .sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
      );
  }
  router.get('/studio/services', async (req, res) => {
    const accountId = await actor(req),
      input = servicePageFilter.safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_SERVICE_FILTER',
        'Choose a valid catalog view and page.',
      );
    const values = await all(accountId),
      filtered = filter(values, input.data);
    res.json({
      accountId,
      limit: SERVICE_LIMIT,
      pageSize: SERVICE_PAGE_SIZE,
      offset: input.data.offset,
      totalCount: values.length,
      filteredCount: filtered.length,
      services: filtered.slice(
        input.data.offset,
        input.data.offset + SERVICE_PAGE_SIZE,
      ),
    });
  });
  router.get('/studio/services/export', async (req, res) => {
    const accountId = await actor(req),
      input = serviceFilter.safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_SERVICE_FILTER',
        'Choose a valid catalog view.',
      );
    res.json({ accountId, services: filter(await all(accountId), input.data) });
  });
  router.put('/studio/services/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = serviceWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_SERVICE',
        'Check the service details, pricing and current numeric version.',
      );
    const { version, ...fields } = input.data,
      digest = createHash('sha256')
        .update(JSON.stringify(input.data))
        .digest('hex');
    const result = await withAccountLock(accountId, async () => {
      const current = await get(id, accountId);
      if (
        current?.value.version === version + 1 &&
        current.row.serviceCommandDigest === digest
      )
        return current.value;
      if ((current?.value.version ?? 0) !== version) throw changed();
      if (!current && (await all(accountId)).length >= SERVICE_LIMIT)
        throw new ApiError(
          409,
          'SERVICE_LIMIT',
          'Export or remove an archived service before adding another.',
        );
      const now = new Date(
        Math.max(Date.now(), current ? Date.parse(current.value.updatedAt) : 0),
      ).toISOString();
      const value = savedService.parse({
        ...fields,
        id,
        version: version + 1,
        createdAt: current?.value.createdAt ?? now,
        updatedAt: now,
      });
      if (
        JSON.stringify((await get(id, accountId))?.value ?? null) !==
        JSON.stringify(current?.value ?? null)
      )
        throw changed();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-service',
          createdAt: value.createdAt,
          studioService: value,
          serviceCommandDigest: digest,
        },
        !current,
      );
      return value;
    });
    res.json({ accountId, service: result });
  });
  router.delete('/studio/services/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = z
        .object({
          version: z
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER - 1),
        })
        .strict()
        .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_SERVICE_DELETE',
        'Load the current service before removal.',
      );
    await withAccountLock(accountId, async () => {
      const current = await get(id, accountId);
      if (!current) return;
      if (current.value.version !== input.data.version) throw changed();
      if (!current.value.archived)
        throw new ApiError(
          409,
          'SERVICE_NOT_ARCHIVED',
          'Archive the service before removing it.',
        );
      const fresh = await get(id, accountId);
      if (
        !fresh ||
        JSON.stringify(fresh.value) !== JSON.stringify(current.value)
      )
        throw changed();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
