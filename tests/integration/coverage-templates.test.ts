import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { templateFixture as fixture } from '../fixtures/coverage-templates';
import { ApiError } from '../../apps/api/src/auth';
import {
  TEMPLATE_ACTOR,
  templateFromCoverage,
  applyCoverageTemplate,
} from '../../packages/shared/src/coverage-templates';

describe('private reusable coverage templates', () => {
  it('saves ordered definitions privately and supports revision-safe editing and removal', async () => {
    const f = fixture();
    const first = (await f.saveTemplate().expect(200)).body.template;
    expect(first.fields).toEqual(f.templateFields);
    expect(first.version).toBe(1);
    expect((await f.read(f.templateRoot).expect(200)).body.templates).toEqual([
      first,
    ]);
    expect(
      (await f.read(`${f.templateRoot}/${f.templateId}`).expect(200)).body
        .template,
    ).toEqual(first);
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body),
    ).not.toContain('Portrait essentials');
    const next = (
      await f
        .saveTemplate(
          { fields: { ...f.templateFields, title: 'Reviewed list' } },
          first,
        )
        .expect(200)
    ).body.template;
    expect(next.generation).toBe(first.generation);
    expect(next.createdAt).toBe(first.createdAt);
    await f.removeTemplate(first).expect(409);
    await f.removeTemplate(next).expect(204);
    await f.removeTemplate(next).expect(204);
    expect((await f.read(f.templateRoot).expect(200)).body.templates).toEqual(
      [],
    );
  });
  it('denies missing sessions, foreign access, actor mismatch and untrusted origins', async () => {
    const f = fixture(),
      current = (await f.saveTemplate().expect(200)).body.template;
    await request(f.app).get(f.templateRoot).expect(401);
    await f.read(`${f.templateRoot}/${f.templateId}`, f.strangerId).expect(404);
    await f.saveTemplate({}, current, f.templateId, f.strangerId).expect(404);
    await f.removeTemplate(current, f.templateId, f.strangerId).expect(404);
    await f.put(`${f.templateRoot}/${f.templateId}`, {}).expect(403);
    await f
      .saveTemplate({}, current)
      .set(TEMPLATE_ACTOR, f.strangerId)
      .expect(403);
    await f
      .saveTemplate({}, current)
      .set('Origin', 'https://outside.test')
      .expect(403);
    expect(
      (await f.read(f.templateRoot, f.strangerId).expect(200)).body.templates,
    ).toEqual([]);
  });
  it.each([
    { version: '0' },
    { version: -1 },
    { version: Number.MAX_SAFE_INTEGER },
    { generation: randomUUID() },
    {
      fields: {
        title: '',
        categories: [{ label: 'Shots', target: 1, note: '' }],
      },
    },
    {
      fields: {
        title: 'Hidden\u0000title',
        categories: [{ label: 'Shots', target: 1, note: '' }],
      },
    },
    { fields: { title: 'Empty', categories: [] } },
    {
      fields: {
        title: 'Invalid',
        categories: [{ label: 'Shots', target: 0, note: '' }],
      },
    },
    {
      fields: {
        title: 'Invalid',
        categories: [{ label: 'Shots', target: 51, note: '' }],
      },
    },
    {
      fields: {
        title: 'Invalid',
        categories: [{ label: 'Shots', target: 1.5, note: '' }],
      },
    },
    {
      fields: {
        title: 'Invalid',
        categories: [
          { label: 'Shots', target: 1, note: '', photoIds: [randomUUID()] },
        ],
      },
    },
    {
      fields: {
        title: 'Duplicate',
        categories: [
          { label: 'Shots', target: 1, note: '' },
          { label: ' shots ', target: 2, note: '' },
        ],
      },
    },
    {
      fields: {
        title: 'Too many',
        categories: Array.from({ length: 21 }, (_, i) => ({
          label: `Shots ${i}`,
          target: 1,
          note: '',
        })),
      },
    },
    {
      fields: {
        title: 'Byte budget',
        categories: Array.from({ length: 20 }, (_, i) => ({
          label: `${i}${'界'.repeat(70)}`,
          target: 1,
          note: '界'.repeat(200),
        })),
      },
    },
  ])(
    'rejects invalid input and photo identity injection: %j',
    async (changes) => {
      const f = fixture();
      await f.saveTemplate(changes).expect(400);
      expect(f.records.has(f.templateId)).toBe(false);
    },
  );
  it('copies definitions without event/photo identity and applies new unassigned category IDs', async () => {
    const f = fixture(),
      photoId = f.photos[0]!.id;
    const source = [
      {
        id: randomUUID(),
        label: 'Family portraits',
        target: 3,
        note: 'Include both generations',
        photoIds: [photoId],
      },
    ];
    const fields = templateFromCoverage('Saved draft', source);
    const value = (await f.saveTemplate({ fields }).expect(200)).body.template;
    expect(JSON.stringify(value)).not.toContain(photoId);
    const appended = applyCoverageTemplate(
      [
        {
          id: randomUUID(),
          label: 'Venue',
          target: 1,
          note: '',
          photoIds: [photoId],
        },
      ],
      value.fields,
      'append',
      randomUUID,
    );
    expect(appended[0]!.photoIds).toEqual([photoId]);
    expect(appended[1]!.photoIds).toEqual([]);
    expect(appended[1]!.id).not.toBe(source[0]!.id);
    expect(() =>
      applyCoverageTemplate(source, value.fields, 'append', randomUUID),
    ).toThrow();
    const replaced = applyCoverageTemplate(
      source,
      value.fields,
      'replace',
      randomUUID,
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.photoIds).toEqual([]);
    expect(source[0]!.photoIds).toEqual([photoId]);
    expect(
      applyCoverageTemplate([], value.fields, 'replace', randomUUID)[0]!.id,
    ).not.toBe(replaced[0]!.id);
  });
  it('rejects duplicate normalized template names and allows renaming the same record', async () => {
    const f = fixture(),
      current = (await f.saveTemplate().expect(200)).body.template;
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: ' portrait ESSENTIALS ' } },
        null,
        randomUUID(),
      )
      .expect(409);
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: ' portrait ESSENTIALS ' } },
        current,
      )
      .expect(200);
  });
  it('recovers a committed reply loss without an extra write', async () => {
    const f = fixture(),
      put = f.store.put;
    let lose = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      await put(row, create);
      if (row.id === f.templateId && lose) {
        lose = false;
        throw new ApiError(503, 'LOST_REPLY', 'Try again.');
      }
    });
    await f.saveTemplate().expect(503);
    expect((await f.saveTemplate().expect(200)).body.template.version).toBe(1);
    expect(f.store.put).toHaveBeenCalledTimes(1);
  });
  it('rejects stale operations against a deleted and recreated template UUID', async () => {
    const f = fixture(),
      first = (await f.saveTemplate().expect(200)).body.template;
    await f.removeTemplate(first).expect(204);
    const replacement = (await f.saveTemplate().expect(200)).body.template;
    expect(replacement.generation).not.toBe(first.generation);
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: 'Stale update' } },
        first,
      )
      .expect(409);
    await f.removeTemplate(first).expect(409);
    expect(f.records.get(f.templateId)!.coverageTemplate).toEqual(replacement);
  });
  it('preserves a concurrent write and detects changes during deletion', async () => {
    const f = fixture(),
      first = (await f.saveTemplate().expect(200)).body.template;
    const get = f.store.get;
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.templateId && ++reads === 2)
        f.records.get(id)!.coverageTemplate!.version = 2;
      return get(id);
    });
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: 'My update' } },
        first,
      )
      .expect(409);
    expect(f.records.get(f.templateId)!.coverageTemplate!.version).toBe(2);
    vi.restoreAllMocks();
    reads = 0;
    const current = f.records.get(f.templateId)!.coverageTemplate!;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.templateId && ++reads === 2)
        f.records.get(id)!.coverageTemplate!.version = 3;
      return get(id);
    });
    await f.removeTemplate(current).expect(409);
    expect(f.records.has(f.templateId)).toBe(true);
  });
  it('enforces creation limits while retaining read, edit and delete recovery', async () => {
    const f = fixture();
    await f.saveTemplate().expect(200);
    const seed = structuredClone(f.records.get(f.templateId)!);
    for (let i = 1; i < 30; i++) {
      const row = structuredClone(seed),
        id = randomUUID();
      row.id = row.coverageTemplate!.id = id;
      row.coverageTemplate!.generation = randomUUID();
      row.coverageTemplate!.fields.title = `Template ${i}`;
      f.records.set(id, row);
    }
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: 'Thirty-first' } },
        null,
        randomUUID(),
      )
      .expect(409);
    const edited = (
      await f
        .saveTemplate(
          { fields: { ...f.templateFields, title: 'Updated at cap' } },
          seed.coverageTemplate!,
        )
        .expect(200)
    ).body.template;
    expect(
      (await f.read(f.templateRoot).expect(200)).body.templates,
    ).toHaveLength(30);
    await f.removeTemplate(edited).expect(204);
    await f
      .saveTemplate(
        { fields: { ...f.templateFields, title: 'New after removal' } },
        null,
        randomUUID(),
      )
      .expect(200);
  });
  it('fails closed on corrupt, duplicate, foreign and excessive directory records', async () => {
    const f = fixture();
    await f.saveTemplate().expect(200);
    const seed = structuredClone(f.records.get(f.templateId)!);
    f.records.get(
      f.templateId,
    )!.coverageTemplate!.fields.categories[0]!.target = 0;
    await f.read(f.templateRoot).expect(503);
    f.records.set(f.templateId, seed);
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([seed, seed]);
    await f.read(f.templateRoot).expect(503);
    vi.spyOn(f.store, 'list').mockResolvedValueOnce(
      Array.from({ length: 101 }, () => seed),
    );
    await f.read(f.templateRoot).expect(503);
    vi.spyOn(f.store, 'list').mockResolvedValueOnce([
      { ...seed, ownerId: f.strangerId },
    ]);
    await f.read(f.templateRoot).expect(404);
  });
  it('does not misreport operational read failures as an empty successful library', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'list').mockRejectedValueOnce(
      new ApiError(503, 'OFFLINE', 'Unavailable.'),
    );
    await f.read(f.templateRoot).expect(503);
  });
  it('keeps templates independent from event deletion and removes them with account erasure', async () => {
    const f = fixture();
    await f.saveTemplate().expect(200);
    const eventId = randomUUID();
    f.records.set(eventId, {
      ...structuredClone(f.records.get(f.eventId)!),
      id: eventId,
    });
    await f.remove(`/api/events/${eventId}`, {}).expect(204);
    expect(f.records.has(f.templateId)).toBe(true);
    f.store.removeFile = async () => {};
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.templateId)).toBe(false);
    await f.saveTemplate().expect(401);
  });
});
