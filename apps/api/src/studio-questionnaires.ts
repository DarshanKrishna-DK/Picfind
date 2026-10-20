import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, type AuthOptions } from './auth.js';
import { withAccountLock, withAccountLocks } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  clientQuestionnaireAccess,
  clientQuestionnaireSnapshot,
  maybeQuestionnaireRecord,
  ownedQuestionnaire,
  questionnaireAccepting,
  questionnaireChanged as changed,
  questionnaireProject,
  questionnaireResponse,
  questionnaireUnavailable as unavailable,
  readOwnQuestionnaireResponse,
  readQuestionnaire,
} from './questionnaire-access.js';
import {
  questionnaireResponseId,
  removeQuestionnaireResponse,
} from './questionnaire-cleanup.js';
import {
  PROJECT_QUESTIONNAIRE_LIMIT,
  QUESTIONNAIRE_LIMIT,
  ownerQuestionnaires,
  publicQuestionnaireResponse,
  questionnaireCreate,
  questionnaireResponseWrite,
  savedQuestionnaire,
  storedQuestionnaireResponse,
  validQuestionnaireAnswers,
} from '../../../packages/shared/src/studio-questionnaires.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = () =>
  new ApiError(
    409,
    'QUESTIONNAIRE_CLOSED',
    'This questionnaire is closed to new answers.',
  );
