import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { portfolioFixture as fixture } from '../fixtures/studio-portfolio';
import { portfolioRecordId } from '../../apps/api/src/studio-portfolio';
import {
  PORTFOLIO_ACTOR,
  PORTFOLIO_CONSENT,
  portfolioSnapshot,
  publicPortfolio,
} from '../../packages/shared/src/studio-portfolio';

describe('explicit photographer portfolio publication', () => {
  it('keeps drafts private, publishes a minimal anonymous projection, and withdraws without losing the saved draft', async () => {
    const f = await fixture();
    expect(
      portfolioSnapshot.parse((await f.read(f.root).expect(200)).body).portfolio
        .version,
    ).toBe(0);
    await f.save().expect(200);
    await f.publicRead().expect(404);
    await f.publish(1).expect(200);
    const live = publicPortfolio.parse((await f.publicRead().expect(200)).body);
    expect(live.name).toBe(f.fields.name);
    expect(live.photos.map((photo) => photo.id)).toEqual(
      f.fields.photos.map((photo) => photo.id),
    );
    const serialized = JSON.stringify(live);
    for (const secret of [
      'Private-photo',
      'Private portrait session',
      'Private client note',
      'private-face-index',
      f.ownerId,
      'commandDigest',
    ])
      expect(serialized).not.toContain(secret);
    await f
      .save({
        version: 2,
        fields: { ...f.fields, biography: 'New private biography' },
      })
      .expect(200);
    expect((await f.publicRead().expect(200)).body.biography).toBe(
      f.fields.biography,
    );
    await f.save({ version: 3, action: 'withdraw' }).expect(200);
    await f.publicRead().expect(404);
    await f.media().expect(404);
    const saved = (await f.read(f.root).expect(200)).body.portfolio;
    expect(saved.draft.biography).toBe('New private biography');
    expect(saved.published).toBeNull();
    expect(f.event.visibility).toBe('private');
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body.jobs),
    ).not.toContain('Asha');
  });
  it('requires verified owner scope, origin, expected actor and explicit publication permission', async () => {
    const f = await fixture();
    await request(f.app).get(f.root).expect(401);
    await f.read(f.root).set(PORTFOLIO_ACTOR, f.strangerId).expect(403);
    await f.save({ action: 'publish' }).expect(400);
    await f
      .save({
        action: 'publish',
        permission: PORTFOLIO_CONSENT,
        fields: { ...f.fields, photos: [] },
      })
      .expect(400);
    await f.save({}, f.strangerId).expect(404);
    await f.save().set('Origin', 'https://outside.test').expect(403);
    expect(f.records.has(f.id)).toBe(false);
  });
  it.each([
    { website: 'javascript:alert(1)' },
    { website: 'http://example.com' },
    { website: 'https://user:password@example.com' },
    { name: '' },
    { biography: 'x'.repeat(1001) },
  ])(
    'rejects invalid profile fields %j without storing a draft',
    async (changes) => {
      const f = await fixture();
      await f.save({ fields: { ...f.fields, ...changes } }).expect(400);
      expect(f.records.has(f.id)).toBe(false);
    },
  );
  it('rejects duplicate selections, excessive selections and invalid revision types', async () => {
    const f = await fixture();
    await f
      .save({
        fields: {
          ...f.fields,
          photos: [f.fields.photos[0], f.fields.photos[0]],
        },
      })
      .expect(400);
    await f
      .save({
        fields: {
          ...f.fields,
          photos: Array.from({ length: 25 }, () => ({
            id: randomUUID(),
            caption: '',
          })),
        },
      })
      .expect(400);
    await f.save({ version: '0' }).expect(400);
    await f.save({ version: -1 }).expect(400);
  });
  it('recovers exact retries, rejects stale overwrites and preserves the published order across draft edits', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    await f.publish().expect(200);
    expect(f.stored().studioPortfolio!.version).toBe(1);
    await f.save({ fields: { ...f.fields, name: 'Stale edit' } }).expect(409);
    const fields = { ...f.fields, photos: [...f.fields.photos].reverse() };
    await f.save({ fields, version: 1 }).expect(200);
    expect((await f.publicRead().expect(200)).body.photos[0].id).toBe(
      f.fields.photos[0]!.id,
    );
    await f
      .save({
        fields,
        version: 2,
        action: 'publish',
        permission: PORTFOLIO_CONSENT,
      })
      .expect(200);
    expect((await f.publicRead().expect(200)).body.photos[0].id).toBe(
      fields.photos[0]!.id,
    );
  });
  it.each([
    'scan',
    'foreign',
    'expired',
    'deleted',
    'archived-event',
    'expired-event',
    'foreign-event',
  ] as const)(
    'excludes %s source photos from choices and publication',
    async (condition) => {
      const f = await fixture(),
        photo = f.photos[0]!;
      if (condition === 'scan') photo.scanId = randomUUID();
      if (condition === 'foreign') photo.ownerId = f.strangerId;
      if (condition === 'expired') photo.expiresAt = '2000-01-01T00:00:00.000Z';
      if (condition === 'deleted')
        photo.deletionStartedAt = new Date().toISOString();
      if (condition === 'archived-event') f.event.archived = true;
      if (condition === 'expired-event')
        f.event.expiresAt = '2000-01-01T00:00:00.000Z';
      if (condition === 'foreign-event') f.event.ownerId = f.strangerId;
      const choices = (await f.read(`${f.root}/photos`).expect(200)).body;
      expect(choices.photos.map((row: { id: string }) => row.id)).not.toContain(
        photo.id,
      );
      await f.publish().expect(409);
      await f.save().expect(404);
    },
  );
  it('retains unavailable draft selections for repair but hides removed public photos and blocks republishing', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    f.records.delete(f.photos[0]!.id);
    const state = portfolioSnapshot.parse(
      (await f.read(f.root).expect(200)).body,
    );
    expect(state.unavailableIds).toEqual([f.photos[0]!.id]);
    await f
      .save({ version: 1, fields: { ...f.fields, tagline: 'Private edit' } })
      .expect(200);
    await f.publish(2).expect(409);
    expect((await f.publicRead().expect(200)).body.photos).toHaveLength(1);
    await f.media().expect(404);
    await f.save({ version: 2, action: 'withdraw' }).expect(200);
  });
  it('returns complete choice totals with deterministic pages and bounded search', async () => {
    const f = await fixture(),
      seed = f.photos[0]!;
    for (let i = 0; i < 42; i++) {
      const photo = { ...seed, id: randomUUID(), filename: `Extra ${i}.jpg` };
      f.records.set(photo.id, photo);
    }
    const first = (await f.read(`${f.root}/photos`).expect(200)).body;
    const second = (await f.read(`${f.root}/photos?offset=40`).expect(200))
      .body;
    expect(first.total).toBe(45);
    expect(first.photos).toHaveLength(40);
    expect(second.photos).toHaveLength(5);
    expect(
      new Set([...first.photos, ...second.photos].map((photo) => photo.id))
        .size,
    ).toBe(45);
    expect(
      (await f.read(`${f.root}/photos?search=Extra%2041`).expect(200)).body
        .total,
    ).toBe(1);
    await f.read(`${f.root}/photos?offset=-1`).expect(400);
    await f.read(`${f.root}/photos?unknown=1`).expect(400);
  });
  it('delivers only selected processed images anonymously and does not expose private attachment filenames', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    const response = await f.media().expect(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body).toEqual(f.jpeg);
    await request(f.app)
      .head(`${f.publicUrl}/photos/${f.photos[0]!.id}`)
      .expect(200);
    await f.media(f.photos[2]!.id).expect(404);
    await f
      .publicRead(`${f.publicUrl}/photos/${f.photos[0]!.id}?download=1`)
      .expect(404);
    await f.publicRead(`/api/public/events/${f.event.id}`).expect(404);
  });
  it('rechecks withdrawal after asynchronous file retrieval and never sends the bytes', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    f.store.file = async () => {
      const current = f.stored().studioPortfolio!;
      current.published = null;
      current.version++;
      return new Response(new Uint8Array(f.jpeg));
    };
    const response = await f.media().expect(404);
    expect(response.headers['content-type']).not.toContain('image/jpeg');
  });
  it('rechecks source ownership after asynchronous file retrieval', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    f.store.file = async () => {
      f.photos[0]!.ownerId = f.strangerId;
      return new Response(new Uint8Array(f.jpeg));
    };
    await f.media().expect(404);
  });
  it('rejects a source change during publication before storing the grant', async () => {
    const f = await fixture(),
      get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.photos[0]!.id && ++reads === 2) f.event.archived = true;
      return get(id);
    });
    await f.publish().expect(409);
    expect(f.records.has(f.id)).toBe(false);
  });
  it('fails closed on malformed stored metadata and forged record ownership', async () => {
    const f = await fixture();
    await f.publish().expect(200);
    const row = f.stored();
    row.studioPortfolio!.version = -1;
    await f.publicRead().expect(503);
    await f.read(f.root).expect(503);
    row.ownerId = f.strangerId;
    expect(portfolioRecordId(f.strangerId)).not.toBe(f.id);
    await f.publicRead().expect(404);
  });
  it('rejects an intervening stored revision without replacing its newer draft', async () => {
    const f = await fixture();
    await f.save().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.id && ++reads === 2) {
        f.stored().studioPortfolio!.version = 2;
        f.stored().studioPortfolio!.draft.tagline = 'Concurrent saved draft';
      }
      return get(id);
    });
    await f
      .save({ version: 1, fields: { ...f.fields, tagline: 'Outdated writer' } })
      .expect(409);
    expect(f.stored().studioPortfolio!.draft.tagline).toBe(
      'Concurrent saved draft',
    );
  });
  it('removes portfolios with account erasure and denies old anonymous media links', async () => {
    const f = await fixture();
    for (const photo of f.photos) photo.faceIds = [];
    await f.publish().expect(200);
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.id)).toBe(false);
    await f.publicRead().expect(404);
    await f.media().expect(404);
    await f.save().expect(401);
  });
});
