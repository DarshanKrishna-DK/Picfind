import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ApiError } from '../../apps/api/src/auth';
import { ENQUIRY_ACTOR } from '../../packages/shared/src/studio-enquiries';
import { handoffFixture as fixture } from '../fixtures/enquiry-handoff';

describe('recoverable private enquiry project handoff', () => {
  it('creates reviewed contact and inquiry project records, preserves the source, and returns completed retries without duplication', async () => {
    const f = await fixture();
    const response = (await f.start().expect(200)).body;
    expect(response.handoff.status).toBe('completed');
    expect(response.enquiry).toMatchObject({ stage: 'new', version: 3 });
    expect(f.records.get(f.command.client.id)!.studioClient).toMatchObject(
      f.command.client.fields,
    );
    expect(f.records.get(f.command.project.id)!.studioProject).toMatchObject({
      clientId: f.command.client.id,
      stage: 'inquiry',
      eventIds: [],
      version: 1,
    });
    expect(response.handoff).not.toHaveProperty('client');
    await f.start().expect(200);
    expect((await f.current()).enquiry.version).toBe(3);
    expect(
      [...f.records.values()].filter((row) => row.purpose === 'studio-client'),
    ).toHaveLength(1);
    await f.start({ operationId: randomUUID() }).expect(409);
    expect(
      JSON.stringify((await f.read('/api/library').expect(200)).body.jobs),
    ).not.toContain('Owner-reviewed');
  });
  it('reuses an explicitly reviewed existing client without modifying it', async () => {
    const f = await fixture();
    const client = (
      await f
        .put(`/api/studio/clients/${f.command.client.id}`, {
          ...f.command.client.fields,
          version: 0,
        })
        .expect(200)
    ).body.client;
    await f
      .start({ client: { mode: 'existing', snapshot: client } })
      .expect(200);
    expect(f.records.get(client.id)!.studioClient).toEqual(client);
    expect((await f.current()).handoff).toMatchObject({
      status: 'completed',
      newClient: false,
      clientId: client.id,
    });
  });
  it('denies foreign source access, spoofed actors, outside origins and foreign client snapshots', async () => {
    const f = await fixture();
    await request(f.app).get(f.root).expect(401);
    await f.read(f.root, f.strangerId).expect(404);
    await f.start({}, f.strangerId).expect(404);
    await f.read(f.root).set(ENQUIRY_ACTOR, f.strangerId).expect(403);
    await f.start().set('Origin', 'https://outside.test').expect(403);
    const foreign = (
      await f
        .put(
          `/api/studio/clients/${randomUUID()}`,
          { ...f.command.client.fields, version: 0 },
          f.strangerId,
        )
        .expect(200)
    ).body.client;
    await f
      .start({ client: { mode: 'existing', snapshot: foreign } })
      .expect(409);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
  });
  it('rejects stale source and client previews before writing the pending marker', async () => {
    const f = await fixture();
    const client = (
      await f
        .put(`/api/studio/clients/${f.command.client.id}`, {
          ...f.command.client.fields,
          version: 0,
        })
        .expect(200)
    ).body.client;
    await f
      .put(`/api/studio/clients/${client.id}`, {
        ...f.command.client.fields,
        phone: 'Changed contact',
        version: 1,
      })
      .expect(200);
    await f
      .start({ client: { mode: 'existing', snapshot: client } })
      .expect(409);
    await f.update().expect(200);
    await f.start().expect(409);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
  });
  it('enforces duplicate-email and destination identity checks before starting', async () => {
    const f = await fixture();
    await f
      .put(`/api/studio/clients/${randomUUID()}`, {
        ...f.command.client.fields,
        version: 0,
      })
      .expect(200);
    await f.start().expect(409);
    await f
      .start({ project: { ...f.command.project, id: f.projectId } })
      .expect(404);
    await f.start({ version: '1' }).expect(400);
    await f.start({ sourceToken: 'not-a-fingerprint' }).expect(400);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
  });
  it.each(['client', 'project', 'completion'] as const)(
    'recovers a failure before the %s write with explicit missing-record confirmation',
    async (step) => {
      const f = await fixture(),
        put = f.store.put.bind(f.store);
      let failed = false;
      vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
        if (
          !failed &&
          ((step === 'client' && row.id === f.command.client.id) ||
            (step === 'project' && row.id === f.command.project.id) ||
            (step === 'completion' &&
              row.enquiryHandoff?.status === 'completed'))
        ) {
          failed = true;
          throw new ApiError(
            503,
            'SYNTHETIC_FAILURE',
            'Synthetic interrupted write.',
          );
        }
        return put(row, create);
      });
      await f.start().expect(503);
      const pending = await f.current();
      expect(pending.handoff!.status).toBe('pending');
      await f.update({}, pending.enquiry.version).expect(409);
      await f
        .remove(`/api/studio/enquiries/${f.enquiryId}`, {
          version: pending.enquiry.version,
        })
        .expect(409);
      const createMissing = Object.values(pending.targets!)
        .filter((target) => target.mayCreate)
        .map((target) => target.id);
      if (createMissing.length)
        await f
          .put(f.root, {
            action: 'resume',
            operationId: pending.handoff!.operationId,
            recoveryToken: pending.recoveryToken,
            createMissing: [],
          })
          .expect(409);
      const resumed = await f.resume();
      expect(resumed.status).toBe(200);
      expect(resumed.body.handoff.status).toBe('completed');
      expect(f.records.get(f.command.client.id)!.studioClient!.version).toBe(1);
      expect(f.records.get(f.command.project.id)!.studioProject!.version).toBe(
        1,
      );
    },
  );
  it.each(['client', 'project', 'completion'] as const)(
    'recovers a lost acknowledgement after the %s write',
    async (step) => {
      const f = await fixture(),
        put = f.store.put.bind(f.store);
      let failed = false;
      vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
        await put(row, create);
        if (
          !failed &&
          ((step === 'client' && row.id === f.command.client.id) ||
            (step === 'project' && row.id === f.command.project.id) ||
            (step === 'completion' &&
              row.enquiryHandoff?.status === 'completed'))
        ) {
          failed = true;
          throw new ApiError(
            503,
            'SYNTHETIC_REPLY_LOSS',
            'Synthetic committed reply loss.',
          );
        }
      });
      await f.start().expect(503);
      if (step === 'completion') await f.start().expect(200);
      else expect((await f.resume()).status).toBe(200);
      expect((await f.current()).handoff!.status).toBe('completed');
      expect(
        [...f.records.values()].filter(
          (row) => row.purpose === 'studio-client',
        ),
      ).toHaveLength(1);
    },
  );
  it('preserves independently edited destinations, permits abandonment, and retains created work after source removal', async () => {
    const f = await fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      if (row.id === f.command.project.id)
        throw new ApiError(
          503,
          'SYNTHETIC_FAILURE',
          'Synthetic project failure.',
        );
      return put(row, create);
    });
    await f.start().expect(503);
    await f
      .put(`/api/studio/clients/${f.command.client.id}`, {
        ...f.command.client.fields,
        name: 'Independently edited',
        version: 1,
      })
      .expect(200);
    const pending = await f.current();
    expect(pending.targets!.client.status).toBe('changed');
    expect((await f.resume()).status).toBe(409);
    const abandoned = (
      await f
        .put(f.root, {
          action: 'abandon',
          operationId: pending.handoff!.operationId,
          recoveryToken: pending.recoveryToken,
        })
        .expect(200)
    ).body;
    expect(abandoned.handoff.status).toBe('abandoned');
    expect(f.records.get(f.command.client.id)!.studioClient!.name).toBe(
      'Independently edited',
    );
    await f
      .remove(`/api/studio/enquiries/${f.enquiryId}`, {
        version: abandoned.enquiry.version,
      })
      .expect(204);
    expect(f.records.has(f.command.client.id)).toBe(true);
    await f.start().expect(404);
  });
  it('requires a fresh recovery fingerprint and does not silently recreate a deleted pre-existing client', async () => {
    const f = await fixture();
    const client = (
      await f
        .put(`/api/studio/clients/${f.command.client.id}`, {
          ...f.command.client.fields,
          version: 0,
        })
        .expect(200)
    ).body.client;
    const put = f.store.put.bind(f.store);
    let fail = true;
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      if (row.id === f.command.project.id && fail) {
        fail = false;
        throw new ApiError(503, 'SYNTHETIC_FAILURE', 'Synthetic failure.');
      }
      return put(row, create);
    });
    await f
      .start({ client: { mode: 'existing', snapshot: client } })
      .expect(503);
    const before = await f.current();
    await f
      .remove(`/api/studio/clients/${client.id}`, { version: 1 })
      .expect(204);
    await f
      .put(f.root, {
        action: 'resume',
        operationId: before.handoff!.operationId,
        recoveryToken: before.recoveryToken,
        createMissing: [f.command.project.id],
      })
      .expect(409);
    const after = await f.current();
    expect(after.targets!.client).toMatchObject({
      status: 'missing',
      mayCreate: false,
    });
    expect((await f.resume()).status).toBe(409);
    expect(f.records.has(client.id)).toBe(false);
  });
  it('enforces client and project quotas before reserving the handoff', async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      f.records.set(id, {
        id,
        kind: 'job',
        ownerId: f.ownerId,
        purpose: 'studio-client',
        createdAt: now,
        studioClient: {
          id,
          name: `Client ${i}`,
          email: '',
          phone: '',
          company: '',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    await f.start().expect(409);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
    const client = [...f.records.values()].find(
      (row) => row.studioClient,
    )!.studioClient!;
    const seed = f.records.get(f.projectId)!;
    for (let i = 1; i < 200; i++) {
      const id = randomUUID(),
        row = structuredClone(seed);
      row.id = row.studioProject!.id = id;
      f.records.set(id, row);
    }
    await f
      .start({ client: { mode: 'existing', snapshot: client } })
      .expect(409);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
  });
  it('requires explicit current confirmation before recreating a removed newly-created client during recovery', async () => {
    const f = await fixture(),
      put = f.store.put.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      if (!failed && row.enquiryHandoff?.status === 'completed') {
        failed = true;
        throw new ApiError(
          503,
          'SYNTHETIC_FAILURE',
          'Synthetic completion failure.',
        );
      }
      return put(row, create);
    });
    await f.start().expect(503);
    await f
      .remove(`/api/studio/clients/${f.command.client.id}`, { version: 1 })
      .expect(204);
    const preview = await f.current();
    expect(preview.targets!.client).toMatchObject({
      status: 'missing',
      mayCreate: true,
    });
    await f
      .put(f.root, {
        action: 'resume',
        operationId: preview.handoff!.operationId,
        recoveryToken: preview.recoveryToken,
        createMissing: [],
      })
      .expect(409);
    expect(f.records.has(f.command.client.id)).toBe(false);
    expect((await f.resume()).status).toBe(200);
    expect(f.records.get(f.command.client.id)!.studioClient).toMatchObject(
      f.command.client.fields,
    );
  });
  it('rejects an oversized combined enquiry and recovery marker before creating destinations', async () => {
    const f = await fixture();
    const row = f.records.get(f.enquiryId)!;
    row.studioEnquiry!.message = '\u0000'.repeat(700);
    row.studioEnquiry!.note = '\u0000'.repeat(1000);
    const preview = await f.current();
    await f
      .start({
        version: preview.enquiry.version,
        sourceToken: preview.sourceToken,
        project: { ...f.command.project, summary: '\u0000'.repeat(500) },
      })
      .expect(400);
    expect(f.records.get(f.enquiryId)!.enquiryHandoff).toBeUndefined();
    expect(f.records.has(f.command.client.id)).toBe(false);
    expect(f.records.has(f.command.project.id)).toBe(false);
  });
  it('erases pending handoffs and any created private records with the account', async () => {
    const f = await fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementation(async (row, create) => {
      if (row.id === f.command.project.id)
        throw new ApiError(503, 'SYNTHETIC_FAILURE', 'Synthetic failure.');
      return put(row, create);
    });
    await f.start().expect(503);
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.enquiryId)).toBe(false);
    expect(f.records.has(f.command.client.id)).toBe(false);
    await f.start().expect(401);
  });
});
