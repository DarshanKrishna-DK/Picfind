import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLocks } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';

export function questionnaireResponseId(formId: string, recipientId: string) {
  const hex = createHash('sha256')
    .update(`picfind:questionnaire-response:${formId}:${recipientId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const invalid = () =>
  new ApiError(
    503,
    'QUESTIONNAIRE_METADATA_INVALID',
    'Questionnaire identity metadata needs repair before cleanup.',
  );
const changed = () =>
  new ApiError(
    409,
    'QUESTIONNAIRE_CHANGED',
    'Questionnaire participants changed. Reload and retry cleanup.',
  );
export function questionnaireIdentity(row: LibraryRecord) {
  const form = row.studioQuestionnaire;
  if (
    row.kind !== 'job' ||
    row.purpose !== 'studio-questionnaire' ||
    row.eventId ||
    !z.uuid().safeParse(row.id).success ||
    form?.id !== row.id ||
    !z.uuid().safeParse(form?.projectId).success ||
    !z.string().min(1).max(128).safeParse(row.ownerId).success ||
    !z.string().min(1).max(128).safeParse(form?.recipientId).success ||
    form!.recipientId === row.ownerId
  )
    throw invalid();
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: form!.projectId,
    recipientId: form!.recipientId,
  };
}
async function forms(store: LibraryStore, ownerId: string, projectId?: string) {
  return (await store.list(ownerId, 'job')).filter(
    (row) =>
      row.ownerId === ownerId &&
      row.purpose === 'studio-questionnaire' &&
      (!projectId || row.studioQuestionnaire?.projectId === projectId),
  );
}
export async function withQuestionnaireCleanupLocks<T>(
  store: LibraryStore,
  ownerId: string,
  projectId: string | undefined,
  operation: (lockedAccounts: ReadonlySet<string>) => Promise<T>,
) {
  const before = await forms(store, ownerId, projectId),
    recipients = [
      ...new Set(before.map((row) => questionnaireIdentity(row).recipientId)),
    ];
  if (recipients.length > 200) throw invalid();
  // Discovery chooses locks, not a frozen deletion list. The operation rereads
  // all current forms in the authorized account/project scope under these locks.
  const lockedAccounts = new Set([ownerId, ...recipients]);
  return withAccountLocks(
    [...lockedAccounts],
    async () => {
      const current = await forms(store, ownerId, projectId);
      for (const row of current)
        if (!lockedAccounts.has(questionnaireIdentity(row).recipientId))
          throw changed();
      return operation(lockedAccounts);
    },
    { allowDeleted: recipients },
  );
}
export async function removeQuestionnaireResponse(
  store: LibraryStore,
  formRow: LibraryRecord,
  lockedAccounts: ReadonlySet<string>,
  assertRemoval: () => Promise<void> = async () => {},
) {
  // The caller already holds these queues. Never reacquire a participant here.
  const form = questionnaireIdentity(formRow);
  if (
    !lockedAccounts.has(form.ownerId) ||
    !lockedAccounts.has(form.recipientId)
  )
    throw invalid();
  const id = questionnaireResponseId(form.id, form.recipientId);
  let row: LibraryRecord;
  try {
    row = await store.get(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return;
    throw failure;
  }
  function belongs(value: LibraryRecord) {
    const response = value.questionnaireResponse;
    return (
      value.id === id &&
      value.ownerId === form.recipientId &&
      value.kind === 'job' &&
      value.purpose === 'questionnaire-response' &&
      !value.eventId &&
      response?.id === id &&
      response.questionnaireId === form.id &&
      response.projectId === form.projectId &&
      response.photographerId === form.ownerId
    );
  }
  if (!belongs(row)) throw changed();
  const fresh = questionnaireIdentity(await store.get(form.id));
  if (JSON.stringify(fresh) !== JSON.stringify(form)) throw changed();
  await assertRemoval();
  try {
    row = await store.get(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return;
    throw failure;
  }
  if (!belongs(row)) throw changed();
  try {
    await store.remove(id);
  } catch (failure) {
    if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
  }
}
