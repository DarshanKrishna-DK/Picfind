import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { savedClient } from '../../../packages/shared/src/studio-clients.js';
import {
  advanceProject,
  PROJECT_LIMIT,
  projectWrite,
  savedProject,
  type SavedProject,
  type ProjectFields,
  type ProjectView,
} from '../../../packages/shared/src/studio-projects.js';

const missing = () =>
  new ApiError(404, 'PROJECT_UNAVAILABLE', 'This project is not available.');
const changed = () =>
  new ApiError(
    409,
    'PROJECT_CHANGED',
    'This project changed in another tab. Load the latest projects before saving again.',
  );
export function createStudioProjects(
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
  function read(row: LibraryRecord, actorId: string, id = row.id) {
    if (
      row.id !== id ||
      row.ownerId !== actorId ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-project' ||
      row.eventId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = savedProject.safeParse(row.studioProject);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.createdAt !== row.createdAt ||
      parsed.data.transitions.some((entry) => entry.actorId !== actorId) ||
      !/^[a-f0-9]{64}$/.test(row.projectCommandDigest ?? '')
    )
      throw new ApiError(
        503,
        'PROJECT_METADATA_INVALID',
        'A project record needs metadata repair.',
      );
    return { row, project: parsed.data };
  }
  async function find(id: string, actorId: string) {
    const row = await maybe(id);
    return row ? read(row, actorId, id) : null;
  }
  function clientName(row: LibraryRecord | null, actorId: string, id: string) {
    if (
      !row ||
      row.id !== id ||
      row.ownerId !== actorId ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-client' ||
      row.eventId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      return null;
    const client = savedClient.safeParse(row.studioClient);
    return client.success &&
      client.data.id === id &&
      client.data.createdAt === row.createdAt
      ? client.data.name
      : null;
  }
  function eventTitle(row: LibraryRecord | null, actorId: string, id: string) {
    if (
      !row ||
      row.id !== id ||
      row.ownerId !== actorId ||
      row.kind !== 'event' ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      return null;
    return typeof row.title === 'string' && row.title.trim()
      ? row.title.slice(0, 200)
      : 'Untitled event';
  }
  async function validateLinks(
    fields: ProjectFields,
    current: SavedProject | null,
    actorId: string,
  ) {
    const links: { id: string; kind: 'client' | 'event' }[] = [];
    if (fields.clientId && fields.clientId !== current?.clientId)
      links.push({ id: fields.clientId, kind: 'client' });
    for (const id of fields.eventIds) {
      if (!current?.eventIds.includes(id)) links.push({ id, kind: 'event' });
    }
    for (let offset = 0; offset < links.length; offset += 4)
      await Promise.all(
        links.slice(offset, offset + 4).map(async (link) => {
          const row = await maybe(link.id);
          const value =
            link.kind === 'client'
              ? clientName(row, actorId, link.id)
              : eventTitle(row, actorId, link.id);
          if (value === null)
            throw new ApiError(
              404,
              'PROJECT_LINK_UNAVAILABLE',
              link.kind === 'client'
                ? 'Choose an available client from your own directory.'
                : 'Choose events that you own.',
            );
        }),
      );
  }
  router.get('/studio/projects', async (req, res) => {
    const accountId = await actor(req);
    const [jobs, events] = await Promise.all([
      getStore().list(accountId, 'job'),
      getStore().list(accountId, 'event'),
    ]);
    const clients = new Map<string, string>();
    for (const row of jobs) {
      const name = clientName(row, accountId, row.id);
      if (name !== null) clients.set(row.id, name);
    }
    const eventNames = new Map<string, string>();
    for (const row of events) {
      const title = eventTitle(row, accountId, row.id);
      if (title !== null) eventNames.set(row.id, title);
    }
    const projects = jobs
      .filter(
        (row) =>
          row.ownerId === accountId &&
          row.kind === 'job' &&
          row.purpose === 'studio-project',
      )
      .map((row) => read(row, accountId).project)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
    if (new Set(projects.map((project) => project.id)).size !== projects.length)
      throw new ApiError(
        503,
        'PROJECT_METADATA_INVALID',
        'Project identifiers need metadata repair.',
      );
    const views: ProjectView[] = projects
      .slice(0, PROJECT_LIMIT)
      .map((project) => ({
        project,
        client: project.clientId
          ? {
              id: project.clientId,
              name: clients.get(project.clientId) ?? null,
            }
          : null,
        events: project.eventIds.map((id) => ({
          id,
          title: eventNames.get(id) ?? null,
        })),
      }));
    res.json({
      accountId,
      limit: PROJECT_LIMIT,
      totalCount: projects.length,
      projects: views,
      clients: [...clients]
        .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
        .slice(0, 200)
        .map(([id, name]) => ({ id, name })),
      events: [...eventNames]
        .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
        .slice(0, 500)
        .map(([id, title]) => ({ id, title })),
    });
  });
  router.put('/studio/projects/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = projectWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_PROJECT',
        'Enter a project name, valid links, stage and current version within their limits.',
      );
    const { version, reason, ...fields } = input.data;
    const digest = createHash('sha256')
      .update(JSON.stringify({ accountId, id, ...input.data }))
      .digest('hex');
    const project = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (
        current?.project.version === version + 1 &&
        current.row.projectCommandDigest === digest
      )
        return current.project;
      if ((current?.project.version ?? 0) !== version) throw changed();
      if (!current) {
        const rows = (await getStore().list(accountId, 'job')).filter(
          (row) =>
            row.ownerId === accountId &&
            row.kind === 'job' &&
            row.purpose === 'studio-project',
        );
        if (rows.length >= PROJECT_LIMIT)
          throw new ApiError(
            409,
            'PROJECT_LIMIT',
            'Archive and remove an unused project before creating another one.',
          );
      }
      await validateLinks(fields, current?.project ?? null, accountId);
      let next: SavedProject;
      try {
        next = advanceProject(
          current?.project ?? null,
          id,
          fields,
          reason,
          accountId,
          new Date().toISOString(),
        );
      } catch (failure) {
        throw new ApiError(
          400,
          'INVALID_PROJECT_TRANSITION',
          failure instanceof Error
            ? failure.message
            : 'This project transition is unavailable.',
        );
      }
      await validateLinks(fields, current?.project ?? null, accountId);
      const fresh = await find(id, accountId);
      if ((fresh?.project.version ?? 0) !== version) throw changed();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-project',
          createdAt: next.createdAt,
          studioProject: next,
          projectCommandDigest: digest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, project });
  });
  router.delete('/studio/projects/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const body = z
      .object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      throw new ApiError(
        400,
        'INVALID_PROJECT',
        'Load the current archived project before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) throw missing();
      if (current.project.version !== body.data.version) throw changed();
      if (current.project.stage !== 'archived')
        throw new ApiError(
          409,
          'PROJECT_NOT_ARCHIVED',
          'Archive this project before removing its private record.',
        );
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
