import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import { ownedProjectRecord } from './studio-project-access.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  EXPENSE_ACTOR,
  EXPENSE_LIMIT,
  EXPENSE_PAGE_SIZE,
  EXPENSE_RECOVERY_LIMIT,
  expenseDelete,
  expenseExport,
  expenseFilter,
  expenseJournal,
  expensePageFilter,
  expenseTotals,
  expenseWrite,
  savedExpense,
  type ExpenseFilter,
  type StudioExpense,
} from '../../../packages/shared/src/studio-expenses.js';

const unavailable = () =>
  new ApiError(
    404,
    'EXPENSE_UNAVAILABLE',
    'This expense record is not available.',
  );
const changed = () =>
  new ApiError(
    409,
    'EXPENSE_CHANGED',
    'This record changed. Reload the journal and load the latest entry.',
  );
const invalid = () =>
  new ApiError(
    503,
    'EXPENSE_METADATA_INVALID',
    'Expense metadata needs repair before continuing.',
  );
export function parseExpenseRecord(
  row: LibraryRecord,
  accountId: string,
  id = row.id,
) {
  if (
    row.id !== id ||
    row.ownerId !== accountId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-expense' ||
    row.eventId ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    throw unavailable();
  const value = savedExpense.safeParse(row.studioExpense);
  if (
    !value.success ||
    value.data.id !== id ||
    value.data.createdAt !== row.createdAt ||
    !/^[a-f0-9]{64}$/.test(row.expenseCommandDigest ?? '')
  )
    throw invalid();
  return value.data;
}
export function createStudioExpenses(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const id = await owner(req);
    if (req.get(EXPENSE_ACTOR) && req.get(EXPENSE_ACTOR) !== id)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the journal.',
      );
    return id;
  }
  const idOf = (value: unknown) => {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw unavailable();
    return result.data;
  };
  async function maybe(id: string) {
    try {
      return await getStore().get(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
  function parse(row: LibraryRecord, accountId: string, id = row.id) {
    return parseExpenseRecord(row, accountId, id);
  }
  async function get(id: string, accountId: string) {
    const row = await maybe(id);
    return row ? { row, value: parse(row, accountId, id) } : null;
  }
  async function records(accountId: string) {
    const jobs = await getStore().list(accountId, 'job');
    const rows = jobs.filter(
      (row) => row.ownerId === accountId && row.purpose === 'studio-expense',
    );
    if (
      rows.length > EXPENSE_RECOVERY_LIMIT ||
      new Set(rows.map((row) => row.id)).size !== rows.length
    )
      throw invalid();
    const values = rows.map((row) => parse(row, accountId));
    const projects: Array<{ id: string; name: string; createdAt: string }> = [];
    for (const row of jobs) {
      if (
        row.ownerId !== accountId ||
        row.purpose !== 'studio-project' ||
        row.projectRemovalStartedAt
      )
        continue;
      try {
        const value = ownedProjectRecord(row, accountId);
        projects.push({
          id: value.project.id,
          name: value.project.name,
          createdAt: value.project.createdAt,
        });
      } catch (failure) {
        if (!(failure instanceof ApiError)) throw failure;
      }
    }
    if (
      projects.length > 500 ||
      new Set(projects.map((row) => row.id)).size !== projects.length
    )
      throw invalid();
    return {
      values,
      projects: projects.sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    };
  }
  async function projectReference(accountId: string, id: string | null) {
    if (!id) return null;
    const row = await maybe(id);
    if (!row)
      throw new ApiError(
        409,
        'EXPENSE_PROJECT_UNAVAILABLE',
        'Choose an available project you own, or clear the project link.',
      );
    try {
      const project = ownedProjectRecord(row, accountId, id);
      if (row.projectRemovalStartedAt) throw unavailable();
      return project.project;
    } catch (failure) {
      if (!(failure instanceof ApiError)) throw failure;
      throw new ApiError(
        409,
        'EXPENSE_PROJECT_UNAVAILABLE',
        'Choose an available project you own, or clear the project link.',
      );
    }
  }
  function filtered(values: StudioExpense[], input: ExpenseFilter) {
    return values
      .filter(
        (row) =>
          (input.direction === 'all' || row.direction === input.direction) &&
          (input.category === 'all' || row.category === input.category) &&
          (!input.from || row.incurredOn >= input.from) &&
          (!input.to || row.incurredOn <= input.to) &&
          (input.project === 'all' ||
            row.projectId ===
              (input.project === 'none' ? null : input.project)) &&
          `${row.title} ${row.merchant} ${row.reference} ${row.note}`
            .toLowerCase()
            .includes(input.search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          b.incurredOn.localeCompare(a.incurredOn) ||
          b.createdAt.localeCompare(a.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }
  function view(
    entry: StudioExpense,
    projects: Array<{ id: string; name: string; createdAt: string }>,
  ) {
    const projectName =
      projects.find(
        (row) =>
          row.id === entry.projectId &&
          row.createdAt === entry.projectCreatedAt,
      )?.name ?? null;
    return {
      entry,
      projectName,
      projectUnavailable: entry.projectId !== null && projectName === null,
    };
  }
  router.get('/studio/expenses', async (req, res) => {
    const accountId = await actor(req),
      input = expensePageFilter.safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_EXPENSE_FILTER',
        'Choose valid journal filters and a date interval.',
      );
    const result = await withAccountLock(accountId, async () => {
      const { values, projects } = await records(accountId),
        matching = filtered(values, input.data);
      return expenseJournal.parse({
        accountId,
        limit: EXPENSE_LIMIT,
        pageSize: EXPENSE_PAGE_SIZE,
        offset: input.data.offset,
        totalCount: values.length,
        filteredCount: matching.length,
        totals: expenseTotals(matching),
        projects,
        entries: matching
          .slice(input.data.offset, input.data.offset + EXPENSE_PAGE_SIZE)
          .map((entry) => view(entry, projects)),
      });
    });
    res.json(result);
  });
  router.get('/studio/expenses/export', async (req, res) => {
    const accountId = await actor(req),
      input = expenseFilter.safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_EXPENSE_FILTER',
        'Choose valid journal filters and a date interval.',
      );
    const result = await withAccountLock(accountId, async () => {
      const { values, projects } = await records(accountId);
      return expenseExport.parse({
        accountId,
        generatedAt: new Date().toISOString(),
        entries: filtered(values, input.data).map((entry) =>
          view(entry, projects),
        ),
      });
    });
    res.json(result);
  });
  router.get('/studio/expenses/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id);
    const result = await withAccountLock(accountId, async () => {
      const current = await get(id, accountId);
      if (!current) throw unavailable();
      const { projects } = await records(accountId);
      return { accountId, ...view(current.value, projects) };
    });
    res.json(result);
  });
  router.put('/studio/expenses/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = expenseWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_EXPENSE',
        'Enter a title, valid date, positive amount and current numeric revision.',
      );
    const { generation, version, confirmProjectLink, ...fields } = input.data,
      digest = createHash('sha256')
        .update(JSON.stringify(input.data))
        .digest('hex');
    const entry = await withAccountLock(accountId, async () => {
      const current = await get(id, accountId);
      const assertCurrent = async () => {
        if (
          JSON.stringify((await get(id, accountId))?.value ?? null) !==
          JSON.stringify(current?.value ?? null)
        )
          throw changed();
      };
      if (
        current?.value.version === version + 1 &&
        current.row.expenseCommandDigest === digest
      ) {
        await assertCurrent();
        return current.value;
      }
      if (
        (current?.value.version ?? 0) !== version ||
        (current?.value.generation ?? null) !== generation
      )
        throw changed();
      if (!current && (await records(accountId)).values.length >= EXPENSE_LIMIT)
        throw new ApiError(
          409,
          'EXPENSE_LIMIT',
          'Export and remove old journal records before adding another.',
        );
      const project = await projectReference(accountId, fields.projectId);
      if (
        project &&
        current?.value.projectId === project.id &&
        current.value.projectCreatedAt !== project.createdAt &&
        !confirmProjectLink
      )
        throw new ApiError(
          409,
          'EXPENSE_LINK_REVIEW_REQUIRED',
          'Review and explicitly confirm this expense belongs to the current project before saving.',
        );
      const now = new Date(
        Math.max(Date.now(), current ? Date.parse(current.value.updatedAt) : 0),
      ).toISOString();
      const next = savedExpense.parse({
        ...fields,
        projectCreatedAt: project?.createdAt ?? null,
        id,
        generation: current?.value.generation ?? randomUUID(),
        version: version + 1,
        createdAt: current?.value.createdAt ?? now,
        updatedAt: now,
      });
      if (
        JSON.stringify(await projectReference(accountId, fields.projectId)) !==
        JSON.stringify(project)
      )
        throw changed();
      await assertCurrent();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'studio-expense',
          createdAt: next.createdAt,
          studioExpense: next,
          expenseCommandDigest: digest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, entry });
  });
  router.delete('/studio/expenses/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = expenseDelete.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_EXPENSE_DELETE',
        'Load the current journal entry before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await get(id, accountId);
      if (!current) return;
      if (
        current.value.generation !== input.data.generation ||
        current.value.version !== input.data.version
      )
        throw changed();
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
