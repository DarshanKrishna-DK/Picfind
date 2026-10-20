import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { questionnaireFixture as fixture } from '../fixtures/questionnaires';
import {
  QUESTIONNAIRE_CONSENT,
  clientQuestionnaire,
  ownerQuestionnaires,
} from '../../packages/shared/src/studio-questionnaires';
import { markDeletedAccount } from '../../apps/api/src/locks';

describe('private photographer preparation questionnaires', () => {
  it.each(['client', 'photographer'] as const)(
    'cleans retained answers during %s account deletion',
    async (who) => {
      const f = fixture();
      await f.issue().expect(200);
      await f.write().expect(200);
      const actor = who === 'client' ? f.clientId : f.ownerId;
      vi.spyOn(f.provider, 'login').mockResolvedValue({
        secret: actor,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const deleted = vi.spyOn(f.provider, 'deleteUser');
      await f
        .remove(
          '/api/account',
          {
            emailCode: '123456',
            password: 'test-password',
            confirmation: 'DELETE',
          },
          actor,
        )
        .expect(204);
      expect(deleted).toHaveBeenCalledWith(actor);
      expect(f.records.has(f.responseId)).toBe(false);
      expect(f.records.has(f.formId)).toBe(who === 'client');
      if (who === 'client') {
        await f.put(`${f.root}/${f.formId}/revoke`, { version: 1 }).expect(200);
        await f.remove(`${f.root}/${f.formId}`, { version: 2 }).expect(204);
      }
    },
  );
  it('does not delete an account after cross-account response cleanup fails', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write().expect(200);
    const deleted = vi.spyOn(f.provider, 'deleteUser'),
      remove = f.store.remove.bind(f.store);
    vi.spyOn(f.store, 'remove').mockImplementation(async (id) => {
      if (id === f.responseId) throw new Error('Response removal unavailable');
      await remove(id);
    });
    const body = {
      emailCode: '123456',
      password: 'test-password',
      confirmation: 'DELETE',
    };
    await f.remove('/api/account', body).expect(500);
    expect(deleted).not.toHaveBeenCalled();
    expect(f.records.has(f.formId) && f.records.has(f.responseId)).toBe(true);
    vi.mocked(f.store.remove).mockImplementation(remove);
    await f.remove('/api/account', body).expect(204);
    expect(f.records.size).toBe(0);
  });
  it('enforces project capacity and recovers a slot after confirmed removal', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const original = f.records.get(f.formId)!;
    for (let index = 1; index < 20; index++) {
      const id = randomUUID(),
        row = structuredClone(original);
      row.id = id;
      row.studioQuestionnaire!.id = id;
      f.records.set(id, row);
    }
    const next = randomUUID();
    await f.put(`${f.root}/${next}`, f.fields).expect(409);
    await f.put(`${f.root}/${f.formId}/revoke`, { version: 1 }).expect(200);
    await f.remove(`${f.root}/${f.formId}`, { version: 2 }).expect(204);
    await f.put(`${f.root}/${next}`, f.fields).expect(200);
  });
  it('refuses a late project archive before writing an answer', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const get = f.store.get.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.projectId && ++reads === 3) f.archive();
      return get(id);
    });
    await f.write().expect(409);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('does not expose a client response after the form recipient changes during a read', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write().expect(200);
    const get = f.store.get.bind(f.store);
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const row = await get(id);
      if (id === f.responseId)
        f.records.get(f.formId)!.studioQuestionnaire!.recipientId =
          f.strangerId;
      return row;
    });
    await f.read(f.clientPath, f.clientId).expect(404);
  });
  it('fails closed on corrupt response references but cleanup still removes damaged nonidentity content', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write().expect(200);
    const response = f.records.get(f.responseId)!.questionnaireResponse!;
    response.answers = [{ questionId: randomUUID(), text: 'Corrupt content' }];
    await f.read(f.clientPath, f.clientId).expect(503);
    await f.read().expect(503);
    const form = f.records.get(f.formId)!.studioQuestionnaire!;
    form.revokedAt = form.updatedAt = new Date().toISOString();
    await f.remove(`${f.root}/${f.formId}`, { version: 1 }).expect(204);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('issues immutable questions and keeps client drafts private until explicit submission', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const draft = await f.write().expect(200);
    expect(clientQuestionnaire.safeParse(draft.body).success).toBe(true);
    expect(draft.body.response).toMatchObject({ state: 'draft', version: 1 });
    const privateView = await f.read().expect(200);
    expect(privateView.body.questionnaires[0].response).toBeNull();
    const answers = f.fields.questions.map((question) => ({
      questionId: question.id,
      text: '<script>literal preferences</script>',
    }));
    const submitted = await f
      .write({
        generation: draft.body.response.generation,
        version: 1,
        action: 'submit',
        consent: QUESTIONNAIRE_CONSENT,
        answers,
      })
      .expect(200);
    expect(submitted.body.response.state).toBe('submitted');
    const owner = await f.read().expect(200);
    expect(ownerQuestionnaires.safeParse(owner.body).success).toBe(true);
    expect(owner.body.questionnaires[0].response.answers).toEqual(answers);
    expect(JSON.stringify(submitted.body)).not.toMatch(
      /recipientEmail|photographerId|projectName|commandDigest/,
    );
    expect(JSON.stringify(owner.body)).not.toContain('commandDigest');
    for (const actor of [f.ownerId, f.clientId])
      expect(
        JSON.stringify((await f.read('/api/library', actor).expect(200)).body),
      ).not.toMatch(/preparation|preferences|questionnaire/);
  });
  it('requires actual owner or assigned client, trusted origins and matching expected actor', async () => {
    const f = fixture();
    await request(f.app).get(f.root).expect(401);
    await f.issue().set('Origin', 'https://outside.test').expect(403);
    await f
      .issue()
      .set('X-PicFind-Questionnaire-Actor', f.strangerId)
      .expect(403);
    await f.issue().expect(200);
    for (const actor of [f.clientId, f.strangerId])
      await f.read(f.root, actor).expect(404);
    for (const actor of [f.ownerId, f.strangerId])
      await f.read(f.clientPath, actor).expect(404);
    await f
      .read(f.clientPath, f.clientId)
      .set('X-PicFind-Questionnaire-Actor', f.ownerId)
      .expect(403);
    await f.put(`${f.clientPath}/response`, {}, f.strangerId).expect(400);
    await f
      .remove(`${f.root}/${f.formId}`, { version: 1 }, f.strangerId)
      .expect(404);
  });
  it('requires a verified different account and does not resolve recipients for unauthorized projects', async () => {
    const f = fixture(),
      resolve = vi.spyOn(f.provider, 'resolveEventMember');
    await f.put(`${f.root}/${f.formId}`, f.fields, f.strangerId).expect(404);
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockResolvedValueOnce(null);
    await f.issue().expect(400);
    resolve.mockResolvedValueOnce({
      ...f.user(f.clientId),
      emailVerified: false,
    });
    await f.issue().expect(400);
    resolve.mockResolvedValueOnce({
      ...f.user(f.ownerId),
      email: f.fields.email,
    });
    await f.issue().expect(400);
    resolve.mockResolvedValueOnce({
      ...f.user(f.clientId),
      email: 'different@example.test',
    });
    await f.issue().expect(400);
    expect(f.records.has(f.formId)).toBe(false);
  });
  it('acknowledges exact creation and response retries after lost replies without overwriting edits', async () => {
    const f = fixture(),
      put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Reply lost');
    });
    await f.issue().expect(500);
    await f.issue().expect(200);
    await f
      .put(`${f.root}/${f.formId}`, { ...f.fields, title: 'Changed' })
      .expect(409);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async (row, create) => {
      await put(row, create);
      throw new Error('Reply lost');
    });
    await f.write().expect(500);
    const retried = await f.write().expect(200);
    expect(retried.body.response.version).toBe(1);
    f.records.get(f.formId)!.studioQuestionnaire!.revokedAt =
      new Date().toISOString();
    f.records.get(f.formId)!.studioQuestionnaire!.updatedAt =
      new Date().toISOString();
    await f.write().expect(200);
    await f
      .write({
        answers: f.fields.questions.map((q) => ({
          questionId: q.id,
          text: 'Changed',
        })),
      })
      .expect(409);
  });
  it('enforces answer identity, byte limits and final required answers and acknowledgment', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write({ answers: [] }).expect(400);
    await f
      .write({ answers: [{ questionId: randomUUID(), text: 'x' }] })
      .expect(400);
    await f
      .write({ action: 'submit', consent: QUESTIONNAIRE_CONSENT })
      .expect(400);
    await f.write({ action: 'submit' }).expect(400);
    await f.write({ consent: QUESTIONNAIRE_CONSENT }).expect(400);
    await f.write({ generation: randomUUID() }).expect(400);
    await f
      .write({
        answers: f.fields.questions.map((q) => ({
          questionId: q.id,
          text: 'x'.repeat(1001),
        })),
      })
      .expect(400);
    expect(f.records.has(f.responseId)).toBe(false);
  });
  it('preserves newer answers against stale saves and withdrawal, including response recreation', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const first = (await f.write().expect(200)).body.response;
    const next = (
      await f.write({ version: 1, generation: first.generation }).expect(200)
    ).body.response;
    await f
      .remove(
        `${f.clientPath}/response`,
        { version: 1, generation: first.generation },
        f.clientId,
      )
      .expect(409);
    await f
      .remove(
        `${f.clientPath}/response`,
        { version: 2, generation: next.generation },
        f.clientId,
      )
      .expect(204);
    const replacement = (await f.write().expect(200)).body.response;
    expect(replacement.generation).not.toBe(first.generation);
    await f
      .remove(
        `${f.clientPath}/response`,
        { version: 1, generation: first.generation },
        f.clientId,
      )
      .expect(409);
    await f.write({ version: 1, generation: first.generation }).expect(409);
    expect(f.records.get(f.responseId)?.questionnaireResponse?.generation).toBe(
      replacement.generation,
    );
  });
  it('makes submission immutable and allows withdrawal after revocation', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const input = {
      action: 'submit',
      consent: QUESTIONNAIRE_CONSENT,
      answers: f.fields.questions.map((q) => ({
        questionId: q.id,
        text: 'Portraits',
      })),
    };
    const response = (await f.write(input).expect(200)).body.response;
    await f
      .write({ ...input, version: 1, generation: response.generation })
      .expect(409);
    await f.put(`${f.root}/${f.formId}/revoke`, { version: 1 }).expect(200);
    await f.write(input).expect(200);
    const closed = await f.read(f.clientPath, f.clientId).expect(200);
    expect(closed.body.accepting).toBe(false);
    await f
      .remove(
        `${f.clientPath}/response`,
        { version: 1, generation: response.generation },
        f.clientId,
      )
      .expect(204);
    expect(
      (await f.read().expect(200)).body.questionnaires[0].response,
    ).toBeNull();
  });
  it.each(['expiry', 'archive', 'revoke'] as const)(
    'rejects new answers after %s and retains withdrawal',
    async (mode) => {
      const f = fixture();
      await f.issue().expect(200);
      const response = (await f.write().expect(200)).body.response;
      if (mode === 'archive') f.archive();
      if (mode === 'revoke')
        await f.put(`${f.root}/${f.formId}/revoke`, { version: 1 }).expect(200);
      if (mode === 'expiry') {
        const row = f.records.get(f.formId)!;
        row.createdAt = row.studioQuestionnaire!.createdAt = new Date(
          Date.now() - 100_000,
        ).toISOString();
        row.studioQuestionnaire!.expiresAt = new Date(
          Date.now() - 1000,
        ).toISOString();
      }
      await f
        .write({ version: 1, generation: response.generation })
        .expect(409);
      expect(
        (await f.read(f.clientPath, f.clientId).expect(200)).body.accepting,
      ).toBe(false);
      await f
        .remove(
          `${f.clientPath}/response`,
          { version: 1, generation: response.generation },
          f.clientId,
        )
        .expect(204);
    },
  );
  it('closes removal durably and retries failed cross-account cleanup', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write().expect(200);
    await f.remove(`${f.root}/${f.formId}`, { version: 1 }).expect(409);
    await f.put(`${f.root}/${f.formId}/revoke`, { version: 1 }).expect(200);
    vi.spyOn(f.store, 'remove').mockRejectedValueOnce(
      new Error('Storage offline'),
    );
    await f.remove(`${f.root}/${f.formId}`, { version: 2 }).expect(500);
    expect(f.records.get(f.formId)?.questionnaireRemovalStartedAt).toBeTruthy();
    await f.read(f.clientPath, f.clientId).expect(404);
    expect(f.records.has(f.responseId)).toBe(true);
    await f.remove(`${f.root}/${f.formId}`, { version: 2 }).expect(204);
    await f.remove(`${f.root}/${f.formId}`, { version: 2 }).expect(204);
    expect(f.records.has(f.formId) || f.records.has(f.responseId)).toBe(false);
  });
  it('removes exactly the linked response during archived project deletion', async () => {
    const f = fixture();
    await f.issue().expect(200);
    await f.write().expect(200);
    const unrelated = randomUUID();
    f.records.set(unrelated, {
      id: unrelated,
      ownerId: f.clientId,
      kind: 'job',
      purpose: 'studio-client',
      createdAt: new Date().toISOString(),
    });
    f.archive();
    await f
      .remove(`/api/studio/projects/${f.projectId}`, { version: 2 })
      .expect(204);
    expect([...f.records.keys()]).toEqual([unrelated]);
  });
  it.each(['before', 'after'] as const)(
    'retries client withdrawal when deletion fails %s committing',
    async (position) => {
      const f = fixture();
      await f.issue().expect(200);
      const response = (await f.write().expect(200)).body.response;
      const remove = f.store.remove.bind(f.store);
      vi.spyOn(f.store, 'remove').mockImplementationOnce(async (id) => {
        if (position === 'after') await remove(id);
        throw new Error('Delete unavailable');
      });
      const body = {
        version: response.version,
        generation: response.generation,
      };
      await f.remove(`${f.clientPath}/response`, body, f.clientId).expect(500);
      await f.remove(`${f.clientPath}/response`, body, f.clientId).expect(204);
      expect(f.records.has(f.responseId)).toBe(false);
    },
  );
  it('keeps answer withdrawal possible after a missing form and a deleted photographer', async () => {
    const f = fixture();
    await f.issue().expect(200);
    const response = (await f.write().expect(200)).body.response;
    f.records.delete(f.formId);
    markDeletedAccount(f.ownerId);
    await f
      .remove(
        `${f.clientPath}/response`,
        { version: response.version, generation: response.generation },
        f.clientId,
      )
      .expect(204);
  });
  it('rejects deleted participants before creating forms or answers', async () => {
    const f = fixture();
    markDeletedAccount(f.clientId);
    await f.issue().expect(401);
    expect(f.records.has(f.formId)).toBe(false);
    const g = fixture();
    await g.issue().expect(200);
    markDeletedAccount(g.ownerId);
    await g.write().expect(401);
    expect(g.records.has(g.responseId)).toBe(false);
  });
});
