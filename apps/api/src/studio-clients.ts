import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  clientFields,
  clientVersion,
  savedClient,
  sameClientFields,
  MAX_STUDIO_CLIENTS,
  type SavedClient,
} from '../../../packages/shared/src/studio-clients.js';

const unavailable = () =>
  new ApiError(404, 'CLIENT_UNAVAILABLE', 'This client is not available.');
const changed = () =>
  new ApiError(
    409,
    'CLIENT_CHANGED',
    'This client changed in another tab. Your draft is still here. Load the latest directory before saving again.',
  );
export function createStudioClients(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const current = await owner(req);
    const expected = req.get('X-PicFind-Studio-Actor');
    if (expected && expected !== current)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the studio.',
      );
    return current;
  }
  function parseId(value: unknown) {
    const id = z.uuid().safeParse(value);
    if (!id.success) throw unavailable();
    return id.data;
  }
  function contact(
    row: LibraryRecord,
    actorId: string,
    id = row.id,
  ): SavedClient {
    if (
      row.id !== id ||
      row.ownerId !== actorId ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-client' ||
      row.eventId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw unavailable();
    const parsed = savedClient.safeParse(row.studioClient);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.createdAt !== row.createdAt
    )
      throw new ApiError(
        503,
        'CLIENT_METADATA_INVALID',
        'A client record needs metadata repair.',
      );
    return parsed.data;
  }
  async function find(id: string, actorId: string) {
    let row: LibraryRecord;
    try {
      row = await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
    return contact(row, actorId, id);
  }
  async function list(actorId: string) {
    const rows = (await getStore().list(actorId, 'job')).filter(
      (row) =>
        row.ownerId === actorId &&
        row.kind === 'job' &&
        row.purpose === 'studio-client',
    );
    if (rows.length > MAX_STUDIO_CLIENTS)
      throw new ApiError(
        503,
        'CLIENT_DIRECTORY_LIMIT',
        'The client directory needs maintenance.',
      );
    return rows
      .map((row) => contact(row, actorId))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  router.get('/studio/clients', async (req, res) => {
    const accountId = await actor(req);
    res.json({
      accountId,
      limit: MAX_STUDIO_CLIENTS,
      clients: await list(accountId),
    });
  });
  router.put('/studio/clients/:id', async (req, res) => {
    const accountId = await actor(req),
      id = parseId(req.params.id);
    const parsed = clientFields
      .extend({ version: clientVersion.max(Number.MAX_SAFE_INTEGER - 1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_CLIENT',
        'Enter a name, a valid optional email and single-line contact details within their limits.',
      );
    const { version, ...fields } = parsed.data;
    const client = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (
        current &&
        current.version === version + 1 &&
        sameClientFields(current, fields)
      )
        return current;
      if ((current?.version ?? 0) !== version) throw changed();
      const directory = await list(accountId);
      if (
        fields.email &&
        directory.some(
          (entry) => entry.id !== id && entry.email === fields.email,
        )
      )
        throw new ApiError(
          409,
          'CLIENT_EMAIL_EXISTS',
          'A client with this email already exists in your directory.',
        );
      if (!current && directory.length >= MAX_STUDIO_CLIENTS)
        throw new ApiError(
          409,
          'CLIENT_LIMIT',
          `Keep at most ${MAX_STUDIO_CLIENTS} clients in this directory. Export or remove an unused contact first.`,
        );
      const fresh = await find(id, accountId);
      if ((fresh?.version ?? 0) !== version) throw changed();
      const now = new Date().toISOString();
      const next: SavedClient = {
        ...fields,
        id,
        version: version + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      await getStore().put(
        {
          id,
          kind: 'job',
          purpose: 'studio-client',
          ownerId: accountId,
          createdAt: next.createdAt,
          studioClient: next,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, client });
  });
  router.delete('/studio/clients/:id', async (req, res) => {
    const accountId = await actor(req),
      id = parseId(req.params.id);
    const input = z
      .object({ version: clientVersion.min(1) })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_CLIENT',
        'Load the current client before deleting it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) throw unavailable();
      if (current.version !== input.data.version) throw changed();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
