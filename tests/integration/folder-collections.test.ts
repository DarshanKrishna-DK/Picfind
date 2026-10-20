import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { creditFixture } from '../fixtures/credit-presets';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import { FOLDER_ACTOR_HEADER } from '../../packages/shared/src/folder-import';

function fixture() {
  const f = creditFixture(),
    id = randomUUID();
  const body = { title: 'Ceremony', photoIds: f.photos.map((row) => row.id) };
  const path = `/api/events/${f.eventId}/proofing-collections/${id}/import`;
  const create = (
    changes: object = {},
    actor = f.ownerId,
    header = actor,
    target = path,
  ) =>
    request(f.app)
      .put(target)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${actor}`)
      .set(FOLDER_ACTOR_HEADER, header)
      .send({ ...body, ...changes });
  return { ...f, id, body, path, create };
}
describe('owner-only idempotent folder collection mapping', () => {
  it('creates an ordinary private collection with exact photo identities and recovers a lost reply', async () => {
    const f = fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Synthetic lost reply');
    });
    await f.create().expect(500);
    const original = structuredClone(f.records.get(f.id));
    const reply = await f
      .create({ photoIds: [...f.body.photoIds].reverse() })
      .expect(201);
    expect(reply.body.collection).toMatchObject({
      id: f.id,
      title: 'Ceremony',
      version: 1,
    });
    expect(new Set(reply.body.collection.photoIds)).toEqual(
      new Set(f.body.photoIds),
    );
    expect(f.records.get(f.id)).toEqual(original);
    expect(JSON.stringify(reply.body)).not.toMatch(
      /privatePhotoNote|collectionImportDigest/,
    );
    expect(
      [...f.records.values()].filter(
        (row) => row.purpose === 'proofing-collection',
      ),
    ).toHaveLength(1);
  });
  it('requires current authentication, exact expected actor and trusted origin', async () => {
    const f = fixture();
    await request(f.app)
      .put(f.path)
      .set('Origin', questionnaireOrigin)
      .send(f.body)
      .expect(401);
    await f.create({}, f.ownerId, f.clientId).expect(409);
    await f.create({}, f.clientId, f.ownerId).expect(409);
    await f.create({}, f.clientId).expect(404);
    await f.create().set('Origin', 'https://foreign.test').expect(403);
    await request(f.app)
      .put(f.path)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send(f.body)
      .expect(409);
    expect(f.records.has(f.id)).toBe(false);
  });
  it('does not overwrite ordinary collections, changed commands or later edits', async () => {
    const f = fixture();
    await f.create().expect(201);
    await f.create({ title: 'Changed title' }).expect(409);
    const row = f.records.get(f.id)!;
    row.collectionVersion = 2;
    await f.create().expect(409);
    row.collectionVersion = 1;
    delete row.collectionImportDigest;
    await f.create().expect(409);
    expect(row.title).toBe('Ceremony');
  });
  it('rejects caller-controlled publication, duplicate identities and invalid titles', async () => {
    const f = fixture();
    for (const changes of [
      { published: true },
      { photoIds: [f.photos[0]!.id, f.photos[0]!.id] },
      { title: '' },
      { photoIds: [] },
    ])
      await f.create(changes).expect(400);
    expect(f.records.has(f.id)).toBe(false);
  });
  it.each(['foreign', 'other-event', 'expired', 'deleting', 'scan'])(
    'rejects a %s photo on creation and replay',
    async (mode) => {
      const f = fixture();
      await f.create().expect(201);
      const row = f.records.get(f.photos[0]!.id)!;
      if (mode === 'foreign') row.ownerId = f.clientId;
      if (mode === 'other-event') row.eventId = randomUUID();
      if (mode === 'expired') row.expiresAt = '2000-01-01T00:00:00.000Z';
      if (mode === 'deleting') row.deletionStartedAt = new Date().toISOString();
      if (mode === 'scan') row.scanId = randomUUID();
      await f.create().expect(400);
      f.records.delete(f.id);
      await f.create().expect(400);
    },
  );
  it.each(['archived', 'expired', 'removing'])(
    'denies a %s event even when replaying a committed mapping',
    async (mode) => {
      const f = fixture();
      await f.create().expect(201);
      const event = f.records.get(f.eventId)!;
      if (mode === 'archived') event.archived = true;
      if (mode === 'expired') event.expiresAt = 'invalid';
      if (mode === 'removing')
        event.deletionStartedAt = new Date().toISOString();
      await f.create().expect(mode === 'removing' ? 404 : 410);
    },
  );
  it('replays at capacity but prevents another collection and preserves foreign UUID collisions', async () => {
    const f = fixture();
    await f.create().expect(201);
    const original = f.records.get(f.id)!;
    for (let index = 1; index < 50; index++) {
      const id = randomUUID();
      f.records.set(id, { ...original, id });
    }
    await f.create().expect(201);
    await f
      .create({}, f.ownerId, f.ownerId, f.path.replace(f.id, randomUUID()))
      .expect(409);
    f.records.get(f.id)!.ownerId = f.clientId;
    await f.create().expect(404);
  });
  it('rechecks photo ownership after the candidate list and refuses a late scope change', async () => {
    const f = fixture(),
      list = f.store.list.bind(f.store);
    vi.spyOn(f.store, 'list').mockImplementation(async (actor, kind) => {
      const rows = await list(actor, kind);
      if (kind === 'photo')
        f.records.get(f.photos[0]!.id)!.ownerId = f.clientId;
      return rows;
    });
    await f.create().expect(409);
    expect(f.records.has(f.id)).toBe(false);
  });
});
