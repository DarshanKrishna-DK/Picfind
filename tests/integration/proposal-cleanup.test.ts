import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { proposalFixture } from '../fixtures/studio-proposals';
import { removeProposalResponse } from '../../apps/api/src/proposal-cleanup';
import { withQuestionnaireCleanupLocks } from '../../apps/api/src/questionnaire-cleanup';
import { withAccountLock } from '../../apps/api/src/locks';

async function fixture() {
  const f = await proposalFixture();
  await f.issue().expect(200);
  await f.respond().expect(200);
  const proposal = structuredClone(f.records.get(f.proposalId)!);
  const cleanup = () =>
    withQuestionnaireCleanupLocks(
      f.store,
      f.ownerId,
      f.projectId,
      async (locked) => {
        await removeProposalResponse(f.store, proposal, locked);
        await f.store.remove(f.proposalId);
      },
    );
  return { ...f, proposal, cleanup };
}
describe('proposal participant cleanup boundaries', () => {
  it('waits for the recipient queue before removing their response and releases it afterward', async () => {
    const f = await fixture(),
      events: string[] = [];
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recipient = withAccountLock(f.clientId, async () => {
      entered();
      await gate;
      events.push('recipient-finished');
    });
    await ready;
    const cleanup = f.cleanup().then(() => {
      events.push('cleaned');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.records.has(f.responseId)).toBe(true);
    release();
    await Promise.all([recipient, cleanup]);
    expect(events).toEqual(['recipient-finished', 'cleaned']);
    expect(await withAccountLock(f.clientId, async () => 'released')).toBe(
      'released',
    );
  });
  it('rejects a new proposal participant introduced after lock discovery before invoking cleanup', async () => {
    const f = await fixture(),
      list = f.store.list.bind(f.store),
      operation = vi.fn();
    vi.spyOn(f.store, 'list')
      .mockImplementationOnce(list)
      .mockImplementationOnce(async (actor, kind) => {
        f.records.get(f.proposalId)!.studioProposal!.recipientId = randomUUID();
        return list(actor, kind);
      });
    await expect(
      withQuestionnaireCleanupLocks(f.store, f.ownerId, f.projectId, operation),
    ).rejects.toMatchObject({ status: 409 });
    expect(operation).not.toHaveBeenCalled();
    expect(f.records.has(f.responseId)).toBe(true);
  });
  it.each(['recipient', 'generation', 'project', 'owner'] as const)(
    'preserves a response when its %s changes before removal',
    async (field) => {
      const f = await fixture();
      await expect(
        withQuestionnaireCleanupLocks(
          f.store,
          f.ownerId,
          f.projectId,
          async (locked) => {
            await removeProposalResponse(
              f.store,
              f.proposal,
              locked,
              async () => {
                const row = f.records.get(f.responseId)!;
                if (field === 'recipient') row.ownerId = randomUUID();
                if (field === 'generation')
                  row.proposalResponse!.proposalGeneration = randomUUID();
                if (field === 'project')
                  row.proposalResponse!.projectId = randomUUID();
                if (field === 'owner')
                  row.proposalResponse!.photographerId = randomUUID();
              },
            );
          },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.records.has(f.responseId)).toBe(true);
      expect(f.records.has(f.proposalId)).toBe(true);
    },
  );
  it('cleans assigned children with damaged content while preserving unrelated recipient records', async () => {
    const f = await fixture(),
      other = randomUUID();
    f.records.get(f.responseId)!.proposalResponse!.note = 'x'.repeat(5000);
    f.records.get(f.proposalId)!.studioProposal!.title = '';
    f.records.set(other, {
      id: other,
      ownerId: f.clientId,
      kind: 'job',
      purpose: 'studio-client',
      createdAt: new Date().toISOString(),
    });
    await f.cleanup();
    expect(f.records.has(f.responseId) || f.records.has(f.proposalId)).toBe(
      false,
    );
    expect(f.records.has(other)).toBe(true);
  });
  it('does not erase a child after its parent disappears before the final authorization check', async () => {
    const f = await fixture(),
      get = f.store.get.bind(f.store);
    vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      if (id === f.proposalId) f.records.delete(id);
      return get(id);
    });
    await expect(f.cleanup()).rejects.toMatchObject({ status: 404 });
    expect(f.records.has(f.responseId)).toBe(true);
  });
  it('rejects missing participant locks and changed parent generations', async () => {
    const f = await fixture();
    await expect(
      removeProposalResponse(f.store, f.proposal, new Set([f.ownerId])),
    ).rejects.toMatchObject({ status: 503 });
    f.records.get(f.proposalId)!.studioProposal!.generation = randomUUID();
    await expect(f.cleanup()).rejects.toMatchObject({ status: 409 });
    expect(f.records.has(f.responseId)).toBe(true);
  });
});
