import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { invitationFixture, origin } from '../fixtures/collection-invitations';
import type { LibraryRecord } from '../../apps/api/src/library';
import { submissionArchiveId } from '../../apps/api/src/proofing-archive';

async function fixture(reuseCurrentSubmissionId = false) {
  const f = invitationFixture();
  f.collection.selectedIds = f.photos.map((photo) => photo.id);
  const first = (await f.create().expect(201)).body.invitation.id as string;
  const second = (
    await f.create({ email: 'second@example.test', days: 7 }).expect(201)
  ).body.invitation.id as string;
  const save = (
    invite: string,
    actor: string,
    photoId: string,
    status: string,
    version: number,
  ) =>
    request(f.app)
      .patch(`${f.path(invite)}/decisions`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ photoId, status, version });
  const submit = async (
    invite: string,
    actor: string,
    version: number,
    id: string = randomUUID(),
  ) => {
    await request(f.app)
      .post(`${f.path(invite)}/submission`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({
        id,
        decisionVersion: version,
        collectionVersion: 1,
        note: 'Private final note',
      })
      .expect(200);
    return id;
  };
  await save(first, 'client', f.photos[0]!.id, 'favorite', 0).expect(200);
  await save(second, 'second', f.photos[0]!.id, 'favorite', 0).expect(200);
  await save(second, 'second', f.photos[1]!.id, 'favorite', 1).expect(200);
  const firstSubmissionId = await submit(first, 'client', 1);
  const secondSubmissionId = await submit(
    second,
    'second',
    2,
    reuseCurrentSubmissionId ? firstSubmissionId : randomUUID(),
  );
  const choice = {
    firstInvitationId: first,
    firstSubmissionId,
    secondInvitationId: second,
    secondSubmissionId,
  };
  const root = `/api/events/${f.event.id}/proofing-collections/${f.collection.id}/submission-comparison`;
  const compare = (input: object = choice, actor = 'owner') =>
    request(f.app)
      .get(root)
      .query(input)
      .set('Cookie', `picfind_session=${actor}`);
  return { ...f, first, second, choice, compare, save, submit };
}

