import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { availabilityFixture } from '../fixtures/studio-availability';
import { ApiError } from '../../apps/api/src/auth';
import {
  availabilityWrite,
  availabilityDirectory,
} from '../../packages/shared/src/studio-availability';
import { appointmentOccurrences } from '../../packages/shared/src/studio-appointments';

describe('private unavailable time', () => {
  it('persists private blocks, exact retries, updates and generation-aware deletion', async () => {
    const f = availabilityFixture(),
      first = (await f.create().expect(200)).body.block;
    expect((await f.create().expect(200)).body.block).toEqual(first);
    const directory = availabilityDirectory.parse(
      (await f.read(f.availabilityRoot).expect(200)).body,
    );
    expect(directory.blocks).toEqual([first]);
    expect((await f.read(f.availabilityPath).expect(200)).body.block).toEqual(
      first,
    );
    await f.create({ version: 1, title: 'Preparation' }).expect(200);
    await f.create({ version: 1, title: 'Stale update' }).expect(409);
    await f
      .remove(f.availabilityPath, { version: 2, generation: randomUUID() })
      .expect(409);
    await f
      .remove(f.availabilityPath, { version: 2, generation: f.generation })
      .expect(204);
    await f.create({ generation: randomUUID() }).expect(200);
    await f.create({ version: 1 }).expect(409);
    expect(f.records.get(f.id)?.studioAvailability?.title).toBe(
      f.blockFields.title,
    );
  });
  it('enforces session, origin, account and owner boundaries', async () => {
    const f = availabilityFixture();
    await request(f.app).get(f.availabilityRoot).expect(401);
    await request(f.app)
      .put(f.availabilityPath)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send(f.command)
      .expect(403);
    await f.create().set('X-PicFind-Studio-Actor', f.strangerId).expect(403);
    await f.create().expect(200);
    await f.read(f.availabilityPath, f.strangerId).expect(404);
    await f
      .put(f.availabilityPath, { ...f.command, version: 1 }, f.strangerId)
      .expect(404);
    await f
      .remove(
        f.availabilityPath,
        { generation: f.generation, version: 1 },
        f.strangerId,
      )
      .expect(404);
    const response = await f.read(f.availabilityRoot, f.strangerId).expect(200);
    expect(response.body.blocks).toEqual([]);
    expect(response.headers['cache-control']).toContain('no-store');
    await f.read(`/api/jobs/${f.id}`).expect(404);
  });
  it('blocks overlaps in both write directions and permits half-open adjacency', async () => {
    const f = availabilityFixture();
    await f.create().expect(200);
    expect((await f.appoint().expect(409)).body.error.code).toBe(
      'AVAILABILITY_OVERLAP',
    );
    await f
      .appoint({
        startLocal: '2026-11-01T11:00',
        endLocal: '2026-11-01T12:00',
        startAt: '2026-11-01T11:00:00.000Z',
        endAt: '2026-11-01T12:00:00.000Z',
      })
      .expect(200);
    await f
      .create({
        version: 1,
        endLocal: '2026-11-01T11:01',
        endAt: '2026-11-01T11:01:00.000Z',
      })
      .expect(409);
    const g = availabilityFixture();
    await g.appoint().expect(200);
    await g.create().expect(409);
    expect(g.records.has(g.id)).toBe(false);
  });
  it('rejects overlapping blocks, ignores inactive blocks and cancelled appointments', async () => {
    const f = availabilityFixture();
    await f.appoint({ status: 'cancelled' }).expect(200);
    await f.create().expect(200);
    const other = `${f.availabilityRoot}/${randomUUID()}`;
    await f.put(other, { ...f.command, generation: randomUUID() }).expect(409);
    await f
      .put(other, { ...f.command, generation: randomUUID(), active: false })
      .expect(200);
    await f.create({ version: 1, active: false }).expect(200);
    await f.appoint().expect(200);
    await f.create({ version: 2 }).expect(409);
  });
  it('serializes concurrent appointment and block creation', async () => {
    const f = availabilityFixture();
    const results = await Promise.all([f.create(), f.appoint()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      [...f.records.values()].filter((r) => r.purpose !== 'studio-project'),
    ).toHaveLength(1);
  });
  it('serializes concurrent block writes and prevents lost updates', async () => {
    const f = availabilityFixture();
    await f.create().expect(200);
    const results = await Promise.all([
      f.create({ version: 1, title: 'First' }),
      f.create({ version: 1, title: 'Second' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(f.records.get(f.id)?.studioAvailability?.version).toBe(2);
  });
  it('allows deactivation and removal with unrelated damaged block metadata', async () => {
    const f = availabilityFixture();
    await f.create().expect(200);
    const broken = randomUUID();
    f.records.set(broken, {
      ...f.records.get(f.id)!,
      id: broken,
    });
    delete f.records.get(broken)!.studioAvailability;
    await f.read(f.availabilityRoot).expect(503);
    await f.create({ version: 1, title: 'Must scan' }).expect(503);
    await f.create({ version: 1, active: false }).expect(200);
    await f
      .remove(f.availabilityPath, { version: 2, generation: f.generation })
      .expect(204);
    expect(f.records.has(broken)).toBe(true);
  });
  it('keeps cancellation available when availability metadata is damaged', async () => {
    const f = availabilityFixture(),
      appointment = (await f.appoint().expect(200)).body.appointment;
    f.records.set(f.id, {
      id: f.id,
      ownerId: f.ownerId,
      kind: 'job',
      purpose: 'studio-availability',
      createdAt: new Date().toISOString(),
    });
    await f
      .appoint({
        startLocal: '2026-11-02T10:00',
        endLocal: '2026-11-02T11:00',
        startAt: '2026-11-02T10:00:00.000Z',
        endAt: '2026-11-02T11:00:00.000Z',
      })
      .expect(503);
    await f
      .appoint({ version: 1, status: 'cancelled' }, appointment.id)
      .expect(200);
  });
  it('fails closed on damaged appointments but allows inactive block recovery', async () => {
    const f = availabilityFixture(),
      id = randomUUID();
    f.records.set(id, {
      id,
      ownerId: f.ownerId,
      kind: 'job',
      purpose: 'studio-appointment',
      createdAt: new Date().toISOString(),
    });
    await f.create().expect(503);
    await f.create({ active: false }).expect(200);
    await f.create({ version: 1 }).expect(503);
    await f
      .remove(f.availabilityPath, { version: 1, generation: f.generation })
      .expect(204);
  });
  it('rejects changed and disappeared records during conflict verification', async () => {
    for (const disappear of [true, false]) {
      const f = availabilityFixture();
      await f.create().expect(200);
      const get = f.store.get;
      f.store.get = async (id) => {
        const row = await get(id);
        if (id === f.id) {
          if (disappear) throw new ApiError(404, 'NOT_FOUND', 'Gone');
          row.studioAvailability!.note = 'Changed concurrently';
        }
        return row;
      };
      await f.read(f.availabilityRoot).expect(409);
      await f
        .appoint({
          startLocal: '2026-11-02T10:00',
          endLocal: '2026-11-02T11:00',
          startAt: '2026-11-02T10:00:00.000Z',
          endAt: '2026-11-02T11:00:00.000Z',
        })
        .expect(409);
    }
  });
  it('propagates storage failures rather than treating them as an empty schedule', async () => {
    const f = availabilityFixture();
    f.store.list = async () => {
      throw new ApiError(503, 'STORE_DOWN', 'Unavailable');
    };
    await f.create().expect(503);
    await f.appoint().expect(503);
    expect(f.records.size).toBe(1);
  });
  it('enforces creation quota, bounded recovery and duplicate identifiers', async () => {
    const f = availabilityFixture();
    await f.create({ active: false }).expect(200);
    const saved = f.records.get(f.id)!;
    for (let index = 1; index < 100; index++) {
      const id = randomUUID();
      f.records.set(id, {
        ...saved,
        id,
        studioAvailability: { ...saved.studioAvailability!, id },
      });
    }
    await f
      .put(`${f.availabilityRoot}/${randomUUID()}`, {
        ...f.command,
        active: false,
      })
      .expect(409);
    await f
      .create({ version: 1, active: false, title: 'Still editable' })
      .expect(200);
    expect(
      (await f.read(f.availabilityRoot).expect(200)).body.blocks,
    ).toHaveLength(100);
    const list = f.store.list;
    f.store.list = async (owner, kind) => {
      const rows = await list(owner, kind);
      return [...rows, rows[1]!];
    };
    await f.read(f.availabilityRoot).expect(503);
    f.store.list = async () => Array.from({ length: 2001 }, () => saved);
    await f.read(f.availabilityRoot).expect(503);
  });
  it('validates timezone occurrences, real dates and interval boundaries', () => {
    const f = availabilityFixture();
    expect(availabilityWrite.safeParse(f.command).success).toBe(true);
    for (const changes of [
      { endAt: f.command.startAt, endLocal: f.command.startLocal },
      { endAt: '2026-12-02T10:01:00.000Z', endLocal: '2026-12-02T10:01' },
      { timeZone: 'Not/AZone' },
      { startLocal: '2026-02-30T10:00' },
      { startLocal: '2026-03-08T02:30', timeZone: 'America/New_York' },
      { startAt: '2026-11-01T10:01:00.000Z' },
    ])
      expect(
        availabilityWrite.safeParse({ ...f.command, ...changes }).success,
      ).toBe(false);
    expect(
      availabilityWrite.safeParse({
        ...f.command,
        endAt: '2026-12-02T10:00:00.000Z',
        endLocal: '2026-12-02T10:00',
      }).success,
    ).toBe(true);
    const choices = appointmentOccurrences(
      '2026-11-01T01:30',
      'America/New_York',
    );
    expect(choices).toHaveLength(2);
    expect(
      availabilityWrite.safeParse({
        ...f.command,
        timeZone: 'America/New_York',
        startLocal: '2026-11-01T01:30',
        endLocal: '2026-11-01T01:30',
        startAt: choices[0]!.instant,
        endAt: choices[1]!.instant,
      }).success,
    ).toBe(true);
  });
  it('rejects malformed input and scoped-record substitutions', async () => {
    const f = availabilityFixture();
    await f.create({ unexpected: true }).expect(400);
    await f.create({ title: '' }).expect(400);
    await f.read(`${f.availabilityRoot}/not-a-uuid`).expect(404);
    await f.create().expect(200);
    for (const field of [
      'eventId',
      'deletionStartedAt',
      'deletionCompletedAt',
    ] as const) {
      const row = f.records.get(f.id)!;
      row[field] = '';
      await f.read(f.availabilityPath).expect(404);
      delete row[field];
    }
    f.records.get(f.id)!.availabilityCommandDigest = 'damaged';
    await f.read(f.availabilityPath).expect(503);
  });
  it('erases blocks with the account without requiring project linkage', async () => {
    const f = availabilityFixture();
    await f.create().expect(200);
    f.records.delete(f.projectId);
    await f.read(f.availabilityPath).expect(200);
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.size).toBe(0);
  });
});
