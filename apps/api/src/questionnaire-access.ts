import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { ownedProjectRecord } from './studio-project-access.js';
import {
  questionnaireIdentity,
  questionnaireResponseId,
} from './questionnaire-cleanup.js';
import {
  publicQuestionnaireResponse,
  savedQuestionnaire,
  storedQuestionnaireResponse,
  validQuestionnaireAnswers,
  type SavedQuestionnaire,
} from '../../../packages/shared/src/studio-questionnaires.js';

export const questionnaireUnavailable = () =>
  new ApiError(
    404,
    'QUESTIONNAIRE_UNAVAILABLE',
    'This questionnaire is unavailable for this account.',
  );
export const questionnaireChanged = () =>
  new ApiError(
    409,
    'QUESTIONNAIRE_CHANGED',
    'Questionnaire details changed. Reload before trying again.',
  );
const invalid = () =>
  new ApiError(
    503,
    'QUESTIONNAIRE_METADATA_INVALID',
    'Questionnaire metadata needs repair.',
  );
export async function maybeQuestionnaireRecord(
  store: LibraryStore,
  id: string,
) {
  try {
    return await store.get(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return null;
    throw failure;
  }
}
export async function questionnaireProject(
  store: LibraryStore,
  ownerId: string,
  projectId: string,
) {
  const row = await maybeQuestionnaireRecord(store, projectId);
  if (!row) throw questionnaireUnavailable();
  return ownedProjectRecord(row, ownerId, projectId);
}
export function readQuestionnaire(
  row: LibraryRecord,
  id: string,
  ownerId?: string,
) {
  if (
    row.id !== id ||
    (ownerId && row.ownerId !== ownerId) ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-questionnaire' ||
    row.eventId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw questionnaireUnavailable();
  const identity = questionnaireIdentity(row),
    result = savedQuestionnaire.safeParse(row.studioQuestionnaire);
  if (
    !result.success ||
    result.data.createdAt !== row.createdAt ||
    !/^[a-f0-9]{64}$/.test(row.questionnaireCommandDigest ?? '') ||
    (row.questionnaireRemovalStartedAt !== undefined &&
      (!z.iso.datetime().safeParse(row.questionnaireRemovalStartedAt).success ||
        Date.parse(row.questionnaireRemovalStartedAt) <
          Date.parse(row.createdAt)))
  )
    throw invalid();
  return { row, form: result.data, identity };
}
export function readOwnQuestionnaireResponse(
  row: LibraryRecord,
  formId: string,
  recipientId: string,
) {
  const id = questionnaireResponseId(formId, recipientId);
  if (
    row.id !== id ||
    row.ownerId !== recipientId ||
    row.kind !== 'job' ||
    row.purpose !== 'questionnaire-response' ||
    row.eventId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw questionnaireUnavailable();
  const result = storedQuestionnaireResponse.safeParse(
    row.questionnaireResponse,
  );
  if (
    !result.success ||
    result.data.id !== id ||
    result.data.questionnaireId !== formId ||
    result.data.createdAt !== row.createdAt ||
    result.data.photographerId === recipientId
  )
    throw invalid();
  return result.data;
}
export async function questionnaireResponse(
  store: LibraryStore,
  ownerId: string,
  form: SavedQuestionnaire,
) {
  const row = await maybeQuestionnaireRecord(
    store,
    questionnaireResponseId(form.id, form.recipientId),
  );
  if (!row) return null;
  const response = readOwnQuestionnaireResponse(row, form.id, form.recipientId);
  if (
    response.photographerId !== ownerId ||
    response.projectId !== form.projectId ||
    !validQuestionnaireAnswers(
      form,
      response.answers,
      response.state === 'submitted',
    )
  )
    throw invalid();
  return response;
}
export async function ownedQuestionnaire(
  store: LibraryStore,
  ownerId: string,
  projectId: string,
  id: string,
) {
  const row = await maybeQuestionnaireRecord(store, id);
  if (!row) throw questionnaireUnavailable();
  const result = readQuestionnaire(row, id, ownerId);
  if (result.form.projectId !== projectId) throw questionnaireUnavailable();
  const project = await questionnaireProject(store, ownerId, projectId);
  return { ...result, project };
}
export async function clientQuestionnaireAccess(
  store: LibraryStore,
  recipientId: string,
  id: string,
) {
  const row = await maybeQuestionnaireRecord(store, id);
  if (
    !row ||
    row.studioQuestionnaire?.recipientId !== recipientId ||
    row.questionnaireRemovalStartedAt
  )
    throw questionnaireUnavailable();
  const result = readQuestionnaire(row, id);
  if (
    result.form.recipientId !== recipientId ||
    row.questionnaireRemovalStartedAt
  )
    throw questionnaireUnavailable();
  const project = await questionnaireProject(
    store,
    row.ownerId,
    result.form.projectId,
  );
  if (project.row.projectRemovalStartedAt) throw questionnaireUnavailable();
  return { ...result, project };
}
export function questionnaireAccepting(
  access: Awaited<ReturnType<typeof clientQuestionnaireAccess>>,
) {
  return (
    !access.form.revokedAt &&
    Date.parse(access.form.expiresAt) > Date.now() &&
    access.project.project.stage !== 'archived' &&
    !access.project.row.projectRemovalStartedAt &&
    !access.row.questionnaireRemovalStartedAt
  );
}
export async function clientQuestionnaireSnapshot(
  store: LibraryStore,
  recipientId: string,
  id: string,
) {
  const access = await clientQuestionnaireAccess(store, recipientId, id),
    response = await questionnaireResponse(
      store,
      access.row.ownerId,
      access.form,
    ),
    fresh = await clientQuestionnaireAccess(store, recipientId, id);
  if (
    fresh.row.ownerId !== access.row.ownerId ||
    JSON.stringify(fresh.form) !== JSON.stringify(access.form)
  )
    throw questionnaireChanged();
  return {
    accountId: recipientId,
    id,
    fields: {
      title: fresh.form.title,
      introduction: fresh.form.introduction,
      questions: fresh.form.questions,
    },
    expiresAt: fresh.form.expiresAt,
    accepting: questionnaireAccepting(fresh),
    response: response ? publicQuestionnaireResponse(response) : null,
  };
}
