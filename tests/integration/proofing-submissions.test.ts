import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth';
import { invitationFixture, origin } from '../fixtures/collection-invitations';
import type { LibraryRecord } from '../../apps/api/src/library';
import { submissionArchiveId } from '../../apps/api/src/proofing-archive';

async function fixture() {
  const f = invitationFixture();
  f.collection.selectedIds = f.photos.map((photo) => photo.id);
  const invitation = (await f.create().expect(201)).body.invitation as {
    id: string;
  };
  const root = `${f.path(invitation.id)}/submission`;
  const ownerRoot = `${f.root}/${invitation.id}/submission`;
  const record = () => f.records.get(invitation.id)!;
  const save = (
    photoId: string,
    status: string | null,
    version: number,
    actor = 'client',
  ) =>
    request(f.app)
      .patch(`${f.path(invitation.id)}/decisions`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ photoId, status, version });
  const input = (note = 'Please retouch these.') => ({
    id: randomUUID(),
    decisionVersion: record().proofingDecisionVersion ?? 0,
    collectionVersion: f.collection.collectionVersion!,
    note,
  });
  const submit = (body: object = input(), actor = 'client') =>
    request(f.app)
      .post(root)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const reopen = (
    submissionId: string,
    reason = 'Please review the album cover.',
    actor = 'owner',
  ) =>
    request(f.app)
      .post(ownerRoot)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({ submissionId, reason });
  const originalPut = f.store.put;
  f.store.put = async (row, createOnly) => {
    if (createOnly && f.records.has(row.id))
      throw new ApiError(409, 'EXISTS', 'Exists.');
    await originalPut(row, createOnly);
  };
  return {
    ...f,
    invitation,
    root,
    ownerRoot,
    record,
    save,
    input,
    submit,
    reopen,
  };
}

