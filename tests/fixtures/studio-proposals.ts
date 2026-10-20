import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { serviceFixture } from './studio-services';
import { questionnaireOrigin } from './questionnaires';
import {
  blankClient,
  savedClient,
} from '../../packages/shared/src/studio-clients';
import { PROPOSAL_CONSENT } from '../../packages/shared/src/studio-proposals';
import { proposalResponseId } from '../../apps/api/src/proposal-cleanup';

export async function proposalFixture() {
  const f = serviceFixture(),
    proposalId = randomUUID(),
    clientRecordId = randomUUID();
  await f.save().expect(200);
  const now = new Date().toISOString();
  f.records.set(clientRecordId, {
    id: clientRecordId,
    ownerId: f.ownerId,
    kind: 'job',
    purpose: 'studio-client',
    createdAt: now,
    studioClient: savedClient.parse({
      ...blankClient(),
      id: clientRecordId,
      name: 'Client',
      email: 'client@example.test',
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  });
  f.records.get(f.projectId)!.studioProject!.clientId = clientRecordId;
  const ownerPath = `/api/studio/projects/${f.projectId}/proposals`,
    clientPath = `/api/proposals/${proposalId}`,
    responseId = proposalResponseId(proposalId, f.clientId);
  const proposalInput = {
    title: 'Your portrait options',
    introduction: 'Choose a preferred package for discussion.',
    days: 7,
    projectVersion: 1,
    clientId: clientRecordId,
    clientVersion: 1,
    clientEmail: 'client@example.test',
    services: [{ id: f.serviceId, version: 1 }],
  };
  const issue = (
    changes: object = {},
    id: string = proposalId,
    actor = f.ownerId,
  ) => f.put(`${ownerPath}/${id}`, { ...proposalInput, ...changes }, actor);
  const respond = (changes: object = {}, actor = f.clientId) =>
    f.put(
      `${clientPath}/response`,
      {
        proposalGeneration:
          f.records.get(proposalId)?.studioProposal?.generation,
        version: 0,
        generation: null,
        decision: 'choose',
        serviceId: f.serviceId,
        note: 'Please discuss availability.',
        consent: PROPOSAL_CONSENT,
        ...changes,
      },
      actor,
    );
  const withdraw = (changes: object = {}, actor = f.ownerId) =>
    request(f.app)
      .post(`${ownerPath}/${proposalId}/withdraw`)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({
        generation: f.records.get(proposalId)?.studioProposal?.generation,
        version: 1,
        ...changes,
      });
  const removeProposal = (changes: object = {}, actor = f.ownerId) =>
    f.remove(
      `${ownerPath}/${proposalId}`,
      {
        generation: f.records.get(proposalId)?.studioProposal?.generation,
        version: 2,
        ...changes,
      },
      actor,
    );
  return {
    ...f,
    proposalId,
    clientRecordId,
    ownerPath,
    clientPath,
    responseId,
    proposalInput,
    issueQuestionnaire: f.issue,
    issue,
    respond,
    withdraw,
    removeProposal,
  };
}
