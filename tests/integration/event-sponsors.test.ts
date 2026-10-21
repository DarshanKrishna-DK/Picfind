import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth';
import { highlightRecordId } from '../../apps/api/src/highlights';
import { sponsorFixture } from '../fixtures/event-sponsors';
import {
  SPONSOR_ACTOR,
  SPONSOR_PERMISSION,
  sponsorFields,
} from '../../packages/shared/src/event-sponsors';

describe('explicit event sponsor placements', () => {
  it('stores near-budget private and public snapshots together within the Appwrite payload limit', async () => {
    const f = await sponsorFixture();
    const fields = {
      gallery: true,
      wall: true,
      placements: Array.from({ length: 6 }, () => ({
        id: randomUUID(),
        name: '"'.repeat(80),
        caption: '',
        website: `https://example.test/${'x'.repeat(270)}`,
      })),
    };
    for (let length = 1; length <= 120; length++) {
      const candidate = {
        ...fields,
        placements: fields.placements.map((row) => ({
          ...row,
          caption: '"'.repeat(length),
        })),
      };
      if (!sponsorFields.safeParse(candidate).success) break;
      fields.placements = candidate.placements;
    }
    expect(Buffer.byteLength(JSON.stringify(fields))).toBeGreaterThan(4100);
    await f.publish({ fields }).expect(200);
    const draft = { ...fields, gallery: false };
    await f.save({ version: 1, fields: draft }).expect(200);
    const row = f.stored();
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(12000);
    expect(JSON.stringify(row).length).toBeLessThan(16000);
    expect(row.eventSponsors!.draft).toEqual(draft);
    expect((await f.publicRead().expect(200)).body.sponsors).toEqual(fields);
  });

  it('normalizes reordered persisted keys before comparing public publication snapshots', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    const get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const row = await get(id);
      if (id === f.id && ++reads === 2) {
        const fields = row.eventSponsors!.published!.fields;
        row.eventSponsors!.published!.fields = {
          placements: fields.placements.map(
            ({ id, name, caption, website }) => ({
              website,
              caption,
              name,
              id,
            }),
          ),
          wall: fields.wall,
          gallery: fields.gallery,
        };
      }
      return row;
    });
    expect((await f.publicRead().expect(200)).body.sponsors).toEqual(
      f.sponsorFields,
    );
  });

  it('requires numeric bounded versions and rejects control characters before writes', async () => {
    const f = await sponsorFixture();
    for (const version of ['0', false, -1, Number.MAX_SAFE_INTEGER])
      await f.save({ version }).expect(400);
    await f
      .save({
        fields: {
          ...f.sponsorFields,
          placements: [
            { ...f.sponsorFields.placements[0]!, name: 'Hidden\u0000name' },
          ],
        },
      })
      .expect(400);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('does not expose published sponsors when the highlights publication is withdrawn', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    f.records.get(highlightRecordId(f.eventId))!.highlights!.published = false;
    await f.publicRead().expect(404);
    expect(f.stored().eventSponsors!.published).not.toBeNull();
  });

  it('rechecks event closure after reading the final sponsor revision', async () => {
    const f = await sponsorFixture(),
      get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.id && ++reads === 2)
        f.records.get(f.eventId)!.archived = true;
      return get(id);
    });
    await f.publish().expect(409);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('keeps private drafts separate from the explicit published snapshot', async () => {
    const f = await sponsorFixture();
    expect((await f.read(f.root)).body).toMatchObject({
      version: 0,
      published: null,
      eventOpen: true,
    });
    await f.save().expect(200);
    expect((await f.publicRead()).body.sponsors).toBeUndefined();
    await f.publish({ version: 1 }).expect(200);
    const published = (await f.publicRead()).body;
    expect(published.sponsors).toEqual(f.sponsorFields);
    expect(JSON.stringify(published)).not.toContain(SPONSOR_PERMISSION);
    const fields = {
      ...f.sponsorFields,
      placements: [
        { ...f.sponsorFields.placements[0]!, name: 'Private draft name' },
      ],
    };
    await f.save({ version: 2, fields }).expect(200);
    expect((await f.publicRead()).body.sponsors).toEqual(f.sponsorFields);
    expect((await f.read(f.root)).body.draft).toEqual(fields);
    await f.withdraw(3).expect(200);
    expect((await f.publicRead()).body.sponsors).toBeUndefined();
    expect((await f.read(f.root)).body.draft).toEqual(fields);
  });

  it('requires current ownership, actor binding, session and trusted origin', async () => {
    const f = await sponsorFixture();
    await f.read(f.root, f.strangerId).expect(404);
    await f
      .write(
        { action: 'save', version: 0, fields: f.sponsorFields },
        f.strangerId,
      )
      .expect(404);
    await f
      .write(
        { action: 'save', version: 0, fields: f.sponsorFields },
        f.ownerId,
        f.strangerId,
      )
      .expect(409);
    await request(f.app).get(f.root).expect(401);
    await request(f.app).get(`/api/public/highlights/${f.eventId}`).expect(401);
    await request(f.app)
      .put(f.root)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('Origin', 'https://other.example.test')
      .set(SPONSOR_ACTOR, f.ownerId)
      .send({ action: 'save', version: 0, fields: f.sponsorFields })
      .expect(403);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('requires explicit permission and at least one selected display to publish', async () => {
    const f = await sponsorFixture();
    await f.publish({ permission: null }).expect(400);
    await f
      .publish({ fields: { ...f.sponsorFields, gallery: false, wall: false } })
      .expect(400);
    await f
      .publish({ fields: { ...f.sponsorFields, placements: [] } })
      .expect(400);
    expect(f.records.has(f.id)).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'http://example.test',
    'https://name:secret@example.test',
    'not a URL',
  ])('rejects unsafe sponsor website %s before writing', async (website) => {
    const f = await sponsorFixture();
    await f
      .save({
        fields: {
          ...f.sponsorFields,
          placements: [{ ...f.sponsorFields.placements[0]!, website }],
        },
      })
      .expect(400);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('bounds placements, unique identities and aggregate encoded fields', async () => {
    const f = await sponsorFixture(),
      original = f.sponsorFields.placements[0]!;
    await f
      .save({
        fields: { ...f.sponsorFields, placements: [original, original] },
      })
      .expect(400);
    await f
      .save({
        fields: {
          ...f.sponsorFields,
          placements: Array.from({ length: 7 }, () => ({
            ...original,
            id: randomUUID(),
          })),
        },
      })
      .expect(400);
    await f
      .save({
        fields: {
          ...f.sponsorFields,
          placements: Array.from({ length: 6 }, () => ({
            id: randomUUID(),
            name: '"'.repeat(80),
            caption: '"'.repeat(120),
            website: `https://example.test/${'x'.repeat(270)}`,
          })),
        },
      })
      .expect(400);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('preserves explicit order and independent gallery/wall choices', async () => {
    const f = await sponsorFixture();
    const fields = {
      ...f.sponsorFields,
      gallery: false,
      placements: [
        {
          ...f.sponsorFields.placements[0]!,
          id: randomUUID(),
          name: 'Second sponsor',
        },
        f.sponsorFields.placements[0]!,
      ],
    };
    await f.publish({ fields }).expect(200);
    expect((await f.publicRead()).body.sponsors).toEqual(fields);
  });

  it('recovers a lost publish reply with the exact command and rejects stale edits', async () => {
    const f = await sponsorFixture(),
      put = f.store.put;
    let lose = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      await put(row, create);
      if (row.id === f.id && lose) {
        lose = false;
        throw new ApiError(503, 'LOST_REPLY', 'Try again');
      }
    });
    await f.publish().expect(503);
    expect((await f.publish()).body.version).toBe(1);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    await f.save().expect(409);
    expect(f.stored().eventSponsors!.published!.fields).toEqual(
      f.sponsorFields,
    );
  });

  it.each([
    { archived: true },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: 'invalid' },
  ])(
    'hides credits for a closed event and still permits withdrawal %#',
    async (patch) => {
      const f = await sponsorFixture();
      await f.publish().expect(200);
      Object.assign(f.records.get(f.eventId)!, patch);
      await f.publicRead().expect(404);
      await f.publish({ version: 1 }).expect(409);
      await f.withdraw(1).expect(200);
      expect(f.stored().eventSponsors!.published).toBeNull();
    },
  );

  it('rejects publication when ownership changes during the final read', async () => {
    const f = await sponsorFixture(),
      get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const row = await get(id);
      return id === f.eventId && ++reads === 2
        ? { ...row, ownerId: f.strangerId }
        : row;
    });
    await f.publish().expect(404);
    expect(f.records.has(f.id)).toBe(false);
  });

  it('does not overwrite a concurrently changed sponsor record', async () => {
    const f = await sponsorFixture();
    await f.save().expect(200);
    const get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.id && ++reads === 2) {
        f.stored().eventSponsors!.version++;
        f.stored().eventSponsors!.draft.placements[0]!.name =
          'Concurrent draft';
      }
      return get(id);
    });
    await f.publish({ version: 1 }).expect(409);
    expect(f.stored().eventSponsors!.draft.placements[0]!.name).toBe(
      'Concurrent draft',
    );
  });

  it('rejects a public projection when credits are withdrawn during photo reads', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    const get = f.store.get;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.photos[0]!.id) f.stored().eventSponsors!.published = null;
      return get(id);
    });
    await f.publicRead().expect(404);
    expect((await f.publicRead()).body.sponsors).toBeUndefined();
  });

  it('fails closed for mismatched scope, damaged metadata and operational read errors', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    f.stored().ownerId = f.strangerId;
    await f.publicRead().expect(404);
    f.stored().ownerId = f.ownerId;
    f.stored().eventSponsors!.version = 0;
    await f.publicRead().expect(503);
    await f.read(f.root).expect(503);
    const get = f.store.get;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.id) throw new ApiError(503, 'UNAVAILABLE', 'Retry');
      return get(id);
    });
    await f.publicRead().expect(503);
  });

  it('removes sponsor state with event deletion', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    f.store.removeFile = async () => {};
    await f.remove(`/api/events/${f.eventId}`, {}).expect(204);
    expect(f.records.has(f.id)).toBe(false);
    await f.publicRead().expect(404);
  });

  it('removes sponsor state with account erasure and denies subsequent writes', async () => {
    const f = await sponsorFixture();
    await f.publish().expect(200);
    f.store.removeFile = async () => {};
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.id)).toBe(false);
    await f.publicRead().expect(404);
    await f.save().expect(401);
  });
});
