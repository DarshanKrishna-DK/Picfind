import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { ownedProjectRecord } from './studio-project-access.js';
import { proposalResponseId } from './proposal-cleanup.js';
import {
  savedProposal,
  storedProposalResponse,
  type StudioProposal,
} from '../../../packages/shared/src/studio-proposals.js';
import { savedClient } from '../../../packages/shared/src/studio-clients.js';

export const proposalUnavailable = () =>
  new ApiError(404, 'PROPOSAL_UNAVAILABLE', 'This proposal is not available.');
export const proposalChanged = () =>
  new ApiError(
    409,
    'PROPOSAL_CHANGED',
    'These proposal details changed. Refresh before continuing.',
  );
export const proposalInvalid = () =>
  new ApiError(
    503,
    'PROPOSAL_METADATA_INVALID',
    'Proposal metadata needs repair before continuing.',
  );
export async function maybeProposalRecord(store: LibraryStore, id: string) {
  try {
    return await store.get(id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) return null;
    throw failure;
  }
}
export function readProposal(
  row: LibraryRecord,
  id: string,
  ownerId = row.ownerId,
) {
  if (
    row.id !== id ||
    row.ownerId !== ownerId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-proposal' ||
    row.eventId ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    throw proposalUnavailable();
  const result = savedProposal.safeParse(row.studioProposal);
  if (
    !result.success ||
    result.data.id !== id ||
    result.data.createdAt !== row.createdAt ||
    result.data.recipientId === ownerId ||
    !/^[a-f0-9]{64}$/.test(row.proposalCommandDigest ?? '') ||
    (row.proposalRemovalStartedAt !== undefined &&
      !z.iso.datetime().safeParse(row.proposalRemovalStartedAt).success)
  )
    throw proposalInvalid();
  return { row, proposal: result.data };
}
export async function proposalProject(
  store: LibraryStore,
  ownerId: string,
  id: string,
) {
  const row = await maybeProposalRecord(store, id);
  if (!row) throw proposalUnavailable();
  let result;
  try {
    result = ownedProjectRecord(row, ownerId, id);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404)
      throw proposalUnavailable();
    throw failure;
  }
  if (row.projectRemovalStartedAt) throw proposalUnavailable();
  return result;
}
export async function proposalClient(
  store: LibraryStore,
  ownerId: string,
  id: string | null,
) {
  if (!id) return null;
  const row = await maybeProposalRecord(store, id);
  if (
    !row ||
    row.id !== id ||
    row.ownerId !== ownerId ||
    row.kind !== 'job' ||
    row.purpose !== 'studio-client' ||
    row.eventId ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    return null;
  const value = savedClient.safeParse(row.studioClient);
  return value.success &&
    value.data.id === id &&
    value.data.createdAt === row.createdAt &&
    value.data.email
    ? value.data
    : null;
}
export async function proposalAccess(
  store: LibraryStore,
  id: string,
  actorId: string,
  owner: boolean,
) {
  const row = await maybeProposalRecord(store, id);
  if (
    !row ||
    (owner
      ? row.ownerId !== actorId
      : row.studioProposal?.recipientId !== actorId)
  )
    throw proposalUnavailable();
  const result = readProposal(row, id);
  if (!owner && row.proposalRemovalStartedAt) throw proposalUnavailable();
  const project = await proposalProject(
    store,
    row.ownerId,
    result.proposal.projectId,
  );
  return { ...result, project };
}
export function proposalAccepting(
  access: Awaited<ReturnType<typeof proposalAccess>>,
) {
  return (
    !access.proposal.withdrawnAt &&
    !access.row.proposalRemovalStartedAt &&
    Date.parse(access.proposal.expiresAt) > Date.now() &&
    access.project.project.stage !== 'archived'
  );
}
export async function readProposalResponse(
  store: LibraryStore,
  ownerId: string,
  proposal: StudioProposal,
) {
  const id = proposalResponseId(proposal.id, proposal.recipientId),
    row = await maybeProposalRecord(store, id);
  if (!row) return null;
  if (
    row.id !== id ||
    row.ownerId !== proposal.recipientId ||
    row.kind !== 'job' ||
    row.purpose !== 'proposal-response' ||
    row.eventId ||
    row.deletionStartedAt !== undefined ||
    row.deletionCompletedAt !== undefined
  )
    throw proposalUnavailable();
  const result = storedProposalResponse.safeParse(row.proposalResponse);
  if (
    !result.success ||
    result.data.id !== id ||
    result.data.createdAt !== row.createdAt ||
    result.data.proposalId !== proposal.id ||
    result.data.proposalGeneration !== proposal.generation ||
    result.data.projectId !== proposal.projectId ||
    result.data.photographerId !== ownerId ||
    (result.data.serviceId &&
      !proposal.options.some((option) => option.id === result.data.serviceId))
  )
    throw proposalInvalid();
  return result.data;
}
