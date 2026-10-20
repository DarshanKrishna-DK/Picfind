import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';

export function proposalResponseId(id: string, recipient: string) {
  const hex = createHash('sha256')
    .update(`picfind:proposal-response:${id}:${recipient}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const invalid = () =>
  new ApiError(
    503,
    'PROPOSAL_METADATA_INVALID',
    'Proposal identity metadata needs repair before cleanup.',
  );
const changed = () =>
  new ApiError(
    409,
    'PROPOSAL_CHANGED',
    'Proposal participants changed. Reload and retry cleanup.',
  );
export function proposalIdentity(row: LibraryRecord) {
  const value = row.studioProposal;
  if (
    row.kind !== 'job' ||
    row.purpose !== 'studio-proposal' ||
    row.eventId ||
    !z.uuid().safeParse(row.id).success ||
    value?.id !== row.id ||
    !z.uuid().safeParse(value.projectId).success ||
    !z.uuid().safeParse(value.generation).success ||
    !z.string().min(1).max(128).safeParse(row.ownerId).success ||
    !z.string().min(1).max(128).safeParse(value.recipientId).success ||
    value.recipientId === row.ownerId
  )
    throw invalid();
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: value.projectId,
    recipientId: value.recipientId,
    generation: value.generation,
  };
}
export async function removeProposalResponse(
  store: LibraryStore,
  proposal: LibraryRecord,
  lockedAccounts: ReadonlySet<string>,
  assertRemoval: () => Promise<void> = async () => {},
) {
  const identity = proposalIdentity(proposal);
  if (
    !lockedAccounts.has(identity.ownerId) ||
    !lockedAccounts.has(identity.recipientId)
  )
    throw invalid();
  const id = proposalResponseId(identity.id, identity.recipientId);
  async function get() {
    try {
      return await store.get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  function belongs(row: LibraryRecord) {
    const value = row.proposalResponse;
    return (
      row.id === id &&
      row.ownerId === identity.recipientId &&
      row.kind === 'job' &&
      row.purpose === 'proposal-response' &&
      !row.eventId &&
      value?.id === id &&
      value.proposalId === identity.id &&
      value.proposalGeneration === identity.generation &&
      value.projectId === identity.projectId &&
      value.photographerId === identity.ownerId
    );
  }
  const row = await get();
  if (!row) return;
  if (!belongs(row)) throw changed();
  if (
    JSON.stringify(proposalIdentity(await store.get(identity.id))) !==
    JSON.stringify(identity)
  )
    throw changed();
  await assertRemoval();
  const fresh = await get();
  if (!fresh) return;
  if (!belongs(fresh)) throw changed();
  try {
    await store.remove(id);
  } catch (failure) {
    if (!(failure instanceof ApiError && failure.status === 404)) throw failure;
  }
}
