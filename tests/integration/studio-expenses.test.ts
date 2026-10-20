import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { expenseFixture as fixture } from '../fixtures/studio-expenses';
import {
  EXPENSE_ACTOR,
  expenseExport,
  expenseJournal,
  savedExpense,
  expenseCsv,
  expenseWrite,
} from '../../packages/shared/src/studio-expenses';

describe('private photographer expense journal', () => {
  it('reserves storage metadata space for the largest accepted escaped command', async () => {
    const f = fixture();
    const changes = {
      title: '界'.repeat(120),
      merchant: '界'.repeat(120),
      reference: '界'.repeat(100),
      note: '',
    };
    for (let size = 1; size <= 1000; size++) {
      const note = '\u0000'.repeat(size);
      if (
        !expenseWrite.safeParse({
          ...f.fields,
          ...changes,
          note,
          version: 0,
          generation: null,
        }).success
      )
        break;
      changes.note = note;
    }
    expect(changes.note.length).toBeGreaterThan(500);
    const saved = (await f.save(changes).expect(200)).body.entry;
    savedExpense.parse(saved);
    const exported = expenseExport.parse(
      (await f.read(`${f.root}/export`).expect(200)).body,
    );
    expect(exported.entries[0]!.entry.note).toBe(changes.note);
    expect(
      Buffer.byteLength(JSON.stringify(f.records.get(f.expenseId)), 'utf8'),
    ).toBeLessThan(16000);
    await f
      .save({ ...changes, note: changes.note + '\u0000' }, saved)
      .expect(400);
  });
  it('persists exact minor units, links an owned project and keeps private journal records out of generic library lists', async () => {
    const f = fixture();
    const saved = savedExpense.parse((await f.save().expect(200)).body.entry);
    expect(saved).toMatchObject({
      amountMinor: 125050,
      version: 1,
      projectId: f.projectId,
    });
    expect(saved.generation).toMatch(/^[a-f0-9-]{36}$/);
    const page = expenseJournal.parse((await f.read(f.root).expect(200)).body);
    expect(page.entries[0]).toMatchObject({
      projectName: 'Portrait session',
      projectUnavailable: false,
    });
    expect(page.totals).toEqual([
      { currency: 'INR', expenses: 125050, refunds: 0, net: 125050 },
    ]);
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body),
    ).not.toContain('Train to event');
  });
  it('denies unauthenticated, foreign-account, spoofed-header and outside-origin mutations', async () => {
    const f = fixture(),
      current = (await f.save().expect(200)).body.entry;
    await request(f.app).get(f.root).expect(401);
    await f.read(`${f.root}/${f.expenseId}`, f.strangerId).expect(404);
    await f.save({}, current, f.expenseId, f.strangerId).expect(404);
    await f.removeEntry(current, f.expenseId, f.strangerId).expect(404);
    await f.read(f.root).set(EXPENSE_ACTOR, f.strangerId).expect(403);
    await request(f.app)
      .put(`${f.root}/${f.expenseId}`)
      .set('Origin', 'https://outside.test')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({})
      .expect(403);
    expect(
      (await f.read(f.root, f.strangerId).expect(200)).body.entries,
    ).toEqual([]);
  });
  it.each([
    { amountMinor: 0 },
    { amountMinor: -1 },
    { amountMinor: 1.5 },
    { amountMinor: '100' },
    { amountMinor: 1000000001 },
    { currency: 'JPY' },
    { incurredOn: '2026-02-30' },
    { incurredOn: '2026-2-01' },
    { title: 'Bad\nTitle' },
    { ownerId: 'injected' },
    { version: '0' },
    { generation: randomUUID() },
    { note: 'x'.repeat(1001) },
  ])(
    'rejects invalid or injected journal fields %j without writing',
    async (patch) => {
      const f = fixture();
      await f
        .put(`${f.root}/${f.expenseId}`, {
          ...f.fields,
          generation: null,
          version: 0,
          ...patch,
        })
        .expect(400);
      expect(f.records.has(f.expenseId)).toBe(false);
    },
  );
  it('keeps totals currency-separated across every filtered page and treats refunds as reductions', async () => {
    const f = fixture(),
      first = (await f.save({ amountMinor: 1, projectId: null }).expect(200))
        .body.entry;
    await f
      .save({ amountMinor: 102, projectId: null }, null, randomUUID())
      .expect(200);
    await f
      .save(
        { amountMinor: 1, direction: 'refund', projectId: null },
        null,
        randomUUID(),
      )
      .expect(200);
    await f
      .save(
        { amountMinor: 999, currency: 'USD', category: 'equipment' },
        null,
        randomUUID(),
      )
      .expect(200);
    const page = expenseJournal.parse((await f.read(f.root).expect(200)).body);
    expect(page.totals).toEqual([
      { currency: 'INR', expenses: 103, refunds: 1, net: 102 },
      { currency: 'USD', expenses: 999, refunds: 0, net: 999 },
    ]);
    const filtered = (
      await f.read(`${f.root}?project=none&direction=refund`).expect(200)
    ).body;
    expect(filtered.filteredCount).toBe(1);
    expect(filtered.totals).toEqual([
      { currency: 'INR', expenses: 0, refunds: 1, net: -1 },
    ]);
    const empty = (await f.read(`${f.root}?from=2027-01-01`).expect(200)).body;
    expect(empty.totals).toEqual([]);
    expect(
      (await f.read(`${f.root}/${first.id}`).expect(200)).body.entry
        .amountMinor,
    ).toBe(1);
  });
  it('exports every filtered page with formula escaping and calendar dates unchanged', async () => {
    const f = fixture();
    await f
      .save({
        title: '=Travel',
        note: 'Line one\n"Line two"',
        amountMinor: 101,
      })
      .expect(200);
    const seed = structuredClone(f.records.get(f.expenseId)!);
    for (let i = 0; i < 43; i++) {
      const id = randomUUID(),
        row = structuredClone(seed);
      row.id = row.studioExpense!.id = id;
      row.studioExpense!.generation = randomUUID();
      f.records.set(id, row);
    }
    const page = expenseJournal.parse((await f.read(f.root).expect(200)).body);
    expect(page.entries).toHaveLength(40);
    expect(page.filteredCount).toBe(44);
    expect(page.totals[0]?.expenses).toBe(4444);
    expect(
      (await f.read(`${f.root}?offset=40`).expect(200)).body.entries,
    ).toHaveLength(4);
    const exported = expenseExport.parse(
      (await f.read(`${f.root}/export?category=travel`).expect(200)).body,
    );
    expect(exported.entries).toHaveLength(44);
    const csv = expenseCsv(exported.entries);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain(`"'=Travel"`);
    expect(csv).toContain('"Line one\n""Line two"""');
    expect(csv).toContain('"2026-10-21"');
    expect(csv).toContain('"INR","1.01","101"');
    for (const row of exported.entries) expect(csv).toContain(row.entry.id);
  });
  it('recovers lost create and update replies and rejects stale edits or reused-ID deletion', async () => {
    const f = fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Lost create reply');
    });
    await f.save().expect(500);
    const initial = (await f.save().expect(200)).body.entry;
    expect(initial.version).toBe(1);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Lost edit reply');
    });
    await f.save({ amountMinor: 120000 }, initial).expect(500);
    const edited = (await f.save({ amountMinor: 120000 }, initial).expect(200))
      .body.entry;
    expect(edited.version).toBe(2);
    await f.save({ amountMinor: 110000 }, initial).expect(409);
    await f.removeEntry(initial).expect(409);
    await f.removeEntry(edited).expect(204);
    await f.removeEntry(edited).expect(204);
    const replacement = (await f.save().expect(200)).body.entry;
    expect(replacement.generation).not.toBe(initial.generation);
    await f.removeEntry(initial).expect(409);
    await f.save({}, initial).expect(409);
  });
  it('retains bookkeeping when a linked project is removed and requires clearing an unavailable link to edit', async () => {
    const f = fixture(),
      entry = (await f.save().expect(200)).body.entry;
    f.archive();
    await f
      .remove(`/api/studio/projects/${f.projectId}`, { version: 2 })
      .expect(204);
    expect(f.records.has(f.expenseId)).toBe(true);
    const page = expenseJournal.parse((await f.read(f.root).expect(200)).body);
    expect(page.entries[0]).toMatchObject({
      projectName: null,
      projectUnavailable: true,
    });
    await f.save({ note: 'Updated' }, entry).expect(409);
    await f.save({ projectId: null }, entry).expect(200);
    expect(
      (await f.read(`${f.root}/${f.expenseId}`).expect(200)).body
        .projectUnavailable,
    ).toBe(false);
  });
  it('rejects foreign and changing project links while accepting current archived projects', async () => {
    const f = fixture(),
      project = f.records.get(f.projectId)!;
    project.ownerId = f.strangerId;
    await f.save().expect(409);
    project.ownerId = f.ownerId;
    f.archive();
    await f.save().expect(200);
    const current = f.records.get(f.expenseId)!.studioExpense!,
      get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.projectId && ++reads === 2) project.ownerId = f.strangerId;
      return get(id);
    });
    await f.save({ note: 'Changed' }, current).expect(409);
    expect(f.records.get(f.expenseId)!.studioExpense!.version).toBe(1);
  });
  it('supports the normal cap, overcapacity export/removal recovery and an explicit repair ceiling', async () => {
    const f = fixture();
    await f.save().expect(200);
    const seed = structuredClone(f.records.get(f.expenseId)!);
    for (let i = 1; i < 500; i++) {
      const id = randomUUID(),
        row = structuredClone(seed);
      row.id = row.studioExpense!.id = id;
      row.studioExpense!.generation = randomUUID();
      f.records.set(id, row);
    }
    await f.save({}, null, randomUUID()).expect(409);
    await f.save({ note: 'Existing edit' }, seed.studioExpense!).expect(200);
    for (let i = 500; i < 1000; i++) {
      const id = randomUUID(),
        row = structuredClone(seed);
      row.id = row.studioExpense!.id = id;
      row.studioExpense!.generation = randomUUID();
      f.records.set(id, row);
    }
    expect(
      expenseExport.parse((await f.read(`${f.root}/export`).expect(200)).body)
        .entries,
    ).toHaveLength(1000);
    const beyond = expenseJournal.parse(
      (await f.read(`${f.root}?offset=1000`).expect(200)).body,
    );
    expect(beyond.entries).toEqual([]);
    expect(beyond.filteredCount).toBe(1000);
    expect(beyond.totals[0]!.expenses).toBe(125050000);
    const extra = structuredClone(seed),
      extraId = randomUUID();
    extra.id = extra.studioExpense!.id = extraId;
    f.records.set(extraId, extra);
    await f.read(`${f.root}/export`).expect(503);
    await f.removeEntry(extra.studioExpense!, extraId).expect(204);
    await f.read(f.root).expect(200);
  });
  it('rejects inverted or unknown filters without returning a misleading empty journal', async () => {
    const f = fixture();
    for (const filter of [
      'from=2026-12-01&to=2026-01-01',
      'offset=-1',
      'offset=1001',
      'category=unknown',
      'project=foreign',
      'unused=1',
    ])
      await f.read(`${f.root}?${filter}`).expect(400);
  });
  it('erases journal entries with the account and prevents old-session recreation', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.expenseId)).toBe(false);
    await f.save().expect(401);
  });
});
