import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { invitationFixture, origin } from '../fixtures/collection-invitations';
import type { LibraryRecord } from '../../apps/api/src/library';
import { ApiError } from '../../apps/api/src/auth';

async function fixture() {
  const f = invitationFixture();
  const invitation = (await f.create().expect(201)).body.invitation as {
    id: string;
  };
  const root = `${f.path(invitation.id)}/comments`;
  const ownerRoot = `${f.root}/${invitation.id}/comments`;
  const post = (body: object, actor = 'client', path = root) =>
    request(f.app)
      .post(path)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const remove = (id: string, actor = 'client', path = root) =>
    request(f.app)
      .delete(`${path}/${id}`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`);
  const input = () => ({
    id: randomUUID(),
    photoId: f.photos[0]!.id,
    text: 'Please soften the background.',
  });
  const record = () => f.records.get(invitation.id)!;
  const comments = () =>
    [...f.records.values()].filter((row) => row.purpose === 'proofing-comment');
  return {
    ...f,
    invitation,
    root,
    ownerRoot,
    post,
    remove,
    input,
    record,
    comments,
  };
}

describe('private client-photographer photo discussion', () => {
  it('persists both roles and returns only the explicit private projection', async () => {
    const f = await fixture();
    const first = f.input();
    await f.post(first).expect(201);
    const second = {
      ...f.input(),
      text: '<script>plain text, not HTML</script>\nSecond line.',
    };
    await f.post(second, 'owner', f.ownerRoot).expect(201);
    const client = (await f.read(f.root).expect(200)).body;
    expect(client.photos).toEqual([
      { id: first.photoId, filename: 'same.jpg' },
    ]);
    expect(client.remaining).toBe(98);
    expect(client.comments).toEqual(
      expect.arrayContaining([
        {
          id: first.id,
          photoId: first.photoId,
          text: first.text,
          author: 'client',
          createdAt: expect.any(String),
          removedAt: null,
          canRemove: true,
        },
        {
          id: second.id,
          photoId: second.photoId,
          text: second.text,
          author: 'photographer',
          createdAt: expect.any(String),
          removedAt: null,
          canRemove: false,
        },
      ]),
    );
    expect(
      (await f.read(f.ownerRoot, 'owner').expect(200)).body.comments.every(
        (row: { canRemove: boolean }) => row.canRemove,
      ),
    ).toBe(true);
    expect(JSON.stringify(client)).not.toMatch(
      /private-face|Private instructions|ownerId|commentAuthorId|client@example/,
    );
    expect((await f.read(f.root).expect(200)).body).toEqual(client);
  });

  it('deduplicates retries but rejects changed content and unrelated existing IDs', async () => {
    const f = await fixture(),
      input = f.input();
    await f.post(input).expect(201);
    await f.post({ ...input, text: ` ${input.text} ` }).expect(201);
    expect(f.comments()).toHaveLength(1);
    await f.post({ ...input, text: 'Changed' }).expect(409);
    await f.post({ ...input, id: f.event.id }).expect(409);
    expect(f.event.title).toBe('Private wedding');
  });

  it('serializes simultaneous retries and preserves both distinct messages', async () => {
    const f = await fixture(),
      input = f.input();
    const results = await Promise.all([f.post(input), f.post(input)]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    expect(f.comments()).toHaveLength(1);
    await Promise.all([
      f.post(f.input()).expect(201),
      f.post(f.input()).expect(201),
    ]);
    expect(f.comments()).toHaveLength(3);
  });

  it('isolates invitations even for the same collection', async () => {
    const f = await fixture();
    const first = f.input();
    await f.post(first).expect(201);
    const other = (
      await f.create({ email: 'other@example.test', days: 1 }).expect(201)
    ).body.invitation;
    const path = `${f.path(other.id)}/comments`;
    expect((await f.read(path, 'other').expect(200)).body.comments).toEqual([]);
    await f.read(f.root, 'other').expect(404);
    await f.post(f.input(), 'other').expect(404);
    await f.remove(first.id, 'other', path).expect(404);
    await f.post(first, 'other', path).expect(409);
  });

  it.each(['moderator', 'stranger', 'owner'])(
    'denies %s on client routes',
    async (actor) => {
      const f = await fixture(),
        input = f.input();
      await f.post(input).expect(201);
      await f.read(f.root, actor).expect(404);
      await f.post(f.input(), actor).expect(404);
      await f.remove(input.id, actor).expect(404);
    },
  );

  it.each(['moderator', 'stranger', 'client'])(
    'denies %s on owner routes',
    async (actor) => {
      const f = await fixture(),
        input = f.input();
      await f.post(input).expect(201);
      await f.read(f.ownerRoot, actor).expect(404);
      await f.post(f.input(), actor, f.ownerRoot).expect(404);
      await f.remove(input.id, actor, f.ownerRoot).expect(404);
    },
  );

  it('requires a session and same-origin mutation', async () => {
    const f = await fixture();
    await request(f.app).get(f.root).expect(401);
    await request(f.app)
      .post(f.root)
      .set('Cookie', 'picfind_session=client')
      .set('Origin', 'https://untrusted.test')
      .send(f.input())
      .expect(403);
    expect(f.comments()).toHaveLength(0);
  });

  it.each(['', ' ', 'a'.repeat(1001), 'bad\u0000text'])(
    'rejects invalid text %#',
    async (text) => {
      const f = await fixture();
      await f.post({ ...f.input(), text }).expect(400);
      expect(f.comments()).toHaveLength(0);
    },
  );

  it('accepts the text boundary and rejects unknown author metadata', async () => {
    const f = await fixture();
    await f.post({ ...f.input(), text: '字'.repeat(1000) }).expect(201);
    expect(Buffer.byteLength(JSON.stringify(f.comments()[0]))).toBeLessThan(
      16000,
    );
    await f.post({ ...f.input(), author: 'photographer' }).expect(400);
    await f.post({ ...f.input(), photoId: 'invalid' }).expect(400);
  });

  it.each(['removed', 'expired', 'deleting', 'foreign', 'scan', 'not-photo'])(
    'hides and denies %s photos',
    async (mode) => {
      const f = await fixture(),
        input = f.input();
      await f.post(input).expect(201);
      const photo = f.photos[0]!;
      if (mode === 'removed') f.collection.selectedIds = [];
      if (mode === 'expired') photo.expiresAt = '2020-01-01T00:00:00Z';
      if (mode === 'deleting')
        photo.deletionStartedAt = new Date().toISOString();
      if (mode === 'foreign') photo.ownerId = 'other-owner';
      if (mode === 'scan') photo.scanId = randomUUID();
      if (mode === 'not-photo') photo.kind = 'job';
      const result = (await f.read(f.root).expect(200)).body;
      expect(result.comments).toEqual([]);
      expect(result.photos).toEqual([]);
      expect(result.unavailableCount).toBe(1);
      await f.post(f.input()).expect(404);
      await f.remove(input.id).expect(404);
    },
  );

  it('removes text while retaining retry protection and author boundaries', async () => {
    const f = await fixture(),
      input = f.input(),
      reply = f.input();
    await f.post(input).expect(201);
    await f.post(reply, 'owner', f.ownerRoot).expect(201);
    await f.remove(reply.id).expect(404);
    await f.remove(input.id).expect(204);
    await f.remove(input.id).expect(204);
    expect(f.records.get(input.id)!.commentText).toBeUndefined();
    const saved = (await f.read(f.root).expect(200)).body.comments.find(
      (row: { id: string }) => row.id === input.id,
    );
    expect(saved).toMatchObject({
      text: null,
      removedAt: expect.any(String),
      canRemove: false,
    });
    await f.post(input).expect(409);
    await f.remove(reply.id, 'owner', f.ownerRoot).expect(204);
  });

  it.each(['revoked', 'expired', 'archived'])(
    'closes %s access while retaining owner reading and removal',
    async (state) => {
      const f = await fixture(),
        input = f.input();
      await f.post(input).expect(201);
      if (state === 'revoked') await f.revoke(f.invitation.id).expect(204);
      if (state === 'expired') f.record().expiresAt = '2020-01-01T00:00:00Z';
      if (state === 'archived') f.event.archived = true;
      await f.read(f.root).expect(404);
      await f.post(f.input()).expect(404);
      await f.remove(input.id).expect(404);
      const saved = (await f.read(f.ownerRoot, 'owner').expect(200)).body;
      expect(saved.canPost).toBe(false);
      expect(saved.comments).toHaveLength(1);
      await f.post(f.input(), 'owner', f.ownerRoot).expect(409);
      await f.remove(input.id, 'owner', f.ownerRoot).expect(204);
    },
  );

  it('denies discussion after collection deletion and removes jobs with event deletion', async () => {
    const f = await fixture();
    await f.post(f.input()).expect(201);
    f.records.delete(f.collection.id);
    await f.read(f.root).expect(404);
    await f.read(f.ownerRoot, 'owner').expect(404);
    f.records.set(f.collection.id, f.collection);
    for (const photo of f.photos) delete photo.faceIds;
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.comments()).toHaveLength(0);
  });

  it('counts removed markers toward capacity and accepts a retry at the cap', async () => {
    const f = await fixture(),
      input = f.input();
    await f.post(input).expect(201);
    const template = f.records.get(input.id)!;
    for (let i = 0; i < 99; i++) {
      const row: LibraryRecord = {
        ...template,
        id: randomUUID(),
        commentRemovedAt: new Date().toISOString(),
      };
      delete row.commentText;
      f.records.set(row.id, row);
    }
    await f.post(input).expect(201);
    await f.post(f.input()).expect(409);
    const saved = (await f.read(f.root).expect(200)).body;
    expect(saved.remaining).toBe(0);
    expect(saved.canPost).toBe(false);
    expect(saved.comments).toHaveLength(100);
  });

  it('rechecks access after listing before exposing discussion', async () => {
    const f = await fixture();
    await f.post(f.input()).expect(201);
    const list = f.store.list;
    f.store.list = async (owner, kind) => {
      const rows = await list(owner, kind);
      if (kind === 'photo')
        f.record().invitationRevokedAt = new Date().toISOString();
      return rows;
    };
    await f.read(f.root).expect(404);
  });

  it('rechecks access after counting messages before saving', async () => {
    const f = await fixture();
    const list = f.store.list;
    f.store.list = async (owner, kind) => {
      const rows = await list(owner, kind);
      if (kind === 'job')
        f.record().invitationRevokedAt = new Date().toISOString();
      return rows;
    };
    await f.post(f.input()).expect(404);
    expect(f.comments()).toHaveLength(0);
  });

  it('does not convert storage failures into absent-message success', async () => {
    const f = await fixture(),
      input = f.input();
    const get = f.store.get;
    f.store.get = async (id) => {
      if (id === input.id)
        throw new ApiError(503, 'UNAVAILABLE', 'Storage unavailable.');
      return get(id);
    };
    await f.post(input).expect(503);
    expect(f.comments()).toHaveLength(0);
  });
});
