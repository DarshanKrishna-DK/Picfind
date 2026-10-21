import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { briefFixture } from '../fixtures/project-brief';
import { ApiError } from '../../apps/api/src/auth';
import {
  BRIEF_ACTOR,
  projectBrief,
  exportProjectBrief,
} from '../../packages/shared/src/project-brief';
describe('private project production brief', () => {
  it('projects all current work while omitting notes and unrelated private values by default', async () => {
    const f = briefFixture(),
      put = vi.spyOn(f.store, 'put'),
      file = vi.spyOn(f.store, 'file');
    const response = await f.read(f.briefRoot).expect(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const brief = projectBrief.parse(response.body);
    expect(brief.notes).toBe('omit');
    expect(brief.milestones).toHaveLength(1);
    expect(brief.appointments).toHaveLength(1);
    expect(brief.events).toEqual([
      { id: f.eventId, title: 'Portrait gallery' },
      { id: f.foreignEventId, title: null },
    ]);
    const serialized = JSON.stringify(brief);
    for (const secret of [
      'Private project',
      'Private milestone',
      'Private appointment',
      'Confidential foreign',
      'secret-passcode-hash',
      'Private event description',
      'CommandDigest',
      'actorId',
      'email',
    ])
      expect(serialized).not.toContain(secret);
    expect(put).not.toHaveBeenCalled();
    expect(file).not.toHaveBeenCalled();
  });
  it('includes only explicitly selected notes and validates disclosure consistency', async () => {
    const f = briefFixture(),
      r = await f.brief('include').expect(200);
    expect(r.body.project.summary).toBe('Private project instructions');
    expect(r.body.milestones[0].note).toBe('Private milestone note');
    expect(r.body.appointments[0].note).toBe('Private appointment note');
    expect(projectBrief.safeParse({ ...r.body, notes: 'omit' }).success).toBe(
      false,
    );
    delete r.body.project.summary;
    expect(projectBrief.safeParse(r.body).success).toBe(false);
  });
  it('enforces session, owner, request identity and strict query boundaries', async () => {
    const f = briefFixture();
    await request(f.app).get(f.briefRoot).expect(401);
    await f.brief('omit', f.strangerId).expect(404);
    await f.read(f.briefRoot).set(BRIEF_ACTOR, f.strangerId).expect(403);
    for (const suffix of [
      '?notes=true',
      '?notes=include&notes=omit',
      '?token=private',
    ])
      await f.read(f.briefRoot + suffix).expect(400);
    await f.read('/api/studio/projects/not-a-uuid/brief').expect(404);
  });
  it('rejects pending project removal and invalid project metadata', async () => {
    const f = briefFixture(),
      row = f.records.get(f.projectId)!;
    row.projectCommandDigest = 'bad';
    await f.brief().expect(503);
    row.projectCommandDigest = 'a'.repeat(64);
    f.archive();
    row.projectRemovalStartedAt = new Date().toISOString();
    await f.brief().expect(409);
  });
  it('keeps unavailable event labels without exposing transferred, deleted or deleting sources', async () => {
    for (const mode of ['transfer', 'delete', 'deleting']) {
      const f = briefFixture(),
        row = f.records.get(f.eventId)!;
      if (mode === 'transfer') row.ownerId = f.strangerId;
      if (mode === 'delete') f.records.delete(f.eventId);
      if (mode === 'deleting') row.deletionStartedAt = new Date().toISOString();
      const r = await f.brief().expect(200);
      expect(r.body.events[0]).toEqual({ id: f.eventId, title: null });
    }
  });
  it('fails on corrupt work records instead of silently omitting a possible association', async () => {
    const f = briefFixture();
    f.records.get(f.milestoneId)!.studioMilestone!.projectId = 'broken';
    await f.brief().expect(503);
  });
  it('fails on deleted or changed selected work between list and fresh read', async () => {
    for (const mode of ['delete', 'change']) {
      const f = briefFixture(),
        list = f.store.list.bind(f.store);
      vi.spyOn(f.store, 'list').mockImplementation(async (...args) => {
        const rows = await list(...args);
        if (mode === 'delete') f.records.delete(f.milestoneId);
        else
          f.records.get(f.milestoneId)!.studioMilestone!.title =
            'Changed after listing';
        return rows;
      });
      await f.brief().expect(409);
    }
  });
  it('rechecks project and readable event authorization after assembling the sections', async () => {
    for (const idKind of ['project', 'event']) {
      const f = briefFixture(),
        get = f.store.get.bind(f.store),
        target = idKind === 'project' ? f.projectId : f.eventId;
      let reads = 0;
      vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
        if (id === target && ++reads === 2)
          f.records.get(id)!.ownerId = f.strangerId;
        return get(id);
      });
      await f.brief('include').expect(409);
    }
  });
  it('treats response object key ordering as equivalent storage contents', async () => {
    const f = briefFixture(),
      get = f.store.get.bind(f.store);
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const value = await get(id);
      return Object.fromEntries(
        Object.entries(value).reverse(),
      ) as typeof value;
    });
    await f.brief().expect(200);
  });
  it('propagates list and selected-record operational failures', async () => {
    const f = briefFixture();
    vi.spyOn(f.store, 'list').mockRejectedValueOnce(
      new ApiError(503, 'SOURCE_FAILED', 'Source failure'),
    );
    await f.brief().expect(503);
    const get = f.store.get.bind(f.store);
    vi.spyOn(f.store, 'get').mockImplementation((id) =>
      id === f.milestoneId
        ? Promise.reject(new ApiError(503, 'SOURCE_FAILED', 'Source failure'))
        : get(id),
    );
    await f.brief().expect(503);
  });
  it('rejects duplicate candidates and oversized scans before incomplete output', async () => {
    const f = briefFixture(),
      list = f.store.list.bind(f.store);
    vi.spyOn(f.store, 'list').mockImplementationOnce(async (...args) => {
      const rows = await list(...args);
      return [...rows, f.records.get(f.milestoneId)!];
    });
    await f.brief().expect(503);
    vi.mocked(f.store.list).mockResolvedValueOnce(
      Array.from({ length: 2001 }, () => f.records.get(f.milestoneId)!),
    );
    await f.brief().expect(503);
  });
  it('includes complete bounded sections and rejects an extra milestone', async () => {
    const f = briefFixture(),
      original = f.records.get(f.milestoneId)!;
    for (let i = 1; i < 30; i++) {
      const id = randomUUID();
      f.records.set(id, {
        ...structuredClone(original),
        id,
        studioMilestone: {
          ...original.studioMilestone!,
          id,
          title: `Milestone ${i}`,
        },
      });
    }
    const r = await f.brief().expect(200);
    expect(r.body.milestones).toHaveLength(30);
    const id = randomUUID();
    f.records.set(id, {
      ...structuredClone(original),
      id,
      studioMilestone: { ...original.studioMilestone!, id },
    });
    await f.brief().expect(503);
  });
  it('excludes other projects and foreign records even if a store list returns them', async () => {
    const f = briefFixture(),
      list = f.store.list.bind(f.store),
      original = f.records.get(f.milestoneId)!;
    const id = randomUUID();
    f.records.set(id, {
      ...structuredClone(original),
      id,
      studioMilestone: {
        ...original.studioMilestone!,
        id,
        projectId: randomUUID(),
      },
    });
    vi.spyOn(f.store, 'list').mockImplementation(async (...args) => [
      ...(await list(...args)),
      { ...original, id: randomUUID(), ownerId: f.strangerId },
    ]);
    const r = await f.brief().expect(200);
    expect(r.body.milestones).toHaveLength(1);
  });
  it('exports parseable versioned JSON and plain text without HTML execution or implicit disclosure', async () => {
    const f = briefFixture();
    f.records.get(f.milestoneId)!.studioMilestone!.title =
      '<script>alert("not code")</script>';
    const r = await f.brief().expect(200);
    const json = exportProjectBrief(r.body, 'json'),
      text = exportProjectBrief(r.body, 'text');
    expect(JSON.parse(json.content)).toMatchObject({
      format: 'picfind-project-brief',
      formatVersion: 1,
      notes: 'omit',
    });
    expect(text.type).toBe('text/plain;charset=utf-8');
    expect(text.content).toContain('Private notes: omitted');
    expect(text.content).toContain('<script>');
    expect(text.content).not.toContain('Private milestone note');
    expect(json.filename).toBe(`picfind-project-${f.projectId}-brief.json`);
    expect(() =>
      exportProjectBrief(
        {
          ...r.body,
          appointments: [r.body.appointments[0], r.body.appointments[0]],
        },
        'text',
      ),
    ).toThrow();
  });
  it('rejects deleted accounts before reading project records', async () => {
    const f = briefFixture();
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    await f.brief().expect(401);
  });
});
