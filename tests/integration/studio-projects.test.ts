import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { blankProject } from '../../packages/shared/src/studio-projects';
const origin = 'http://localhost:5173';
function fixture() {
  const records = new Map<string, LibraryRecord>();
  const store: LibraryStore = {
    list: async (actor, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    put: vi.fn(async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(async (id) => {
      records.delete(id);
    }),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    { store },
  );
  const now = new Date().toISOString(),
    eventId = randomUUID(),
    clientId = randomUUID();
  records.set(eventId, {
    id: eventId,
    kind: 'event',
    ownerId: 'owner',
    createdAt: now,
    title: 'Private event',
    visibility: 'private',
  });
  records.set(clientId, {
    id: clientId,
    kind: 'job',
    purpose: 'studio-client',
    ownerId: 'owner',
    createdAt: now,
    studioClient: {
      id: clientId,
      name: 'Private client',
      email: 'private@example.test',
      phone: '',
      company: '',
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  });
  const fields = {
    ...blankProject(),
    name: 'Wedding delivery',
    clientId,
    eventIds: [eventId],
  };
  const save = (
    id: string = randomUUID(),
    changes: object = {},
    version = 0,
    actor = 'owner',
  ) =>
    request(app)
      .put(`/api/studio/projects/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ ...fields, reason: '', ...changes, version });
  const read = (actor = 'owner') =>
    request(app)
      .get('/api/studio/projects')
      .set('Cookie', `picfind_session=${actor}`);
  const remove = (id: string, version: number, actor = 'owner') =>
    request(app)
      .delete(`/api/studio/projects/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ version });
  return { app, store, records, eventId, clientId, fields, read, save, remove };
}
describe('owner-only photographer projects', () => {
  it('persists linked work with current names but no copied contact or photo data', async () => {
    const f = fixture(),
      id = randomUUID();
    const created = await f.save(id).expect(200);
    expect(created.body.project).toMatchObject({
      ...f.fields,
      version: 1,
      transitionCount: 1,
    });
    const loaded = await f.read().expect(200);
    expect(loaded.body.projects[0]).toMatchObject({
      client: { id: f.clientId, name: 'Private client' },
      events: [{ id: f.eventId, title: 'Private event' }],
    });
    expect(JSON.stringify(loaded.body)).not.toMatch(
      /private@example|projectCommandDigest|phone/,
    );
    expect(f.records.get(id)?.studioProject).not.toHaveProperty('email');
    expect(f.store.upload).not.toHaveBeenCalled();
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(JSON.stringify(library.body)).not.toContain('Wedding delivery');
  });
  it('requires authenticated expected-account requests and trusted mutation origins', async () => {
    const f = fixture(),
      id = randomUUID();
    await request(f.app).get('/api/studio/projects').expect(401);
    await f.save(id).set('Origin', 'https://outside.test').expect(403);
    await f.save(id).set('X-PicFind-Studio-Actor', 'other').expect(403);
    await f.read().set('X-PicFind-Studio-Actor', 'other').expect(403);
    expect(f.records.size).toBe(2);
  });
  it('denies foreign contacts, moderator-only events, foreign projects and wrong-purpose IDs', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    await f.save(id, {}, 1, 'other').expect(404);
    await f.remove(id, 1, 'other').expect(404);
    expect((await f.read('other').expect(200)).body.projects).toEqual([]);
    f.records.get(f.eventId)!.members = [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: new Date().toISOString(),
      },
    ];
    await f.save(randomUUID(), { clientId: null }, 0, 'moderator').expect(404);
    await f.save(randomUUID(), { eventIds: [] }, 0, 'other').expect(404);
    await f.save(f.clientId).expect(404);
    await f.save(f.eventId).expect(404);
  });
  it('keeps unavailable existing references private and allows the owner to remove or retain them', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    f.records.get(f.clientId)!.ownerId = 'other';
    f.records.delete(f.eventId);
    const loaded = await f.read().expect(200);
    expect(loaded.body.projects[0].client).toEqual({
      id: f.clientId,
      name: null,
    });
    expect(loaded.body.projects[0].events).toEqual([
      { id: f.eventId, title: null },
    ]);
    expect(loaded.body.clients).toEqual([]);
    expect(loaded.body.events).toEqual([]);
    await f.save(id, { stage: 'archived' }, 1).expect(200);
    await f.save(randomUUID()).expect(404);
    await f
      .save(id, { clientId: null, eventIds: [], stage: 'archived' }, 2)
      .expect(200);
  });
  it('requires backward-change reasons and preserves exact retry history', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id, { stage: 'editing' }).expect(200);
    await f.save(id, { stage: 'shooting' }, 1).expect(400);
    const changed = await f
      .save(id, { stage: 'shooting', reason: 'Reshoot requested' }, 1)
      .expect(200);
    expect(changed.body.project.transitions.at(-1)).toMatchObject({
      from: 'editing',
      to: 'shooting',
      reason: 'Reshoot requested',
      actorId: 'owner',
    });
    const replay = await f
      .save(id, { stage: 'shooting', reason: 'Reshoot requested' }, 1)
      .expect(200);
    expect(replay.body).toEqual(changed.body);
    await f
      .save(id, { stage: 'shooting', reason: 'Different reason' }, 1)
      .expect(409);
    expect(f.store.put).toHaveBeenCalledTimes(2);
  });
  it('serializes stale edits and recovers a committed create after reply loss', async () => {
    const f = fixture(),
      id = randomUUID(),
      put = f.store.put;
    f.store.put = async (row, create) => {
      await put(row, create);
      throw new ApiError(503, 'LOST_REPLY', 'Synthetic lost reply.');
    };
    await f.save(id).expect(503);
    f.store.put = put;
    await f.save(id).expect(200);
    expect(put).toHaveBeenCalledOnce();
    const results = await Promise.all([
      f.save(id, { name: 'One' }, 1),
      f.save(id, { name: 'Two' }, 1),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(f.records.get(id)!.studioProject!.transitions).toHaveLength(1);
  });
  it('deletes only a currently archived project and preserves all linked records', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    await f.remove(id, 1).expect(409);
    await f.save(id, { stage: 'archived' }, 1).expect(200);
    await f.remove(id, 1).expect(409);
    await f.remove(id, 2).expect(204);
    expect(f.records.has(id)).toBe(false);
    expect(f.records.has(f.eventId)).toBe(true);
    expect(f.records.has(f.clientId)).toBe(true);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it.each(['clientId', 'eventId'] as const)(
    'checks a newly selected %s again before committing',
    async (target) => {
      const f = fixture(),
        get = f.store.get;
      let reads = 0;
      f.store.get = async (id) => {
        if (id === f[target] && ++reads === 2)
          f.records.get(id)!.ownerId = 'other';
        return get(id);
      };
      await f.save().expect(404);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('bounds overcapacity reads while retaining archive and removal recovery', async () => {
    const f = fixture(),
      first = randomUUID();
    await f.save(first).expect(200);
    const template = f.records.get(first)!;
    for (let index = 0; index < 200; index++) {
      const id = randomUUID();
      f.records.set(id, {
        ...structuredClone(template),
        id,
        studioProject: { ...structuredClone(template.studioProject!), id },
      });
    }
    const before = await f.read().expect(200);
    expect(before.body.totalCount).toBe(201);
    expect(before.body.projects).toHaveLength(200);
    await f.save().expect(409);
    await f.save(first, { stage: 'archived' }, 1).expect(200);
    await f.remove(first, 2).expect(204);
    expect((await f.read().expect(200)).body.totalCount).toBe(200);
  });
  it.each(['history', 'actor', 'digest', 'version'] as const)(
    'fails closed on corrupt stored %s',
    async (kind) => {
      const f = fixture(),
        id = randomUUID();
      await f.save(id).expect(200);
      const row = f.records.get(id)!;
      if (kind === 'history') row.studioProject!.transitionCount = 2;
      if (kind === 'actor')
        row.studioProject!.transitions[0]!.actorId = 'other';
      if (kind === 'digest') row.projectCommandDigest = 'invalid';
      if (kind === 'version') row.studioProject!.version = 0;
      await f.read().expect(503);
      await f.save(id, {}, 1).expect(503);
    },
  );
  it.each([
    { name: '' },
    { name: 'a'.repeat(101) },
    { summary: 'a'.repeat(1001) },
    { stage: 'paid' },
    { clientId: 'invalid' },
    { eventIds: Array.from({ length: 21 }, () => randomUUID()) },
    { ownerId: 'other' },
  ])('rejects invalid project input %j', async (changes) => {
    const f = fixture();
    await f.save(randomUUID(), changes).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
});
