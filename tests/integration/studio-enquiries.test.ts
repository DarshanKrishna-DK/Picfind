import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { enquiryFixture as fixture } from '../fixtures/studio-enquiries';
import {
  ENQUIRY_ACTOR,
  ENQUIRY_HOURLY_LIMIT,
  ENQUIRY_CONSENT,
  enquirySubmit,
  enquiryFormDirectory,
  enquiryInbox,
  enquiryReceipt,
  publishedEnquiryForm,
} from '../../packages/shared/src/studio-enquiries';

describe('published studio enquiry intake and private follow-up', () => {
  it('throttles retained new intake per photographer while allowing exact replay and recovery after the window', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    const original = f.records.get(f.enquiryId)!;
    for (let i = 1; i < ENQUIRY_HOURLY_LIMIT; i++) {
      const row = structuredClone(original),
        id = randomUUID();
      row.id = row.studioEnquiry!.id = id;
      f.records.set(id, row);
    }
    const blocked = await f.submit({}, randomUUID()).expect(429);
    expect(blocked.body.error.code).toBe('ENQUIRY_INTAKE_BUSY');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await f.submit().expect(201);
    expect(
      [...f.records.values()].filter((row) => row.purpose === 'studio-enquiry'),
    ).toHaveLength(25);
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    for (const row of f.records.values()) {
      if (!row.studioEnquiry) continue;
      row.createdAt =
        row.studioEnquiry.createdAt =
        row.studioEnquiry.updatedAt =
          old;
      row.studioEnquiry.history = [{ stage: 'new', at: old }];
    }
    await f.submit({}, randomUUID()).expect(201);
  });
  it('keeps a near-limit submission with worst escaped notes and full history inside the Appwrite payload budget', async () => {
    const f = fixture();
    await f.publish().expect(200);
    let message = 'अ'.repeat(2000);
    while (
      !enquirySubmit.safeParse({
        ...f.contact,
        message,
        formVersion: 1,
        consent: ENQUIRY_CONSENT,
      }).success
    )
      message = message.slice(0, -1);
    await f.submit({ message }).expect(201);
    const row = f.records.get(f.enquiryId)!,
      value = row.studioEnquiry!;
    value.history = Array.from({ length: 30 }, (_, i) => ({
      stage: i % 2 ? ('contacted' as const) : ('new' as const),
      at: value.createdAt,
    }));
    value.stage = 'contacted';
    await f
      .update({ stage: 'contacted', note: '\u0001'.repeat(1000) })
      .expect(200);
    expect(
      Buffer.byteLength(JSON.stringify(f.records.get(f.enquiryId))),
    ).toBeLessThan(16000);
    await f.read('/api/studio/enquiries').expect(200);
  });
  it('requires explicit publication and projects only the public form fields', async () => {
    const f = fixture();
    const empty = await f.read('/api/studio/enquiry-form').expect(200);
    expect(enquiryFormDirectory.safeParse(empty.body).success).toBe(true);
    expect(empty.body.form).toBeNull();
    await request(f.app).get(f.publicPath).expect(404);
    await f.publish({ enabled: false }).expect(200);
    await request(f.app).get(f.publicPath).expect(404);
    await f.publish({}, 1).expect(200);
    const result = await request(f.app).get(f.publicPath).expect(200);
    expect(publishedEnquiryForm.parse(result.body)).toEqual({
      id: f.formId,
      name: f.formFields.name,
      introduction: f.formFields.introduction,
      version: 2,
    });
    expect(result.headers['cache-control']).toContain('no-store');
    await f.publish({ name: 'Stale edit' }, 1).expect(409);
    await f.publish({}, 1).expect(200);
    expect(f.records.get(f.formId)?.enquiryForm?.version).toBe(2);
  });
  it('persists consented contact details privately and recovers a committed submission reply loss', async () => {
    const f = fixture();
    await f.publish().expect(200);
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Lost reply');
    });
    await f.submit().expect(500);
    const response = await f.submit().expect(201);
    expect(enquiryReceipt.parse(response.body).id).toBe(f.enquiryId);
    expect(Object.keys(response.body).sort()).toEqual(['id', 'receivedAt']);
    const inbox = await f.read('/api/studio/enquiries').expect(200);
    expect(enquiryInbox.safeParse(inbox.body).success).toBe(true);
    expect(inbox.body.enquiries).toHaveLength(1);
    expect(inbox.body.enquiries[0]).toMatchObject({
      ...f.contact,
      stage: 'new',
      version: 1,
    });
    expect(JSON.stringify(inbox.body)).not.toMatch(/Digest|ownerId/);
    const library = await f.read('/api/library').expect(200);
    expect(JSON.stringify(library.body)).not.toContain(f.contact.message);
    await request(f.app).get(`${f.publicPath}/${f.enquiryId}`).expect(404);
    await f.submit({ message: 'Changed retry' }).expect(409);
  });
  it('keeps cross-owner access, actor spoofing and outside origins denied', async () => {
    const f = fixture();
    await f.publish().set(ENQUIRY_ACTOR, f.clientId).expect(403);
    await f.publish().expect(200);
    await f.submit().set('Origin', 'https://outside.test').expect(403);
    await f.submit().expect(201);
    await request(f.app).get('/api/studio/enquiries').expect(401);
    expect(
      (await f.read('/api/studio/enquiries', f.clientId).expect(200)).body
        .enquiries,
    ).toEqual([]);
    await f.update({}, 1, f.clientId).expect(404);
    await f.update().set(ENQUIRY_ACTOR, f.clientId).expect(403);
    await f
      .remove(
        `/api/studio/enquiries/${f.enquiryId}`,
        { version: 1 },
        f.clientId,
      )
      .expect(404);
    await f
      .read('/api/studio/enquiries')
      .set(ENQUIRY_ACTOR, f.clientId)
      .expect(403);
  });
  it.each([
    { consent: false },
    { consent: undefined },
    { formVersion: '1' },
    { date: '2026-02-30' },
    { email: 'not-an-email' },
    { phone: 'line\nbreak' },
    { message: 'अ'.repeat(2000) },
    { message: '' },
    { ownerId: 'injected' },
  ])('rejects invalid consent or bounded fields %j', async (changes) => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit(changes).expect(400);
    expect(f.records.has(f.enquiryId)).toBe(false);
  });
  it('rejects stale publication and closes both new submissions and exact retries', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    await f.publish({ introduction: 'Changed details' }, 1).expect(200);
    await f.submit().expect(409);
    await f.submit({ formVersion: 2 }, randomUUID()).expect(201);
    await f.publish({ enabled: false }, 2).expect(200);
    await f.submit({ formVersion: 3 }, randomUUID()).expect(404);
    await f.submit().expect(404);
    expect(
      (await f.read('/api/studio/enquiries').expect(200)).body.totalCount,
    ).toBe(2);
  });
  it('stops public projection and submission when publication changes during the final read', async () => {
    const f = fixture();
    await f.publish().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    const spy = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.formId && ++reads === 2)
        f.records.get(id)!.enquiryForm!.enabled = false;
      return get(id);
    });
    await request(f.app).get(f.publicPath).expect(404);
    spy.mockRestore();
    f.records.get(f.formId)!.enquiryForm!.enabled = true;
    const list = f.store.list.bind(f.store);
    vi.spyOn(f.store, 'list').mockImplementation(async (actor, kind) => {
      const rows = await list(actor, kind);
      f.records.get(f.formId)!.enquiryForm!.enabled = false;
      return rows;
    });
    await f.submit().expect(404);
    expect(f.records.has(f.enquiryId)).toBe(false);
  });
  it('does not expose a form whose ownership changes during public projection', async () => {
    const f = fixture();
    await f.publish().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.formId && ++reads === 2)
        f.records.get(id)!.ownerId = f.clientId;
      return get(id);
    });
    await request(f.app).get(f.publicPath).expect(404);
  });
  it('records follow-up history, preserves notes and acknowledges an exact lost update reply', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row) => {
      await put(row);
      throw new Error('Update reply lost');
    });
    await f.update().expect(500);
    const result = await f.update().expect(200);
    expect(result.body.enquiry).toMatchObject({
      version: 2,
      stage: 'contacted',
      note: 'Private follow-up note.',
    });
    expect(
      result.body.enquiry.history.map((row: { stage: string }) => row.stage),
    ).toEqual(['new', 'contacted']);
    await f.update({ stage: 'qualified' }, 1).expect(409);
    await f.update({ stage: 'qualified' }, 2).expect(200);
    await f.submit().expect(201);
    expect(f.records.get(f.enquiryId)?.studioEnquiry?.stage).toBe('qualified');
    await f
      .remove(`/api/studio/enquiries/${f.enquiryId}`, { version: 2 })
      .expect(409);
    await f
      .remove(`/api/studio/enquiries/${f.enquiryId}`, { version: 3 })
      .expect(204);
    expect(f.records.has(f.enquiryId)).toBe(false);
    await f
      .remove(`/api/studio/enquiries/${f.enquiryId}`, { version: 3 })
      .expect(204);
  });
  it('bounds history without blocking note updates or explicit deletion', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    const value = f.records.get(f.enquiryId)!.studioEnquiry!;
    value.history = Array.from({ length: 30 }, (_, i) => ({
      stage: i % 2 ? 'contacted' : 'new',
      at: value.createdAt,
    }));
    value.stage = 'contacted';
    value.version = 30;
    await f.update({ stage: 'qualified' }, 30).expect(409);
    const result = await f.update({ note: 'Still editable' }, 30).expect(200);
    expect(result.body.enquiry.history).toHaveLength(30);
    await f
      .remove(`/api/studio/enquiries/${f.enquiryId}`, { version: 31 })
      .expect(204);
  });
  it('pages a full inbox, filters real records and frees capacity through removal', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    const original = f.records.get(f.enquiryId)!;
    for (let i = 1; i < 201; i++) {
      const row = structuredClone(original),
        id = randomUUID();
      row.id = row.studioEnquiry!.id = id;
      row.studioEnquiry!.name = `Request ${i}`;
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      row.createdAt =
        row.studioEnquiry!.createdAt =
        row.studioEnquiry!.updatedAt =
          old;
      row.studioEnquiry!.history = [{ stage: 'new', at: old }];
      f.records.set(id, row);
    }
    const first = (await f.read('/api/studio/enquiries').expect(200)).body;
    expect(first.totalCount).toBe(201);
    expect(first.enquiries).toHaveLength(50);
    const second = (await f.read('/api/studio/enquiries?offset=50').expect(200))
      .body;
    expect(
      new Set(
        [...first.enquiries, ...second.enquiries].map(
          (row: { id: string }) => row.id,
        ),
      ).size,
    ).toBe(100);
    expect(
      (await f.read('/api/studio/enquiries?search=Request%20200').expect(200))
        .body.filteredCount,
    ).toBe(1);
    await f.submit({}, randomUUID()).expect(409);
    await f.submit().expect(201);
    for (const row of first.enquiries.slice(0, 2))
      await f
        .remove(`/api/studio/enquiries/${row.id}`, { version: row.version })
        .expect(204);
    await f.submit({}, randomUUID()).expect(201);
  });
  it('erases enquiries with the owner account and refuses recreation by an old session', async () => {
    const f = fixture();
    await f.publish().expect(200);
    await f.submit().expect(201);
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.enquiryId)).toBe(false);
    expect(f.records.has(f.formId)).toBe(false);
    await f.submit().expect(404);
    await f.publish().expect(401);
  });
});
