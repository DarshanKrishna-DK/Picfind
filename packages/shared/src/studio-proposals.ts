import { z } from 'zod';
import { savedService } from './studio-services.js';

export const PROPOSAL_ACTOR = 'X-PicFind-Proposal-Actor';
export const PROPOSAL_CONSENT = 'proposal-preference-v1';
export const PROPOSAL_LIMIT = 200;
export const PROJECT_PROPOSAL_LIMIT = 20;
// Read beyond the normal creation cap to permit removal of imported excess rows.
export const PROPOSAL_RECOVERY_LIMIT = 500;
const accountId = z.string().min(1).max(128);
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const title = z.string().trim().min(1).max(100);
const introduction = z.string().trim().max(1000);
const bytes = (value: unknown, limit: number) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= limit;
export const proposalCreate = z
  .object({
    title,
    introduction,
    days: z.number().int().min(1).max(30),
    projectVersion: version,
    clientId: z.uuid(),
    clientVersion: version,
    clientEmail: z.email().max(254),
    services: z
      .array(
        z.object({ id: z.uuid(), version, snapshot: savedService }).strict(),
      )
      .min(1)
      .max(3),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.services.map((row) => row.id)).size ===
        value.services.length &&
      value.services.every(
        (row) =>
          row.snapshot.id === row.id && row.snapshot.version === row.version,
      ),
  )
  .refine((value) => bytes(value, 12000));
export const proposalFields = z
  .object({
    title,
    introduction,
    options: z.array(savedService).min(1).max(3),
  })
  .strict()
  .refine(
    (value) =>
      value.options.every((row) => !row.archived) &&
      new Set(value.options.map((row) => row.id)).size ===
        value.options.length &&
      new Set(value.options.map((row) => row.currency)).size === 1,
  )
  .refine((value) => bytes(value, 10000));
export const savedProposal = proposalFields
  .safeExtend({
    id: z.uuid(),
    generation: z.uuid(),
    projectId: z.uuid(),
    recipientId: accountId,
    recipientEmail: z.email().max(254),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    withdrawnAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
      (!value.withdrawnAt ||
        (Date.parse(value.withdrawnAt) >= Date.parse(value.createdAt) &&
          Date.parse(value.withdrawnAt) <= Date.parse(value.updatedAt))),
  )
  .refine((value) => bytes(value, 12000));
export type StudioProposal = z.infer<typeof savedProposal>;
const preference = {
  decision: z.enum(['choose', 'decline']),
  serviceId: z.uuid().nullable(),
  note: z.string().trim().max(1000),
};
const validDecision = (value: {
  decision: 'choose' | 'decline';
  serviceId: string | null;
}) => (value.decision === 'choose') === (value.serviceId !== null);
export const proposalResponseWrite = z
  .object({
    ...preference,
    proposalGeneration: z.uuid(),
    generation: z.uuid().nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    consent: z.literal(PROPOSAL_CONSENT),
  })
  .strict()
  .refine(validDecision)
  .refine((value) => (value.version === 0) === (value.generation === null))
  .refine((value) => bytes(value, 4000));
export const proposalResponseView = z
  .object({
    ...preference,
    id: z.uuid(),
    generation: z.uuid(),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(validDecision)
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export const storedProposalResponse = proposalResponseView
  .safeExtend({
    proposalId: z.uuid(),
    proposalGeneration: z.uuid(),
    projectId: z.uuid(),
    photographerId: accountId,
    consent: z.literal(PROPOSAL_CONSENT),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => bytes(value, 6000));
export type ProposalResponse = z.infer<typeof storedProposalResponse>;
export type ProposalResponseView = z.infer<typeof proposalResponseView>;
export function publicProposalResponse(
  value: ProposalResponse,
): ProposalResponseView {
  const {
    id,
    generation,
    version,
    decision,
    serviceId,
    note,
    createdAt,
    updatedAt,
  } = value;
  return proposalResponseView.parse({
    id,
    generation,
    version,
    decision,
    serviceId,
    note,
    createdAt,
    updatedAt,
  });
}
export const ownerProposals = z
  .object({
    accountId,
    projectId: z.uuid(),
    projectName: z.string(),
    projectVersion: version,
    editable: z.boolean(),
    limit: z.literal(PROJECT_PROPOSAL_LIMIT),
    client: z
      .object({ id: z.uuid(), version, name: z.string(), email: z.email() })
      .strict()
      .nullable(),
    proposals: z
      .array(
        z
          .object({
            proposal: savedProposal,
            removalPending: z.boolean(),
            responseUnavailable: z.boolean(),
            response: proposalResponseView.nullable(),
          })
          .strict(),
      )
      .max(PROJECT_PROPOSAL_LIMIT),
  })
  .strict();
export const clientProposal = z
  .object({
    accountId,
    id: z.uuid(),
    generation: z.uuid(),
    fields: proposalFields,
    expiresAt: z.iso.datetime(),
    accepting: z.boolean(),
    response: proposalResponseView.nullable(),
  })
  .strict();
