import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  QUESTIONNAIRE_CONSENT,
  questionnaireCreate,
  questionnaireFields,
  questionnaireResponseWrite,
  storedQuestionnaireResponse,
  publicQuestionnaireResponse,
  validQuestionnaireAnswers,
  savedQuestionnaire,
  ownerQuestionnaires,
} from '../../packages/shared/src/studio-questionnaires';

function fixture() {
  const fields = {
    title: 'Shoot preparation',
    introduction: 'Please share your preferences.',
    questions: [
      {
        id: randomUUID(),
        label: 'Priority shots',
        required: true,
        multiline: true,
      },
      {
        id: randomUUID(),
        label: 'Other notes',
        required: false,
        multiline: false,
      },
    ],
  };
  const now = '2026-10-21T12:00:00.000Z';
  const form = {
    ...fields,
    id: randomUUID(),
    projectId: randomUUID(),
    recipientId: 'client',
    recipientEmail: 'client@example.test',
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: '2026-10-28T12:00:00.000Z',
    revokedAt: null,
  };
  const response = {
    id: randomUUID(),
    generation: randomUUID(),
    version: 1,
    answers: fields.questions.map((question) => ({
      questionId: question.id,
      text: '',
    })),
    state: 'draft' as const,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    questionnaireId: form.id,
    projectId: form.projectId,
    photographerId: 'owner',
    commandDigest: 'a'.repeat(64),
    consent: null,
  };
  return { fields, form, response };
}
describe('private project questionnaire contracts', () => {
  it('validates exact question identity while allowing incomplete private drafts', () => {
    const { fields, response } = fixture();
    expect(validQuestionnaireAnswers(fields, response.answers, false)).toBe(
      true,
    );
    expect(validQuestionnaireAnswers(fields, response.answers, true)).toBe(
      false,
    );
    response.answers[0]!.text = 'Family portraits';
    expect(validQuestionnaireAnswers(fields, response.answers, true)).toBe(
      true,
    );
    expect(
      validQuestionnaireAnswers(fields, response.answers.slice(1), false),
    ).toBe(false);
    response.answers[1]!.questionId = randomUUID();
    expect(validQuestionnaireAnswers(fields, response.answers, false)).toBe(
      false,
    );
  });
  it('requires final sharing consent and rejects accidental consent on draft saves', () => {
    const { response } = fixture();
    const input = {
      version: 0,
      generation: null,
      answers: response.answers,
      action: 'submit',
      consent: null,
    };
    expect(questionnaireResponseWrite.safeParse(input).success).toBe(false);
    expect(
      questionnaireResponseWrite.safeParse({
        ...input,
        consent: QUESTIONNAIRE_CONSENT,
      }).success,
    ).toBe(true);
    expect(
      questionnaireResponseWrite.safeParse({ ...input, action: 'save' })
        .success,
    ).toBe(true);
    expect(
      questionnaireResponseWrite.safeParse({
        ...input,
        action: 'save',
        consent: QUESTIONNAIRE_CONSENT,
      }).success,
    ).toBe(false);
  });
  it('preserves the field byte budget when metadata extends a saved form', () => {
    const { fields, form } = fixture();
    fields.questions = Array.from({ length: 10 }, () => ({
      id: randomUUID(),
      label: 'A'.repeat(160),
      required: false,
      multiline: true,
    }));
    fields.introduction = 'A'.repeat(500);
    expect(questionnaireFields.safeParse(fields).success).toBe(true);
    expect(
      questionnaireCreate.safeParse({
        ...fields,
        email: form.recipientEmail,
        days: 7,
      }).success,
    ).toBe(true);
    expect(savedQuestionnaire.safeParse({ ...form, ...fields }).success).toBe(
      true,
    );
    fields.questions.forEach((question) => {
      question.label = '界'.repeat(160);
    });
    expect(questionnaireFields.safeParse(fields).success).toBe(false);
  });
  it('rejects duplicate questions, oversized answers and inconsistent saved lifecycle metadata', () => {
    const { fields, response, form } = fixture();
    expect(
      questionnaireFields.safeParse({
        ...fields,
        questions: [fields.questions[0], fields.questions[0]],
      }).success,
    ).toBe(false);
    expect(
      storedQuestionnaireResponse.safeParse({
        ...response,
        answers: Array.from({ length: 10 }, () => ({
          questionId: randomUUID(),
          text: '界'.repeat(1000),
        })),
      }).success,
    ).toBe(false);
    expect(
      storedQuestionnaireResponse.safeParse({ ...response, state: 'submitted' })
        .success,
    ).toBe(false);
    expect(
      savedQuestionnaire.safeParse({ ...form, expiresAt: form.createdAt })
        .success,
    ).toBe(false);
    expect(
      savedQuestionnaire.safeParse({
        ...form,
        revokedAt: '2026-10-22T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
  it('omits internal references and forbids private drafts in owner response projections', () => {
    const { form, response } = fixture();
    const view = publicQuestionnaireResponse(
      storedQuestionnaireResponse.parse(response),
    );
    expect(JSON.stringify(view)).not.toMatch(
      /commandDigest|photographerId|questionnaireId|projectId|consent/,
    );
    const snapshot = {
      accountId: 'owner',
      projectId: form.projectId,
      projectName: 'Project',
      editable: true,
      limit: 20,
      questionnaires: [
        { questionnaire: form, removalPending: false, response: view },
      ],
    };
    expect(ownerQuestionnaires.safeParse(snapshot).success).toBe(false);
    expect(
      ownerQuestionnaires.safeParse({
        ...snapshot,
        questionnaires: [{ ...snapshot.questionnaires[0], response: null }],
      }).success,
    ).toBe(true);
  });
});
