import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { ownedProjectRecord } from './studio-project-access.js';
import {
  advanceMilestone,
  milestoneWrite,
  savedMilestone,
  MILESTONE_LIMIT,
  PROJECT_MILESTONE_LIMIT,
} from '../../../packages/shared/src/studio-milestones.js';

const missing = () =>
  new ApiError(
    404,
    'MILESTONE_UNAVAILABLE',
    'This milestone is not available.',
  );
const changed = () =>
  new ApiError(
    409,
    'MILESTONE_CHANGED',
    'This milestone changed. Load the latest work queue before saving again.',
  );
function read(row: LibraryRecord, actorId: string, id = row.id) {
  if (
    row.id !== id ||
    row.ownerId !== actorId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-milestone' ||
    row.eventId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw missing();
  const parsed = savedMilestone.safeParse(row.studioMilestone);
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    parsed.data.createdAt !== row.createdAt ||
    !/^[a-f0-9]{64}$/.test(row.milestoneCommandDigest ?? '')
  )
    throw new ApiError(
      503,
      'MILESTONE_METADATA_INVALID',
      'A milestone record needs metadata repair.',
    );
  return { row, milestone: parsed.data };
}
async function maybe(store: LibraryStore, id: string) {
  try {
    return await store.get(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return null;
    throw failure;
  }
}
export function createStudioMilestones(
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
  async function find(id: string, actorId: string) {
    const row = await maybe(getStore(), id);
    return row ? read(row, actorId, id) : null;
  }
  async function activeProject(id: string, actorId: string) {
    const row = await maybe(getStore(), id);
    if (!row)
      throw new ApiError(
        404,
        'PROJECT_UNAVAILABLE',
        'Choose an available project that you own.',
      );
    const { project } = ownedProjectRecord(row, actorId, id);
    if (row.projectRemovalStartedAt)
      throw new ApiError(
        409,
        'PROJECT_REMOVING',
        'Project removal has started. Resume removal from Projects.',
      );
    if (project.stage === 'archived')
      throw new ApiError(
        409,
        'PROJECT_ARCHIVED',
        'Restore the project before changing its milestones.',
      );
    return project;
  }
  router.get('/studio/milestones', async (req, res) => {
    const accountId = await actor(req);
    const jobs = (await getStore().list(accountId, 'job')).filter(
      (row) => row.ownerId === accountId && row.kind === 'job',
    );
    const projects = new Map(
      jobs
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
            { id: row.id, name: project.name, stage: project.stage },
          ] as const;
        }),
    );
    const milestones = jobs
      .filter((row) => row.purpose === 'studio-milestone')
      .map((row) => read(row, accountId).milestone)
      .sort(
        (a, b) =>
          a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
      );
    if (new Set(milestones.map((entry) => entry.id)).size !== milestones.length)
      throw new ApiError(
        503,
        'MILESTONE_METADATA_INVALID',
        'Milestone identifiers need repair.',
      );
    res.json({
      accountId,
      limit: MILESTONE_LIMIT,
      totalCount: milestones.length,
      milestones: milestones.slice(0, MILESTONE_LIMIT).map((milestone) => ({
        milestone,
        project: projects.get(milestone.projectId) ?? null,
      })),
      projects: [...projects.values()]
        .filter((project) => project.stage !== 'archived')
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .slice(0, 200),
    });
  });
  router.put('/studio/milestones/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = milestoneWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_MILESTONE',
        'Enter a title, real due date, IANA timezone and current version within their limits.',
      );
    const { version, ...fields } = input.data;
    const digest = createHash('sha256')
      .update(JSON.stringify({ accountId, id, ...input.data }))
      .digest('hex');
    const milestone = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      // Parent authorization also applies to retries after a project changes.
      await activeProject(fields.projectId, accountId);
      if (
        current?.milestone.version === version + 1 &&
        current.row.milestoneCommandDigest === digest
      )
        return current.milestone;
      if ((current?.milestone.version ?? 0) !== version) throw changed();
      if (current && fields.projectId !== current.milestone.projectId)
        throw new ApiError(
          400,
          'MILESTONE_PROJECT_FIXED',
          'Create a new milestone to use another project.',
        );
      if (!current) {
        const rows = (await getStore().list(accountId, 'job')).filter(
          (row) =>
            row.ownerId === accountId &&
            row.kind === 'job' &&
            row.purpose === 'studio-milestone',
        );
        if (
          rows.length >= MILESTONE_LIMIT ||
          rows.filter(
            (row) => row.studioMilestone?.projectId === fields.projectId,
          ).length >= PROJECT_MILESTONE_LIMIT
        )
          throw new ApiError(
            409,
            'MILESTONE_LIMIT',
            'Remove unused milestones first. Limits are thirty per project and three hundred per account.',
          );
      }
      const next = advanceMilestone(
        current?.milestone ?? null,
        id,
        fields,
        new Date().toISOString(),
      );
      await activeProject(fields.projectId, accountId);
      const fresh = await find(id, accountId);
      if ((fresh?.milestone.version ?? 0) !== version) throw changed();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-milestone',
          createdAt: next.createdAt,
          studioMilestone: next,
          milestoneCommandDigest: digest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, milestone });
  });
  router.delete('/studio/milestones/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const input = z
      .object({ version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_MILESTONE',
        'Load the current milestone before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) throw missing();
      if (current.milestone.version !== input.data.version) throw changed();
      await getStore().remove(id);
    });
    res.status(204).end();
  });
  return router;
}
