import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError, type AuthUser } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import {
  advanceProject,
  blankProject,
} from '../../packages/shared/src/studio-projects';
import { questionnaireResponseId } from '../../apps/api/src/questionnaire-cleanup';

export const questionnaireOrigin = 'http://localhost:5173';
export function questionnaireFixture() {
  const ownerId = randomUUID(),
    clientId = randomUUID(),
    strangerId = randomUUID(),
    projectId = randomUUID(),
    formId = randomUUID();
  const project = advanceProject(
    null,
    projectId,
    {
      ...blankProject(),
      name: 'Portrait session',
    },
    '',
    ownerId,
    new Date().toISOString(),
  );
  const records = new Map<string, LibraryRecord>([
    [
      projectId,
      {
        id: projectId,
        ownerId,
        kind: 'job',
        purpose: 'studio-project',
        createdAt: project.createdAt,
        studioProject: project,
        projectCommandDigest: 'a'.repeat(64),
      },
    ],
  ]);
  const store: LibraryStore = {
    async get(id) {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    async list(actor, kind) {
      return [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row));
    },
    async put(row, create) {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      records.set(row.id, structuredClone(row));
    },
    async remove(id) {
      records.delete(id);
    },
    async upload() {
      throw new Error('Unexpected upload');
    },
    async file() {
      throw new Error('Unexpected file');
    },
    async removeFile() {
      throw new Error('Unexpected file removal');
    },
  };
  const user = (id: string): AuthUser => ({
    id,
    name: id === ownerId ? 'Photographer' : 'Client',
    email: id === clientId ? 'client@example.test' : `${id}@example.test`,
    emailVerified: true,
  });
  const provider = {
    getUser: async (id: string) => user(id),
    resolveEventMember: async (email: string): Promise<AuthUser | null> =>
      email === 'client@example.test' ? user(clientId) : null,
    register: async () => user(ownerId),
    login: async () => ({
      secret: ownerId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    logout: async () => {},
    deleteUser: async () => {},
    verifyActionCode: async () => {},
  };
  const app = createApp(
    { webOrigin: questionnaireOrigin, secureCookies: false, provider },
    { store },
  );
  const fields = {
    title: 'Portrait preparation',
    introduction: 'Share your preferences before the shoot.',
    questions: [
      {
        id: randomUUID(),
        label: 'Priority photographs',
        required: true,
        multiline: true,
      },
      {
        id: randomUUID(),
        label: 'Location preference',
        required: false,
        multiline: false,
      },
    ],
    email: 'client@example.test',
    days: 7,
  };
  const root = `/api/studio/projects/${projectId}/questionnaires`,
    clientPath = `/api/questionnaires/${formId}`;
  const read = (path = root, actor = ownerId) =>
    request(app).get(path).set('Cookie', `picfind_session=${actor}`);
  const put = (path: string, body: object, actor = ownerId) =>
    request(app)
      .put(path)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const remove = (path: string, body: object, actor = ownerId) =>
    request(app)
      .delete(path)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${actor}`)
      .send(body);
  const issue = () => put(`${root}/${formId}`, fields);
  const responseId = questionnaireResponseId(formId, clientId);
  const write = (changes: object = {}) =>
    put(
      `${clientPath}/response`,
      {
        generation: null,
        version: 0,
        action: 'save',
        consent: null,
        answers: fields.questions.map((question) => ({
          questionId: question.id,
          text: '',
        })),
        ...changes,
      },
      clientId,
    );
  function archive() {
    const row = records.get(projectId)!;
    row.studioProject = advanceProject(
      row.studioProject!,
      projectId,
      {
        ...blankProject(),
        name: project.name,
        stage: 'archived',
      },
      'Project finished',
      ownerId,
      new Date().toISOString(),
    );
  }
  return {
    app,
    provider,
    store,
    records,
    ownerId,
    clientId,
    strangerId,
    projectId,
    formId,
    responseId,
    fields,
    root,
    clientPath,
    user,
    read,
    put,
    remove,
    issue,
    write,
    archive,
  };
}
