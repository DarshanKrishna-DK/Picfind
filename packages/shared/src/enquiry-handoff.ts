import { z } from 'zod';
import { clientFields, savedClient } from './studio-clients.js';
import { savedProject } from './studio-projects.js';
import { savedEnquiry } from './studio-enquiries.js';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  operationId: z.uuid(),
  requestDigest: fingerprint,
  sourceCreatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
};
export const pendingHandoff = z
  .object({
    ...common,
    status: z.literal('pending'),
    newClient: z.boolean(),
    client: savedClient,
    project: savedProject,
  })
  .strict()
  .refine(
    (value) =>
      value.project.clientId === value.client.id &&
      value.project.stage === 'inquiry' &&
      value.project.version === 1 &&
      value.project.eventIds.length === 0 &&
      value.project.createdAt === value.startedAt &&
      Date.parse(value.sourceCreatedAt) <= Date.parse(value.startedAt) &&
      (!value.newClient ||
        (value.client.version === 1 &&
          value.client.createdAt === value.startedAt)),
  );
const finishedHandoff = z
  .object({
    ...common,
    status: z.enum(['completed', 'abandoned']),
    newClient: z.boolean(),
    clientId: z.uuid(),
    projectId: z.uuid(),
    finishedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.sourceCreatedAt) <= Date.parse(value.startedAt) &&
      Date.parse(value.startedAt) <= Date.parse(value.finishedAt),
  );
export const enquiryHandoff = z.union([pendingHandoff, finishedHandoff]);
export type EnquiryHandoff = z.infer<typeof enquiryHandoff>;
export type PendingHandoff = z.infer<typeof pendingHandoff>;
const start = z
  .object({
    action: z.literal('start'),
    operationId: z.uuid(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 3),
    sourceToken: fingerprint,
    client: z.discriminatedUnion('mode', [
      z
        .object({ mode: z.literal('new'), id: z.uuid(), fields: clientFields })
        .strict(),
      z.object({ mode: z.literal('existing'), snapshot: savedClient }).strict(),
    ]),
    project: z
      .object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(100),
        summary: z.string().trim().max(1000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 5000,
  );
export const handoffCommand = z.union([
  start,
  z
    .object({
      action: z.literal('resume'),
      operationId: z.uuid(),
      recoveryToken: fingerprint,
      createMissing: z
        .array(z.uuid())
        .max(2)
        .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict(),
  z
    .object({
      action: z.literal('abandon'),
      operationId: z.uuid(),
      recoveryToken: fingerprint,
    })
    .strict(),
]);
const target = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(['matching', 'missing', 'changed']),
    mayCreate: z.boolean(),
  })
  .strict();
export const handoffPreview = z
  .object({
    accountId: z.string().min(1),
    enquiry: savedEnquiry,
    sourceToken: fingerprint,
    clients: z.array(savedClient).max(200),
    totalClients: z.number().int().min(0),
    handoff: enquiryHandoff.nullable(),
    recoveryToken: fingerprint.nullable(),
    targets: z.object({ client: target, project: target }).strict().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.handoff === null) === (value.targets === null) &&
      (value.handoff?.status === 'pending') === (value.recoveryToken !== null),
  );
export type HandoffPreview = z.infer<typeof handoffPreview>;
