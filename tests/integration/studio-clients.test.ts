import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import {
  MAX_STUDIO_CLIENTS,
  type ClientFields,
} from '../../packages/shared/src/studio-clients';
import { listDriveImages } from '../../apps/api/src/drive';

vi.mock('../../apps/api/src/drive', async (original) => ({
  ...(await original<typeof import('../../apps/api/src/drive')>()),
  listDriveImages: vi.fn(async () => []),
}));
const origin = 'http://localhost:5173';
const fields: ClientFields = {
  name: 'Asha Rao',
  email: 'asha@example.test',
  phone: '+91 555 0100',
  company: 'Photo client',
};
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
        throw new ApiError(409, 'CONFLICT', 'Record already exists.');
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
    { store, driveApiKey: 'synthetic-key-never-sent' },
  );
  const read = (actor = 'owner') =>
    request(app)
      .get('/api/studio/clients')
      .set('Cookie', `picfind_session=${actor}`);
  const save = (
    id: string = randomUUID(),
    values: unknown = fields,
    version = 0,
    actor = 'owner',
  ) =>
    request(app)
      .put(`/api/studio/clients/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ ...(values as object), version });
  const remove = (id: string, version = 1, actor = 'owner') =>
    request(app)
      .delete(`/api/studio/clients/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ version });
  function seed(id = randomUUID(), actor = 'owner', values = fields) {
    const now = new Date().toISOString();
    const row: LibraryRecord = {
      id,
      ownerId: actor,
      kind: 'job',
      purpose: 'studio-client',
      createdAt: now,
      studioClient: {
        ...values,
        id,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    };
    records.set(id, row);
    return row;
  }
  return { app, records, store, read, save, remove, seed };
}
describe('private photographer client directory', () => {
  it('normalizes mixed-case stored emails before checking a duplicate', async () => {
    const f = fixture();
    f.seed(randomUUID(), 'owner', { ...fields, email: 'ASHA@Example.Test' });
    expect((await f.read().expect(200)).body.clients[0].email).toBe(
      'asha@example.test',
    );
    await f.save().expect(409);
    expect(f.records.size).toBe(1);
  });
  it('preserves creation time when an update occurs a year later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
      const f = fixture(),
        id = randomUUID();
      await f.save(id).expect(200);
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const updated = await f
        .save(id, { ...fields, name: 'New name' }, 1)
        .expect(200);
      expect(updated.body.client.createdAt).toBe('2025-01-01T00:00:00.000Z');
      expect(updated.body.client.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
  it('offers bounded recovery reads and existing edits when stored data exceeds capacity', async () => {
    const f = fixture();
    const rows = Array.from({ length: MAX_STUDIO_CLIENTS + 1 }, () =>
      f.seed(randomUUID(), 'owner', { ...fields, email: '' }),
    );
    const before = await f.read().expect(200);
    expect(before.body.totalCount).toBe(201);
    expect(before.body.clients).toHaveLength(200);
    await f.save(randomUUID(), { ...fields, email: '' }).expect(409);
    await f
      .save(rows[0]!.id, { ...fields, email: '', name: 'Corrected' }, 1)
      .expect(200);
    await f.remove(rows[0]!.id, 2).expect(204);
    const after = await f.read().expect(200);
    expect(after.body.totalCount).toBe(200);
    expect(after.body.clients).toHaveLength(200);
  });
  it('persists normalized contact fields, updates and clears optional details without file operations', async () => {
    const f = fixture(),
      id = randomUUID();
    expect((await f.read().expect(200)).body).toEqual({
      accountId: 'owner',
      limit: MAX_STUDIO_CLIENTS,
      totalCount: 0,
      clients: [],
    });
    const first = await f
      .save(id, {
        ...fields,
        name: '  Asha Rao  ',
        email: ' ASHA@EXAMPLE.TEST ',
      })
      .expect(200);
    expect(first.body.client).toMatchObject({ ...fields, id, version: 1 });
    expect((await f.read().expect(200)).body.clients).toEqual([
      first.body.client,
    ]);
    const updated = await f
      .save(id, { name: 'Asha Studio', email: '', phone: '', company: '' }, 1)
      .expect(200);
    expect(updated.body.client).toMatchObject({
      name: 'Asha Studio',
      email: '',
      phone: '',
      company: '',
      version: 2,
      createdAt: first.body.client.createdAt,
    });
    expect(f.store.put).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ purpose: 'studio-client' }),
      true,
    );
    expect(f.store.put).toHaveBeenNthCalledWith(2, expect.anything(), false);
    expect(f.store.upload).not.toHaveBeenCalled();
    expect(f.store.file).not.toHaveBeenCalled();
  });
  it('requires a session, trusted mutation origin and the expected browser account', async () => {
    const f = fixture(),
      id = randomUUID();
    await request(f.app).get('/api/studio/clients').expect(401);
    await request(f.app)
      .put(`/api/studio/clients/${id}`)
      .set('Origin', origin)
      .send({ ...fields, version: 0 })
      .expect(401);
    await f.save(id).set('Origin', 'https://outside.test').expect(403);
    await f.save(id).set('X-PicFind-Studio-Actor', 'other').expect(403);
    await f.read().set('X-PicFind-Studio-Actor', 'other').expect(403);
    expect(f.records.size).toBe(0);
  });
  it('keeps contacts out of library and scan projections and isolates owners', async () => {
    const f = fixture(),
      row = f.seed();
    expect((await f.read('other').expect(200)).body.clients).toEqual([]);
    for (const actor of ['other', 'moderator', 'guest']) {
      await f.save(row.id, fields, 1, actor).expect(404);
      await f.remove(row.id, 1, actor).expect(404);
    }
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(JSON.stringify(library.body)).not.toMatch(
      /asha@example|Asha Rao|studioClient/,
    );
    await request(f.app)
      .get(`/api/discover/scans/${row.id}`)
      .set('Cookie', 'picfind_session=owner')
      .expect(404);
    expect(f.records.get(row.id)).toEqual(row);
  });
  it.each(['event', 'photo', 'import'] as const)(
    'never overwrites a %s record through the contact route',
    async (kind) => {
      const f = fixture(),
        row = f.seed();
      if (kind === 'import') row.purpose = 'import';
      else row.kind = kind;
      await f.save(row.id).expect(404);
      await f.remove(row.id).expect(404);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('rejects duplicate email case-insensitively but allows matching names and cross-owner contacts', async () => {
    const f = fixture();
    await f.save().expect(200);
    await f
      .save(randomUUID(), { ...fields, email: 'ASHA@example.test' })
      .expect(409);
    await f.save(randomUUID(), fields, 0, 'other').expect(200);
    await f.save(randomUUID(), { ...fields, email: '' }).expect(200);
    await f.save(randomUUID(), { ...fields, email: '' }).expect(200);
    expect((await f.read().expect(200)).body.clients).toHaveLength(3);
  });
  it('serializes conflicting edits and independent duplicate-email creates', async () => {
    const f = fixture(),
      row = f.seed();
    const edits = await Promise.all([
      f.save(row.id, { ...fields, name: 'One' }, 1),
      f.save(row.id, { ...fields, name: 'Two' }, 1),
    ]);
    expect(edits.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const creates = await Promise.all([
      f.save(randomUUID(), { ...fields, email: 'new@example.test' }),
      f.save(randomUUID(), { ...fields, email: 'NEW@example.test' }),
    ]);
    expect(creates.map((reply) => reply.status).sort()).toEqual([200, 409]);
  });
  it('recovers a committed write after a lost reply without adding a contact or version', async () => {
    const f = fixture(),
      id = randomUUID(),
      put = f.store.put;
    f.store.put = async (row, create) => {
      await put(row, create);
      throw new ApiError(503, 'LOST_REPLY', 'Synthetic lost reply.');
    };
    await f.save(id).expect(503);
    f.store.put = put;
    const retry = await f.save(id).expect(200);
    expect(retry.body.client.version).toBe(1);
    expect(f.records.size).toBe(1);
    expect(put).toHaveBeenCalledOnce();
    await f.save(id, { ...fields, name: 'Different' }).expect(409);
  });
  it('requires current version to remove only the selected contact', async () => {
    const f = fixture(),
      row = f.seed(),
      other = f.seed(randomUUID(), 'owner', { ...fields, email: '' });
    await f.remove(row.id, 2).expect(409);
    await f.remove(row.id).expect(204);
    expect(f.records.has(row.id)).toBe(false);
    expect(f.records.get(other.id)).toEqual(other);
    await f.remove(row.id).expect(404);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it.each([
    { name: '' },
    { name: 'a'.repeat(101) },
    { email: 'not-an-email' },
    { phone: 'a'.repeat(41) },
    { company: 'a'.repeat(101) },
    { name: 'line\nbreak' },
    { phone: 'null\0byte' },
    { ownerId: 'other' },
    { version: -1 },
  ])('rejects invalid contact fields %j', async (changes) => {
    const f = fixture();
    const input = { ...fields, ...changes };
    await f
      .save(randomUUID(), input, 'version' in changes ? changes.version : 0)
      .expect(400);
    expect(f.records.size).toBe(0);
  });
  it.each(['version', 'id', 'date', 'payload', 'purpose'] as const)(
    'fails closed on malformed stored %s',
    async (kind) => {
      const f = fixture(),
        row = f.seed();
      if (kind === 'version') row.studioClient!.version = 0;
      if (kind === 'id') row.studioClient!.id = randomUUID();
      if (kind === 'date') row.createdAt = 'invalid';
      if (kind === 'payload') delete row.studioClient;
      if (kind === 'purpose') row.eventId = randomUUID();
      await f.read().expect(kind === 'purpose' ? 404 : 503);
      await f.save(row.id, fields, 1).expect(kind === 'purpose' ? 404 : 503);
      expect(f.store.put).not.toHaveBeenCalled();
    },
  );
  it('enforces capacity while allowing edits and exact creation replays', async () => {
    const f = fixture();
    const rows = Array.from({ length: MAX_STUDIO_CLIENTS }, () =>
      f.seed(randomUUID(), 'owner', { ...fields, email: '' }),
    );
    await f.save(randomUUID(), { ...fields, email: '' }).expect(409);
    await f
      .save(rows[0]!.id, { ...fields, email: '', name: 'Updated' }, 1)
      .expect(200);
    await f.save(rows[1]!.id, { ...fields, email: '' }, 0).expect(200);
    expect((await f.read().expect(200)).body.clients).toHaveLength(
      MAX_STUDIO_CLIENTS,
    );
  });
  it('propagates storage outages instead of treating them as an empty directory', async () => {
    const f = fixture();
    f.store.get = async () => {
      throw new ApiError(503, 'STORAGE_DOWN', 'Storage unavailable.');
    };
    await f.save().expect(503);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('keeps contact records outside the development Drive import quota while counting legacy imports', async () => {
    const f = fixture();
    for (let index = 0; index < 25; index++)
      f.seed(randomUUID(), 'owner', { ...fields, email: '' });
    const send = () =>
      request(f.app)
        .post('/api/imports/drive')
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=owner')
        .send({
          url: 'https://drive.google.com/drive/folders/abcdefghijklmnopqrstuvw',
        });
    await send().expect(201);
    expect(listDriveImages).toHaveBeenCalled();
    for (let index = 0; index < 19; index++) {
      const id = randomUUID();
      f.records.set(id, {
        id,
        ownerId: 'owner',
        kind: 'job',
        createdAt: new Date().toISOString(),
      });
    }
    const blocked = await send().expect(409);
    expect(blocked.body.error.code).toBe('JOB_LIMIT');
  });
});
