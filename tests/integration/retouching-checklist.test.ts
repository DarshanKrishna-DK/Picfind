import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../apps/api/src/auth';
import { retouchingKey } from '../../apps/api/src/retouching-state';
import { invitationFixture, origin } from '../fixtures/collection-invitations';

async function fixture() {
  const f = invitationFixture();
  f.collection.selectedIds = f.photos.map((p) => p.id);
  const invitationId = (await f.create().expect(201)).body.invitation
    .id as string;
  const submissionId = randomUUID(),
    photoId = f.photos[0]!.id;
  await request(f.app)
    .patch(`${f.path(invitationId)}/decisions`)
    .set('Origin', origin)
    .set('Cookie', 'picfind_session=client')
    .send({ version: 0, photoId, status: 'favorite' })
    .expect(200);
  await request(f.app)
    .post(`${f.path(invitationId)}/submission`)
    .set('Origin', origin)
    .set('Cookie', 'picfind_session=client')
    .send({
      id: submissionId,
      decisionVersion: 1,
      collectionVersion: 1,
      note: 'Private client note',
    })
    .expect(200);
  const root = `${f.root}/${invitationId}/submission/${submissionId}/retouching`;
  const key = retouchingKey(invitationId, submissionId, photoId);
  const read = (actor = 'owner') => f.read(root, actor);
  const input = (version = 0, status = 'editing', note = 'Remove dust') => ({
    version,
    status,
    note,
  });
  const save = (body: object = input(), actor = 'owner', photo = photoId) =>
    request(f.app)
      .patch(`${root}/${photo}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const put = f.store.put;
  f.store.put = async (row, createOnly) => {
    if (createOnly && f.records.has(row.id))
      throw new ApiError(409, 'EXISTS', 'Exists.');
    await put(row, createOnly);
  };
  return {
    ...f,
    invitationId,
    submissionId,
    photoId,
    root,
    key,
    read,
    input,
    save,
  };
}

describe('round-bound photographer retouching checklist', () => {
  it('persists work, notes and complete history without exposing other private metadata', async () => {
    const f = await fixture();
    const initial = await f.read().expect(200);
    expect(initial.headers['cache-control']).toContain('no-store');
    expect(initial.body.items).toEqual([
      {
        photoId: f.photoId,
        filename: 'same.jpg',
        status: 'queued',
        note: '',
        version: 0,
        history: [],
      },
    ]);
    await f.save().expect(200);
    await f.save(f.input(1, 'ready', 'Dust removed')).expect(200);
    const result = (await f.read().expect(200)).body;
    expect(result.items[0]).toMatchObject({
      status: 'ready',
      note: 'Dust removed',
      version: 2,
    });
    expect(
      result.items[0].history.map((x: { version: number }) => x.version),
    ).toEqual([1, 2]);
    expect(JSON.stringify(result)).not.toMatch(
      /private-face|Private instructions|Private client note|example.test/,
    );
    expect(f.records.get(f.key)!.retouchingTask!.photoId).toBe(f.photoId);
    expect(
      f.records.get(f.invitationId)!.proofingSubmission!.favoriteIds,
    ).toEqual([f.photoId]);
  });
  it('makes exact lost-response retries and unchanged saves idempotent', async () => {
    const f = await fixture();
    await f.save().expect(200);
    const saved = structuredClone(f.records.get(f.key));
    await f.save().expect(200);
    await f.save(f.input(1)).expect(200);
    expect(f.records.get(f.key)).toEqual(saved);
    await f.save(f.input(0, 'editing', 'Different instruction')).expect(409);
    expect(f.records.get(f.key)).toEqual(saved);
  });
  it('requires ordered progress and an explanation for going backwards', async () => {
    const f = await fixture();
    await f.save(f.input(0, 'ready', '')).expect(409);
    expect(f.records.has(f.key)).toBe(false);
    await f.save().expect(200);
    await f.save(f.input(1, 'queued', '   ')).expect(409);
    await f.save(f.input(1, 'ready', '')).expect(200);
    await f.save(f.input(2, 'queued', 'Restart')).expect(409);
    await f
      .save(f.input(2, 'editing', 'Client requested another pass'))
      .expect(200);
    await f.save(f.input(3, 'queued', 'Waiting for source')).expect(200);
    expect((await f.read().expect(200)).body.items[0].version).toBe(4);
  });
  it.each(['client', 'moderator', 'other-owner'])(
    'denies %s both reads and writes',
    async (actor) => {
      const f = await fixture();
      await f.save().expect(200);
      const before = structuredClone(f.records.get(f.key));
      await f.read(actor).expect(404);
      await f.save(f.input(1, 'ready'), actor).expect(404);
      expect(f.records.get(f.key)).toEqual(before);
    },
  );
  it('requires a session and the trusted write origin', async () => {
    const f = await fixture();
    await request(f.app).get(f.root).expect(401);
    await request(f.app)
      .patch(`${f.root}/${f.photoId}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://wrong.example')
      .send(f.input())
      .expect(403);
    expect(f.records.has(f.key)).toBe(false);
  });
  it.each(['collection', 'invitation', 'submission', 'photo'])(
    'rejects wrong %s scope',
    async (part) => {
      const f = await fixture();
      let path = f.root;
      if (part === 'collection')
        path = path.replace(f.collection.id, randomUUID());
      if (part === 'invitation')
        path = path.replace(f.invitationId, randomUUID());
      if (part === 'submission')
        path = path.replace(f.submissionId, randomUUID());
      await request(f.app)
        .patch(`${path}/${part === 'photo' ? f.photos[1]!.id : f.photoId}`)
        .set('Cookie', 'picfind_session=owner')
        .set('Origin', origin)
        .send(f.input())
        .expect(404);
      expect(f.records.has(f.key)).toBe(false);
    },
  );
  it.each(['removed', 'expired', 'deleted', 'scan', 'owner', 'event'])(
    'omits and refuses %s photos',
    async (state) => {
      const f = await fixture();
      await f.save().expect(200);
      const photo = f.photos[0]!;
      if (state === 'removed') f.collection.selectedIds = [];
      if (state === 'expired') photo.expiresAt = '2000-01-01T00:00:00.000Z';
      if (state === 'deleted')
        photo.deletionStartedAt = new Date().toISOString();
      if (state === 'scan') photo.scanId = randomUUID();
      if (state === 'owner') photo.ownerId = 'someone-else';
      if (state === 'event') photo.eventId = randomUUID();
      expect((await f.read().expect(200)).body).toMatchObject({
        items: [],
        unavailableCount: 1,
      });
      await f.save(f.input(1, 'ready')).expect(404);
      expect(f.records.get(f.key)!.retouchingTask!.history).toHaveLength(1);
    },
  );
  it.each(['archived', 'expired'])(
    'keeps %s events readable but refuses work changes',
    async (state) => {
      const f = await fixture();
      await f.save().expect(200);
      if (state === 'archived') f.event.archived = true;
      else f.event.expiresAt = '2000-01-01T00:00:00.000Z';
      expect((await f.read().expect(200)).body.readOnly).toBe(true);
      await f.save(f.input(1, 'ready')).expect(409);
    },
  );
  it('allows private owner work after the invitation is revoked and expired', async () => {
    const f = await fixture();
    const invitation = f.records.get(f.invitationId)!;
    invitation.invitationRevokedAt = new Date().toISOString();
    invitation.expiresAt = '2000-01-01T00:00:00.000Z';
    await f.save().expect(200);
    expect((await f.read().expect(200)).body.items[0].status).toBe('editing');
    await f.read('client').expect(404);
  });
  it('isolates a new submitted round while retaining the earlier checklist', async () => {
    const f = await fixture();
    await f.save().expect(200);
    await request(f.app)
      .post(`${f.root.split(`/${f.submissionId}`)[0]}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ submissionId: f.submissionId, reason: 'Choose final cover' })
      .expect(200);
    const next = randomUUID();
    await request(f.app)
      .post(`${f.path(f.invitationId)}/submission`)
      .set('Cookie', 'picfind_session=client')
      .set('Origin', origin)
      .send({ id: next, decisionVersion: 2, collectionVersion: 1, note: '' })
      .expect(200);
    expect((await f.read().expect(200)).body.items[0].status).toBe('editing');
    expect((await f.read('owner').expect(200)).body.round).toBe(1);
    const nextState = (
      await request(f.app)
        .get(f.root.replace(f.submissionId, next))
        .set('Cookie', 'picfind_session=owner')
        .expect(200)
    ).body;
    expect(nextState).toMatchObject({
      round: 2,
      items: [{ status: 'queued', note: '', version: 0, history: [] }],
    });
  });
  it('isolates invitations using the same submission UUID and same photo', async () => {
    const f = await fixture();
    await f.save().expect(200);
    const other = (
      await f.create({ email: 'client2@example.test', days: 7 }).expect(201)
    ).body.invitation.id as string;
    await request(f.app)
      .patch(`${f.path(other)}/decisions`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=client2')
      .send({ version: 0, photoId: f.photoId, status: 'favorite' })
      .expect(200);
    await request(f.app)
      .post(`${f.path(other)}/submission`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=client2')
      .send({
        id: f.submissionId,
        decisionVersion: 1,
        collectionVersion: 1,
        note: '',
      })
      .expect(200);
    const otherRoot = f.root.replace(f.invitationId, other);
    expect(
      (
        await request(f.app)
          .get(otherRoot)
          .set('Cookie', 'picfind_session=owner')
          .expect(200)
      ).body.items[0],
    ).toMatchObject({ status: 'queued', note: '', version: 0 });
    await request(f.app)
      .patch(`${otherRoot}/${f.photoId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send(f.input(0, 'editing', 'Other client work'))
      .expect(200);
    expect((await f.read().expect(200)).body.items[0].note).toBe('Remove dust');
  });
  it('bounds history without truncating prior changes', async () => {
    const f = await fixture();
    for (let version = 0; version < 30; version++)
      await f.save(f.input(version, 'editing', `Pass ${version}`)).expect(200);
    const saved = structuredClone(f.records.get(f.key));
    await f.save(f.input(30, 'ready', 'Done')).expect(409);
    await f.save(f.input(29, 'editing', 'Pass 29')).expect(200);
    expect(f.records.get(f.key)).toEqual(saved);
    expect((await f.read().expect(200)).body.items[0].history).toHaveLength(30);
  });
  it.each([
    'version',
    'transition',
    'scope',
    'owner',
    'purpose',
    'key',
    'deleting',
  ])('fails closed on corrupt %s metadata', async (field) => {
    const f = await fixture();
    await f.save().expect(200);
    const row = f.records.get(f.key)!;
    if (field === 'version') row.retouchingTask!.history[0]!.version = 2;
    if (field === 'transition')
      row.retouchingTask!.history[0]!.status = 'ready';
    if (field === 'scope') row.retouchingTask!.submissionId = randomUUID();
    if (field === 'owner') row.ownerId = 'wrong';
    if (field === 'purpose') row.purpose = 'proofing-comment';
    if (field === 'key') {
      f.records.delete(f.key);
      row.id = randomUUID();
      f.records.set(row.id, row);
    }
    if (field === 'deleting') row.deletionStartedAt = new Date().toISOString();
    // Wrong-owner records are absent from owner list reads, but direct mutation must still refuse them.
    if (field !== 'owner') await f.read().expect(503);
    await f.save(f.input(1, 'ready')).expect(503);
  });
  it.each([
    { version: -1, status: 'editing', note: '' },
    { version: 0, status: 'sent', note: '' },
    { version: 0, status: 'editing', note: 'x'.repeat(201) },
    { version: 0, status: 'editing', note: '', extra: true },
  ])('rejects malformed input %#', async (body) => {
    const f = await fixture();
    await f.save(body).expect(400);
    expect(f.records.has(f.key)).toBe(false);
  });
  it('keeps a failed write retryable without appending partial history', async () => {
    const f = await fixture();
    const put = f.store.put;
    f.store.put = async (row, createOnly) => {
      if (row.purpose === 'retouching-task')
        throw new ApiError(503, 'OFFLINE', 'Unavailable.');
      await put(row, createOnly);
    };
    await f.save().expect(503);
    expect(f.records.has(f.key)).toBe(false);
    f.store.put = put;
    await f.save().expect(200);
    expect((await f.read().expect(200)).body.items[0].history).toHaveLength(1);
  });
  it('detects a task replaced during an asynchronous save', async () => {
    const f = await fixture();
    await f.save().expect(200);
    const get = f.store.get;
    let reads = 0;
    f.store.get = async (id) => {
      if (id === f.key && ++reads === 2)
        f.records.get(id)!.retouchingTask!.history[0]!.note = 'External change';
      return get(id);
    };
    await f.save(f.input(1, 'ready')).expect(409);
    expect(f.records.get(f.key)!.retouchingTask!.history[0]!.note).toBe(
      'External change',
    );
  });
  it('removes work records with event cleanup and omits them from library import jobs', async () => {
    const f = await fixture();
    await f.save().expect(200);
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(JSON.stringify(library.body)).not.toContain('Remove dust');
    for (const photo of f.photos) delete photo.faceIds;
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(f.key)).toBe(false);
  });
});
