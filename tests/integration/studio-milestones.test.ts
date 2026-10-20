import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import {
  advanceProject,
  blankProject,
} from '../../packages/shared/src/studio-projects';
import { advanceMilestone } from '../../packages/shared/src/studio-milestones';

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
  const projectId = randomUUID(),
    createdAt = '2026-01-01T00:00:00.000Z';
  records.set(projectId, {
    id: projectId,
    ownerId: 'owner',
    kind: 'job',
    purpose: 'studio-project',
    createdAt,
    studioProject: advanceProject(
      null,
      projectId,
      { ...blankProject(), name: 'Private wedding', stage: 'editing' },
      '',
      'owner',
      createdAt,
    ),
    projectCommandDigest: 'a'.repeat(64),
  });
  const fields = {
    projectId,
    title: 'Deliver proofs',
    note: 'Private note',
    dueDate: '2026-11-01',
    timeZone: 'America/New_York',
    status: 'open' as const,
  };
  const save = (
    id: string = randomUUID(),
    changes: object = {},
    version = 0,
    actor = 'owner',
  ) =>
    request(app)
      .put(`/api/studio/milestones/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ ...fields, ...changes, version });
  const read = (actor = 'owner') =>
    request(app)
      .get('/api/studio/milestones')
      .set('Cookie', `picfind_session=${actor}`);
  const remove = (id: string, version: number, actor = 'owner') =>
    request(app)
      .delete(`/api/studio/milestones/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ version });
  const archive = () => {
    const row = records.get(projectId)!;
    row.studioProject = advanceProject(
      row.studioProject!,
      projectId,
      { ...blankProject(), name: 'Private wedding', stage: 'archived' },
      '',
      'owner',
      new Date().toISOString(),
    );
  };
  const removeProject = () =>
    request(app)
      .delete(`/api/studio/projects/${projectId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ version: records.get(projectId)!.studioProject!.version });
  const seed = (id: string = randomUUID(), parentId = projectId) => {
    records.set(id, {
      id,
      ownerId: 'owner',
      kind: 'job',
      purpose: 'studio-milestone',
      createdAt,
      studioMilestone: advanceMilestone(
        null,
        id,
        { ...fields, projectId: parentId },
        createdAt,
      ),
      milestoneCommandDigest: 'b'.repeat(64),
    });
    return id;
  };
  return {
    records,
    store,
    app,
    projectId,
    fields,
    save,
    read,
    remove,
    archive,
    removeProject,
    seed,
  };
}
describe('private dated studio milestones', () => {
  it('persists with a current owner project projection and no command digest', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    const result = await f.read().expect(200);
    expect(result.body).toMatchObject({
      accountId: 'owner',
      totalCount: 1,
      limit: 300,
      milestones: [
        {
          milestone: { ...f.fields, id, version: 1, completedAt: null },
          project: {
            id: f.projectId,
            name: 'Private wedding',
            stage: 'editing',
          },
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain('CommandDigest');
    expect((await f.read('other').expect(200)).body.milestones).toEqual([]);
  });
  it('rejects anonymous, cross-origin and changed-account requests', async () => {
    const f = fixture(),
      id = randomUUID();
    await request(f.app).get('/api/studio/milestones').expect(401);
    await request(f.app)
      .put(`/api/studio/milestones/${id}`)
      .set('Origin', 'https://evil.example')
      .set('Cookie', 'picfind_session=owner')
      .send({ ...f.fields, version: 0 })
      .expect(403);
    await request(f.app)
      .get('/api/studio/milestones')
      .set('Cookie', 'picfind_session=owner')
      .set('X-PicFind-Studio-Actor', 'other')
      .expect(403);
    await f.save(id).set('X-PicFind-Studio-Actor', 'other').expect(403);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'wrong-purpose', 'missing', 'archived', 'deleting'])(
    'denies a %s parent without saving',
    async (kind) => {
      const f = fixture(),
        row = f.records.get(f.projectId)!;
      if (kind === 'foreign') row.ownerId = 'other';
      if (kind === 'wrong-purpose') row.purpose = 'studio-client';
      if (kind === 'missing') f.records.delete(f.projectId);
      if (kind === 'archived') f.archive();
      if (kind === 'deleting') row.deletionStartedAt = new Date().toISOString();
      const result = await f.save();
      expect([404, 409]).toContain(result.status);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('rechecks ownership after quota work before committing', async () => {
    const f = fixture(),
      get = f.store.get;
    let parentReads = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.projectId && ++parentReads === 2) row.ownerId = 'other';
      return row;
    };
    await f.save().expect(404);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('recovers exact completed retries without another write or completion timestamp', async () => {
    const f = fixture(),
      id = randomUUID();
    const first = await f.save(id, { status: 'completed' }).expect(200);
    const replay = await f.save(id, { status: 'completed' }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    f.archive();
    await f.save(id, { status: 'completed' }).expect(409);
    expect(f.store.put).toHaveBeenCalledTimes(1);
  });
  it('serializes competing edits and preserves completion through editing and reopening', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    const results = await Promise.all([
      f.save(id, { title: 'One' }, 1),
      f.save(id, { title: 'Two' }, 1),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const completed = await f.save(id, { status: 'completed' }, 2).expect(200);
    const edited = await f
      .save(id, { title: 'Final', status: 'completed' }, 3)
      .expect(200);
    expect(edited.body.milestone.completedAt).toBe(
      completed.body.milestone.completedAt,
    );
    const reopened = await f.save(id, {}, 4).expect(200);
    expect(reopened.body.milestone.completedAt).toBeNull();
    expect(reopened.body.milestone.version).toBe(5);
    await f.remove(id, 4).expect(409);
    await f.remove(id, 5, 'other').expect(404);
    await f.remove(id, 5).expect(204);
    expect(f.records.has(f.projectId)).toBe(true);
  });
  it('keeps archived and unavailable work removable without exposing a foreign name', async () => {
    const f = fixture(),
      id = f.seed();
    f.archive();
    const archived = await f.read().expect(200);
    expect(archived.body.projects).toEqual([]);
    expect(archived.body.milestones[0].project.stage).toBe('archived');
    f.records.get(f.projectId)!.ownerId = 'other';
    // Even a faulty over-broad store projection cannot disclose another owner.
    f.store.list = async () => [...f.records.values()];
    const unavailable = await f.read().expect(200);
    expect(unavailable.body.milestones[0].project).toBeNull();
    expect(JSON.stringify(unavailable.body)).not.toContain('Private wedding');
    await f.remove(id, 1).expect(204);
  });
  it('does not allow moving a saved milestone to another project', async () => {
    const f = fixture(),
      id = f.seed(),
      second = randomUUID();
    const original = f.records.get(f.projectId)!;
    f.records.set(second, {
      ...original,
      id: second,
      studioProject: { ...original.studioProject!, id: second },
    });
    await f.save(id, { projectId: second }, 1).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('enforces per-project and account capacity while allowing existing edits and recovery deletion', async () => {
    const f = fixture();
    const ids = Array.from({ length: 30 }, () => f.seed());
    await f.save().expect(409);
    await f.save(ids[0], { title: 'Still editable' }, 1).expect(200);
    await f.remove(ids[1]!, 1).expect(204);
    await f.save().expect(200);
    for (let i = 0; i < 271; i++) f.seed(randomUUID(), randomUUID());
    const result = await f.read().expect(200);
    expect(result.body.totalCount).toBe(301);
    expect(result.body.milestones).toHaveLength(300);
    await f.save().expect(409);
    await f.remove(ids[0]!, 2).expect(204);
  });
  it('keeps the parent after partial cleanup failure and safely finishes on retry', async () => {
    const f = fixture(),
      first = f.seed(),
      second = f.seed(),
      unrelated = f.seed(randomUUID(), randomUUID()),
      foreign = f.seed();
    f.records.get(foreign)!.ownerId = 'other';
    f.archive();
    const realRemove = f.store.remove;
    f.store.remove = vi.fn(async (id) => {
      expect(f.records.get(f.projectId)!.projectRemovalStartedAt).toEqual(
        expect.any(String),
      );
      if (id === second)
        throw new ApiError(503, 'OUTAGE', 'Synthetic cleanup outage.');
      await realRemove(id);
    });
    await f.removeProject().expect(503);
    expect(f.records.has(first)).toBe(false);
    expect(f.records.has(f.projectId)).toBe(true);
    expect(f.records.has(second)).toBe(true);
    expect(f.records.get(f.projectId)!.projectRemovalStartedAt).toEqual(
      expect.any(String),
    );
    const projects = await request(f.app)
      .get('/api/studio/projects')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(projects.body.projects[0].removalPending).toBe(true);
    await request(f.app)
      .put(`/api/studio/projects/${f.projectId}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({
        ...blankProject(),
        name: 'Restore',
        stage: 'editing',
        reason: 'Change my mind',
        version: 2,
      })
      .expect(409);
    expect(f.records.get(f.projectId)!.studioProject!.stage).toBe('archived');
    await f.save(second, {}, 1).expect(409);
    f.store.remove = realRemove;
    await f.removeProject().expect(204);
    expect(f.records.has(second)).toBe(false);
    expect(f.records.has(f.projectId)).toBe(false);
    expect(f.records.has(unrelated)).toBe(true);
    expect(f.records.has(foreign)).toBe(true);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it('rejects a changed parent before recording removal or deleting children', async () => {
    const f = fixture(),
      child = f.seed(),
      get = f.store.get;
    f.archive();
    let reads = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.projectId && ++reads === 2) row.studioProject!.version++;
      return row;
    };
    await f.removeProject().expect(409);
    expect(f.records.has(child)).toBe(true);
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('does not delete children when persisting removal intent fails', async () => {
    const f = fixture(),
      child = f.seed();
    f.archive();
    f.store.put = vi.fn(async () => {
      throw new ApiError(503, 'OUTAGE', 'Synthetic intent failure.');
    });
    await f.removeProject().expect(503);
    expect(f.records.has(child)).toBe(true);
    expect(f.records.get(f.projectId)!.projectRemovalStartedAt).toBeUndefined();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('checks persisted removal intent before each child deletion', async () => {
    const f = fixture(),
      child = f.seed(),
      get = f.store.get;
    f.archive();
    f.store.get = async (id) => {
      if (id === child)
        delete f.records.get(f.projectId)!.projectRemovalStartedAt;
      return get(id);
    };
    await f.removeProject().expect(409);
    expect(f.records.has(child)).toBe(true);
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('finishes an authorized removal when the parent is already absent after child cleanup', async () => {
    const f = fixture(),
      child = f.seed(),
      remove = f.store.remove;
    f.archive();
    f.store.remove = vi.fn(async (id) => {
      if (!f.records.has(id))
        throw new ApiError(404, 'NOT_FOUND', 'Already removed.');
      await remove(id);
      if (id === child) f.records.delete(f.projectId);
    });
    await f.removeProject().expect(204);
    expect(f.records.has(child)).toBe(false);
    expect(f.records.has(f.projectId)).toBe(false);
  });
  it('stops cleanup when a child changes scope during deletion', async () => {
    const f = fixture(),
      id = f.seed(),
      get = f.store.get;
    f.archive();
    f.store.get = async (key) => {
      const row = await get(key);
      if (key === id) row.ownerId = 'other';
      return row;
    };
    await f.removeProject().expect(409);
    expect(f.records.has(id)).toBe(true);
    expect(f.records.has(f.projectId)).toBe(true);
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it.each([
    { dueDate: '2026-02-29' },
    { timeZone: 'Mars/Base' },
    { title: '' },
    { ownerId: 'other' },
    { completedAt: '2026-01-01T00:00:00.000Z' },
    { note: 'x'.repeat(1001) },
  ])('rejects malformed or system-controlled fields %j', async (changes) => {
    const f = fixture();
    await f.save(randomUUID(), changes).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('fails closed on corrupt stored completion metadata', async () => {
    const f = fixture(),
      id = f.seed();
    f.records.get(id)!.studioMilestone!.completedAt = new Date().toISOString();
    await f.read().expect(503);
    await f.save(id, {}, 1).expect(503);
    expect(f.store.put).not.toHaveBeenCalled();
  });
});
