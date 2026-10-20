import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { serviceFixture as fixture } from '../fixtures/studio-services';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import {
  SERVICE_ACTOR,
  serviceCatalog,
  serviceExport,
} from '../../packages/shared/src/studio-services';

describe('private reusable photographer services', () => {
  it('persists and filters saved packages while keeping them out of generic and public projections', async () => {
    const f = fixture();
    const created = await f.save().expect(200);
    expect(created.body.service).toMatchObject({
      ...f.fields,
      version: 1,
      id: f.serviceId,
    });
    const first = serviceCatalog.parse((await f.read(f.root).expect(200)).body);
    expect(first.totalCount).toBe(1);
    expect(first.services[0]?.amountMinor).toBe(250000);
    await f.save({ archived: true }, 1).expect(200);
    expect((await f.read(f.root).expect(200)).body.services).toEqual([]);
    expect(
      (await f.read(`${f.root}?state=archived&search=edited`).expect(200)).body
        .services,
    ).toHaveLength(1);
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body),
    ).not.toContain('A private package.');
    await request(f.app).get(`${f.root}/export`).expect(401);
    await request(f.app).get(`${f.root}/${f.serviceId}`).expect(404);
  });
  it('rejects wrong accounts, expected actors and untrusted origins without modifying records', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f.save({}, 1, f.serviceId, f.strangerId).expect(404);
    await f
      .read(f.root, f.strangerId)
      .set(SERVICE_ACTOR, f.ownerId)
      .expect(403);
    expect(
      (await f.read(`${f.root}/export`, f.strangerId).expect(200)).body
        .services,
    ).toEqual([]);
    await f
      .remove(`${f.root}/${f.serviceId}`, { version: 1 }, f.strangerId)
      .expect(404);
    await request(f.app)
      .put(`${f.root}/${randomUUID()}`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('Origin', 'https://outside.test')
      .send({ ...f.fields, version: 0 })
      .expect(403);
    expect(f.records.get(f.serviceId)?.studioService?.version).toBe(1);
  });
  it.each([
    { version: '0' },
    { version: null },
    { amountMinor: 1.5 },
    { amountMinor: -1 },
    { amountMinor: 1000000001 },
    { pricingMode: 'quote', amountMinor: 100 },
    { pricingMode: 'fixed', amountMinor: null },
    { durationMinutes: '120' },
    { title: 'Bad\nTitle' },
    { deliverables: Array.from({ length: 21 }, () => 'One item') },
    { ownerId: 'injected' },
  ])('rejects invalid package fields %j', async (changes) => {
    const f = fixture();
    await f
      .put(`${f.root}/${f.serviceId}`, { ...f.fields, version: 0, ...changes })
      .expect(400);
    expect(f.records.has(f.serviceId)).toBe(false);
  });
  it('recovers a committed write reply loss and rejects a changed stale retry', async () => {
    const f = fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, createOnly) => {
      await put(row, createOnly);
      throw new Error('Synthetic lost reply');
    });
    await f.save().expect(500);
    await f.save().expect(200);
    expect(f.records.get(f.serviceId)?.studioService?.version).toBe(1);
    await f.save({ title: 'Changed command' }).expect(409);
    await f.save({ title: 'Updated package' }, 1).expect(200);
    expect(f.records.get(f.serviceId)?.studioService?.version).toBe(2);
  });
  it('requires current archived state for removal and recovers an acknowledged deletion retry', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f.remove(`${f.root}/${f.serviceId}`, { version: 1 }).expect(409);
    await f.save({ archived: true }, 1).expect(200);
    await f.remove(`${f.root}/${f.serviceId}`, { version: 1 }).expect(409);
    await f.remove(`${f.root}/${f.serviceId}`, { version: 2 }).expect(204);
    await f.remove(`${f.root}/${f.serviceId}`, { version: 2 }).expect(204);
    expect(f.records.has(f.serviceId)).toBe(false);
  });
  it('exports every filtered page and allows overcapacity archive/removal recovery', async () => {
    const f = fixture();
    await f.save().expect(200);
    const original = f.records.get(f.serviceId)!;
    for (let i = 1; i < 201; i++) {
      const row = structuredClone(original),
        id = randomUUID();
      row.id = row.studioService!.id = id;
      row.studioService!.title = `Package ${String(i).padStart(3, '0')}`;
      f.records.set(id, row);
    }
    const first = serviceCatalog.parse((await f.read(f.root).expect(200)).body);
    expect(first.totalCount).toBe(201);
    expect(first.services).toHaveLength(40);
    const second = serviceCatalog.parse(
      (await f.read(`${f.root}?offset=40`).expect(200)).body,
    );
    expect(
      new Set([...first.services, ...second.services].map((row) => row.id))
        .size,
    ).toBe(80);
    const exported = serviceExport.parse(
      (await f.read(`${f.root}/export`).expect(200)).body,
    );
    expect(exported.services).toHaveLength(201);
    expect(
      (await f.read(`${f.root}/export?search=Package%20200`).expect(200)).body
        .services,
    ).toHaveLength(1);
    await f.save({}, 0, randomUUID()).expect(409);
    await f.save().expect(200);
    for (const value of first.services.slice(0, 2)) {
      await f
        .save(
          {
            ...value,
            archived: true,
            id: undefined,
            createdAt: undefined,
            updatedAt: undefined,
          },
          1,
          value.id,
        )
        .expect(200);
      await f.remove(`${f.root}/${value.id}`, { version: 2 }).expect(204);
    }
    await f.save({}, 0, randomUUID()).expect(200);
  });
  it('rejects a changed record at the final write check and malformed stored identities', async () => {
    const f = fixture();
    await f.save().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    const spy = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const row = await get(id);
      if (id === f.serviceId && ++reads === 1)
        f.records.get(id)!.studioService!.version = 2;
      return row;
    });
    await f.save({ title: 'Stale replacement' }, 1).expect(409);
    expect(f.records.get(f.serviceId)?.studioService?.title).toBe(
      f.fields.title,
    );
    spy.mockRestore();
    f.records.get(f.serviceId)!.studioService!.id = randomUUID();
    await f.read(f.root).expect(503);
    await f.read(`${f.root}/export`).expect(503);
  });
  it('keeps a maximum accepted draft within the stored payload budget and clears prices for quote mode', async () => {
    const f = fixture();
    await f.save({ description: 'अ'.repeat(1900) }).expect(200);
    expect(
      Buffer.byteLength(JSON.stringify(f.records.get(f.serviceId))),
    ).toBeLessThan(16000);
    await f.save({ pricingMode: 'quote', amountMinor: null }, 1).expect(200);
    expect(f.records.get(f.serviceId)?.studioService?.amountMinor).toBeNull();
  });
  it('removes the catalog with account erasure and refuses old-session recreation', async () => {
    const f = fixture();
    await f.save().expect(200);
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
    expect(f.records.has(f.serviceId)).toBe(false);
    await f.save({}, 0, randomUUID()).expect(401);
  });
});