const versionBody = z
  .object({
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export function createStudioQuestionnaires(
  auth: AuthOptions,
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  const writes = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  async function actor(req: Request) {
    const id = await owner(req);
    if (
      req.get('X-PicFind-Questionnaire-Actor') &&
      req.get('X-PicFind-Questionnaire-Actor') !== id
    )
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload this page.',
      );
    return id;
  }
  function idOf(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
  function versionOf(value: unknown) {
    const parsed = versionBody.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_QUESTIONNAIRE',
        'Load the current version before continuing.',
      );
    return parsed.data.version;
  }
  async function activeProject(accountId: string, projectId: string) {
    const current = await questionnaireProject(
      getStore(),
      accountId,
      projectId,
    );
    if (
      current.project.stage === 'archived' ||
      current.row.projectRemovalStartedAt
    )
      throw closed();
    return current;
  }
  async function snapshot(accountId: string, projectId: string) {
    await questionnaireProject(getStore(), accountId, projectId);
    const rows = (await getStore().list(accountId, 'job')).filter(
      (row) =>
        row.ownerId === accountId &&
        row.purpose === 'studio-questionnaire' &&
        row.studioQuestionnaire?.projectId === projectId,
    );
    if (rows.length > PROJECT_QUESTIONNAIRE_LIMIT) throw changed();
    const questionnaires = [];
    const load = async (row: LibraryRecord) => {
      const access = await ownedQuestionnaire(
        getStore(),
        accountId,
        projectId,
        row.id,
      );
      const response = await questionnaireResponse(
        getStore(),
        accountId,
        access.form,
      );
      const fresh = await ownedQuestionnaire(
        getStore(),
        accountId,
        projectId,
        row.id,
      );
      if (JSON.stringify(fresh.form) !== JSON.stringify(access.form))
        throw changed();
      return {
        questionnaire: fresh.form,
        removalPending: !!fresh.row.questionnaireRemovalStartedAt,
        response:
          response?.state === 'submitted'
            ? publicQuestionnaireResponse(response)
            : null,
      };
    };
    for (let offset = 0; offset < rows.length; offset += 4)
      questionnaires.push(
        ...(await Promise.all(rows.slice(offset, offset + 4).map(load))),
      );
    const project = await questionnaireProject(
      getStore(),
      accountId,
      projectId,
    );
    return ownerQuestionnaires.parse({
      accountId,
      projectId,
      projectName: project.project.name,
      editable:
        project.project.stage !== 'archived' &&
        !project.row.projectRemovalStartedAt,
      limit: PROJECT_QUESTIONNAIRE_LIMIT,
      questionnaires: questionnaires.sort((a, b) =>
        b.questionnaire.createdAt.localeCompare(a.questionnaire.createdAt),
      ),
    });
  }
  const ownerPath = '/studio/projects/:projectId/questionnaires';
  router.get(ownerPath, async (req, res) => {
    res.json(await snapshot(await actor(req), idOf(req.params.projectId)));
  });
  router.put(`${ownerPath}/:id`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id);
    const input = questionnaireCreate.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_QUESTIONNAIRE',
        'Enter a recipient, expiry and questions within their limits.',
      );
    const email = input.data.email.trim().toLowerCase(),
      commandDigest = digest({
        accountId,
        projectId,
        id,
        ...input.data,
        email,
      });
    async function retry() {
      const row = await maybeQuestionnaireRecord(getStore(), id);
      if (!row) return null;
      const current = await ownedQuestionnaire(
        getStore(),
        accountId,
        projectId,
        id,
      );
      if (
        current.row.questionnaireRemovalStartedAt ||
        current.row.questionnaireCommandDigest !== commandDigest
      )
        throw changed();
      return current.form;
    }
    const existing = await withAccountLock(accountId, retry);
    if (existing) {
      res.json({ accountId, questionnaire: existing });
      return;
    }
    await activeProject(accountId, projectId);
    if (!auth.provider?.resolveEventMember)
      throw new ApiError(
        503,
        'QUESTIONNAIRE_LOOKUP_UNAVAILABLE',
        'Account lookup is not configured.',
      );
    const recipient = await auth.provider.resolveEventMember(email);
    if (
      !recipient?.emailVerified ||
      recipient.id === accountId ||
      !z.string().min(1).max(128).safeParse(recipient.id).success ||
      recipient.email.trim().toLowerCase() !== email
    )
      throw new ApiError(
        400,
        'QUESTIONNAIRE_RECIPIENT_UNAVAILABLE',
        'Choose another verified PicFind account.',
      );
    const questionnaire = await withAccountLocks(
      [accountId, recipient.id],
      async () => {
        const repeated = await retry();
        if (repeated) return repeated;
        await activeProject(accountId, projectId);
        const rows = (await getStore().list(accountId, 'job')).filter(
          (row) =>
            row.ownerId === accountId && row.purpose === 'studio-questionnaire',
        );
        if (
          rows.length >= QUESTIONNAIRE_LIMIT ||
          rows.filter((row) => row.studioQuestionnaire?.projectId === projectId)
            .length >= PROJECT_QUESTIONNAIRE_LIMIT
        )
          throw new ApiError(
            409,
            'QUESTIONNAIRE_LIMIT',
            'Remove an expired or revoked questionnaire before issuing another.',
          );
        const now = new Date().toISOString();
        const form = savedQuestionnaire.parse({
          id,
          projectId,
          title: input.data.title,
          introduction: input.data.introduction,
          questions: input.data.questions,
          recipientId: recipient.id,
          recipientEmail: email,
          version: 1,
          createdAt: now,
          updatedAt: now,
          revokedAt: null,
          expiresAt: new Date(
            Date.parse(now) + input.data.days * 86_400_000,
          ).toISOString(),
        });
        await activeProject(accountId, projectId);
        await getStore().put(
          {
            id,
            ownerId: accountId,
            kind: 'job',
            purpose: 'studio-questionnaire',
            createdAt: now,
            studioQuestionnaire: form,
            questionnaireCommandDigest: commandDigest,
          },
          true,
        );
        return form;
      },
    );
    res.json({ accountId, questionnaire });
  });
  router.put(`${ownerPath}/:id/revoke`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id),
      version = versionOf(req.body);
    await withAccountLock(accountId, async () => {
      const access = await ownedQuestionnaire(
        getStore(),
        accountId,
        projectId,
        id,
      );
      if (
        access.row.questionnaireRemovalStartedAt ||
        access.project.row.projectRemovalStartedAt
      )
        throw closed();
      if (access.form.revokedAt && access.form.version === version + 1) return;
      if (
        access.form.version !== version ||
        version >= Number.MAX_SAFE_INTEGER - 1
      )
        throw changed();
      if (access.form.revokedAt) return;
      const fresh = await ownedQuestionnaire(
        getStore(),
        accountId,
        projectId,
        id,
      );
      if (
        JSON.stringify(fresh.row) !== JSON.stringify(access.row) ||
        fresh.project.row.projectRemovalStartedAt
      )
        throw changed();
      const now = new Date(
        Math.max(Date.now(), Date.parse(fresh.form.updatedAt)),
      ).toISOString();
      await getStore().put({
        ...fresh.row,
        studioQuestionnaire: {
          ...fresh.form,
          version: version + 1,
          revokedAt: now,
          updatedAt: now,
        },
      });
    });
    res.json(await snapshot(accountId, projectId));
  });
  router.delete(`${ownerPath}/:id`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id),
      version = versionOf(req.body);
    await questionnaireProject(getStore(), accountId, projectId);
    const initial = await maybeQuestionnaireRecord(getStore(), id);
    if (!initial) {
      res.status(204).end();
      return;
    }
    const first = readQuestionnaire(initial, id, accountId);
    if (first.form.projectId !== projectId) throw unavailable();
    const recipientId = first.form.recipientId;
    await withAccountLocks(
      [accountId, recipientId],
      async () => {
        if (!(await maybeQuestionnaireRecord(getStore(), id))) return;
        const current = await ownedQuestionnaire(
          getStore(),
          accountId,
          projectId,
          id,
        );
        if (
          current.form.recipientId !== recipientId ||
          current.form.version !== version
        )
          throw changed();
        if (
          !current.form.revokedAt &&
          Date.parse(current.form.expiresAt) > Date.now()
        )
          throw new ApiError(
            409,
            'QUESTIONNAIRE_NOT_CLOSED',
            'Revoke this questionnaire before removing it.',
          );
        const removalAt =
          current.row.questionnaireRemovalStartedAt ??
          new Date(
            Math.max(Date.now(), Date.parse(current.form.updatedAt)),
          ).toISOString();
        const assertRemoval = async () => {
          const fresh = await ownedQuestionnaire(
            getStore(),
            accountId,
            projectId,
            id,
          );
          if (
            fresh.form.version !== version ||
            fresh.form.recipientId !== recipientId ||
            fresh.row.questionnaireRemovalStartedAt !== removalAt
          )
            throw changed();
        };
        if (!current.row.questionnaireRemovalStartedAt)
          await getStore().put({
            ...current.row,
            questionnaireRemovalStartedAt: removalAt,
          });
        await assertRemoval();
        await removeQuestionnaireResponse(
          getStore(),
          current.row,
          new Set([accountId, recipientId]),
          assertRemoval,
        );
        await assertRemoval();
        try {
          await getStore().remove(id);
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404))
            throw failure;
        }
      },
      { allowDeleted: [recipientId] },
    );
    res.status(204).end();
  });
  router.get('/questionnaires/:id', async (req, res) => {
    res.json(
      await clientQuestionnaireSnapshot(
        getStore(),
        await actor(req),
        idOf(req.params.id),
      ),
    );
  });
  router.put('/questionnaires/:id/response', writes, async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = questionnaireResponseWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_QUESTIONNAIRE_RESPONSE',
        'Check the answer limits, current version and sharing acknowledgment.',
      );
    const first = await clientQuestionnaireAccess(getStore(), accountId, id);
    const photographerId = first.row.ownerId;
    const commandDigest = digest({ accountId, id, ...input.data });
    await withAccountLocks([accountId, photographerId], async () => {
      const current = await clientQuestionnaireAccess(
        getStore(),
        accountId,
        id,
      );
      if (current.row.ownerId !== photographerId) throw changed();
      const response = await questionnaireResponse(
        getStore(),
        photographerId,
        current.form,
      );
      if (
        response?.version === input.data.version + 1 &&
        response.commandDigest === commandDigest
      )
        return;
      if (!questionnaireAccepting(current)) throw closed();
      if (
        response?.state === 'submitted' ||
        (response?.version ?? 0) !== input.data.version ||
        (response?.generation ?? null) !== input.data.generation
      )
        throw changed();
      if (
        !validQuestionnaireAnswers(
          current.form,
          input.data.answers,
          input.data.action === 'submit',
        )
      )
        throw new ApiError(
          400,
          'INVALID_QUESTIONNAIRE_ANSWERS',
          'Answer the listed questions and complete required answers before submitting.',
        );
      const now = new Date(
        Math.max(
          Date.now(),
          Date.parse(response?.updatedAt ?? current.form.createdAt),
        ),
      ).toISOString();
      const next = storedQuestionnaireResponse.parse({
        id: questionnaireResponseId(id, accountId),
        questionnaireId: id,
        generation: response?.generation ?? randomUUID(),
        photographerId,
        projectId: current.form.projectId,
        version: input.data.version + 1,
        answers: input.data.answers,
        state: input.data.action === 'submit' ? 'submitted' : 'draft',
        createdAt: response?.createdAt ?? now,
        updatedAt: now,
        submittedAt: input.data.action === 'submit' ? now : null,
        commandDigest,
        consent: input.data.consent,
      });
      const freshResponse = await questionnaireResponse(
        getStore(),
        photographerId,
        current.form,
      );
      if (JSON.stringify(freshResponse) !== JSON.stringify(response))
        throw changed();
      const fresh = await clientQuestionnaireAccess(getStore(), accountId, id);
      if (
        fresh.row.ownerId !== photographerId ||
        JSON.stringify(fresh.form) !== JSON.stringify(current.form)
      )
        throw changed();
      if (!questionnaireAccepting(fresh)) throw closed();
      await getStore().put(
        {
          id: next.id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'questionnaire-response',
          createdAt: next.createdAt,
          questionnaireResponse: next,
        },
        !response,
      );
    });
    res.json(await clientQuestionnaireSnapshot(getStore(), accountId, id));
  });
  router.delete('/questionnaires/:id/response', writes, async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      responseId = questionnaireResponseId(id, accountId);
    const input = versionBody
      .extend({ generation: z.uuid() })
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_QUESTIONNAIRE_RESPONSE',
        'Reload the saved response before withdrawing it.',
      );
    const { version, generation } = input.data;
    const initial = await maybeQuestionnaireRecord(getStore(), responseId);
    if (!initial) {
      res.status(204).end();
      return;
    }
    const first = readOwnQuestionnaireResponse(initial, id, accountId);
    await withAccountLocks(
      [accountId, first.photographerId],
      async () => {
        const row = await maybeQuestionnaireRecord(getStore(), responseId);
        if (!row) return;
        const response = readOwnQuestionnaireResponse(row, id, accountId);
        if (
          response.photographerId !== first.photographerId ||
          response.version !== version ||
          response.generation !== generation
        )
          throw changed();
        const fresh = await maybeQuestionnaireRecord(getStore(), responseId);
        if (!fresh) return;
        if (JSON.stringify(fresh) !== JSON.stringify(row)) throw changed();
        try {
          await getStore().remove(responseId);
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.status === 404))
            throw failure;
        }
      },
      { allowDeleted: [first.photographerId] },
    );
    res.status(204).end();
  });
  return router;
}
