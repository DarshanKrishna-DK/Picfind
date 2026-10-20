import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { proposalFixture as fixture } from '../fixtures/studio-proposals';
import {
  clientProposal,
  ownerProposals,
  PROPOSAL_ACTOR,
  proposalResponseView,
} from '../../packages/shared/src/studio-proposals';
import { questionnaireResponseId } from '../../apps/api/src/questionnaire-cleanup';

describe('immutable package proposals and client preferences', () => {
  it('issues a scoped immutable package snapshot and records a client preference without changing project stage', async () => {
    const f = await fixture();
    const result = await f.issue().expect(200);
    expect(result.body.proposal.options[0]).toMatchObject({
      id: f.serviceId,
      version: 1,
      amountMinor: 250000,
    });
    await f
      .save({ amountMinor: 500000, title: 'Repriced catalog item' }, 1)
      .expect(200);
    const view = clientProposal.parse(
      (await f.read(f.clientPath, f.clientId).expect(200)).body,
    );
    expect(view.fields.options[0]?.amountMinor).toBe(250000);
    expect(JSON.stringify(view)).not.toContain('recipientEmail');
    expect(JSON.stringify(view)).not.toContain('commandDigest');
    await f.respond().expect(200);
    const owner = ownerProposals.parse(
      (await f.read(f.ownerPath).expect(200)).body,
    );
    expect(owner.proposals[0]?.response).toMatchObject({
      decision: 'choose',
      serviceId: f.serviceId,
      version: 1,
    });
    expect(f.records.get(f.responseId)?.ownerId).toBe(f.clientId);
    expect(f.records.get(f.projectId)?.studioProject?.stage).toBe('inquiry');
    expect(
      JSON.stringify(
        (await f.read('/api/library', f.clientId).expect(200)).body,
      ),
    ).not.toContain('Please discuss availability.');
  });
  it('denies copied links, wrong owners, account changes and outside origins', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await request(f.app).get(f.clientPath).expect(401);
    await f.read(f.clientPath, f.strangerId).expect(404);
    await f.respond({}, f.strangerId).expect(404);
    await f.read(f.ownerPath, f.clientId).expect(404);
    await f
      .read(f.clientPath, f.clientId)
      .set(PROPOSAL_ACTOR, f.ownerId)
      .expect(403);
    await f.withdraw({}, f.strangerId).expect(404);
    await request(f.app)
      .put(`${f.clientPath}/response`)
      .set('Cookie', `picfind_session=${f.clientId}`)
      .set('Origin', 'https://outside.test')
      .send({})
      .expect(403);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('keeps damaged response content private while letting the owner close and remove the proposal', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    f.records.get(f.responseId)!.proposalResponse!.note = 'x'.repeat(5000);
    await f.read(f.clientPath, f.clientId).expect(503);
    const owner = ownerProposals.parse(
      (await f.read(f.ownerPath).expect(200)).body,
    );
    expect(owner.proposals[0]).toMatchObject({
      response: null,
      responseUnavailable: true,
    });
    await f.withdraw().expect(204);
    await f.removeProposal().expect(204);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('uses one unavailable response for missing, foreign and removal-started projects', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const project = structuredClone(f.records.get(f.projectId)!);
    f.records.delete(f.projectId);
    const absent = await f.read(f.clientPath, f.clientId).expect(404);
    f.records.set(f.projectId, { ...project, ownerId: f.strangerId });
    const foreign = await f.read(f.clientPath, f.clientId).expect(404);
    const unavailable = {
      code: absent.body.error.code,
      message: absent.body.error.message,
    };
    expect(foreign.body.error).toMatchObject(unavailable);
    f.records.set(f.projectId, project);
    f.archive();
    f.records.get(f.projectId)!.projectRemovalStartedAt =
      new Date().toISOString();
    const removing = await f.read(f.clientPath, f.clientId).expect(404);
    expect(removing.body.error).toMatchObject(unavailable);
  });
  it('creates a server-generated response generation and never accepts self-proposals', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const response = proposalResponseView.parse(
      (await f.respond().expect(200)).body.response,
    );
    expect(response.generation).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      clientProposal.parse(
        (await f.read(f.clientPath, f.clientId).expect(200)).body,
      ).response?.generation,
    ).toBe(response.generation);
    vi.spyOn(f.provider, 'resolveEventMember').mockResolvedValue({
      ...f.user(f.ownerId),
      email: 'client@example.test',
    });
    await f.issue({}, randomUUID()).expect(400);
  });
  it('refuses a changed cleanup participant before deleting any account records', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    const list = f.store.list.bind(f.store);
    let discoveries = 0;
    vi.spyOn(f.store, 'list').mockImplementation(async (actor, kind) => {
      if (actor === f.ownerId && kind === 'job' && ++discoveries === 2)
        f.records.get(f.proposalId)!.studioProposal!.recipientId = f.strangerId;
      return list(actor, kind);
    });
    const remove = vi.spyOn(f.store, 'remove'),
      removeFile = vi.spyOn(f.store, 'removeFile');
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(409);
    expect(remove).not.toHaveBeenCalled();
    expect(removeFile).not.toHaveBeenCalled();
    expect(f.records.has(f.responseId) && f.records.has(f.projectId)).toBe(
      true,
    );
  });
  it('rejects changed recipients after individual removal preflight without touching either response', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    await f.withdraw().expect(204);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.proposalId && ++reads === 2)
        f.records.get(id)!.studioProposal!.recipientId = f.strangerId;
      return get(id);
    });
    const remove = vi.spyOn(f.store, 'remove');
    await f.removeProposal().expect(409);
    expect(remove).not.toHaveBeenCalled();
    expect(f.records.has(f.responseId)).toBe(true);
  });
  it('rejects a stored response from another proposal generation even when its retry digest matches', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    f.records.get(f.responseId)!.proposalResponse!.proposalGeneration =
      randomUUID();
    await f.respond().expect(503);
    await f.read(f.clientPath, f.clientId).expect(503);
    expect(f.records.get(f.responseId)!.proposalResponse!.version).toBe(1);
  });
  it('rejects stale project, client and service versions and unverified recipient resolution', async () => {
    const f = await fixture();
    await f.issue({ projectVersion: 2 }).expect(409);
    await f.issue({ clientVersion: 2 }).expect(409);
    await f.issue({ clientEmail: 'someone@example.test' }).expect(409);
    await f.issue({ services: [{ id: f.serviceId, version: 2 }] }).expect(409);
    vi.spyOn(f.provider, 'resolveEventMember').mockResolvedValue({
      ...f.user(f.clientId),
      emailVerified: false,
    });
    await f.issue().expect(400);
    expect(f.records.has(f.proposalId)).toBe(false);
  });
  it('rejects a reused catalog ID at the same version when the selected package snapshot changed', async () => {
    const f = await fixture();
    const selected = structuredClone(
      f.records.get(f.serviceId)!.studioService!,
    );
    await f.save({ archived: true }, 1).expect(200);
    await f.remove(`${f.root}/${f.serviceId}`, { version: 2 }).expect(204);
    await f.save({ amountMinor: 900000 }).expect(200);
    expect(f.records.get(f.serviceId)!.studioService!.version).toBe(1);
    await f
      .issue({
        services: [{ id: f.serviceId, version: 1, snapshot: selected }],
      })
      .expect(409);
    expect(f.records.has(f.proposalId)).toBe(false);
    const current = structuredClone(f.records.get(f.serviceId)!.studioService!);
    await f
      .issue({ services: [{ id: f.serviceId, version: 1, snapshot: current }] })
      .expect(200);
    expect(
      f.records.get(f.proposalId)!.studioProposal!.options[0]!.amountMinor,
    ).toBe(900000);
  });
  it('rejects archived services, mixed currencies and oversized combined package snapshots', async () => {
    const f = await fixture(),
      other = randomUUID();
    await f.save({ archived: true }, 1).expect(200);
    await f.issue({ services: [{ id: f.serviceId, version: 2 }] }).expect(409);
    await f.save({}, 2).expect(200);
    await f.save({ currency: 'USD' }, 0, other).expect(200);
    await f
      .issue({
        services: [
          { id: f.serviceId, version: 3 },
          { id: other, version: 1 },
        ],
      })
      .expect(400);
    await f.save({ description: 'अ'.repeat(1800) }, 3).expect(200);
    await f
      .save({ description: 'अ'.repeat(1800), currency: 'INR' }, 1, other)
      .expect(200);
    await f
      .issue({
        services: [
          { id: f.serviceId, version: 4 },
          { id: other, version: 2 },
        ],
      })
      .expect(400);
    expect(f.records.has(f.proposalId)).toBe(false);
  });
  it('recovers lost issue and preference replies without duplicating records or changing snapshots', async () => {
    const f = await fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Lost issue reply');
    });
    await f.issue().expect(500);
    await f.issue().expect(200);
    await f.issue({ title: 'Changed command' }).expect(409);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Lost response reply');
    });
    await f.respond().expect(500);
    await f.respond().expect(200);
    expect(f.records.get(f.responseId)?.proposalResponse?.version).toBe(1);
    expect(
      [...f.records.values()].filter(
        (row) => row.purpose === 'studio-proposal',
      ),
    ).toHaveLength(1);
    await f.respond({ note: 'Changed old revision' }).expect(409);
  });
  it('revises a preference into a decline with generation checks and preserves the previous response after stale writes', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const first = proposalResponseView.parse(
      (await f.respond().expect(200)).body.response,
    );
    await f
      .respond({
        decision: 'decline',
        serviceId: null,
        version: 1,
        generation: randomUUID(),
      })
      .expect(409);
    await f
      .respond({
        decision: 'decline',
        serviceId: null,
        version: 1,
        generation: first.generation,
      })
      .expect(200);
    await f.respond().expect(409);
    expect(f.records.get(f.responseId)?.proposalResponse).toMatchObject({
      decision: 'decline',
      serviceId: null,
      version: 2,
    });
  });
  it.each([
    { consent: false },
    { version: '0' },
    { generation: randomUUID() },
    { decision: 'choose', serviceId: null },
    { decision: 'decline', serviceId: randomUUID() },
    { note: '\u0001'.repeat(1000) },
    { ownerId: 'injected' },
  ])('rejects invalid preference input %j', async (changes) => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond(changes).expect(400);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('closes preferences on withdrawal or project archive and keeps existing receipts readable', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    await f.withdraw().expect(204);
    await f.withdraw().expect(204);
    await f.respond().expect(409);
    const closed = (await f.read(f.clientPath, f.clientId).expect(200)).body;
    expect(closed.accepting).toBe(false);
    expect(closed.response.version).toBe(1);
    const second = randomUUID();
    await f.issue({}, second).expect(200);
    f.archive();
    await f
      .read(`/api/proposals/${second}`, f.clientId)
      .expect(200)
      .expect((res) => expect(res.body.accepting).toBe(false));
    await f.issue({}, randomUUID()).expect(409);
  });
  it('rejects expired proposals and removes their recipient response with retryable cleanup', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    const row = f.records.get(f.proposalId)!,
      value = row.studioProposal!;
    const old = new Date(Date.now() - 2 * 86400000).toISOString();
    row.createdAt = value.createdAt = old;
    value.expiresAt = new Date(Date.now() - 86400000).toISOString();
    await f.respond().expect(409);
    const remove = f.store.remove.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'remove').mockImplementation(async (id) => {
      if (id === f.proposalId && !failed) {
        failed = true;
        throw new Error('Synthetic final removal failure');
      }
      await remove(id);
    });
    await f.removeProposal({ version: 1 }).expect(500);
    expect(f.records.has(f.responseId)).toBe(false);
    expect(f.records.get(f.proposalId)?.proposalRemovalStartedAt).toBeDefined();
    await f.read(f.clientPath, f.clientId).expect(404);
    await f.removeProposal({ version: 1 }).expect(204);
    expect(f.records.has(f.proposalId)).toBe(false);
  });
  it('rejects an old proposal generation when a deliberately reused ID is issued again', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const old = f.records.get(f.proposalId)!.studioProposal!.generation;
    await f.withdraw().expect(204);
    await f.removeProposal().expect(204);
    await f.issue().expect(200);
    expect(f.records.get(f.proposalId)!.studioProposal!.generation).not.toBe(
      old,
    );
    await f.respond({ proposalGeneration: old }).expect(409);
    await f.respond().expect(200);
  });
  it('refuses issuance if client contact changes during account resolution', async () => {
    const f = await fixture();
    vi.spyOn(f.provider, 'resolveEventMember').mockImplementation(async () => {
      f.records.get(f.clientRecordId)!.studioClient!.email =
        'changed@example.test';
      return f.user(f.clientId);
    });
    await f.issue().expect(409);
    expect(f.records.has(f.proposalId)).toBe(false);
  });
  it('refuses a new or replayed response when withdrawal occurs during its final access read', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    const spy = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.proposalId && ++reads === 3) {
        const value = f.records.get(id)!.studioProposal!;
        value.withdrawnAt = value.updatedAt = new Date().toISOString();
        value.version++;
      }
      return get(id);
    });
    await f.respond().expect(409);
    expect(f.records.has(f.responseId)).toBe(false);
    spy.mockRestore();
    f.records.get(f.proposalId)!.studioProposal!.withdrawnAt = null;
    await f.respond().expect(200);
    reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.proposalId && ++reads === 3) {
        const value = f.records.get(id)!.studioProposal!;
        value.withdrawnAt = value.updatedAt = new Date().toISOString();
        value.version++;
      }
      return get(id);
    });
    await f.respond().expect(409);
  });
  it('recovers project capacity by removing a withdrawn proposal', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    const original = f.records.get(f.proposalId)!;
    for (let i = 1; i < 20; i++) {
      const row = structuredClone(original),
        id = randomUUID();
      row.id = row.studioProposal!.id = id;
      row.studioProposal!.generation = randomUUID();
      f.records.set(id, row);
    }
    await f.issue({}, randomUUID()).expect(409);
    await f.issue().expect(200);
    await f.withdraw().expect(204);
    await f.removeProposal().expect(204);
    await f.issue({}, randomUUID()).expect(200);
    expect((await f.read(f.ownerPath).expect(200)).body.proposals).toHaveLength(
      20,
    );
  });
  it('cleans proposal and questionnaire responses together on project removal', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    await f.issueQuestionnaire().expect(200);
    await f.write().expect(200);
    const questionnaireResponse = questionnaireResponseId(f.formId, f.clientId);
    expect(f.records.has(questionnaireResponse)).toBe(true);
    f.archive();
    const project = f.records.get(f.projectId)!.studioProject!;
    await f
      .remove(`/api/studio/projects/${f.projectId}`, {
        version: project.version,
      })
      .expect(204);
    for (const id of [
      f.projectId,
      f.proposalId,
      f.responseId,
      f.formId,
      questionnaireResponse,
    ])
      expect(f.records.has(id)).toBe(false);
  });
  it('removes recipient responses during photographer erasure and rejects old-session recreation', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    const proposalGeneration = f.records.get(f.proposalId)!.studioProposal!
      .generation;
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    expect(f.records.has(f.proposalId)).toBe(false);
    expect(f.records.has(f.responseId)).toBe(false);
    await f.respond({ proposalGeneration }).expect(404);
    await f.issue().expect(401);
  });
  it('erases a recipient-owned response and prevents an old session from recreating it', async () => {
    const f = await fixture();
    await f.issue().expect(200);
    await f.respond().expect(200);
    vi.spyOn(f.provider, 'login').mockResolvedValue({
      secret: f.clientId,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f
      .remove(
        '/api/account',
        {
          password: 'test-password',
          emailCode: '123456',
          confirmation: 'DELETE',
        },
        f.clientId,
      )
      .expect(204);
    expect(f.records.has(f.responseId)).toBe(false);
    expect(f.records.has(f.proposalId)).toBe(true);
    await f.respond().expect(401);
  });
});
