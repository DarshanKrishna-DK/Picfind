import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, type AuthOptions } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock, withAccountLocks } from './locks.js';
import {
  proposalResponseId,
  proposalIdentity,
  removeProposalResponse,
} from './proposal-cleanup.js';
import {
  maybeProposalRecord,
  proposalAccess,
  proposalAccepting,
  proposalChanged as changed,
  proposalClient,
  proposalInvalid,
  proposalProject,
  proposalUnavailable as unavailable,
  readProposal,
  readProposalResponse,
} from './proposal-access.js';
import { savedService } from '../../../packages/shared/src/studio-services.js';
import {
  PROPOSAL_ACTOR,
  PROPOSAL_LIMIT,
  PROPOSAL_RECOVERY_LIMIT,
  PROJECT_PROPOSAL_LIMIT,
  clientProposal,
  ownerProposals,
  proposalCreate,
  proposalFields,
  proposalResponseWrite,
  publicProposalResponse,
  savedProposal,
  storedProposalResponse,
} from '../../../packages/shared/src/studio-proposals.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = () =>
  new ApiError(
    409,
    'PROPOSAL_CLOSED',
    'This proposal is closed to new preferences.',
  );
const command = z
  .object({
    generation: z.uuid(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 2),
  })
  .strict();
export function createStudioProposals(
  auth: AuthOptions,
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router(),
    writes = rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    });
  async function actor(req: Request) {
    const id = await owner(req);
    if (req.get(PROPOSAL_ACTOR) && req.get(PROPOSAL_ACTOR) !== id)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the proposal.',
      );
    return id;
  }
  function idOf(value: unknown) {
    const id = z.uuid().safeParse(value);
    if (!id.success) throw unavailable();
    return id.data;
  }
  function versionOf(value: unknown) {
    const parsed = command.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_PROPOSAL_VERSION',
        'Load the current proposal before continuing.',
      );
    return parsed.data;
  }
  async function owned(accountId: string, projectId: string, id: string) {
    const value = await proposalAccess(getStore(), id, accountId, true);
    if (value.proposal.projectId !== projectId) throw unavailable();
    return value;
  }
  async function rows(accountId: string) {
    const values = (await getStore().list(accountId, 'job')).filter(
      (row) => row.ownerId === accountId && row.purpose === 'studio-proposal',
    );
    if (
      values.length > PROPOSAL_RECOVERY_LIMIT ||
      new Set(values.map((row) => row.id)).size !== values.length
    )
      throw proposalInvalid();
    return values;
  }
  async function snapshot(accountId: string, projectId: string) {
    const before = await proposalProject(getStore(), accountId, projectId);
    const selected = (await rows(accountId)).filter(
      (row) => row.studioProposal?.projectId === projectId,
    );
    if (selected.length > PROJECT_PROPOSAL_LIMIT) throw proposalInvalid();
    const proposals = [];
    for (const row of selected) {
      const access = await owned(accountId, projectId, row.id);
      let response: Awaited<ReturnType<typeof readProposalResponse>> = null;
      let responseUnavailable = false;
      try {
        response = await readProposalResponse(
          getStore(),
          accountId,
          access.proposal,
        );
      } catch (failure) {
        if (
          !(failure instanceof ApiError) ||
          !['PROPOSAL_METADATA_INVALID', 'PROPOSAL_UNAVAILABLE'].includes(
            failure.code,
          )
        )
          throw failure;
        responseUnavailable = true;
      }
      const fresh = await owned(accountId, projectId, row.id);
      if (JSON.stringify(access.proposal) !== JSON.stringify(fresh.proposal))
        throw changed();
      proposals.push({
        proposal: fresh.proposal,
        removalPending: Boolean(fresh.row.proposalRemovalStartedAt),
        responseUnavailable,
        response: response ? publicProposalResponse(response) : null,
      });
    }
    const client = await proposalClient(
      getStore(),
      accountId,
      before.project.clientId,
    );
    const project = await proposalProject(getStore(), accountId, projectId);
    if (JSON.stringify(project.project) !== JSON.stringify(before.project))
      throw changed();
    return ownerProposals.parse({
      accountId,
      projectId,
      projectName: project.project.name,
      projectVersion: project.project.version,
      editable: project.project.stage !== 'archived' && Boolean(client),
      client: client
        ? {
            id: client.id,
            version: client.version,
            name: client.name,
            email: client.email,
          }
        : null,
      limit: PROJECT_PROPOSAL_LIMIT,
      proposals: proposals.sort((a, b) =>
        b.proposal.createdAt.localeCompare(a.proposal.createdAt),
      ),
    });
  }
  const path = '/studio/projects/:projectId/proposals';
  router.get(path, async (req, res) =>
    res.json(await snapshot(await actor(req), idOf(req.params.projectId))),
  );
  router.put(`${path}/:id`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id),
      input = proposalCreate.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_PROPOSAL',
        'Choose current project and client details, an expiry and up to three service versions.',
      );
    const data = input.data;
    const commandDigest = digest({ accountId, projectId, id, ...data });
    async function retry() {
      const row = await maybeProposalRecord(getStore(), id);
      if (!row) return null;
      const existing = await owned(accountId, projectId, id);
      if (
        existing.row.proposalRemovalStartedAt ||
        row.proposalCommandDigest !== commandDigest
      )
        throw changed();
      return existing.proposal;
    }
    const existing = await withAccountLock(accountId, retry);
    if (existing) {
      res.json({ accountId, proposal: existing });
      return;
    }
    async function issuanceContext() {
      const project = await proposalProject(getStore(), accountId, projectId);
      if (project.project.stage === 'archived') throw closed();
      if (
        project.project.version !== data.projectVersion ||
        project.project.clientId !== data.clientId
      )
        throw changed();
      const client = await proposalClient(
        getStore(),
        accountId,
        project.project.clientId,
      );
      if (
        !client ||
        client.version !== data.clientVersion ||
        client.email !== data.clientEmail
      )
        throw changed();
      return { project: project.project, client };
    }
    const initial = await issuanceContext();
    if (!auth.provider?.resolveEventMember)
      throw new ApiError(
        503,
        'PROPOSAL_LOOKUP_UNAVAILABLE',
        'Account lookup is not configured.',
      );
    const recipient = await auth.provider.resolveEventMember(
      initial.client.email,
    );
    if (
      !recipient?.emailVerified ||
      recipient.id === accountId ||
      !z.string().min(1).max(128).safeParse(recipient.id).success ||
      recipient.email.trim().toLowerCase() !== initial.client.email
    )
      throw new ApiError(
        400,
        'PROPOSAL_RECIPIENT_UNAVAILABLE',
        'The linked client needs another verified PicFind account with this email.',
      );
    const proposal = await withAccountLocks(
      [accountId, recipient.id],
      async () => {
        const repeated = await retry();
        if (repeated) return repeated;
        const context = await issuanceContext(),
          retained = await rows(accountId);
        if (
          retained.length >= PROPOSAL_LIMIT ||
          retained.filter((row) => row.studioProposal?.projectId === projectId)
            .length >= PROJECT_PROPOSAL_LIMIT
        )
          throw new ApiError(
            409,
            'PROPOSAL_LIMIT',
            'Remove an expired or withdrawn proposal before issuing another.',
          );
        async function service(id: string, version: number) {
          const row = await maybeProposalRecord(getStore(), id);
          if (
            !row ||
            row.id !== id ||
            row.ownerId !== accountId ||
            row.kind !== 'job' ||
            row.purpose !== 'studio-service' ||
            row.eventId ||
            row.deletionStartedAt !== undefined ||
            row.deletionCompletedAt !== undefined
          )
            throw unavailable();
          const value = savedService.safeParse(row.studioService);
          if (
            !value.success ||
            value.data.id !== id ||
            value.data.createdAt !== row.createdAt
          )
            throw proposalInvalid();
          if (value.data.archived || value.data.version !== version)
            throw changed();
          return value.data;
        }
        const options = await Promise.all(
          input.data.services.map((row) => service(row.id, row.version)),
        );
        if (
          options.some(
            (option, index) =>
              JSON.stringify(option) !==
              JSON.stringify(input.data.services[index]!.snapshot),
          )
        )
          throw changed();
        const fields = proposalFields.safeParse({
          title: input.data.title,
          introduction: input.data.introduction,
          options,
        });
        if (!fields.success)
          throw new ApiError(
            400,
            'PROPOSAL_OPTIONS_INVALID',
            'Use one currency and shorter package details so the complete proposal fits its size limit.',
          );
        const now = new Date().toISOString();
        const next = savedProposal.parse({
          ...fields.data,
          id,
          generation: randomUUID(),
          projectId,
          recipientId: recipient.id,
          recipientEmail: initial.client.email,
          version: 1,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(
            Date.parse(now) + input.data.days * 86400000,
          ).toISOString(),
          withdrawnAt: null,
        });
        if (JSON.stringify(await issuanceContext()) !== JSON.stringify(context))
          throw changed();
        const latestOptions = await Promise.all(
          input.data.services.map((row) => service(row.id, row.version)),
        );
        if (JSON.stringify(latestOptions) !== JSON.stringify(options))
          throw changed();
        await getStore().put(
          {
            id,
            ownerId: accountId,
            kind: 'job',
            purpose: 'studio-proposal',
            createdAt: now,
            studioProposal: next,
            proposalCommandDigest: commandDigest,
          },
          true,
        );
        return next;
      },
    );
    res.json({ accountId, proposal });
  });
  router.post(`${path}/:id/withdraw`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id),
      input = versionOf(req.body);
    await withAccountLock(accountId, async () => {
      const access = await owned(accountId, projectId, id);
      if (
        access.proposal.generation !== input.generation ||
        access.row.proposalRemovalStartedAt
      )
        throw changed();
      if (
        access.proposal.withdrawnAt &&
        access.proposal.version === input.version + 1
      )
        return;
      if (access.proposal.version !== input.version) throw changed();
      if (access.proposal.withdrawnAt) return;
      const fresh = await owned(accountId, projectId, id);
      if (JSON.stringify(fresh.row) !== JSON.stringify(access.row))
        throw changed();
      const now = new Date(
        Math.max(Date.now(), Date.parse(access.proposal.updatedAt)),
      ).toISOString();
      await getStore().put({
        ...fresh.row,
        studioProposal: {
          ...fresh.proposal,
          withdrawnAt: now,
          updatedAt: now,
          version: input.version + 1,
        },
      });
    });
    res.status(204).end();
  });
  router.delete(`${path}/:id`, writes, async (req, res) => {
    const accountId = await actor(req),
      projectId = idOf(req.params.projectId),
      id = idOf(req.params.id),
      input = versionOf(req.body);
    const before = await maybeProposalRecord(getStore(), id);
    if (!before) {
      res.status(204).end();
      return;
    }
    const initial = readProposal(before, id, accountId);
    if (initial.proposal.projectId !== projectId) throw unavailable();
    await withAccountLocks(
      [accountId, initial.proposal.recipientId],
      async () => {
        const access = await owned(accountId, projectId, id);
        if (
          JSON.stringify(proposalIdentity(access.row)) !==
            JSON.stringify(proposalIdentity(before)) ||
          access.proposal.generation !== input.generation ||
          access.proposal.version !== input.version
        )
          throw changed();
        if (
          !access.proposal.withdrawnAt &&
          Date.parse(access.proposal.expiresAt) > Date.now()
        )
          throw closed();
        const pending: LibraryRecord = {
          ...access.row,
          proposalRemovalStartedAt:
            access.row.proposalRemovalStartedAt ?? new Date().toISOString(),
        };
        await getStore().put(pending);
        async function assertRemoval() {
          const current = await owned(accountId, projectId, id);
          if (JSON.stringify(current.row) !== JSON.stringify(pending))
            throw changed();
        }
        await removeProposalResponse(
          getStore(),
          pending,
          new Set([accountId, initial.proposal.recipientId]),
          assertRemoval,
        );
        await assertRemoval();
        await getStore().remove(id);
      },
      { allowDeleted: [initial.proposal.recipientId] },
    );
    res.status(204).end();
  });
  async function clientSnapshot(accountId: string, id: string) {
    const access = await proposalAccess(getStore(), id, accountId, false),
      response = await readProposalResponse(
        getStore(),
        access.row.ownerId,
        access.proposal,
      ),
      fresh = await proposalAccess(getStore(), id, accountId, false);
    if (
      JSON.stringify(fresh.proposal) !== JSON.stringify(access.proposal) ||
      fresh.row.ownerId !== access.row.ownerId
    )
      throw changed();
    return clientProposal.parse({
      accountId,
      id,
      generation: fresh.proposal.generation,
      fields: {
        title: fresh.proposal.title,
        introduction: fresh.proposal.introduction,
        options: fresh.proposal.options,
      },
      expiresAt: fresh.proposal.expiresAt,
      accepting: proposalAccepting(fresh),
      response: response ? publicProposalResponse(response) : null,
    });
  }
  router.get('/proposals/:id', async (req, res) =>
    res.json(await clientSnapshot(await actor(req), idOf(req.params.id))),
  );
  router.put('/proposals/:id/response', writes, async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = proposalResponseWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_PROPOSAL_RESPONSE',
        'Choose an option or decline, consent to share the preference, and use the current revision.',
      );
    const initial = await proposalAccess(getStore(), id, accountId, false),
      commandDigest = digest(input.data);
    const response = await withAccountLocks(
      [accountId, initial.row.ownerId],
      async () => {
        const access = await proposalAccess(getStore(), id, accountId, false);
        if (
          access.row.ownerId !== initial.row.ownerId ||
          access.proposal.generation !== input.data.proposalGeneration
        )
          throw changed();
        if (!proposalAccepting(access)) throw closed();
        if (
          input.data.serviceId &&
          !access.proposal.options.some(
            (row) => row.id === input.data.serviceId,
          )
        )
          throw changed();
        const current = await readProposalResponse(
          getStore(),
          access.row.ownerId,
          access.proposal,
        );
        async function assertCurrent() {
          const fresh = await proposalAccess(getStore(), id, accountId, false);
          if (!proposalAccepting(fresh)) throw closed();
          if (
            JSON.stringify(fresh.proposal) !==
              JSON.stringify(access.proposal) ||
            fresh.row.ownerId !== access.row.ownerId ||
            JSON.stringify(
              await readProposalResponse(
                getStore(),
                access.row.ownerId,
                access.proposal,
              ),
            ) !== JSON.stringify(current)
          )
            throw changed();
        }
        if (
          current?.version === input.data.version + 1 &&
          current.commandDigest === commandDigest
        ) {
          await assertCurrent();
          return current;
        }
        if (
          (current?.version ?? 0) !== input.data.version ||
          (current?.generation ?? null) !== input.data.generation
        )
          throw changed();
        const now = new Date(
            Math.max(Date.now(), current ? Date.parse(current.updatedAt) : 0),
          ).toISOString(),
          responseId = proposalResponseId(id, accountId);
        const next = storedProposalResponse.parse({
          id: responseId,
          generation: current?.generation ?? randomUUID(),
          version: input.data.version + 1,
          decision: input.data.decision,
          serviceId: input.data.serviceId,
          note: input.data.note,
          proposalId: id,
          proposalGeneration: access.proposal.generation,
          projectId: access.proposal.projectId,
          photographerId: access.row.ownerId,
          consent: input.data.consent,
          commandDigest,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        });
        await assertCurrent();
        await getStore().put(
          {
            id: responseId,
            ownerId: accountId,
            kind: 'job',
            purpose: 'proposal-response',
            createdAt: next.createdAt,
            proposalResponse: next,
          },
          !current,
        );
        return next;
      },
    );
    res.json({ accountId, response: publicProposalResponse(response) });
  });
  return router;
}