describe('final proofing submissions', () => {
  it('reuses a valid legacy archive when completing an interrupted reopen', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const legacy: LibraryRecord = {
      id: input.id,
      kind: 'job',
      purpose: 'proofing-submission',
      ownerId: 'owner',
      eventId: f.event.id,
      createdAt: f.record().proofingSubmission!.submittedAt,
      submissionInvitationId: f.invitation.id,
      proofingSubmission: structuredClone(f.record().proofingSubmission!),
    };
    f.records.set(legacy.id, legacy);
    expect((await f.read(f.root).expect(200)).body.history).toEqual([]);
    await f.reopen(input.id).expect(200);
    await f.reopen(input.id).expect(200);
    expect(f.records.get(legacy.id)).toEqual(legacy);
    expect(f.records.has(submissionArchiveId(f.invitation.id, input.id))).toBe(
      false,
    );
    expect((await f.read(f.root).expect(200)).body.history[0].id).toBe(
      input.id,
    );
    await f.submit({ ...f.input(), id: input.id }).expect(409);
  });
  it('does not overwrite an unrelated record occupying the legacy raw UUID', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const unrelated = { ...f.collection, id: input.id };
    f.records.set(input.id, unrelated);
    await f.reopen(input.id).expect(200);
    expect(f.records.get(input.id)).toEqual(unrelated);
    const archiveId = submissionArchiveId(f.invitation.id, input.id);
    expect(archiveId).toMatch(/^[0-9a-f]{32}$/);
    expect(f.records.get(archiveId)!.proofingSubmission!.id).toBe(input.id);
  });
  it('rejects duplicate legacy and scoped archives without unlocking the current round', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const snapshot = structuredClone(f.record());
    const archive: LibraryRecord = {
      id: input.id,
      kind: 'job',
      purpose: 'proofing-submission',
      ownerId: 'owner',
      eventId: f.event.id,
      createdAt: snapshot.createdAt,
      submissionInvitationId: f.invitation.id,
      proofingSubmission: snapshot.proofingSubmission!,
    };
    f.records.set(input.id, archive);
    const scopedId = submissionArchiveId(f.invitation.id, input.id);
    f.records.set(scopedId, { ...archive, id: scopedId });
    await f.read(f.root).expect(503);
    await f.reopen(input.id).expect(409);
    expect(f.record()).toEqual(snapshot);
  });
  it.each(['owner', 'event', 'invitation', 'snapshot', 'deleting'])(
    'rejects conflicting scoped archive %s provenance',
    async (field) => {
      const f = await fixture(),
        input = f.input();
      await f.submit(input).expect(200);
      const current = structuredClone(f.record());
      const archive: LibraryRecord = {
        id: submissionArchiveId(f.invitation.id, input.id),
        kind: 'job',
        purpose: 'proofing-submission',
        ownerId: 'owner',
        eventId: f.event.id,
        createdAt: current.createdAt,
        submissionInvitationId: f.invitation.id,
        proofingSubmission: structuredClone(current.proofingSubmission!),
      };
      if (field === 'owner') archive.ownerId = 'different-owner';
      if (field === 'event') archive.eventId = randomUUID();
      if (field === 'invitation') archive.submissionInvitationId = randomUUID();
      if (field === 'snapshot')
        archive.proofingSubmission!.note = 'Different snapshot';
      if (field === 'deleting')
        archive.deletionStartedAt = new Date().toISOString();
      f.records.set(archive.id, archive);
      await f.reopen(input.id).expect(409);
      expect(f.record()).toEqual(current);
      expect(f.records.get(archive.id)).toEqual(archive);
    },
  );
  it('rejects a scoped archive key derived from a different invitation', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const wrongId = submissionArchiveId(randomUUID(), input.id);
    f.records.set(wrongId, {
      id: wrongId,
      kind: 'job',
      purpose: 'proofing-submission',
      ownerId: 'owner',
      eventId: f.event.id,
      createdAt: f.record().createdAt,
      submissionInvitationId: f.invitation.id,
      proofingSubmission: f.record().proofingSubmission!,
    });
    await f.read(f.root).expect(503);
  });
  it('enforces the final favorite range and projects saved counts without counting maybe decisions', async () => {
    const f = await fixture();
    f.collection.submissionPolicy = { minimum: 1, maximum: 1, closesAt: null };
    await f.save(f.photos[0]!.id, 'maybe', 0).expect(200);
    expect((await f.submit().expect(409)).body.error.code).toBe(
      'SUBMISSION_COUNT',
    );
    expect(f.record().proofingSubmission).toBeUndefined();
    await f.save(f.photos[0]!.id, 'favorite', 1).expect(200);
    await f.save(f.photos[1]!.id, 'favorite', 2).expect(200);
    expect((await f.submit().expect(409)).body.error.code).toBe(
      'SUBMISSION_COUNT',
    );
    const state = (await f.read(f.root).expect(200)).body;
    expect(state.requirements).toMatchObject({
      policy: { minimum: 1, maximum: 1, closesAt: null },
      favoriteCount: 2,
      unavailableCount: 0,
      window: { closed: false },
    });
    await f.save(f.photos[1]!.id, 'rejected', 3).expect(200);
    await f.submit().expect(200);
    expect(f.record().proofingSubmission!.favoriteIds).toEqual([
      f.photos[0]!.id,
    ]);
  });
  it('counts unavailable favorites and refuses to silently submit a smaller set', async () => {
    const f = await fixture();
    f.collection.submissionPolicy = { minimum: 1, maximum: 2, closesAt: null };
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    f.photos[0]!.deletionStartedAt = new Date().toISOString();
    expect((await f.read(f.root).expect(200)).body.requirements).toMatchObject({
      favoriteCount: 1,
      unavailableCount: 1,
    });
    expect((await f.submit().expect(409)).body.error.code).toBe(
      'SUBMISSION_PHOTO_UNAVAILABLE',
    );
    expect(f.record().proofingSubmission).toBeUndefined();
  });
  it.each([-1, 0, 1])(
    'enforces the exact deadline boundary with %i ms remaining',
    async (remaining) => {
      const f = await fixture();
      const now = Date.now();
      f.collection.submissionPolicy = {
        minimum: 0,
        maximum: 100,
        closesAt: new Date(now + remaining).toISOString(),
      };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const state = (await f.read(f.root).expect(200)).body;
        expect(state.requirements.window.closed).toBe(remaining <= 0);
        await f.submit().expect(remaining <= 0 ? 409 : 200);
        expect(Boolean(f.record().proofingSubmission)).toBe(remaining > 0);
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('checks the deadline after asynchronous availability reads', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    const before = Date.now(),
      deadline = before + 500;
    f.collection.submissionPolicy = {
      minimum: 1,
      maximum: 2,
      closesAt: new Date(deadline).toISOString(),
    };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
    const get = f.store.get;
    f.store.get = async (id) => {
      const row = await get(id);
      if (id === f.photos[0]!.id) clock.mockReturnValue(deadline);
      return row;
    };
    try {
      expect((await f.submit().expect(409)).body.error.code).toBe(
        'SUBMISSION_CLOSED',
      );
      expect(f.record().proofingSubmission).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
  it('keeps exact retries and history valid after closure but requires extension for the reopened round', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const snapshot = structuredClone(f.record().proofingSubmission);
    f.collection.submissionPolicy = {
      minimum: 1,
      maximum: 2,
      closesAt: '2020-01-01T00:00:00.000Z',
    };
    f.collection.collectionVersion = 2;
    await f.submit(input).expect(200);
    expect(f.record().proofingSubmission).toEqual(snapshot);
    await f.reopen(input.id).expect(200);
    await f.save(f.photos[0]!.id, 'favorite', 1).expect(200);
    expect((await f.submit().expect(409)).body.error.code).toBe(
      'SUBMISSION_CLOSED',
    );
    const state = (await f.read(f.root).expect(200)).body;
    expect(state.history[0].id).toBe(input.id);
    const stale = f.input();
    f.collection.submissionPolicy.closesAt = null;
    f.collection.collectionVersion = 3;
    await f.submit(stale).expect(409);
    await f.submit().expect(200);
    expect(f.record().proofingSubmission!.round).toBe(2);
  });
  it.each([
    null,
    {},
    { minimum: 0, maximum: 101, closesAt: null },
    { minimum: 0, maximum: 100, closesAt: '' },
  ])('fails closed on corrupt stored policy: %j', async (submissionPolicy) => {
    const f = await fixture();
    Object.assign(f.collection, { submissionPolicy });
    await f.read(f.root).expect(503);
    await f.read(f.ownerRoot, 'owner').expect(503);
    expect((await f.submit().expect(503)).body.error.code).toBe(
      'COLLECTION_POLICY_INVALID',
    );
    expect(f.record().proofingSubmission).toBeUndefined();
  });
  it('persists only favorites, locks edits, projects private metadata and survives reload', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    await f.save(f.photos[1]!.id, 'maybe', 1).expect(200);
    const input = f.input();
    await f.submit(input).expect(200);
    const persisted = structuredClone(f.record());
    expect(persisted.proofingSubmission).toMatchObject({
      id: input.id,
      round: 1,
      favoriteIds: [f.photos[0]!.id],
      decisionVersion: 2,
    });
    const state = (await f.read(f.root).expect(200)).body;
    expect(state.current).toMatchObject({
      id: input.id,
      favoriteCount: 1,
      unavailableCount: 0,
      photos: [{ photoId: f.photos[0]!.id, filename: 'same.jpg' }],
    });
    expect(state.canReopen).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(
      /private-face|Private instructions|ownerId|invitationRecipientId|favoriteIds/,
    );
    expect(
      (await f.save(f.photos[0]!.id, 'rejected', 2).expect(409)).body.error
        .code,
    ).toBe('PROOFING_SUBMITTED');
    expect(f.record()).toEqual(persisted);
    expect(
      (await f.read(`${f.path(f.invitation.id)}/decisions`).expect(200)).body
        .submitted.id,
    ).toBe(input.id);
    expect(
      (await f.read(f.ownerRoot, 'owner').expect(200)).body.canReopen,
    ).toBe(true);
  });
  it('allows an explicitly submitted empty set and reopens it into a valid editable decision version', async () => {
    const f = await fixture();
    const input = f.input('');
    await f.submit(input).expect(200);
    expect(f.record().proofingSubmission!.favoriteIds).toEqual([]);
    await f.reopen(input.id).expect(200);
    expect(f.record().proofingDecisionVersion).toBe(1);
    await f.save(f.photos[0]!.id, 'favorite', 1).expect(200);
    expect((await f.read(f.root).expect(200)).body.history).toHaveLength(1);
  });
  it('retries the same submission without changing timestamps and rejects changed payloads', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const snapshot = structuredClone(f.record());
    await f.submit(input).expect(200);
    for (const body of [
      { ...input, id: randomUUID() },
      { ...input, note: 'Different' },
      { ...input, decisionVersion: 1 },
      { ...input, collectionVersion: 2 },
    ])
      await f.submit(body).expect(409);
    expect(f.record()).toEqual(snapshot);
    f.collection.collectionVersion = 2;
    await f.submit(input).expect(200);
    expect(f.record()).toEqual(snapshot);
  });
  it('rejects stale decision and collection versions and identifier reuse before writing', async () => {
    const f = await fixture(),
      input = f.input();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    await f.submit(input).expect(409);
    const updated = f.input();
    f.collection.collectionVersion = 2;
    await f.submit(updated).expect(409);
    await f.submit({ ...f.input(), id: f.photos[0]!.id }).expect(409);
    expect(f.record().proofingSubmission).toBeUndefined();
  });
  it('serializes competing submissions and draft edits', async () => {
    const f = await fixture();
    const left = f.input(),
      right = f.input();
    const outcomes = await Promise.all([f.submit(left), f.submit(right)]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(409);
    const g = await fixture(),
      input = g.input();
    const writes = await Promise.all([
      g.save(g.photos[0]!.id, 'favorite', 0),
      g.submit(input),
    ]);
    expect(writes.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });
  it.each([
    'missing',
    'removed',
    'expired',
    'deleting',
    'other-event',
    'scan',
  ] as const)(
    'rejects a %s favorite instead of silently altering the submitted set',
    async (mode) => {
      const f = await fixture(),
        photo = f.photos[0]!;
      await f.save(photo.id, 'favorite', 0).expect(200);
      if (mode === 'missing') f.records.delete(photo.id);
      if (mode === 'removed') f.collection.selectedIds = [f.photos[1]!.id];
      if (mode === 'expired') photo.expiresAt = '2000-01-01T00:00:00.000Z';
      if (mode === 'deleting')
        photo.deletionStartedAt = new Date().toISOString();
      if (mode === 'other-event') photo.eventId = randomUUID();
      if (mode === 'scan') photo.scanId = randomUUID();
      expect((await f.submit().expect(409)).body.error.code).toBe(
        'SUBMISSION_PHOTO_UNAVAILABLE',
      );
      expect(f.record().proofingSubmission).toBeUndefined();
    },
  );
  it('preserves immutable submitted IDs while hiding photos no longer in the current collection', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    const input = f.input();
    await f.submit(input).expect(200);
    f.collection.selectedIds = [f.photos[1]!.id];
    f.collection.collectionVersion = 2;
    expect((await f.read(f.root).expect(200)).body.current).toMatchObject({
      collectionVersion: 1,
      favoriteCount: 1,
      unavailableCount: 1,
      photos: [],
    });
    expect(f.record().proofingSubmission!.favoriteIds).toEqual([
      f.photos[0]!.id,
    ]);
  });
  it('archives before reopening, invalidates stale edits and retains independent later rounds', async () => {
    const f = await fixture();
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
    const first = f.input();
    await f.submit(first).expect(200);
    await f.reopen(first.id).expect(200);
    const archiveId = submissionArchiveId(f.invitation.id, first.id);
    const archived = structuredClone(f.records.get(archiveId));
    expect(archived).toMatchObject({
      purpose: 'proofing-submission',
      submissionInvitationId: f.invitation.id,
    });
    expect(f.record().proofingRound).toBe(2);
    expect(f.record().proofingSubmission).toBeUndefined();
    await f.save(f.photos[0]!.id, null, 1).expect(409);
    await f.save(f.photos[0]!.id, null, 2).expect(200);
    await f.save(f.photos[1]!.id, 'favorite', 3).expect(200);
    const second = f.input('Second round');
    await f.submit(second).expect(200);
    const result = (await f.read(f.root).expect(200)).body;
    expect(result.current.photos[0].photoId).toBe(f.photos[1]!.id);
    expect(result.history[0].photos[0].photoId).toBe(f.photos[0]!.id);
    expect(result.reopenReason).toBe('Please review the album cover.');
    expect(f.records.get(archiveId)).toEqual(archived);
    await f.reopen(first.id).expect(409);
  });
  it('retries reopening once without another version bump or archive', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    await f.reopen(input.id).expect(200);
    const row = structuredClone(f.record());
    await f.reopen(input.id).expect(200);
    await f.reopen(input.id, 'Different reason').expect(409);
    expect(f.record()).toEqual(row);
    expect((await f.read(f.root).expect(200)).body.history).toHaveLength(1);
    await f.submit(input).expect(409);
  });
  it.each(['archive', 'invitation'] as const)(
    'recovers safely from a failed %s write during reopening',
    async (failure) => {
      const f = await fixture(),
        input = f.input();
      await f.submit(input).expect(200);
      const original = structuredClone(f.record()),
        put = f.store.put;
      f.store.put = async (row, createOnly) => {
        if (
          failure === 'archive'
            ? row.purpose === 'proofing-submission'
            : row.id === f.invitation.id
        )
          throw new Error('Storage unavailable.');
        await put(row, createOnly);
      };
      await f.reopen(input.id).expect(500);
      expect(f.record()).toEqual(original);
      expect(
        f.records.has(submissionArchiveId(f.invitation.id, input.id)),
      ).toBe(failure === 'invitation');
      const locked = (await f.read(f.root).expect(200)).body;
      expect(locked.current.id).toBe(input.id);
      expect(locked.history).toEqual([]);
      await f.save(f.photos[0]!.id, 'favorite', 0).expect(409);
      f.store.put = put;
      await f.reopen(input.id).expect(200);
      expect((await f.read(f.root).expect(200)).body.history).toHaveLength(1);
    },
  );
  it('does not unlock a submission if the archive identifier is occupied by a different record', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    const archiveId = submissionArchiveId(f.invitation.id, input.id);
    f.records.set(archiveId, { ...f.collection, id: archiveId });
    await f.reopen(input.id).expect(409);
    expect(f.record().proofingSubmission!.id).toBe(input.id);
  });
  it.each(['owner', 'moderator', 'other-client', 'other-owner'])(
    'denies client access to %s',
    async (actor) => {
      const f = await fixture();
      await f.read(f.root, actor).expect(404);
      await f.submit(f.input(), actor).expect(404);
    },
  );
  it.each(['client', 'moderator', 'other-owner'])(
    'denies owner history and reopening to %s',
    async (actor) => {
      const f = await fixture(),
        input = f.input();
      await f.submit(input).expect(200);
      await f.read(f.ownerRoot, actor).expect(404);
      await f.reopen(input.id, 'Change', actor).expect(404);
    },
  );
  it.each(['revoked', 'expired', 'archived'] as const)(
    'retains owner history but denies client access and reopening when %s',
    async (mode) => {
      const f = await fixture(),
        input = f.input();
      await f.submit(input).expect(200);
      if (mode === 'revoked') await f.revoke(f.invitation.id).expect(204);
      if (mode === 'expired') f.record().expiresAt = '2000-01-01T00:00:00.000Z';
      if (mode === 'archived') f.event.archived = true;
      await f.read(f.root).expect(404);
      await f.submit(input).expect(404);
      await f.reopen(input.id).expect(404);
      expect(
        (await f.read(f.ownerRoot, 'owner').expect(200)).body,
      ).toMatchObject({ canReopen: false, current: { id: input.id } });
    },
  );
  it('enforces authentication, origin, input lengths and strict request fields', async () => {
    const f = await fixture();
    await request(f.app).get(f.root).expect(401);
    await request(f.app)
      .post(f.root)
      .set('Cookie', 'picfind_session=client')
      .send(f.input())
      .expect(403);
    for (const body of [
      { ...f.input(), note: 'x'.repeat(201) },
      { ...f.input(), note: '\u0001' },
      { ...f.input(), decisionVersion: -1 },
      { ...f.input(), collectionVersion: 0 },
      { ...f.input(), id: 'bad' },
      { ...f.input(), ownerId: 'other' },
    ])
      await f.submit(body).expect(400);
    const input = f.input();
    await f.submit(input).expect(200);
    await f.reopen(input.id, '').expect(400);
    await f.reopen(input.id, 'x'.repeat(201)).expect(400);
  });
  it('fails closed on malformed current or archive metadata', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    f.record().proofingSubmission!.round = 2;
    await f.read(f.root).expect(503);
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(503);
    await f.reopen(input.id).expect(503);
    f.record().proofingSubmission!.round = 1;
    await f.reopen(input.id).expect(200);
    f.records.get(
      submissionArchiveId(f.invitation.id, input.id),
    )!.proofingSubmission!.favoriteIds = ['bad'];
    await f.read(f.root).expect(503);
  });
  it('does not default a malformed stored round to an editable first round', async () => {
    const f = await fixture();
    Object.assign(f.record(), { proofingRound: null });
    await f.read(f.root).expect(503);
    await f.submit().expect(503);
    await f.save(f.photos[0]!.id, 'favorite', 0).expect(503);
  });
  it.each(['client', 'owner'])(
    'rejects a changing collection during a %s history read',
    async (actor) => {
      const f = await fixture(),
        input = f.input();
      await f.save(f.photos[0]!.id, 'favorite', 0).expect(200);
      await f.submit({ ...input, decisionVersion: 1 }).expect(200);
      const list = f.store.list;
      f.store.list = async (owner, kind) => {
        const result = await list(owner, kind);
        if (kind === 'photo') {
          f.collection.selectedIds = [f.photos[1]!.id];
          f.collection.collectionVersion! += 1;
        }
        return result;
      };
      const response = await f
        .read(actor === 'client' ? f.root : f.ownerRoot, actor)
        .expect(409);
      expect(response.body.error.code).toBe('SUBMISSION_CHANGED');
      expect(JSON.stringify(response.body)).not.toContain('same.jpg');
    },
  );
  it('rejects a submission changed outside the process lock during a history read', async () => {
    const f = await fixture();
    const list = f.store.list;
    f.store.list = async (owner, kind) => {
      const result = await list(owner, kind);
      if (kind === 'photo')
        Object.assign(f.record(), {
          proofingDecisionVersion: 1,
          proofingDecisions: [],
          proofingDecisionUpdatedAt: new Date().toISOString(),
        });
      return result;
    };
    await f.read(f.root).expect(409);
  });
  it('enforces round and payload capacity without losing the current state', async () => {
    const f = await fixture(),
      input = f.input();
    f.record().proofingRound = 20;
    await f.submit(input).expect(200);
    expect((await f.reopen(input.id).expect(409)).body.error.code).toBe(
      'SUBMISSION_ROUND_LIMIT',
    );
    const g = await fixture();
    g.record().invitationEmail = 'x'.repeat(15_800);
    expect((await g.submit().expect(409)).body.error.code).toBe(
      'SUBMISSION_CAPACITY',
    );
    expect(g.record().proofingSubmission).toBeUndefined();
  });
  it('stores a full 100-photo submission within the existing library payload limit', async () => {
    const f = await fixture(),
      now = new Date().toISOString();
    const photos: LibraryRecord[] = Array.from({ length: 100 }, () => ({
      ...f.photos[0]!,
      id: randomUUID(),
    }));
    for (const photo of photos) f.records.set(photo.id, photo);
    f.collection.selectedIds = photos.map((photo) => photo.id);
    Object.assign(f.record(), {
      proofingDecisions: photos.map((photo) => ({
        photoId: photo.id,
        status: 'favorite',
      })),
      proofingDecisionVersion: 1,
      proofingDecisionUpdatedAt: now,
    });
    await f.submit(f.input('n'.repeat(200))).expect(200);
    expect(JSON.stringify(f.record()).length).toBeLessThanOrEqual(16_000);
    expect(f.record().proofingSubmission!.favoriteIds).toHaveLength(100);
  });
  it('reauthorizes after reads and preserves failures instead of reporting false success', async () => {
    const f = await fixture(),
      list = f.store.list;
    f.store.list = async (owner, kind) => {
      const result = await list(owner, kind);
      if (kind === 'photo')
        f.record().invitationRevokedAt = new Date().toISOString();
      return result;
    };
    await f.read(f.root).expect(404);
    const g = await fixture(),
      put = g.store.put;
    g.store.put = async () => {
      throw new Error('Write interrupted.');
    };
    await g.submit().expect(500);
    expect(g.record().proofingSubmission).toBeUndefined();
    g.store.put = put;
    await g.submit().expect(200);
  });
  it('removes submission archives through existing event deletion', async () => {
    const f = await fixture(),
      input = f.input();
    await f.submit(input).expect(200);
    await f.reopen(input.id).expect(200);
    for (const photo of f.photos) delete photo.faceIds;
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .expect(204);
    expect(f.records.has(submissionArchiveId(f.invitation.id, input.id))).toBe(
      false,
    );
    expect(f.records.has(f.invitation.id)).toBe(false);
  });
});
