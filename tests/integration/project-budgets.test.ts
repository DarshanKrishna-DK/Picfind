import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { budgetFixture as fixture } from '../fixtures/project-budgets';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import { ApiError } from '../../apps/api/src/auth';
import { budgetReport } from '../../packages/shared/src/project-budgets';
import { expenseCsv } from '../../packages/shared/src/studio-expenses';
import {
  advanceProject,
  blankProject,
} from '../../packages/shared/src/studio-projects';

function recreate(f: ReturnType<typeof fixture>) {
  const createdAt = new Date(
    Date.parse(f.projectCreatedAt) + 60_000,
  ).toISOString();
  const row = f.records.get(f.projectId)!;
  row.createdAt = createdAt;
  row.studioProject = advanceProject(
    null,
    f.projectId,
    { ...blankProject(), name: 'Replacement project' },
    '',
    f.ownerId,
    createdAt,
  );
  return createdAt;
}
describe('private project cost budgets', () => {
  it('rejects inconsistent cost reports instead of turning missing amounts into zero', async () => {
    const f = fixture();
    await f.save().expect(200);
    const report = (await f.writeBudget().expect(200)).body;
    for (const change of [
      { overBudget: null },
      { remaining: null },
      { net: 0 },
      { expenses: -1 },
      { budget: null },
    ]) {
      expect(
        budgetReport.safeParse({
          ...report,
          currencies: [{ ...report.currencies[0], ...change }],
        }).success,
      ).toBe(false);
    }
    expect(budgetReport.safeParse({ ...report, currencies: [] }).success).toBe(
      false,
    );
    expect(
      budgetReport.safeParse({
        ...report,
        currencies: [report.currencies[0], report.currencies[0]],
      }).success,
    ).toBe(false);
  });
  it('rejects an unlinked expense with a stale project creation identity in reads and exports', async () => {
    const f = fixture();
    await f.save().expect(200);
    f.records.get(f.expenseId)!.studioExpense!.projectId = null;
    await f.read(f.root).expect(503);
    await f.read(`${f.root}/export`).expect(503);
    await f.read(f.budgetRoot).expect(503);
  });
  it('keeps the terminal safe revision readable and rejects increment overflow before writing', async () => {
    const f = fixture();
    await f.writeBudget().expect(200);
    f.records.get(f.budgetId)!.projectBudget!.version =
      Number.MAX_SAFE_INTEGER - 1;
    expect((await f.read(f.budgetRoot).expect(200)).body.version).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    await f.writeBudget({ version: Number.MAX_SAFE_INTEGER - 1 }).expect(400);
    expect(f.records.get(f.budgetId)!.projectBudget!.version).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
  });
  it('persists exact limits and reports separate currencies, refunds, zero budgets and unbudgeted costs', async () => {
    const f = fixture();
    await f.save({ amountMinor: 12345 }).expect(200);
    await f
      .save({ direction: 'refund', amountMinor: 20000 }, null, randomUUID())
      .expect(200);
    await f
      .save({ currency: 'USD', amountMinor: 1 }, null, randomUUID())
      .expect(200);
    const response = await f
      .writeBudget({
        fields: {
          limits: [
            { currency: 'INR', amountMinor: 0 },
            { currency: 'GBP', amountMinor: 1000000000 },
          ],
          note: 'Private note',
        },
      })
      .expect(200);
    const result = budgetReport.parse(response.body);
    expect(result.verifiedEntries).toBe(3);
    expect(result.currencies).toEqual([
      {
        currency: 'INR',
        budget: 0,
        expenses: 12345,
        refunds: 20000,
        net: -7655,
        remaining: 7655,
        overBudget: 0,
      },
      {
        currency: 'USD',
        budget: null,
        expenses: 1,
        refunds: 0,
        net: 1,
        remaining: null,
        overBudget: null,
      },
      {
        currency: 'GBP',
        budget: 1000000000,
        expenses: 0,
        refunds: 0,
        net: 0,
        remaining: 1000000000,
        overBudget: 0,
      },
    ]);
    expect((await f.read(f.budgetRoot).expect(200)).body.fields).toEqual(
      result.fields,
    );
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body),
    ).not.toContain('Private note');
  });
  it('reports a negative remaining balance and explicit over-budget amount', async () => {
    const f = fixture();
    await f.save({ amountMinor: 170001 }).expect(200);
    expect(
      (await f.writeBudget().expect(200)).body.currencies[0],
    ).toMatchObject({ remaining: -20001, overBudget: 20001 });
  });
  it('denies missing sessions, foreign owners, wrong actor headers and untrusted origins', async () => {
    const f = fixture();
    await request(f.app).get(f.budgetRoot).expect(401);
    await f.read(f.budgetRoot, f.strangerId).expect(404);
    await f.writeBudget({}, f.strangerId).expect(404);
    await f.writeBudget({}, f.ownerId, f.strangerId).expect(409);
    await f.put(f.budgetRoot, {}).expect(409);
    await request(f.app)
      .put(f.budgetRoot)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('Origin', 'https://outside.test')
      .send({})
      .expect(403);
    expect(f.records.has(f.budgetId)).toBe(false);
  });
  it.each([
    { version: '0' },
    { version: -1 },
    { version: Number.MAX_SAFE_INTEGER },
    { projectCreatedAt: 'invalid' },
    { fields: { limits: [{ currency: 'INR', amountMinor: -1 }], note: '' } },
    { fields: { limits: [{ currency: 'INR', amountMinor: 0.1 }], note: '' } },
    { fields: { limits: [{ currency: 'INR', amountMinor: '10' }], note: '' } },
    {
      fields: {
        limits: [{ currency: 'INR', amountMinor: 1000000001 }],
        note: '',
      },
    },
    { fields: { limits: [{ currency: 'JPY', amountMinor: 100 }], note: '' } },
    {
      fields: {
        limits: [
          { currency: 'INR', amountMinor: 100 },
          { currency: 'INR', amountMinor: 200 },
        ],
        note: '',
      },
    },
    { fields: { limits: [], note: 'x'.repeat(1001) } },
    { fields: { limits: [], note: '\u0000'.repeat(1000) } },
    { fields: { limits: [], note: '', ownerId: 'injected' } },
  ])('rejects invalid input before writes: %j', async (changes) => {
    const f = fixture();
    await f.writeBudget(changes).expect(400);
    expect(f.records.has(f.budgetId)).toBe(false);
  });
  it('requires explicit review before binding an older unverified expense link', async () => {
    const f = fixture();
    let entry = (await f.save().expect(200)).body.entry;
    delete f.records.get(f.expenseId)!.studioExpense!.projectCreatedAt;
    entry = f.records.get(f.expenseId)!.studioExpense!;
    const report = (await f.read(f.budgetRoot).expect(200)).body;
    expect(report).toMatchObject({
      unverifiedLinks: 1,
      verifiedEntries: 0,
      currencies: [],
    });
    expect((await f.read(f.root).expect(200)).body.entries[0]).toMatchObject({
      projectName: null,
      projectUnavailable: true,
    });
    await f.save({ note: 'Unrelated change' }, entry).expect(409);
    const saved = (
      await f.save({ confirmProjectLink: true }, entry).expect(200)
    ).body.entry;
    expect(saved.projectCreatedAt).toBe(f.projectCreatedAt);
    expect((await f.read(f.budgetRoot).expect(200)).body).toMatchObject({
      unverifiedLinks: 0,
      verifiedEntries: 1,
    });
    const exported = (await f.read(`${f.root}/export`).expect(200)).body;
    expect(expenseCsv(exported.entries)).toContain(f.projectCreatedAt);
  });
  it('does not inherit budgets or expenses when a project identifier is recreated', async () => {
    const f = fixture();
    const entry = (await f.save().expect(200)).body.entry;
    await f.writeBudget().expect(200);
    const createdAt = recreate(f);
    const report = (await f.read(f.budgetRoot).expect(200)).body;
    expect(report).toMatchObject({
      version: 0,
      historicalLinks: 1,
      verifiedEntries: 0,
      fields: { limits: [], note: '' },
    });
    await f.writeBudget({ version: 1 }).expect(409);
    await f.save({ note: 'Unrelated edit' }, entry).expect(409);
    const current = (
      await f.save({ confirmProjectLink: true }, entry).expect(200)
    ).body.entry;
    expect(current.projectCreatedAt).toBe(createdAt);
    expect(current.createdAt).toBe(entry.createdAt);
    expect((await f.read(f.budgetRoot).expect(200)).body.verifiedEntries).toBe(
      1,
    );
    await f.writeBudget({ projectCreatedAt: createdAt }).expect(200);
  });
  it('keeps costs independent when a project budget is cleared or an expense is unlinked', async () => {
    const f = fixture();
    const entry = (await f.save().expect(200)).body.entry;
    await f.writeBudget().expect(200);
    const cleared = (
      await f
        .writeBudget({ version: 1, fields: { limits: [], note: '' } })
        .expect(200)
    ).body;
    expect(cleared.currencies[0]).toMatchObject({ budget: null, net: 125050 });
    await f.save({ projectId: null }, entry).expect(200);
    expect((await f.read(f.budgetRoot).expect(200)).body.currencies).toEqual(
      [],
    );
    expect((await f.read(f.root).expect(200)).body.totals[0].net).toBe(125050);
  });
  it('recovers committed reply loss without an extra revision and rejects stale edits', async () => {
    const f = fixture(),
      put = f.store.put;
    let lose = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      await put(row, create);
      if (row.id === f.budgetId && lose) {
        lose = false;
        throw new ApiError(503, 'LOST_REPLY', 'Try again.');
      }
    });
    await f.writeBudget().expect(503);
    expect((await f.writeBudget().expect(200)).body.version).toBe(1);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    await f
      .writeBudget({ fields: { ...f.budgetFields, note: 'Stale' } })
      .expect(409);
  });
  it('fails closed on corrupt, duplicated and over-limit expense journals', async () => {
    const f = fixture();
    await f.save().expect(200);
    const seed = structuredClone(f.records.get(f.expenseId)!);
    f.records.get(f.expenseId)!.studioExpense!.amountMinor = -1;
    await f.read(f.budgetRoot).expect(503);
    await f.writeBudget().expect(503);
    expect(f.records.has(f.budgetId)).toBe(false);
    f.records.set(f.expenseId, seed);
    const list = vi.spyOn(f.store, 'list');
    list.mockResolvedValueOnce([seed, seed]);
    await f.read(f.budgetRoot).expect(503);
    list.mockResolvedValueOnce(Array.from({ length: 1001 }, () => seed));
    await f.read(f.budgetRoot).expect(503);
  });
  it('does not turn operational read failures or foreign rows into zero totals', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'list').mockRejectedValueOnce(
      new ApiError(503, 'OFFLINE', 'Unavailable.'),
    );
    await f.read(f.budgetRoot).expect(503);
    await f.save().expect(200);
    const row = structuredClone(f.records.get(f.expenseId)!);
    row.ownerId = f.strangerId;
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([row]);
    await f.read(f.budgetRoot).expect(404);
  });
  it('rejects wrong-scope and corrupt budget records', async () => {
    const f = fixture();
    await f.writeBudget().expect(200);
    const row = f.records.get(f.budgetId)!;
    row.ownerId = f.strangerId;
    await f.read(f.budgetRoot).expect(404);
    row.ownerId = f.ownerId;
    row.projectBudget!.version = 0;
    await f.read(f.budgetRoot).expect(503);
  });
  it('rejects a project ownership change during report reads', async () => {
    const f = fixture(),
      list = f.store.list;
    vi.spyOn(f.store, 'list').mockImplementation(async (...args) => {
      const result = await list(...args);
      f.records.get(f.projectId)!.ownerId = f.strangerId;
      return result;
    });
    await f.read(f.budgetRoot).expect(404);
  });
  it('checks final project removal after reading the budget and does not overwrite it', async () => {
    const f = fixture();
    f.archive();
    const get = f.store.get;
    let budgetReads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.budgetId && ++budgetReads === 3)
        f.records.get(f.projectId)!.projectRemovalStartedAt =
          new Date().toISOString();
      return get(id);
    });
    await f.writeBudget().expect(404);
    expect(f.records.has(f.budgetId)).toBe(false);
  });
  it('preserves a concurrent budget update instead of overwriting it', async () => {
    const f = fixture();
    await f.writeBudget().expect(200);
    const get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.budgetId && ++reads === 2)
        f.records.get(id)!.projectBudget!.version = 2;
      return get(id);
    });
    await f.writeBudget({ version: 1 }).expect(409);
    expect(f.records.get(f.budgetId)!.projectBudget!.version).toBe(2);
  });
  it('removes project budgets through durable project cleanup while retaining historical expenses', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f.writeBudget().expect(200);
    f.archive();
    const project = f.records.get(f.projectId)!.studioProject!;
    await f
      .remove(`/api/studio/projects/${f.projectId}`, {
        version: project.version,
      })
      .expect(204);
    expect(f.records.has(f.budgetId)).toBe(false);
    expect(f.records.get(f.expenseId)!.studioExpense!.projectCreatedAt).toBe(
      f.projectCreatedAt,
    );
  });
  it('erases budgets and expenses with the account and rejects old sessions', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f.writeBudget().expect(200);
    await request(f.app)
      .delete('/api/account')
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.budgetId)).toBe(false);
    expect(f.records.has(f.expenseId)).toBe(false);
    await f.writeBudget().expect(401);
  });
});
