import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { creditFixture as fixture } from '../fixtures/credit-presets';
import {
  CREDIT_ACTOR_HEADER,
  creditPresetDirectory,
  creditPreview,
  creditPhotoPage,
} from '../../packages/shared/src/credit-presets';

describe('owned photographer credit presets and fresh batch previews', () => {
  it('persists private presets separately from photos, galleries and generic library jobs', async () => {
    const f = fixture();
    await f.save().expect(200);
    const result = await f.read(f.presetRoot).expect(200);
    expect(creditPresetDirectory.safeParse(result.body).success).toBe(true);
    expect(result.body.presets[0]).toMatchObject({ ...f.fields, version: 1 });
    expect(JSON.stringify(result.body)).not.toMatch(/CommandDigest|published/);
    const library = await f.read('/api/library').expect(200);
    expect(JSON.stringify(library.body)).not.toContain(f.fields.name);
    f.photos.forEach((photo) =>
      expect(f.records.get(photo.id)?.attribution).toBeUndefined(),
    );
    await f.remove(`${f.presetRoot}/${f.presetId}`, { version: 1 }).expect(204);
    expect(f.records.has(f.presetId)).toBe(false);
    f.photos.forEach((photo) => expect(f.records.has(photo.id)).toBe(true));
  });
  it('rejects account changes, unauthorized preset edits and foreign photo previews', async () => {
    const f = fixture();
    await request(f.app).get(f.presetRoot).expect(401);
    await f.save().set(CREDIT_ACTOR_HEADER, f.clientId).expect(403);
    await f.save().set('Origin', 'https://outside.test').expect(403);
    await f.save().expect(200);
    expect(
      (await f.read(f.presetRoot, f.clientId).expect(200)).body.presets,
    ).toEqual([]);
    await f.save({}, 1, f.clientId).expect(404);
    await f
      .remove(`${f.presetRoot}/${f.presetId}`, { version: 1 }, f.clientId)
      .expect(404);
    await f.preview(undefined, {}, f.clientId).expect(404);
    await f.preview().set(CREDIT_ACTOR_HEADER, f.clientId).expect(403);
    await f
      .read('/api/studio/credit-photos')
      .set(CREDIT_ACTOR_HEADER, f.clientId)
      .expect(403);
    const id = f.photos[0]!.id;
    await f
      .read(`/api/photos/${id}/attribution`)
      .set(CREDIT_ACTOR_HEADER, f.clientId)
      .expect(403);
    await f
      .patch(id, { name: 'Name', website: '', published: false, version: 0 })
      .set(CREDIT_ACTOR_HEADER, f.clientId)
      .expect(403);
  });
  it('supports exact lost-reply retries while refusing stale edits and deletes', async () => {
    const f = fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Reply lost');
    });
    await f.save().expect(500);
    expect((await f.save().expect(200)).body.preset.version).toBe(1);
    await f.save({ name: 'Second photographer' }, 1).expect(200);
    await f.save({ name: 'Stale photographer' }, 1).expect(409);
    await f.remove(`${f.presetRoot}/${f.presetId}`, { version: 1 }).expect(409);
    await f.remove(`${f.presetRoot}/${f.presetId}`, { version: 2 }).expect(204);
    await f.remove(`${f.presetRoot}/${f.presetId}`, { version: 2 }).expect(204);
  });
  it('recovers preset capacity and displays overcapacity records for explicit removal', async () => {
    const f = fixture();
    await f.save().expect(200);
    const original = f.records.get(f.presetId)!;
    for (let index = 1; index < 21; index++) {
      const row = structuredClone(original),
        id = randomUUID();
      row.id = row.creditPreset!.id = id;
      f.records.set(id, row);
    }
    expect((await f.read(f.presetRoot).expect(200)).body.presets).toHaveLength(
      21,
    );
    const id = randomUUID();
    await f
      .put(`${f.presetRoot}/${id}`, { ...f.fields, version: 0 })
      .expect(409);
    const extras = [...f.records.values()]
      .filter((row) => row.purpose === 'photographer-credit-preset')
      .slice(0, 2);
    for (const row of extras)
      await f.remove(`${f.presetRoot}/${row.id}`, { version: 1 }).expect(204);
    await f
      .put(`${f.presetRoot}/${id}`, { ...f.fields, version: 0 })
      .expect(200);
  });
  it('previews only requested current credits and never mutates photos', async () => {
    const f = fixture(),
      first = f.photos[0]!;
    first.attribution = {
      name: 'Earlier credit',
      website: '',
      published: true,
      version: 1,
      updatedAt: first.createdAt,
    };
    const put = vi.spyOn(f.store, 'put');
    const result = await f.preview([first.id]).expect(200);
    expect(creditPreview.safeParse(result.body).success).toBe(true);
    expect(result.body.photos).toHaveLength(1);
    expect(result.body.photos[0]).toMatchObject({
      id: first.id,
      filename: first.filename,
      current: first.attribution,
    });
    expect(put).not.toHaveBeenCalled();
  });
  it('validates batch bounds, duplicate identifiers and publication fields', async () => {
    const f = fixture(),
      id = f.photos[0]!.id;
    await f.preview([]).expect(400);
    await f.preview([id, id]).expect(400);
    await f
      .preview(Array.from({ length: 101 }, () => randomUUID()))
      .expect(400);
    await f.preview(undefined, { name: '', published: true }).expect(400);
    await f.save({ published: true }).expect(400);
  });
  it('rejects a late owner change and corrupt saved attribution during preview', async () => {
    const f = fixture(),
      id = f.photos[0]!.id,
      get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (key) => {
      if (key === id && ++reads === 2) f.records.get(id)!.ownerId = f.clientId;
      return get(key);
    });
    await f.preview([id]).expect(404);
    vi.mocked(f.store.get).mockImplementation(get);
    f.records.get(id)!.ownerId = f.ownerId;
    Object.assign(f.records.get(id)!, { attribution: { name: 'Corrupt' } });
    await f.preview([id]).expect(503);
  });
  it('refuses publication in closed events but permits a private replacement', async () => {
    const f = fixture();
    f.records.get(f.eventId)!.archived = true;
    await f.preview(undefined, { published: true }).expect(409);
    await f.preview().expect(200);
    await f
      .patch(f.photos[0]!.id, {
        name: f.fields.name,
        website: f.fields.website,
        published: false,
        version: 0,
      })
      .expect(200);
  });
  it('bounds concurrent preview reads and preserves requested order', async () => {
    const f = fixture(),
      get = f.store.get.bind(f.store);
    let active = 0,
      peak = 0;
    const ids = [];
    for (let index = 0; index < 12; index++) {
      const photo = {
        ...f.photos[0]!,
        id: randomUUID(),
        filename: `photo-${index}.jpg`,
      };
      ids.push(photo.id);
      f.records.set(photo.id, photo);
    }
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await get(id);
      } finally {
        active--;
      }
    });
    const result = await f.preview(ids).expect(200);
    expect(result.body.photos.map((row: { id: string }) => row.id)).toEqual(
      ids,
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
  it('paginates and filters owned available photo metadata without disclosing face or private-note fields', async () => {
    const f = fixture(),
      first = f.photos[0]!;
    for (let index = 0; index < 104; index++) {
      const row = {
        ...first,
        id: randomUUID(),
        filename: `extra-${index}.jpg`,
        privatePhotoNote: 'Private secret',
        faceIds: ['face-secret'],
      };
      f.records.set(row.id, row);
    }
    const root = '/api/studio/credit-photos';
    const page = (await f.read(root).expect(200)).body;
    expect(creditPhotoPage.safeParse(page).success).toBe(true);
    expect(page.photos).toHaveLength(100);
    expect(page.totalCount).toBe(107);
    expect(JSON.stringify(page)).not.toMatch(/Private secret|face-secret/);
    expect(
      (await f.read(`${root}?offset=100`).expect(200)).body.photos,
    ).toHaveLength(7);
    expect(
      (await f.read(`${root}?search=portrait-1`).expect(200)).body.photos.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([first.id]);
    expect(
      (await f.read(`${root}?eventId=library`).expect(200)).body.photos,
    ).toEqual([]);
    expect((await f.read(root, f.clientId).expect(200)).body.photos).toEqual(
      [],
    );
    f.records.get(first.id)!.deletionStartedAt = new Date().toISOString();
    expect(
      (await f.read(`${root}?search=portrait-1`).expect(200)).body.photos,
    ).toEqual([]);
  });
  it('removes presets with account data and rejects recreation by a previously authenticated request', async () => {
    const f = fixture();
    await f.save().expect(200);
    f.photos.forEach((row) => f.records.delete(row.id));
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.presetId)).toBe(false);
    await f.save().expect(401);
  });
});