describe('owner comparison of submitted rounds', () => {
  it.each([false, true])(
    'archives two invitations that used the same current UUID without merging their history (legacy first: %s)',
    async (legacyFirst) => {
      const f = await fixture(true);
      if (legacyFirst) {
        const snapshot = structuredClone(
          f.records.get(f.first)!.proofingSubmission!,
        );
        f.records.set(snapshot.id, {
          id: snapshot.id,
          ownerId: 'owner',
          kind: 'job',
          purpose: 'proofing-submission',
          eventId: f.event.id,
          createdAt: snapshot.submittedAt,
          submissionInvitationId: f.first,
          proofingSubmission: snapshot,
        });
      }
      const reopen = (invite: string) =>
        request(f.app)
          .post(`${f.root}/${invite}/submission`)
          .set('Origin', origin)
          .set('Cookie', 'picfind_session=owner')
          .send({
            submissionId: f.choice.firstSubmissionId,
            reason: 'Another round',
          });
      await reopen(f.first).expect(200);
      await reopen(f.second).expect(200);
      await reopen(f.first).expect(200);
      await reopen(f.second).expect(200);
      for (const [invite, count] of [
        [f.first, 1],
        [f.second, 2],
      ] as const) {
        const state = (
          await f.read(`${f.root}/${invite}/submission`, 'owner').expect(200)
        ).body;
        expect(state.current).toBeNull();
        expect(state.round).toBe(2);
        expect(state.history).toHaveLength(1);
        expect(state.history[0].favoriteCount).toBe(count);
      }
      expect(
        [...f.records.values()].filter(
          (row) => row.purpose === 'proofing-submission',
        ),
      ).toHaveLength(2);
      expect((await f.compare().expect(200)).body.shared).toBe(1);
      await request(f.app)
        .post(`${f.path(f.first)}/submission`)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=client')
        .send({
          id: f.choice.firstSubmissionId,
          decisionVersion: 2,
          collectionVersion: 1,
          note: '',
        })
        .expect(409);
    },
  );
  it('distinguishes identical current submission UUIDs by invitation identity', async () => {
    const f = await fixture(true);
    const result = (await f.compare().expect(200)).body;
    expect(result.first.submissionId).toBe(result.second.submissionId);
    expect(result.first.invitationId).not.toBe(result.second.invitationId);
    expect(result.photos).toHaveLength(2);
    expect(result.shared).toBe(1);
  });
  it('accepts semantically identical invitation reads with reordered stored keys', async () => {
    const f = await fixture(),
      get = f.store.get;
    const reads = new Map<string, number>();
    f.store.get = async (id) => {
      const row = await get(id);
      const count = (reads.get(id) ?? 0) + 1;
      reads.set(id, count);
      return [f.first, f.second].includes(id) && count > 1
        ? (Object.fromEntries(Object.entries(row).reverse()) as LibraryRecord)
        : row;
    };
    expect((await f.compare().expect(200)).body.shared).toBe(1);
  });
  it('ignores unrelated jobs before applying history limits and deduplicates an interrupted reopen archive', async () => {
    const f = await fixture();
    const current = f.records.get(f.first)!.proofingSubmission!;
    for (let index = 0; index < 24; index++) {
      const id = randomUUID();
      f.records.set(id, {
        id,
        kind: 'job',
        ownerId: 'owner',
        createdAt: current.submittedAt,
        eventId: index % 3 === 0 ? randomUUID() : f.event.id,
        purpose: index % 3 === 1 ? 'import' : 'proofing-submission',
        submissionInvitationId: index % 3 === 2 ? randomUUID() : f.first,
      });
    }
    f.records.set(current.id, {
      id: current.id,
      kind: 'job',
      ownerId: 'owner',
      createdAt: current.submittedAt,
      eventId: f.event.id,
      purpose: 'proofing-submission',
      submissionInvitationId: f.first,
      proofingSubmission: Object.fromEntries(
        Object.entries(current).reverse(),
      ) as typeof current,
    });
    const state = (
      await f.read(`${f.root}/${f.first}/submission`, 'owner').expect(200)
    ).body;
    expect(state.current.id).toBe(current.id);
    expect(state.history).toEqual([]);
    expect((await f.compare().expect(200)).body.shared).toBe(1);
  });
  it('returns an empty comparison for two valid empty submitted sets', async () => {
    const f = await fixture();
    f.records.get(f.first)!.proofingSubmission!.favoriteIds = [];
    f.records.get(f.second)!.proofingSubmission!.favoriteIds = [];
    const result = (await f.compare().expect(200)).body;
    expect(result.photos).toEqual([]);
    expect(result.shared).toBe(0);
    expect(result.first.favoriteCount).toBe(0);
    expect(result.second.favoriteCount).toBe(0);
  });
  it('detects an archived snapshot replacement after the history read', async () => {
    const f = await fixture();
    await request(f.app)
      .post(`${f.root}/${f.first}/submission`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        submissionId: f.choice.firstSubmissionId,
        reason: 'Review again',
      })
      .expect(200);
    const list = f.store.list;
    f.store.list = async (actor, kind) => {
      const rows = await list(actor, kind);
      if (kind === 'photo')
        f.records.get(
          submissionArchiveId(f.first, f.choice.firstSubmissionId),
        )!.proofingSubmission!.note = 'Changed externally';
      return rows;
    };
    expect((await f.compare().expect(409)).body.error.code).toBe(
      'COMPARISON_CHANGED',
    );
  });
  it('compares stored identity despite repeated filenames and excludes private fields', async () => {
    const f = await fixture();
    const result = await f.compare().expect(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.body).toMatchObject({
      shared: 1,
      collectionVersion: 1,
      first: {
        submissionId: f.choice.firstSubmissionId,
        favoriteCount: 1,
        unavailableCount: 0,
      },
      second: {
        submissionId: f.choice.secondSubmissionId,
        favoriteCount: 2,
        unavailableCount: 0,
      },
    });
    expect(result.body.photos).toEqual(
      expect.arrayContaining([
        { id: f.photos[0]!.id, filename: 'same.jpg', selectedBy: 'both' },
        { id: f.photos[1]!.id, filename: 'same.jpg', selectedBy: 'second' },
      ]),
    );
    expect(result.body.photos).toHaveLength(2);
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-face|Private instructions|Private final note|example.test|ownerId|favoriteIds/,
    );
    const reverse = (
      await f
        .compare({
          firstInvitationId: f.second,
          firstSubmissionId: f.choice.secondSubmissionId,
          secondInvitationId: f.first,
          secondSubmissionId: f.choice.firstSubmissionId,
        })
        .expect(200)
    ).body;
    expect(
      reverse.photos.find(
        (photo: { id: string }) => photo.id === f.photos[1]!.id,
      ).selectedBy,
    ).toBe('first');
  });
  it.each(['client', 'second', 'moderator', 'stranger'])(
    'denies comparison to %s',
    async (actor) => {
      const f = await fixture();
      await f.compare(f.choice, actor).expect(404);
    },
  );
  it.each([
    'firstInvitationId',
    'firstSubmissionId',
    'secondInvitationId',
    'secondSubmissionId',
  ])('rejects an unrelated or malformed %s', async (field) => {
    const f = await fixture();
    await f.compare({ ...f.choice, [field]: randomUUID() }).expect(404);
    await f.compare({ ...f.choice, [field]: 'bad-id' }).expect(400);
  });
  it('rejects duplicate snapshots, missing fields and unknown fields', async () => {
    const f = await fixture();
    await f
      .compare({
        ...f.choice,
        secondInvitationId: f.first,
        secondSubmissionId: f.choice.firstSubmissionId,
      })
      .expect(400);
    await f.compare({ firstInvitationId: f.first }).expect(400);
    await f.compare({ ...f.choice, extra: 'ignored' }).expect(400);
  });
  it.each(['owner', 'event', 'collection', 'deleting'])(
    'denies an invitation with changed %s scope',
    async (mutation) => {
      const f = await fixture();
      const row = f.records.get(f.second)!;
      if (mutation === 'owner') row.ownerId = 'other';
      if (mutation === 'event') row.eventId = randomUUID();
      if (mutation === 'collection') row.invitationCollectionId = randomUUID();
      if (mutation === 'deleting')
        row.deletionStartedAt = new Date().toISOString();
      await f.compare().expect(404);
    },
  );
  it('retains owner comparison after access expiry, revocation and event archive', async () => {
    const f = await fixture();
    f.records.get(f.first)!.invitationRevokedAt = new Date().toISOString();
    f.records.get(f.second)!.expiresAt = '2020-01-01T00:00:00.000Z';
    f.event.archived = true;
    expect((await f.compare().expect(200)).body.shared).toBe(1);
    await f.read(`${f.path(f.first)}/submission`).expect(404);
  });
  it.each([
    'removed',
    'expired',
    'deleting',
    'not-selected',
    'scan',
    'different-event',
  ])(
    'omits %s photos and reports per-round unavailable counts',
    async (mode) => {
      const f = await fixture(),
        photo = f.photos[0]!;
      if (mode === 'removed') f.records.delete(photo.id);
      if (mode === 'expired') photo.expiresAt = '2020-01-01T00:00:00.000Z';
      if (mode === 'deleting')
        photo.deletionStartedAt = new Date().toISOString();
      if (mode === 'not-selected') f.collection.selectedIds = [f.photos[1]!.id];
      if (mode === 'scan') photo.scanId = randomUUID();
      if (mode === 'different-event') photo.eventId = randomUUID();
      const result = (await f.compare().expect(200)).body;
      expect(result.shared).toBe(0);
      expect(result.first.unavailableCount).toBe(1);
      expect(result.second.unavailableCount).toBe(1);
      expect(result.photos).toEqual([
        { id: f.photos[1]!.id, filename: 'same.jpg', selectedBy: 'second' },
      ]);
      expect(JSON.stringify(result)).not.toContain(photo.id);
    },
  );
  it('compares archived and current rounds of one invitation', async () => {
    const f = await fixture();
    await request(f.app)
      .post(`${f.root}/${f.first}/submission`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        submissionId: f.choice.firstSubmissionId,
        reason: 'Different cover',
      })
      .expect(200);
    await f.save(f.first, 'client', f.photos[0]!.id, 'rejected', 2).expect(200);
    await f.save(f.first, 'client', f.photos[1]!.id, 'favorite', 3).expect(200);
    const next = await f.submit(f.first, 'client', 4);
    const result = (
      await f
        .compare({
          ...f.choice,
          secondInvitationId: f.first,
          secondSubmissionId: next,
        })
        .expect(200)
    ).body;
    expect(result.shared).toBe(0);
    expect(result.first.round).toBe(1);
    expect(result.second.round).toBe(2);
    expect(result.photos).toEqual(
      expect.arrayContaining([
        { id: f.photos[0]!.id, filename: 'same.jpg', selectedBy: 'first' },
        { id: f.photos[1]!.id, filename: 'same.jpg', selectedBy: 'second' },
      ]),
    );
    const archive = f.records.get(
      submissionArchiveId(f.first, f.choice.firstSubmissionId),
    )!;
    archive.proofingSubmission!.favoriteIds.push(f.photos[0]!.id);
    await f
      .compare({
        ...f.choice,
        secondInvitationId: f.first,
        secondSubmissionId: next,
      })
      .expect(503);
  });
  it.each(['collection', 'invitation', 'event'])(
    'rejects a detectable %s change during photo inventory reads',
    async (mode) => {
      const f = await fixture(),
        list = f.store.list;
      f.store.list = async (actor, kind) => {
        const rows = await list(actor, kind);
        if (kind === 'photo') {
          if (mode === 'collection') f.collection.collectionVersion = 2;
          if (mode === 'invitation')
            f.records.get(f.second)!.proofingSubmission!.note =
              'Changed elsewhere';
          if (mode === 'event')
            f.event.deletionStartedAt = new Date().toISOString();
        }
        return rows;
      };
      await f.compare().expect(mode === 'event' ? 404 : 409);
    },
  );
  it('rejects corrupt current submissions and duplicate archived rounds', async () => {
    const f = await fixture();
    const invite = f.records.get(f.first)!;
    const snapshot = structuredClone(invite.proofingSubmission!);
    invite.proofingSubmission!.round = 2;
    await f.compare().expect(503);
    invite.proofingSubmission = snapshot;
    const archive: LibraryRecord = {
      id: randomUUID(),
      kind: 'job',
      ownerId: 'owner',
      eventId: f.event.id,
      purpose: 'proofing-submission',
      createdAt: snapshot.submittedAt,
      submissionInvitationId: f.first,
      proofingSubmission: { ...snapshot, id: randomUUID() },
    };
    f.records.set(archive.id, archive);
    await f.compare().expect(503);
  });
});
