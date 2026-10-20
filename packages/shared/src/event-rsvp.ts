import { z } from 'zod';

export const RSVP_LIMIT = 300;
export const RSVP_CONSENT = 'event-rsvp-v1' as const;
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
const readVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const rsvpSettingsFields = z
  .object({
    enabled: z.boolean(),
    closesAt: z.iso.datetime().nullable(),
    maxPartySize: z.number().int().min(1).max(10),
  })
  .strict();
export const emptyRsvpSettings = () => ({
  enabled: false,
  closesAt: null,
  maxPartySize: 1,
  version: 0,
  updatedAt: null,
});
export const rsvpSettingsWrite = rsvpSettingsFields
  .extend({ version })
  .strict();
export const storedRsvpSettings = rsvpSettingsFields
  .extend({
    version: readVersion.refine((value) => value > 0),
    updatedAt: z.iso.datetime(),
    commandDigest: digest,
  })
  .strict();
export type StoredRsvpSettings = z.infer<typeof storedRsvpSettings>;
export const rsvpSettingsView = rsvpSettingsFields
  .extend({
    version: readVersion,
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((value) =>
    value.version === 0
      ? value.updatedAt === null &&
        !value.enabled &&
        value.closesAt === null &&
        value.maxPartySize === 1
      : value.updatedAt !== null,
  );
const fields = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    response: z.enum(['going', 'maybe', 'not-going']),
    partySize: z.number().int().min(0).max(10),
    message: z.string().trim().max(300),
  })
  .strict();
function partyValid(value: z.infer<typeof fields>) {
  return value.response === 'not-going'
    ? value.partySize === 0
    : value.partySize >= 1;
}
export const rsvpFields = fields.refine(partyValid);
export type RsvpFields = z.infer<typeof rsvpFields>;
export const rsvpWrite = fields
  .extend({
    version,
    receiptId: z.uuid(),
    invitationRevision: readVersion.refine((value) => value > 0),
    consent: z.literal(RSVP_CONSENT),
  })
  .strict()
  .refine(partyValid);
export const rsvpRemoval = z
  .object({ version: readVersion, receiptId: z.uuid() })
  .strict();
export const rsvpView = fields
  .extend({
    id: z.uuid(),
    version: readVersion.refine((value) => value > 0),
    invitationRevision: readVersion.refine((value) => value > 0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(partyValid)
  .refine(
    (value) => Date.parse(value.createdAt) <= Date.parse(value.updatedAt),
  );
export type RsvpView = z.infer<typeof rsvpView>;
export const storedRsvp = rsvpView
  .safeExtend({
    receiptHash: digest,
    consent: z.literal(RSVP_CONSENT),
    commandDigest: digest,
  })
  .strict();
export type StoredRsvp = z.infer<typeof storedRsvp>;
export function publicRsvp(value: StoredRsvp): RsvpView {
  return {
    id: value.id,
    displayName: value.displayName,
    response: value.response,
    partySize: value.partySize,
    message: value.message,
    version: value.version,
    invitationRevision: value.invitationRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
export const guestRsvpSnapshot = z
  .object({
    eventId: z.uuid(),
    receiptId: z.uuid().nullable(),
    invitationRevision: readVersion,
    accepting: z.boolean(),
    policy: rsvpSettingsFields,
    response: rsvpView.nullable(),
  })
  .strict()
  .refine((value) => !value.response || value.response.id === value.receiptId)
  .refine(
    (value) =>
      !value.accepting ||
      (value.policy.enabled && value.invitationRevision > 0),
  );
export type GuestRsvpSnapshot = z.infer<typeof guestRsvpSnapshot>;
export const hostRsvpSnapshot = z
  .object({
    accountId: z.string().min(1),
    eventId: z.uuid(),
    editable: z.boolean(),
    accepting: z.boolean(),
    settings: rsvpSettingsView,
    responses: z.array(rsvpView).max(RSVP_LIMIT),
    limit: z.literal(RSVP_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.responses.map((entry) => entry.id)).size ===
      value.responses.length,
  );
export type HostRsvpSnapshot = z.infer<typeof hostRsvpSnapshot>;
export function rsvpTotals(responses: readonly RsvpView[]) {
  const totals = {
    responses: responses.length,
    going: 0,
    maybe: 0,
    notGoing: 0,
    goingParty: 0,
    maybeParty: 0,
  };
  for (const response of responses) {
    if (response.response === 'going') {
      totals.going++;
      totals.goingParty += response.partySize;
    } else if (response.response === 'maybe') {
      totals.maybe++;
      totals.maybeParty += response.partySize;
    } else totals.notGoing++;
  }
  return totals;
}
