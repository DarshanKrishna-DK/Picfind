import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth';
import { markDeletedAccount } from '../../apps/api/src/locks';
import {
  questionnaireResponseId,
  removeQuestionnaireResponse,
  withQuestionnaireCleanupLocks,
} from '../../apps/api/src/questionnaire-cleanup';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

function fixture(owner = randomUUID(), recipient = randomUUID()) {
  const now = '2026-10-21T12:00:00.000Z',
    id = randomUUID(),
    projectId = randomUUID(),
    responseId = questionnaireResponseId(id, recipient);
  const form: LibraryRecord = {
    id,
    kind: 'job',
    purpose: 'studio-questionnaire',
    ownerId: owner,
    createdAt: now,
    studioQuestionnaire: {
      id,
      projectId,
      title: 'Preparation',
      introduction: '',
      questions: [
        {
          id: randomUUID(),
          label: 'Priority',
          required: true,
          multiline: false,
        },
      ],
      recipientId: recipient,
      recipientEmail: 'client@example.test',
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: '2026-10-28T12:00:00.000Z',
      revokedAt: null,
    },
  };
  const response: LibraryRecord = {
    id: responseId,
    kind: 'job',
    purpose: 'questionnaire-response',
    ownerId: recipient,
    createdAt: now,
    questionnaireResponse: {
      id: responseId,
      generation: randomUUID(),
      questionnaireId: id,
      projectId,
      photographerId: owner,
      version: 1,
      state: 'draft',
      answers: [],
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      consent: null,
      commandDigest: 'a'.repeat(64),
    },
  };
  const unrelated: LibraryRecord = {
    id: randomUUID(),
    kind: 'job',
    purpose: 'studio-client',
    ownerId: recipient,
    createdAt: now,
  };
  const records = new Map(
    [form, response, unrelated].map((row) => [row.id, row]),
  );
  const list = async (actor: string, kind: LibraryRecord['kind']) =>
    [...records.values()]
      .filter((row) => row.ownerId === actor && row.kind === kind)
      .map((row) => structuredClone(row));
  const store: LibraryStore = {
    get: vi.fn(async (key) => {
      const row = records.get(key);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    }),
    list: vi.fn(list),
    put: vi.fn(async (row) => {
      records.set(row.id, structuredClone(row));
    }),
    remove: vi.fn(async (key) => {
      records.delete(key);
    }),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const cleanup = () =>
    withQuestionnaireCleanupLocks(store, owner, projectId, async (locked) => {
      await removeQuestionnaireResponse(store, form, locked);
      await store.remove(form.id);
    });
  return {
    owner,
    recipient,
    projectId,
    form,
    response,
    unrelated,
    records,
    store,
    list,
    cleanup,
  };
}
describe('strictly scoped shared questionnaire cleanup', () => {
  it('removes only the assigned response even when answer content needs repair', async () => {
    const f = fixture();
    f.response.questionnaireResponse!.version = -1;
    await f.cleanup();
    expect([...f.records.keys()]).toEqual([f.unrelated.id]);
  });
  it('retains the form after a deletion failure and retries even after recipient account deletion', async () => {
    const f = fixture();
    vi.mocked(f.store.remove).mockRejectedValueOnce(
      new Error('Storage interrupted.'),
    );
    await expect(f.cleanup()).rejects.toThrow('Storage interrupted.');
    expect(f.records.has(f.form.id)).toBe(true);
    expect(f.records.has(f.response.id)).toBe(true);
    markDeletedAccount(f.recipient);
    await f.cleanup();
    expect([...f.records.keys()]).toEqual([f.unrelated.id]);
  });
  it('refuses a newly introduced participant before calling the removal operation', async () => {
    const f = fixture(),
      operation = vi.fn();
    vi.mocked(f.store.list)
      .mockImplementationOnce(f.list)
      .mockImplementationOnce(async (actor, kind) => {
        f.form.studioQuestionnaire!.recipientId = randomUUID();
        return f.list(actor, kind);
      });
    await expect(
      withQuestionnaireCleanupLocks(f.store, f.owner, f.projectId, operation),
    ).rejects.toMatchObject({ status: 409 });
    expect(operation).not.toHaveBeenCalled();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('does not remove a response whose scope changes during the final parent check', async () => {
    const f = fixture();
    await expect(
      withQuestionnaireCleanupLocks(
        f.store,
        f.owner,
        f.projectId,
        async (locked) =>
          removeQuestionnaireResponse(f.store, f.form, locked, async () => {
            f.response.ownerId = 'different-account';
          }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('rejects wrong response references and missing participant locks', async () => {
    const f = fixture();
    await expect(
      removeQuestionnaireResponse(f.store, f.form, new Set([f.owner])),
    ).rejects.toMatchObject({ status: 503 });
    f.response.questionnaireResponse!.questionnaireId = randomUUID();
    await expect(f.cleanup()).rejects.toMatchObject({ status: 409 });
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('allows reciprocal photographer cleanup to complete without deleting unrelated recipient records', async () => {
    const a = randomUUID(),
      b = randomUUID(),
      first = fixture(a, b),
      second = fixture(b, a);
    for (const row of second.records.values()) first.records.set(row.id, row);
    await Promise.all([
      first.cleanup(),
      withQuestionnaireCleanupLocks(
        first.store,
        b,
        second.projectId,
        async (locked) => {
          await removeQuestionnaireResponse(first.store, second.form, locked);
          await first.store.remove(second.form.id);
        },
      ),
    ]);
    expect([...first.records.keys()].sort()).toEqual(
      [first.unrelated.id, second.unrelated.id].sort(),
    );
  });
  it('handles an already removed response and rejects a corrupt self-invitation', async () => {
    const f = fixture();
    f.records.delete(f.response.id);
    await f.cleanup();
    expect(f.records.has(f.unrelated.id)).toBe(true);
    const other = fixture();
    other.form.studioQuestionnaire!.recipientId = other.owner;
    await expect(other.cleanup()).rejects.toMatchObject({ status: 503 });
    expect(other.store.remove).not.toHaveBeenCalled();
  });
});
