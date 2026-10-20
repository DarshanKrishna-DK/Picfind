import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { invitationPageRecordId } from '../../apps/api/src/event-invitation-page';
import { rsvpCookieName, rsvpResponseId } from '../../apps/api/src/event-rsvp';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { blankInvitationPage } from '../../packages/shared/src/event-invitation-page';
import type { GuestRsvpSnapshot } from '../../packages/shared/src/event-rsvp';

const origin = 'http://localhost:5173';
function fixture(secure = false) {
  const now = new Date().toISOString(),
    event: LibraryRecord = {
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'event',
      createdAt: now,
      title: 'Private event',
      visibility: 'private',
      members: [
        {
          userId: 'moderator',
          role: 'moderator',
          grantId: randomUUID(),
          addedAt: now,
        },
      ],
    };
  const fields = { ...blankInvitationPage(), date: '2026-11-01' },
    publication: LibraryRecord = {
      id: invitationPageRecordId(event.id),
      ownerId: 'owner',
      kind: 'job',
      purpose: 'event-invitation-page',
      eventId: event.id,
      createdAt: now,
      invitationPage: {
        draft: fields,
        published: { fields, revision: 1, publishedAt: now },
        version: 1,
        updatedAt: now,
        commandDigest: 'a'.repeat(64),
      },
    };
  const records = new Map([event, publication].map((row) => [row.id, row]));
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
    put: vi.fn(async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Exists.');
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
      secureCookies: secure,
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
  const url = `/api/events/${event.id}/rsvp`,
    guest = `/api/public/invitations/${event.id}/rsvp`;
  const ownerCookie = (actor = 'owner') =>
    `${secure ? '__Host-' : ''}picfind_session=${actor}`;
  const host = (actor = 'owner') =>
    request(app).get(url).set('Cookie', ownerCookie(actor));
  const configure = (body: object = {}, actor = 'owner') =>
    request(app)
      .put(url)
      .set('Origin', origin)
      .set('Cookie', ownerCookie(actor))
      .send({
        version: 0,
        enabled: true,
        closesAt: null,
        maxPartySize: 5,
        ...body,
      });
  const client = () => request.agent(app);
  type Agent = ReturnType<typeof client>;
  const prepare = (agent: Agent) =>
    agent.post(`${guest}/session`).set('Origin', origin).send({});
  const body = (snapshot: GuestRsvpSnapshot, changes: object = {}) => ({
    version: snapshot.response?.version ?? 0,
    receiptId: snapshot.receiptId,
    invitationRevision: snapshot.invitationRevision,
    displayName: 'Guest family',
    response: 'going',
    partySize: 2,
    message: 'Arriving together',
    consent: 'event-rsvp-v1',
    ...changes,
  });
  const save = (
    agent: Agent,
    snapshot: GuestRsvpSnapshot,
    changes: object = {},
  ) => agent.put(guest).set('Origin', origin).send(body(snapshot, changes));
  const erase = (agent: Agent, snapshot: GuestRsvpSnapshot) =>
    agent
      .delete(guest)
      .set('Origin', origin)
      .send({
        receiptId: snapshot.receiptId,
        version: snapshot.response?.version ?? 0,
      });
  return {
    event,
    publication,
    records,
    store,
    app,
    url,
    guest,
    host,
    configure,
    client,
    prepare,
    body,
    save,
    erase,
  };
}
describe('private browser-receipt RSVP collection', () => {
  it('recovers identical settings retries and rejects competing owner versions', async () => {
    const f = fixture();
    const first = (await f.configure().expect(200)).body;
    expect((await f.configure().expect(200)).body).toEqual(first);
    expect(f.store.put).toHaveBeenCalledTimes(1);
    const changes = await Promise.all([
      f.configure({ version: 1, maxPartySize: 3 }),
      f.configure({ version: 1, maxPartySize: 4 }),
    ]);
    expect(changes.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(f.store.put).toHaveBeenCalledTimes(2);
  });
  it('limits repeated receipt preparation without storing guest response rows', async () => {
    const f = fixture(),
      client = f.client();
    await f.configure().expect(200);
    for (let attempt = 0; attempt < 60; attempt++)
      await f.prepare(client).expect(200);
    await f.prepare(client).expect(429);
    expect((await f.host().expect(200)).body.responses).toEqual([]);
    expect(f.store.put).toHaveBeenCalledTimes(1);
  });
  it('defaults closed and requires explicit host setup without publishing responses', async () => {
    const f = fixture(),
      client = f.client();
    expect((await f.host().expect(200)).body.settings.enabled).toBe(false);
    await f.prepare(client).expect(409);
    await f.configure().expect(200);
    const prepared = await f.prepare(client).expect(200);
    expect(String(prepared.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(prepared.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(String(prepared.headers['set-cookie'])).toContain('Max-Age=2592000');
    const saved = await f.save(client, prepared.body).expect(200);
    expect(saved.body.response).toMatchObject({
      displayName: 'Guest family',
      partySize: 2,
      version: 1,
    });
    expect((await client.get(f.guest).expect(200)).body.response).toEqual(
      saved.body.response,
    );
    const host = await f.host().expect(200);
    expect(host.body.responses).toHaveLength(1);
    expect(JSON.stringify(host.body)).not.toMatch(
      /receiptHash|commandDigest|secret/,
    );
    expect(JSON.stringify(saved.body)).not.toMatch(
      /receiptHash|commandDigest|secret|owner/,
    );
    const publicPage = await request(f.app)
      .get(`/api/public/invitations/${f.event.id}`)
      .expect(200);
    expect(JSON.stringify(publicPage.body)).not.toContain('Guest family');
  });
  it('sets a host-only secure cookie under the production configuration', async () => {
    const f = fixture(true);
    await f.configure().expect(200);
    const result = await f.prepare(f.client()).expect(200);
    const header = String(result.headers['set-cookie']);
    expect(header).toContain(`${rsvpCookieName(f.event.id, true)}=`);
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header).not.toContain('Domain=');
  });
  it('isolates browser receipts and rejects guessed IDs, missing receipts and cross-origin writes', async () => {
    const f = fixture(),
      a = f.client(),
      b = f.client();
    await f.configure().expect(200);
    const sa = (await f.prepare(a).expect(200)).body,
      sb = (await f.prepare(b).expect(200)).body;
    await f.save(a, sa).expect(200);
    expect((await b.get(f.guest).expect(200)).body.response).toBeNull();
    await f.save(b, sa).expect(403);
    await request(f.app)
      .put(f.guest)
      .set('Origin', origin)
      .send(f.body(sa))
      .expect(401);
    await f.save(a, sa).set('Origin', 'https://evil.example').expect(403);
    await b
      .delete(f.guest)
      .set('Origin', origin)
      .send({ receiptId: sa.receiptId, version: 1 })
      .expect(403);
    expect(sa.receiptId).not.toBe(sb.receiptId);
    const otherEvent = { ...f.event, id: randomUUID() };
    f.records.set(otherEvent.id, otherEvent);
    const otherPage = {
      ...f.publication,
      id: invitationPageRecordId(otherEvent.id),
      eventId: otherEvent.id,
    };
    f.records.set(otherPage.id, otherPage);
    const other = await a
      .get(`/api/public/invitations/${otherEvent.id}/rsvp`)
      .expect(200);
    expect(other.body.receiptId).toBeNull();
    expect(other.body.response).toBeNull();
  });
  it('denies owner data and settings to missing sessions, moderators and spoofed accounts', async () => {
    const f = fixture();
    await request(f.app)
      .get(f.url)
      .set('X-PicFind-Rsvp-Actor', 'owner')
      .expect(401);
    for (const actor of ['other', 'moderator']) {
      await f.host(actor).expect(404);
      await f.configure({}, actor).expect(404);
    }
    await f.host().set('X-PicFind-Rsvp-Actor', 'other').expect(403);
    await f.configure().set('Origin', 'https://evil.example').expect(403);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it('requires host-sharing consent and enforces the current reported party limit', async () => {
    const f = fixture(),
      a = f.client();
    await f.configure({ maxPartySize: 2 }).expect(200);
    const state = (await f.prepare(a).expect(200)).body;
    await f.save(a, state, { consent: null }).expect(400);
    await f.save(a, state, { partySize: 3 }).expect(400);
    await f.save(a, state, { response: 'not-going', partySize: 1 }).expect(400);
    await f.save(a, state, { response: 'not-going', partySize: 0 }).expect(200);
  });
  it('recovers identical lost replies and serializes competing updates', async () => {
    const f = fixture(),
      a = f.client();
    await f.configure().expect(200);
    const initial = (await f.prepare(a).expect(200)).body;
    const first = (await f.save(a, initial).expect(200)).body;
    expect((await f.save(a, initial).expect(200)).body).toEqual(first);
    expect(f.store.put).toHaveBeenCalledTimes(2);
    const responses = await Promise.all([
      f.save(a, first, { message: 'First edit' }),
      f.save(a, first, { message: 'Second edit' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    await f.save(a, initial, { displayName: 'Stale overwrite' }).expect(409);
  });
  it.each(['deadline', 'disabled', 'withdrawn', 'archived'] as const)(
    'keeps a receipt readable and withdrawable after %s closure',
    async (mode) => {
      const f = fixture(),
        a = f.client();
      await f.configure().expect(200);
      const initial = (await f.prepare(a).expect(200)).body;
      const saved = (await f.save(a, initial).expect(200)).body;
      if (mode === 'deadline')
        await f
          .configure({ version: 1, closesAt: '2000-01-01T00:00:00.000Z' })
          .expect(200);
      if (mode === 'disabled')
        await f.configure({ version: 1, enabled: false }).expect(200);
      if (mode === 'withdrawn') f.publication.invitationPage!.published = null;
      if (mode === 'archived') f.event.archived = true;
      const state = (await a.get(f.guest).expect(200)).body;
      expect(state.accepting).toBe(false);
      expect(state.response.displayName).toBe('Guest family');
      await f
        .save(a, saved, { message: 'Too late' })
        .expect(mode === 'withdrawn' || mode === 'archived' ? 404 : 409);
      const erased = await f.erase(a, saved).expect(204);
      expect(String(erased.headers['set-cookie'])).toContain(
        'Expires=Thu, 01 Jan 1970',
      );
      expect(f.records.has(saved.receiptId)).toBe(false);
      await f.erase(a, saved).expect(204);
    },
  );
  it('requires guests to reload after a published invitation revision changes', async () => {
    const f = fixture(),
      a = f.client();
    await f.configure().expect(200);
    const initial = (await f.prepare(a).expect(200)).body;
    f.publication.invitationPage!.version = 2;
    f.publication.invitationPage!.published!.revision = 2;
    await f.save(a, initial).expect(409);
    const fresh = (await a.get(f.guest).expect(200)).body;
    await f.save(a, fresh).expect(200);
  });
  it('bounds responses without preventing existing guests from editing at capacity', async () => {
    const f = fixture(),
      a = f.client(),
      b = f.client();
    await f.configure().expect(200);
    const initial = (await f.prepare(a).expect(200)).body,
      saved = (await f.save(a, initial).expect(200)).body;
    const original = f.records.get(saved.receiptId)!;
    for (let index = 1; index < 300; index++) {
      const receiptHash = createHash('sha256')
          .update(`fixture-${index}`)
          .digest('hex'),
        id = rsvpResponseId(f.event.id, receiptHash);
      f.records.set(id, {
        ...structuredClone(original),
        id,
        rsvpResponse: { ...original.rsvpResponse!, id, receiptHash },
      });
    }
    const extra = (await f.prepare(b).expect(200)).body;
    await f.save(b, extra).expect(409);
    await f.save(a, saved, { partySize: 3 }).expect(200);
    expect((await f.host().expect(200)).body.responses).toHaveLength(300);
  });
  it('fails closed on corrupt stored response metadata and changing event ownership', async () => {
    const f = fixture(),
      a = f.client();
    await f.configure().expect(200);
    const initial = (await f.prepare(a).expect(200)).body,
      saved = (await f.save(a, initial).expect(200)).body;
    const row = f.records.get(saved.receiptId)!;
    row.rsvpResponse!.partySize = 0;
    await f.host().expect(503);
    await a.get(f.guest).expect(503);
    row.rsvpResponse!.partySize = 2;
    const original = f.store.get;
    f.store.get = async (id) => {
      const value = await original(id);
      if (id === saved.receiptId) f.event.ownerId = 'other';
      return value;
    };
    await f.save(a, saved, { message: 'Changing owner' }).expect(404);
    expect(row.rsvpResponse!.version).toBe(1);
  });
  it('removes only an owned selected response and includes all response records in event cleanup', async () => {
    const f = fixture(),
      a = f.client();
    await f.configure().expect(200);
    const initial = (await f.prepare(a).expect(200)).body,
      saved = (await f.save(a, initial).expect(200)).body;
    await request(f.app)
      .delete(`${f.url}/${saved.receiptId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=other')
      .send({ version: 1 })
      .expect(404);
    await request(f.app)
      .delete(`${f.url}/${saved.receiptId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ version: 0 })
      .expect(400);
    await request(f.app)
      .delete(`${f.url}/${saved.receiptId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ version: 1 })
      .expect(204);
    const newState = (await a.get(f.guest).expect(200)).body;
    await f.save(a, newState).expect(200);
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(
      [...f.records.values()].filter((row) => row.eventId === f.event.id),
    ).toEqual([]);
    await f.erase(a, saved).expect(204);
  });
});
