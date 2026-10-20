import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { invitationPageRecordId } from '../../apps/api/src/event-invitation-page';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { blankInvitationPage } from '../../packages/shared/src/event-invitation-page';

const origin = 'http://localhost:5173';
function fixture() {
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: 'owner',
    createdAt: new Date().toISOString(),
    title: 'Private gallery title',
    description: 'Private gallery description',
    visibility: 'private',
    members: [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: new Date().toISOString(),
      },
    ],
  };
  const records = new Map([[event.id, event]]);
  const store: LibraryStore = {
    get: vi.fn(async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    }),
    list: async (owner, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row, createOnly) => {
      if (createOnly && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(async (id) => {
      records.delete(id);
    }),
    file: vi.fn(),
    upload: vi.fn(),
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
        login: vi.fn(),
        logout: vi.fn(),
        register: vi.fn(),
      },
    },
    { store },
  );
  const url = `/api/events/${event.id}/invitation-page`,
    publicUrl = `/api/public/invitations/${event.id}`;
  const fields = {
    ...blankInvitationPage(),
    heading: 'Celebration',
    host: 'The hosts',
    date: '2026-11-01',
    venue: 'Event hall',
    address: 'Guest entrance',
    instructions: 'Welcome guests',
  };
  const read = (actor = 'owner') =>
    request(app).get(url).set('Cookie', `picfind_session=${actor}`);
  const save = (body: object = {}, actor = 'owner') =>
    request(app)
      .put(url)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ version: 0, action: 'save', fields, ...body });
  const publicRead = () => request(app).get(publicUrl);
  const stored = () => records.get(invitationPageRecordId(event.id))!;
  return {
    event,
    records,
    store,
    app,
    url,
    publicUrl,
    fields,
    read,
    save,
    publicRead,
    stored,
  };
}
describe('explicit event invitation publication', () => {
  it('keeps saved drafts private and publishes only an explicit minimal snapshot', async () => {
    const f = fixture();
    expect((await f.read().expect(200)).body.page.version).toBe(0);
    await f.publicRead().expect(404);
    await f.save().expect(200);
    await f.publicRead().expect(404);
    const published = (
      await f.save({ version: 1, action: 'publish' }).expect(200)
    ).body.page;
    expect(published.published.fields).toEqual(f.fields);
    const result = await f.publicRead().expect(200);
    expect(Object.keys(result.body).sort()).toEqual([
      'eventId',
      'fields',
      'publishedAt',
      'revision',
    ]);
    expect(result.body.revision).toBe(2);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(result.body)).not.toMatch(
      /Private gallery|owner|commandDigest|draft|photos|members/,
    );
    expect(f.event.visibility).toBe('private');
    await request(f.app).get(`/api/public/events/${f.event.id}`).expect(404);
    f.event.visibility = 'link';
    await request(f.app).get(`/api/public/events/${f.event.id}`).expect(401);
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(JSON.stringify(library.body)).not.toContain('Guest entrance');
  });
  it('retains the published snapshot when a later private draft is saved and replaces it only on publication', async () => {
    const f = fixture();
    await f.save({ action: 'publish' }).expect(200);
    const fields = { ...f.fields, address: 'Unpublished new address' };
    const draft = await f.save({ version: 1, fields }).expect(200);
    expect(draft.body.page.draft.address).toBe('Unpublished new address');
    expect((await f.publicRead().expect(200)).body.fields.address).toBe(
      'Guest entrance',
    );
    expect((await f.publicRead().expect(200)).body.revision).toBe(1);
    await f.save({ version: 2, action: 'publish', fields }).expect(200);
    expect((await f.publicRead().expect(200)).body.fields.address).toBe(
      'Unpublished new address',
    );
    await f
      .save({ version: 3, action: 'withdraw', fields: f.fields })
      .expect(200);
    await f.publicRead().expect(404);
    expect((await f.read().expect(200)).body.page.draft.address).toBe(
      'Unpublished new address',
    );
  });
  it('denies missing sessions, spoofed account headers, cross-origin writes, moderators and other owners', async () => {
    const f = fixture();
    await request(f.app)
      .get(f.url)
      .set('X-PicFind-Invitation-Actor', 'owner')
      .expect(401);
    await f
      .read('other')
      .set('X-PicFind-Invitation-Actor', 'owner')
      .expect(403);
    await f.read().set('X-PicFind-Invitation-Actor', 'other').expect(403);
    await f.save().set('Origin', 'https://evil.example').expect(403);
    for (const actor of ['other', 'moderator']) {
      await f.read(actor).expect(404);
      await f.save({}, actor).expect(404);
    }
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('recovers identical immediate retries and rejects stale or different commands', async () => {
    const f = fixture();
    const first = await f.save({ action: 'publish' }).expect(200);
    expect((await f.save({ action: 'publish' }).expect(200)).body).toEqual(
      first.body,
    );
    expect(f.store.put).toHaveBeenCalledTimes(1);
    await f.save({ action: 'withdraw' }).expect(409);
    await f
      .save({
        action: 'publish',
        fields: { ...f.fields, host: 'Another host' },
      })
      .expect(409);
    const concurrent = await Promise.all([
      f.save({ version: 1, fields: { ...f.fields, host: 'Host A' } }),
      f.save({ version: 1, fields: { ...f.fields, host: 'Host B' } }),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(f.store.put).toHaveBeenCalledTimes(2);
  });
  it.each(['archived', 'expired'] as const)(
    'denies public access and editing on %s events while allowing withdrawal',
    async (mode) => {
      const f = fixture();
      await f.save({ action: 'publish' }).expect(200);
      if (mode === 'archived') f.event.archived = true;
      else f.event.expiresAt = '2000-01-01T00:00:00.000Z';
      expect((await f.read().expect(200)).body.editable).toBe(false);
      await f.publicRead().expect(404);
      await f.save({ version: 1 }).expect(409);
      await f.save({ version: 1, action: 'publish' }).expect(409);
      await f.save({ version: 1, action: 'withdraw' }).expect(200);
      expect(f.stored().invitationPage!.published).toBeNull();
      expect(f.stored().invitationPage!.draft).toEqual(f.fields);
      f.event.archived = false;
      f.event.expiresAt = '';
      await f.publicRead().expect(404);
    },
  );
  it('rejects invalid fields and combined serialization overflow without replacing prior publication', async () => {
    const f = fixture();
    await f
      .save({ action: 'publish', fields: { ...f.fields, date: '' } })
      .expect(400);
    await f.save({ fields: { ...f.fields, time: '24:00' } }).expect(400);
    const fields = { ...f.fields, instructions: '\u0000'.repeat(1000) };
    await f.save({ fields }).expect(200);
    await f.save({ version: 1, action: 'publish', fields }).expect(400);
    expect(f.stored().invitationPage!.version).toBe(1);
    await f.publicRead().expect(404);
  });
  it.each(['purpose', 'owner', 'event', 'corrupt', 'timestamp'] as const)(
    'fails closed on %s record damage',
    async (damage) => {
      const f = fixture();
      await f.save({ action: 'publish' }).expect(200);
      const row = f.stored();
      if (damage === 'purpose') row.purpose = 'event-coverage';
      if (damage === 'owner') row.ownerId = 'other';
      if (damage === 'event') row.eventId = randomUUID();
      if (damage === 'corrupt') row.invitationPage!.version = 0;
      if (damage === 'timestamp') row.createdAt = '2099-01-01T00:00:00.000Z';
      const status = ['corrupt', 'timestamp'].includes(damage) ? 503 : 404;
      await f.read().expect(status);
      await f.publicRead().expect(status);
      await f.save({ version: 1 }).expect(status);
      expect(f.store.put).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['owner', 'withdraw', 'archive'] as const)(
    'rechecks %s changes during public reads',
    async (change) => {
      const f = fixture();
      await f.save({ action: 'publish' }).expect(200);
      const original = f.store.get;
      let pageReads = 0;
      f.store.get = async (id) => {
        const row = await original(id);
        if (id === f.stored().id && ++pageReads === 1) {
          if (change === 'owner') f.event.ownerId = 'other';
          if (change === 'archive') f.event.archived = true;
          if (change === 'withdraw')
            f.stored().invitationPage!.published = null;
        }
        return row;
      };
      await f.publicRead().expect(404);
    },
  );
  it('rejects ownership and intervening revision changes before writing', async () => {
    for (const change of ['owner', 'revision']) {
      const f = fixture();
      await f.save().expect(200);
      const original = f.store.get;
      let pageReads = 0;
      f.store.get = async (id) => {
        const row = await original(id);
        if (id === f.stored().id && ++pageReads === 1) {
          if (change === 'owner') f.event.ownerId = 'other';
          else f.stored().invitationPage!.version++;
        }
        return row;
      };
      await f
        .save({ version: 1, action: 'publish' })
        .expect(change === 'owner' ? 404 : 409);
      expect(f.store.put).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps timestamps monotonic after clock rollback and deletes the page with its event', async () => {
    const f = fixture();
    await f.save({ action: 'publish' }).expect(200);
    const previous = f.stored().invitationPage!.updatedAt;
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(previous) - 10_000);
    try {
      await f.save({ version: 1 }).expect(200);
      expect(f.stored().invitationPage!.updatedAt).toBe(previous);
    } finally {
      clock.mockRestore();
    }
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(invitationPageRecordId(f.event.id))).toBe(false);
    await f.publicRead().expect(404);
  });
});
