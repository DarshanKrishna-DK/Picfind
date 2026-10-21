import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import { ownedProjectRecord } from './studio-project-access.js';
import { parseExpenseRecord } from './studio-expenses.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { EXPENSE_RECOVERY_LIMIT } from '../../../packages/shared/src/studio-expenses.js';
import {
  BUDGET_ACTOR,
  budgetCommand,
  budgetComparison,
  budgetReport,
  savedBudget,
  type SavedBudget,
} from '../../../packages/shared/src/project-budgets.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function budgetRecordId(projectId: string, createdAt: string) {
  const hex = digest(['picfind:project-budget:v1', projectId, createdAt]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const changed = () =>
  new ApiError(
    409,
    'BUDGET_CHANGED',
    'The project or budget changed. Load the latest budget before saving.',
  );
const unavailable = () =>
  new ApiError(
    404,
    'BUDGET_UNAVAILABLE',
    'This project budget is not available.',
  );
const invalid = () =>
  new ApiError(
    503,
    'BUDGET_METADATA_INVALID',
    'Budget or expense metadata needs repair before reporting costs.',
  );

export function createProjectBudgets(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/studio/projects/:id/budget';
  async function projectOf(id: unknown, actor: string) {
    if (!z.uuid().safeParse(id).success) throw unavailable();
    const { row, project } = ownedProjectRecord(
      await store().get(id as string),
      actor,
      id as string,
    );
    if (row.projectRemovalStartedAt) throw unavailable();
    return project;
  }
  type Project = Awaited<ReturnType<typeof projectOf>>;
  async function load(project: Project, actor: string) {
    const id = budgetRecordId(project.id, project.createdAt);
    let row: LibraryRecord;
    try {
      row = await store().get(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { row: null, value: null };
      throw error;
    }
    if (
      row.id !== id ||
      row.ownerId !== actor ||
      row.kind !== 'job' ||
      row.purpose !== 'project-budget' ||
      row.eventId ||
      row.scanId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw unavailable();
    const parsed = savedBudget.safeParse(row.projectBudget);
    if (
      !parsed.success ||
      parsed.data.projectId !== project.id ||
      parsed.data.projectCreatedAt !== project.createdAt ||
      !z.iso.datetime().safeParse(row.createdAt).success ||
      Date.parse(row.createdAt) > Date.parse(parsed.data.updatedAt)
    )
      throw invalid();
    return { row, value: parsed.data };
  }
  async function report(
    project: Project,
    actor: string,
    current: SavedBudget | null,
  ) {
    const rows = (await store().list(actor, 'job')).filter(
      (row) => row.purpose === 'studio-expense',
    );
    if (
      rows.length > EXPENSE_RECOVERY_LIMIT ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw invalid();
    const linked = rows
      .map((row) => parseExpenseRecord(row, actor))
      .filter((entry) => entry.projectId === project.id);
    const verified = linked.filter(
      (entry) => entry.projectCreatedAt === project.createdAt,
    );
    const fields = current?.fields ?? { limits: [], note: '' };
    const fresh = await load(project, actor);
    if (digest(fresh.value) !== digest(current)) throw changed();
    const finalProject = await projectOf(project.id, actor);
    if (finalProject.createdAt !== project.createdAt) throw changed();
    return budgetReport.parse({
      accountId: actor,
      projectId: project.id,
      projectCreatedAt: project.createdAt,
      projectName: finalProject.name,
      version: current?.version ?? 0,
      fields,
      updatedAt: current?.updatedAt ?? null,
      checkedAt: new Date().toISOString(),
      verifiedEntries: verified.length,
      unverifiedLinks: linked.filter((entry) => !entry.projectCreatedAt).length,
      historicalLinks: linked.filter(
        (entry) =>
          entry.projectCreatedAt &&
          entry.projectCreatedAt !== project.createdAt,
      ).length,
      currencies: budgetComparison(fields, verified),
    });
  }
  router.get(root, async (req, res) => {
    const actor = await owner(req);
    res.json(
      await withAccountLock(actor, async () => {
        const project = await projectOf(req.params.id, actor);
        const { value } = await load(project, actor);
        return report(project, actor, value);
      }),
    );
  });
  router.put(root, async (req, res) => {
    const actor = await owner(req);
    if (req.get(BUDGET_ACTOR) !== actor)
      throw new ApiError(
        409,
        'BUDGET_ACCOUNT_CHANGED',
        'The signed-in account changed. Refresh this budget.',
      );
    const parsed = budgetCommand.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_BUDGET',
        'Enter unique currency limits, a bounded note and the current numeric revision.',
      );
    const command = parsed.data,
      commandDigest = digest(command);
    res.json(
      await withAccountLock(actor, async () => {
        const project = await projectOf(req.params.id, actor);
        if (command.projectCreatedAt !== project.createdAt) throw changed();
        const initial = await load(project, actor),
          current = initial.value;
        if (
          current?.version === command.version + 1 &&
          current.commandDigest === commandDigest
        )
          return report(project, actor, current);
        if ((current?.version ?? 0) !== command.version) throw changed();
        // Validate the journal before persisting a budget whose reply needs its totals.
        await report(project, actor, current);
        const now = new Date(
          Math.max(Date.now(), Date.parse(current?.updatedAt ?? '') || 0),
        ).toISOString();
        const value = savedBudget.parse({
          projectId: project.id,
          projectCreatedAt: project.createdAt,
          version: command.version + 1,
          fields: command.fields,
          updatedAt: now,
          commandDigest,
        });
        const fresh = await load(project, actor);
        if (digest(fresh.row) !== digest(initial.row)) throw changed();
        if (
          (await projectOf(project.id, actor)).createdAt !== project.createdAt
        )
          throw changed();
        const row: LibraryRecord = {
          id: budgetRecordId(project.id, project.createdAt),
          kind: 'job',
          ownerId: actor,
          purpose: 'project-budget',
          createdAt: initial.row?.createdAt ?? now,
          projectBudget: value,
        };
        if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 10000)
          throw invalid();
        await store().put(row, initial.row === null);
        return report(project, actor, value);
      }),
    );
  });
  return router;
}
