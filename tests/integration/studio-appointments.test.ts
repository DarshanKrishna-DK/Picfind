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
import {
  appointmentOccurrences,
  type AppointmentFields,
} from '../../packages/shared/src/studio-appointments';

const origin = 'http://localhost:5173',
  createdAt = '2026-01-01T00:00:00.000Z';
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
  const project = () => {
    const id = randomUUID();
    records.set(id, {
      id,
      ownerId: 'owner',
      kind: 'job',
      purpose: 'studio-project',
      createdAt,
      studioProject: advanceProject(
        null,
        id,
        { ...blankProject(), name: 'Private wedding', stage: 'booked' },
        '',
        'owner',
        createdAt,
      ),
      projectCommandDigest: 'a'.repeat(64),
    });
    return id;
  };
  const projectId = project();
  const fields: AppointmentFields = {
    projectId,
    title: 'Portrait session',
    note: 'Private location note',
    timeZone: 'Asia/Kolkata',
    startLocal: '2026-11-01T10:00',
    endLocal: '2026-11-01T11:00',
    startAt: '2026-11-01T04:30:00.000Z',
    endAt: '2026-11-01T05:30:00.000Z',
    status: 'scheduled',
  };
  const interval = (
    startLocal: string,
    endLocal: string,
    timeZone = fields.timeZone,
  ) => ({
    startLocal,
    endLocal,
    timeZone,
    startAt: appointmentOccurrences(startLocal, timeZone)[0]!.instant,
    endAt: appointmentOccurrences(endLocal, timeZone)[0]!.instant,
  });
  const save = (
    id: string = randomUUID(),
    changes: object = {},
    version = 0,
    actor = 'owner',
  ) =>
    request(app)
      .put(`/api/studio/appointments/${id}`)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin)
      .send({ ...fields, ...changes, version });
  const read = (actor = 'owner') =>
    request(app)
      .get('/api/studio/appointments')
      .set('Cookie', `picfind_session=${actor}`);
  const remove = (id: string, version: number, actor = 'owner') =>
    request(app)
      .delete(`/api/studio/appointments/${id}`)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin)
      .send({ version });
  const archive = (id = projectId) => {
    const row = records.get(id)!;
    row.studioProject = advanceProject(
      row.studioProject!,
      id,
      { ...blankProject(), name: 'Private wedding', stage: 'archived' },
      '',
      'owner',
      new Date().toISOString(),
    );
  };
  const seed = (changes: Partial<AppointmentFields> = {}) => {
    const id = randomUUID();
    records.set(id, {
      id,
      ownerId: 'owner',
      kind: 'job',
      purpose: 'studio-appointment',
      createdAt,
      studioAppointment: {
        ...fields,
        ...changes,
        id,
        version: 1,
        createdAt,
        updatedAt: createdAt,
      },
      appointmentCommandDigest: 'b'.repeat(64),
    });
    return id;
  };
  const removeProject = () =>
    request(app)
      .delete(`/api/studio/projects/${projectId}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ version: records.get(projectId)!.studioProject!.version });
  return {
    app,
    records,
    store,
    projectId,
    project,
    fields,
    interval,
    save,
    read,
    remove,
    archive,
    seed,
    removeProject,
  };
}
describe('private studio appointment reservations', () => {
  it('persists exact local/UTC times with owner project names and no command digest', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    const result = await f.read().expect(200);
    expect(result.body).toMatchObject({
      accountId: 'owner',
      totalCount: 1,
      appointments: [
        {
          appointment: { ...f.fields, id, version: 1 },
          project: {
            id: f.projectId,
            name: 'Private wedding',
            removalPending: false,
          },
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain('CommandDigest');
    expect((await f.read('other').expect(200)).body.appointments).toEqual([]);
  });
  it('enforces session, origin, account header and record ownership', async () => {
    const f = fixture(),
      id = randomUUID();
    await request(f.app).get('/api/studio/appointments').expect(401);
    await f.save(id).set('Origin', 'https://evil.example').expect(403);
    await f.save(id).set('X-PicFind-Studio-Actor', 'other').expect(403);
    await f.save(id).expect(200);
    await f.save(id, {}, 1, 'other').expect(404);
    await f.remove(id, 1, 'other').expect(404);
    await f.read().set('X-PicFind-Studio-Actor', 'other').expect(403);
  });
  it('serializes overlapping creates and accepts an adjacent reservation', async () => {
    const f = fixture();
    const results = await Promise.all([f.save(), f.save()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(
      results.find((result) => result.status === 409)!.body.error.code,
    ).toBe('APPOINTMENT_OVERLAP');
    await f
      .save(randomUUID(), f.interval('2026-11-01T11:00', '2026-11-01T12:00'))
      .expect(200);
    expect((await f.read()).body.totalCount).toBe(2);
  });
  it('releases time on cancellation and rechecks overlap on restoration', async () => {
    const f = fixture(),
      first = randomUUID(),
      second = randomUUID();
    await f.save(first).expect(200);
    await f.save(first, { status: 'cancelled' }, 1).expect(200);
    await f.save(second).expect(200);
    await f.save(first, {}, 2).expect(409);
    expect(f.records.get(first)!.studioAppointment!.status).toBe('cancelled');
    await f.remove(second, 1).expect(204);
    await f.save(first, {}, 2).expect(200);
  });
  it('retains archived-project reservations until explicitly cancelled', async () => {
    const f = fixture(),
      first = randomUUID(),
      otherProject = f.project();
    await f.save(first).expect(200);
    f.archive();
    await f.save(randomUUID(), { projectId: otherProject }).expect(409);
    await f.save(first, { status: 'cancelled' }, 1).expect(200);
    await f.save(randomUUID(), { projectId: otherProject }).expect(200);
    await f.save(first, {}, 2).expect(409);
  });
  it('permits cancellation but no metadata edit after the parent becomes unavailable', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    f.records.get(f.projectId)!.ownerId = 'other';
    expect(
      (await f.read().expect(200)).body.appointments[0].project,
    ).toBeNull();
    await f
      .save(id, { note: 'Changed note', status: 'cancelled' }, 1)
      .expect(404);
    await f.save(id, { status: 'cancelled' }, 1).expect(200);
    await f.save(id, { status: 'cancelled' }, 1).expect(200);
    await f.remove(id, 2).expect(204);
  });
  it('replays the exact command without duplicating a reservation and conflicts on stale edits', async () => {
    const f = fixture(),
      id = randomUUID();
    const first = await f.save(id).expect(200);
    expect((await f.save(id).expect(200)).body).toEqual(first.body);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    await f.save(id, { note: 'Changed note' }, 1).expect(200);
    await f.save(id, {}, 1).expect(409);
    await f.remove(id, 1).expect(409);
    expect(f.records.get(id)!.studioAppointment!.note).toBe('Changed note');
  });
  it('allows normalized cancellation during pending project removal but rejects detail changes', async () => {
    const f = fixture(),
      id = randomUUID();
    await f.save(id).expect(200);
    f.archive();
    f.records.get(f.projectId)!.projectRemovalStartedAt =
      new Date().toISOString();
    await f
      .save(id, { status: 'cancelled', note: 'Changed during removal' }, 1)
      .expect(409);
    expect(f.records.get(id)!.studioAppointment!.status).toBe('scheduled');
    await f
      .save(id, { status: 'cancelled', note: `  ${f.fields.note}  ` }, 1)
      .expect(200);
    expect(f.records.get(id)!.studioAppointment).toMatchObject({
      status: 'cancelled',
      note: f.fields.note,
      version: 2,
    });
    await f.save(id, {}, 2).expect(409);
  });
  it.each(['missing', 'foreign', 'archived', 'removing'])(
    'rejects a %s parent for new reservations',
    async (kind) => {
      const f = fixture();
      if (kind === 'missing') f.records.delete(f.projectId);
      if (kind === 'foreign') f.records.get(f.projectId)!.ownerId = 'other';
      if (kind === 'archived' || kind === 'removing') f.archive();
      if (kind === 'removing')
        f.records.get(f.projectId)!.projectRemovalStartedAt =
          new Date().toISOString();
      const response = await f.save();
      expect([404, 409]).toContain(response.status);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('rechecks project ownership after scanning reservations', async () => {
    const f = fixture(),
      get = f.store.get;
    let count = 0;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.projectId && ++count === 2) row.ownerId = 'other';
      return row;
    };
    await f.save().expect(404);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('enforces stable project identity and refuses corrupt conflict records', async () => {
    const f = fixture(),
      id = f.seed(),
      second = f.project();
    await f.save(id, { projectId: second }, 1).expect(400);
    f.records.get(id)!.studioAppointment!.title = '';
    await f.save().expect(503);
    await f.read().expect(503);
  });
  it('rejects unresolved/reassigned DST instants and system fields at the API', async () => {
    const f = fixture();
    await f
      .save(randomUUID(), { startAt: '2026-11-01T10:00:00.000Z' })
      .expect(400);
    await f
      .save(randomUUID(), {
        startLocal: '2026-03-08T02:30',
        timeZone: 'America/New_York',
      })
      .expect(400);
    await f
      .save(randomUUID(), {
        startLocal: '2026-11-01T01:30',
        timeZone: 'America/New_York',
        startAt: '',
      })
      .expect(400);
    await f.save(randomUUID(), { ownerId: 'other' }).expect(400);
    await f.save(randomUUID(), { note: 'x'.repeat(1001) }).expect(400);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('enforces both caps while retaining edit/delete recovery', async () => {
    const f = fixture(),
      ids = Array.from({ length: 30 }, () => f.seed({ status: 'cancelled' }));
    await f.save().expect(409);
    await f
      .save(ids[0], { note: 'Still editable', status: 'cancelled' }, 1)
      .expect(200);
    await f.remove(ids[1]!, 1).expect(204);
    await f.save().expect(200);
    for (let i = 0; i < 271; i++)
      f.seed({ status: 'cancelled', projectId: randomUUID() });
    const result = await f.read().expect(200);
    expect(result.body.totalCount).toBe(301);
    expect(result.body.appointments).toHaveLength(300);
    await f.save(randomUUID(), { projectId: f.project() }).expect(409);
    await f.remove(ids[0]!, 2).expect(204);
  });
  it('resumes mixed milestone/appointment project cleanup without affecting unrelated reservations', async () => {
    const f = fixture(),
      appointment = f.seed(),
      unrelated = f.seed({ projectId: randomUUID() }),
      milestone = randomUUID();
    f.records.set(milestone, {
      id: milestone,
      ownerId: 'owner',
      kind: 'job',
      purpose: 'studio-milestone',
      createdAt,
      studioMilestone: advanceMilestone(
        null,
        milestone,
        {
          projectId: f.projectId,
          title: 'Deliver',
          note: '',
          dueDate: '2026-11-01',
          timeZone: 'UTC',
          status: 'open',
        },
        createdAt,
      ),
      milestoneCommandDigest: 'c'.repeat(64),
    });
    f.archive();
    const remove = f.store.remove;
    f.store.remove = vi.fn(async (id) => {
      if (id === milestone)
        throw new ApiError(503, 'OUTAGE', 'Synthetic cleanup outage.');
      await remove(id);
    });
    await f.removeProject().expect(503);
    expect(f.records.has(appointment)).toBe(false);
    expect(f.records.get(f.projectId)!.projectRemovalStartedAt).toBeTruthy();
    expect(f.records.has(milestone)).toBe(true);
    f.store.remove = remove;
    await f.removeProject().expect(204);
    expect(f.records.has(milestone)).toBe(false);
    expect(f.records.has(unrelated)).toBe(true);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
});
