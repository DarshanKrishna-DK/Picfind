import { z } from 'zod';

export const PROJECT_QUESTIONNAIRE_LIMIT = 20;
export const QUESTIONNAIRE_LIMIT = 200;
export const QUESTIONNAIRE_CONSENT = 'project-questionnaire-v1' as const;
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const accountId = z.string().min(1).max(128);
export const questionnaireQuestion = z
  .object({
    id: z.uuid(),
    label: z.string().trim().min(1).max(160),
    required: z.boolean(),
    multiline: z.boolean(),
  })
  .strict();
export const questionnaireFields = z
  .object({
    title: z.string().trim().min(1).max(100),
    introduction: z.string().trim().max(500),
    questions: z.array(questionnaireQuestion).min(1).max(10),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.questions.map((question) => question.id)).size ===
      value.questions.length,
  )
  .refine(
    (value) =>
      new TextEncoder().encode(
        JSON.stringify({
          title: value.title,
          introduction: value.introduction,
          questions: value.questions,
        }),
      ).byteLength <= 4_000,
  );
export type QuestionnaireFields = z.infer<typeof questionnaireFields>;
export const questionnaireCreate = questionnaireFields
  .safeExtend({
    email: z.email().max(254),
    days: z.number().int().min(1).max(30),
  })
  .strict();
export const savedQuestionnaire = questionnaireFields
  .safeExtend({
    id: z.uuid(),
    projectId: z.uuid(),
    recipientId: accountId,
    recipientEmail: z.email().max(254),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      (!value.revokedAt ||
        (Date.parse(value.revokedAt) >= Date.parse(value.createdAt) &&
          Date.parse(value.revokedAt) <= Date.parse(value.updatedAt))),
  );
export type SavedQuestionnaire = z.infer<typeof savedQuestionnaire>;
export const questionnaireAnswers = z
  .array(
    z
      .object({
        questionId: z.uuid(),
        text: z.string().trim().max(1000),
      })
      .strict(),
  )
  .max(10)
  .refine(
    (value) =>
      new Set(value.map((answer) => answer.questionId)).size === value.length,
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8_000,
  );
export type QuestionnaireAnswers = z.infer<typeof questionnaireAnswers>;
export const questionnaireResponseWrite = z
  .object({
    generation: z.uuid().nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    action: z.enum(['save', 'submit']),
    answers: questionnaireAnswers,
    consent: z.literal(QUESTIONNAIRE_CONSENT).nullable(),
  })
  .strict()
  .refine((value) => (value.version === 0) === (value.generation === null))
  .refine((value) =>
    value.action === 'submit'
      ? value.consent === QUESTIONNAIRE_CONSENT
      : value.consent === null,
  );
export const questionnaireResponseView = z
  .object({
    id: z.uuid(),
    generation: z.uuid(),
    version,
    answers: questionnaireAnswers,
    state: z.enum(['draft', 'submitted']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    submittedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
      (value.state === 'draft'
        ? value.submittedAt === null
        : value.submittedAt !== null &&
          Date.parse(value.submittedAt) >= Date.parse(value.createdAt) &&
          Date.parse(value.submittedAt) <= Date.parse(value.updatedAt)),
  );
export type QuestionnaireResponseView = z.infer<
  typeof questionnaireResponseView
>;
export const storedQuestionnaireResponse = questionnaireResponseView
  .safeExtend({
    questionnaireId: z.uuid(),
    projectId: z.uuid(),
    photographerId: accountId,
    commandDigest: digest,
    consent: z.literal(QUESTIONNAIRE_CONSENT).nullable(),
  })
  .strict()
  .refine((value) =>
    value.state === 'submitted'
      ? value.consent === QUESTIONNAIRE_CONSENT
      : value.consent === null,
  );
export type StoredQuestionnaireResponse = z.infer<
  typeof storedQuestionnaireResponse
>;
export function validQuestionnaireAnswers(
  fields: QuestionnaireFields,
  answers: QuestionnaireAnswers,
  final: boolean,
) {
  return (
    answers.length === fields.questions.length &&
    fields.questions.every((question) => {
      const answer = answers.find((value) => value.questionId === question.id);
      return !!answer && (!final || !question.required || !!answer.text.trim());
    })
  );
}
export function publicQuestionnaireResponse(
  value: StoredQuestionnaireResponse,
): QuestionnaireResponseView {
  return {
    id: value.id,
    generation: value.generation,
    version: value.version,
    answers: value.answers,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    submittedAt: value.submittedAt,
  };
}
export const ownerQuestionnaires = z
  .object({
    accountId,
    projectId: z.uuid(),
    projectName: z.string().max(100),
    editable: z.boolean(),
    limit: z.literal(PROJECT_QUESTIONNAIRE_LIMIT),
    questionnaires: z
      .array(
        z
          .object({
            questionnaire: savedQuestionnaire,
            removalPending: z.boolean(),
            response: questionnaireResponseView.nullable(),
          })
          .strict(),
      )
      .max(PROJECT_QUESTIONNAIRE_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.questionnaires.map((row) => row.questionnaire.id)).size ===
        value.questionnaires.length &&
      value.questionnaires.every(
        (row) =>
          row.questionnaire.projectId === value.projectId &&
          (!row.response ||
            (row.response.state === 'submitted' &&
              validQuestionnaireAnswers(
                row.questionnaire,
                row.response.answers,
                true,
              ))),
      ),
  );
export type OwnerQuestionnaires = z.infer<typeof ownerQuestionnaires>;
export const clientQuestionnaire = z
  .object({
    accountId,
    id: z.uuid(),
    fields: questionnaireFields,
    expiresAt: z.iso.datetime(),
    accepting: z.boolean(),
    response: questionnaireResponseView.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      !value.response ||
      validQuestionnaireAnswers(
        value.fields,
        value.response.answers,
        value.response.state === 'submitted',
      ),
  );
export type ClientQuestionnaire = z.infer<typeof clientQuestionnaire>;
