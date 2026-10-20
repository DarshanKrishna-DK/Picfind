import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { invitationFixture, origin } from '../fixtures/collection-invitations';
import type { LibraryRecord } from '../../apps/api/src/library';

async function fixture() {
  const f = invitationFixture();
  f.collection.selectedIds = f.photos.map((photo) => photo.id);
  const invitation = (await f.create().expect(201)).body.invitation as {
    id: string;
  };
  const root = `${f.path(invitation.id)}/decisions`;
  const ownerRoot = `${f.root}/${invitation.id}/decisions`;
  const save = (
    photoId: string,
    status: string | null,
    version: number,
    actor = 'client',
  ) =>
    request(f.app)
      .patch(root)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ photoId, status, version });
  const record = () => f.records.get(invitation.id)!;
  return { ...f, invitation, root, ownerRoot, save, record };
}

describe('saved client proofing decisions', () => {
  it('persists all choices, reloads, clears and shows the owner an explicit private projection', async () => {
    const f = await fixture();
    expect((await f.read(f.root).expect(200)).body).toEqual({
      version: 0,
      updatedAt: null,
      decisions: [],
      unavailableCount: 0,
    });
    const photoId = f.photos[0]!.id;
    for (const [i, status] of ['favorite', 'maybe', 'rejected'].entries()) {
      const saved = (await f.save(photoId, status, i).expect(200)).body;
      expect(saved).toEqual({
        version: i + 1,
        updatedAt: expect.any(String),
        unavailableCount: 0,
        decisions: [{ photoId, filename: 'same.jpg', status }],
      });
      expect((await f.read(f.root).expect(200)).body).toEqual(saved);
      expect((await f.read(f.ownerRoot, 'owner').expect(200)).body).toEqual(
        saved,
      );
    }
    await f.save(f.photos[1]!.id, 'favorite', 3).expect(200);
    const cleared = (await f.save(photoId, null, 4).expect(200)).body;
    expect(cleared.decisions).toEqual([
      { photoId: f.photos[1]!.id, filename: 'same.jpg', status: 'favorite' },
    ]);
    expect(f.record().proofingDecisions).toEqual([
      { photoId: f.photos[1]!.id, status: 'favorite' },
    ]);
    expect(JSON.stringify(cleared)).not.toMatch(
      /Private instructions|private-face|client@example|ownerId/,
    );
  });
  it('isolates clients and denies moderators, owner writes and unauthorized reads', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    const second = (
      await f.create({ email: 'other@example.test', days: 1 }).expect(201)
    ).body.invitation;
    expect(
      (await f.read(`${f.path(second.id)}/decisions`, 'other').expect(200)).body
        .decisions,
    ).toEqual([]);
    for (const actor of ['other', 'moderator', 'owner']) {
      await f.read(f.root, actor).expect(404);
      await f.save(f.photos[0]!.id, 'rejected', 1, actor).expect(404);
    }
    for (const actor of ['client', 'other', 'moderator'])
      await f.read(f.ownerRoot, actor).expect(404);
    await request(f.app).get(f.root).expect(401);
    await request(f.app)
      .patch(f.root)
      .set('Cookie', 'picfind_session=client')
      .send({})
      .expect(403);
    expect(f.record().proofingDecisionVersion).toBe(1);
  });
  it('rejects stale and simultaneous writes without overwriting an accepted decision', async () => {
    const f = await fixture();
    const responses = await Promise.all(
      f.photos.map((photo) => f.save(photo.id, 'favorite', 0)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const saved = (await f.read(f.root).expect(200)).body;
    expect(saved.version).toBe(1);
    expect(saved.decisions).toHaveLength(1);
    const rejected = await f.save(f.photos[0]!.id, 'maybe', 0).expect(409);
    expect(rejected.body.error.code).toBe('DECISIONS_CHANGED');
    expect((await f.read(f.root).expect(200)).body).toEqual(saved);
  });
  it.each(['revoked', 'expired', 'event-archived', 'collection-deleted'])(
    'denies client changes after %s',
    async (condition) => {
      const f = await fixture();
      await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
      if (condition === 'revoked') await f.revoke(f.invitation.id).expect(204);
      if (condition === 'expired')
        f.record().expiresAt = '2020-01-01T00:00:00Z';
      if (condition === 'event-archived') f.event.archived = true;
      if (condition === 'collection-deleted') f.records.delete(f.collection.id);
      await f.read(f.root).expect(404);
      await f.save(f.photos[0]!.id, 'rejected', 1).expect(404);
      expect(f.record().proofingDecisions?.[0]?.status).toBe('favorite');
      if (condition !== 'collection-deleted')
        expect(
          (await f.read(f.ownerRoot, 'owner').expect(200)).body.decisions[0]
            .status,
        ).toBe('favorite');
    },
  );
  it.each([
    'expired',
    'deleting',
    'foreign-event',
    'foreign-owner',
    'scan',
    'removed',
  ])(
    'counts hidden %s choices and prunes them only on a successful save',
    async (condition) => {
      const f = await fixture();
      const photo = f.photos[0]!;
      await f.save(photo.id, 'favorite', 0).expect(200);
      if (condition === 'expired') photo.expiresAt = '2020-01-01T00:00:00Z';
      if (condition === 'deleting')
        photo.deletionStartedAt = new Date().toISOString();
      if (condition === 'foreign-event') photo.eventId = f.collection.id;
      if (condition === 'foreign-owner') photo.ownerId = 'foreign';
      if (condition === 'scan') photo.scanId = f.collection.id;
      if (condition === 'removed') f.collection.selectedIds = [f.photos[1]!.id];
      const hidden = (await f.read(f.root).expect(200)).body;
      expect(hidden.decisions).toEqual([]);
      expect(hidden.unavailableCount).toBe(1);
      expect(f.record().proofingDecisions).toHaveLength(1);
      await f.save(photo.id, 'maybe', 1).expect(409);
      const changed = (await f.save(f.photos[1]!.id, 'maybe', 1).expect(200))
        .body;
      expect(changed.unavailableCount).toBe(0);
      expect(f.record().proofingDecisions).toEqual([
        { photoId: f.photos[1]!.id, status: 'maybe' },
      ]);
    },
  );
  it.each([
    { proofingDecisionVersion: -1 },
    { proofingDecisions: [] },
    {
      proofingDecisionVersion: 1,
      proofingDecisionUpdatedAt: 'invalid',
      proofingDecisions: [],
    },
    {
      proofingDecisionVersion: 1,
      proofingDecisionUpdatedAt: '2026-01-01T00:00:00Z',
    },
  ])('fails closed on incomplete or invalid metadata %j', async (patch) => {
    const f = await fixture();
    Object.assign(f.record(), patch);
    await f.read(f.root).expect(503);
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(503);
    expect(f.record()).toMatchObject(patch);
  });
  it('rejects invalid status, foreign photo, unexpected fields and malformed saved entries', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'approved', 0).expect(400);
    await request(f.app)
      .patch(f.root)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=client')
      .send({
        photoId: f.photos[0]!.id,
        status: 'favorite',
        version: 0,
        ownerId: 'owner',
      })
      .expect(400);
    await f.save(f.event.id, 'favorite', 0).expect(409);
    f.record().proofingDecisionVersion = 1;
    f.record().proofingDecisionUpdatedAt = new Date().toISOString();
    f.record().proofingDecisions = [
      { photoId: f.photos[0]!.id, status: 'favorite' },
      { photoId: f.photos[0]!.id, status: 'maybe' },
    ];
    await f.read(f.root).expect(503);
    await f.save(f.photos[1]!.id, 'favorite', 1).expect(503);
  });
  it('rechecks revocation during photo lookup and preserves the revoked grant', async () => {
    const f = await fixture();
    const list = f.store.list;
    f.store.list = async (owner, kind) => {
      const rows = await list(owner, kind);
      if (kind === 'photo')
        f.record().invitationRevokedAt = new Date().toISOString();
      return rows;
    };
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(404);
    expect(f.record().invitationRevokedAt).toBeDefined();
    expect(f.record().proofingDecisions).toBeUndefined();
  });
  it('handles the final safe version without persisting unreadable metadata', async () => {
    const f = await fixture();
    Object.assign(f.record(), {
      proofingDecisionVersion: Number.MAX_SAFE_INTEGER - 1,
      proofingDecisions: [],
      proofingDecisionUpdatedAt: new Date().toISOString(),
    } satisfies Partial<LibraryRecord>);
    expect(
      (
        await f
          .save(f.photos[0]!.id, 'favorite', Number.MAX_SAFE_INTEGER - 1)
          .expect(200)
      ).body.version,
    ).toBe(Number.MAX_SAFE_INTEGER);
    await f.read(f.root).expect(200);
    await f.save(f.photos[0]!.id, null, Number.MAX_SAFE_INTEGER).expect(400);
  });
});
